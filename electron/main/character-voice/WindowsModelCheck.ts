import {execFile} from 'node:child_process'
import {isAbsolute,join,dirname} from 'node:path'
import type {VoiceEngine,ExecutionProfile} from '../../shared/character-voice-contract'
import type {VoxGgufConfig} from './TtsRuntimeSupervisor'
import voxWindowsPolicy from '../../voice/runtime-gguf-windows-voxcpm2.json'
import defaultVoice from '../../voice/base-voice-defaults.json'
import type {ReferenceCondition} from './ReferenceProfileStore'
import type {GgufRuntimeConnection} from '../../shared/windows-gguf-runtime-catalog'

// The pinned checker does not fork or close its standard pipes. A Windows venv
// redirector's bootstrap child inherits them: close drains that child as well.
// Cancellation waits for both the owned tree termination and drained close.
export async function checkWindowsModel(python:string,model:string,worker:string,engine:VoiceEngine,signal:AbortSignal,options:{managedRuntime?:GgufRuntimeConnection['managedRuntime'];beforeManagedSpawn?:()=>Promise<void>;timeoutMs?:number;gguf?:VoxGgufConfig&{package:string;executionProfile:ExecutionProfile};ggufModelKind?:'public-base';conditioning?:ReferenceCondition}={}):Promise<void>{
 if(![python,model,worker].every(isAbsolute))return Promise.reject(Error('VOICE_RUNTIME_CONFIG'))
 const publicVox=options.ggufModelKind==='public-base'
 if(options.ggufModelKind!==undefined&&(!options.gguf||!publicVox))return Promise.reject(Error('VOICE_RUNTIME_CONFIG'))
 if(options.gguf&&(engine!=='voxcpm2'||!['gguf-cuda-f16','gguf-cuda-f16-complete','gguf-vulkan-f16','gguf-vulkan-f16-complete'].includes(options.gguf.executionProfile)||![options.gguf.runtimeDir,options.gguf.derivativeDir,options.gguf.receipt].every(p=>typeof p==='string'&&isAbsolute(p))||(publicVox?options.gguf.package!==''||model!==options.gguf.derivativeDir:!isAbsolute(options.gguf.package))))return Promise.reject(Error('VOICE_RUNTIME_CONFIG'))
 if(options.conditioning&&(!publicVox||options.conditioning.kind!=='wav-reference'||!isAbsolute(options.conditioning.path)||Buffer.byteLength(JSON.stringify(options.conditioning),'utf8')>8192))return Promise.reject(Error('VOICE_RUNTIME_CONFIG'))
 if(signal.aborted)return Promise.reject(Error('VOICE_MODEL_CHECK_CANCELLED'))
 if(options.managedRuntime){if(!options.beforeManagedSpawn||![options.managedRuntime.root,options.managedRuntime.receipt].every(isAbsolute))throw Error('GGUF_RUNTIME_ADMISSION');await options.beforeManagedSpawn()}
 if(signal.aborted)return Promise.reject(Error('VOICE_MODEL_CHECK_CANCELLED'))
 return new Promise((resolve,reject)=>{
  let closed=false,stopping=false,expired=false,result:{error:Error|null;stdout:string}|undefined,force:ReturnType<typeof setTimeout>|undefined
  const finish=()=>{
   if(!closed||!result||stopping)return
   signal.removeEventListener('abort',abort);clearTimeout(deadline);if(force)clearTimeout(force)
   if(signal.aborted){reject(Error('VOICE_MODEL_CHECK_CANCELLED'));return}
   try{
    const checked=JSON.parse(result.stdout)
    if(expired||result.error||checked.status!=='PASS')throw Error()
    if(options.gguf){
     if(options.managedRuntime){const pin=(voxWindowsPolicy as unknown as {managedRuntimeCatalog?:{sha256:string}}).managedRuntimeCatalog;if(!pin||checked.managedRuntimeVerified!==true||checked.managedRuntimeId!==options.managedRuntime.runtimeId||checked.managedRuntimeCatalogSha256!==pin.sha256)throw Error()}
     if(checked.engine!=='voxcpm2'||checked.executionProfile!==options.gguf.executionProfile.replace(/-complete$/,'')||checked.sourceCommit!==voxWindowsPolicy.sourceCommit||checked.nativeExecuted!==false||checked.ggufVerification!=='full-sha256')throw Error()
     if(publicVox){
      const files=checked.modelFiles as Record<string,{bytes:number;sha256:string}>|undefined,pinned=voxWindowsPolicy.publicModel
      if(checked.ggufModelKind!=='public-base'||checked.originalModelVerification!=='not-applicable-public-gguf'||checked.modelRepository!==pinned.repo||checked.modelRevision!==pinned.revision||checked.publisher!==pinned.repo.split('/')[0]||!files||Object.keys(files).length!==Object.keys(pinned.files).length||Object.entries(pinned.files).some(([name,file])=>!Object.hasOwn(files,name)||files[name]?.sha256!==file.sha256||files[name]?.bytes!==file.bytes)||checked.packageSha256!==null||checked.adapterSha256!==null)throw Error()
      if(options.conditioning){if(checked.mode!=='wav-reference'||checked.referenceContract!==1||checked.referenceCacheBuilds!==1||checked.referenceSha256!==options.conditioning.sha256||checked.conditioningFingerprint!==options.conditioning.fingerprint||checked.defaultVoice!==null)throw Error()}
      else if(checked.mode!=='base'||checked.referenceContract!==1||checked.referenceCacheBuilds!==0||checked.referenceSha256!==null||checked.conditioningFingerprint!==null||!checked.defaultVoice||checked.defaultVoice.description!==defaultVoice.description||checked.defaultVoice.seed!==defaultVoice.seed||Object.keys(checked.defaultVoice).length!==2)throw Error()
     }else{
      const derivative=typeof checked.packageSha256==='string'&&/^[a-f0-9]{64}$/.test(checked.packageSha256)&&Object.hasOwn(voxWindowsPolicy.derivatives,checked.packageSha256)?voxWindowsPolicy.derivatives[checked.packageSha256 as keyof typeof voxWindowsPolicy.derivatives]:undefined
      if(checked.ggufModelKind==='public-base'||checked.originalModelVerification!=='provenance-and-presence'||!derivative||checked.adapterSha256!==derivative.adapterSha256||typeof checked.referenceSha256!=='string'||!/^[a-f0-9]{64}$/.test(checked.referenceSha256))throw Error()
     }
    }
    resolve()
   }catch{reject(Error('VOICE_MODEL_CHECK_FAILED'))}
  }
  // Node's signal/timeout would terminate only the launcher. Own the deadline
  // and tree instead; never allow cleanup/replacement while its pipes are live.
  const args=options.gguf?['-I','-B',join(dirname(worker),'voxcpm_windows_gguf_runtime.py'),'--verify','--package',options.gguf.package,'--model',model,'--runtime-dir',options.gguf.runtimeDir,'--derivative-dir',options.gguf.derivativeDir,'--receipt',options.gguf.receipt,'--execution-profile',options.gguf.executionProfile.replace(/-complete$/,'')]:['-I','-B',join(dirname(worker),'windows_model_check.py'),'--engine',engine,'--model',model]
  if(options.gguf&&options.managedRuntime)args.push('--managed-runtime-json',JSON.stringify(options.managedRuntime))
  if(publicVox)args.push('--model-kind','public-base')
  if(options.conditioning)args.push('--conditioning-json',JSON.stringify(options.conditioning))
  const child=execFile(python,args,{windowsHide:true,maxBuffer:16*1024,env:{...process.env,PYTHONPATH:'',PYTHONNOUSERSITE:'1',PYTHONDONTWRITEBYTECODE:'1',PYTHONUTF8:'1'}},(error,stdout)=>{result={error,stdout};finish()})
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
