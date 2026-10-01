import {execFile} from 'node:child_process'
import {isAbsolute,join,dirname} from 'node:path'
import type {VoiceEngine} from '../../shared/character-voice-contract'

// CPU-only, owned process; resolve cancellation only after its close event.
export function checkWindowsModel(python:string,model:string,worker:string,engine:VoiceEngine,signal:AbortSignal):Promise<void>{
 if(![python,model,worker].every(isAbsolute))return Promise.reject(Error('VOICE_RUNTIME_CONFIG'))
 return new Promise((resolve,reject)=>{
  let closed=false,result:{error:Error|null;stdout:string}|undefined
  const finish=()=>{if(!closed||!result)return;if(signal.aborted){reject(Error('VOICE_MODEL_CHECK_CANCELLED'));return}try{if(result.error||JSON.parse(result.stdout).status!=='PASS')throw Error();resolve()}catch{reject(Error('VOICE_MODEL_CHECK_FAILED'))}}
  const child=execFile(python,['-I','-B',join(dirname(worker),'windows_model_check.py'),'--engine',engine,'--model',model],{signal,windowsHide:true,timeout:600_000,maxBuffer:16*1024,env:{...process.env,PYTHONPATH:'',PYTHONNOUSERSITE:'1',PYTHONDONTWRITEBYTECODE:'1',PYTHONUTF8:'1'}},(error,stdout)=>{result={error,stdout};finish()})
  child.once('close',()=>{closed=true;finish()})
 })
}
