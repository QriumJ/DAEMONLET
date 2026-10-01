import {execFile} from 'node:child_process'
import {isAbsolute,join,dirname} from 'node:path'
import type {VoiceEngine} from '../../shared/character-voice-contract'

// The pinned checker does not fork or close its standard pipes. A Windows venv
// redirector's bootstrap child inherits them: close drains that child as well.
// Cancellation waits for both the owned tree termination and drained close.
export function checkWindowsModel(python:string,model:string,worker:string,engine:VoiceEngine,signal:AbortSignal,options:{timeoutMs?:number}={}):Promise<void>{
 if(![python,model,worker].every(isAbsolute))return Promise.reject(Error('VOICE_RUNTIME_CONFIG'))
 if(signal.aborted)return Promise.reject(Error('VOICE_MODEL_CHECK_CANCELLED'))
 return new Promise((resolve,reject)=>{
  let closed=false,stopping=false,expired=false,result:{error:Error|null;stdout:string}|undefined,force:ReturnType<typeof setTimeout>|undefined
  const finish=()=>{
   if(!closed||!result||stopping)return
   signal.removeEventListener('abort',abort);clearTimeout(deadline);if(force)clearTimeout(force)
   if(signal.aborted){reject(Error('VOICE_MODEL_CHECK_CANCELLED'));return}
   try{if(expired||result.error||JSON.parse(result.stdout).status!=='PASS')throw Error();resolve()}catch{reject(Error('VOICE_MODEL_CHECK_FAILED'))}
  }
  // Node's signal/timeout would terminate only the launcher. Own the deadline
  // and tree instead; never allow cleanup/replacement while its pipes are live.
  const child=execFile(python,['-I','-B',join(dirname(worker),'windows_model_check.py'),'--engine',engine,'--model',model],{windowsHide:true,maxBuffer:16*1024,env:{...process.env,PYTHONPATH:'',PYTHONNOUSERSITE:'1',PYTHONDONTWRITEBYTECODE:'1',PYTHONUTF8:'1'}},(error,stdout)=>{result={error,stdout};finish()})
  const abort=()=>{
   if(closed||stopping)return
   if(process.platform==='win32'&&child.pid){
    stopping=true
    execFile('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,timeout:5000,maxBuffer:4096},()=>{stopping=false;finish()})
   }else{child.kill();force=setTimeout(()=>child.kill('SIGKILL'),2000)}
  }
  const deadline=setTimeout(()=>{expired=true;abort()},options.timeoutMs??600_000)
  child.once('close',()=>{closed=true;finish()});signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort()
 })
}
