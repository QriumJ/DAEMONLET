import {mkdir,lstat,statfs,open,rm,rename,readFile,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {randomUUID,createHash} from 'node:crypto'
import catalog from '../../voice/base-model.json'
import runtimeCatalog from '../../voice/runtime-base-macos.json'
import {verifyRuntime} from '../character-chat/runtime-artifacts.mjs'
import {digestFile} from '../character-chat/ModelManager'
import {streamChunks} from '../character-chat/stream'
import type {VoiceProfile,VoiceInstallState} from '../../shared/character-voice-contract'
import {VoiceAssetIdentity} from './VoiceAssetIdentity'
import defaults from '../../voice/base-voice-defaults.json'
export const BASE_VOICE:VoiceProfile={id:'voxcpm2_default',version:catalog.revision,name:'기본 음성 · VoxCPM2',fingerprint:createHash('sha256').update(JSON.stringify({catalog,defaults})).digest('hex'),adapterSha256:'none'}
export const BASE_KEY=BASE_VOICE.id+'@'+BASE_VOICE.version
export interface BaseVoiceInstallation {readonly native:boolean;readonly profile:VoiceProfile;readonly executable:string;readonly path:string;snapshot():VoiceInstallState;initialize():Promise<void>;identity():Promise<string|null>;ready():Promise<string>;cancelVerification():Promise<void>;install():Promise<void>;cancel():Promise<void>}
export class VoiceBaseInstaller implements BaseVoiceInstallation {
 readonly native=true
 readonly profile=BASE_VOICE
 private verifying:Promise<string>|null=null
 private verifyController:AbortController|null=null
 private assets:VoiceAssetIdentity|null=null
 private lastUpdate=0
 private operation:Promise<void>|null=null
 private controller:AbortController|null=null
 private status:VoiceInstallState={supported:process.platform==='darwin'&&process.arch==='arm64',installed:false,phase:'idle',bytes:0,total:Object.values(catalog.files).reduce((n,f)=>n+f.bytes,0),error:null}
 constructor(readonly root:string,readonly runtimeRoot:string,private changed:()=>void,private options:{fetch?:typeof fetch;catalog?:typeof catalog;verifyRuntime?:(signal?:AbortSignal)=>Promise<unknown>;freeBytes?:()=>Promise<number>}={}){}
 private get model(){return this.options.catalog??catalog}
 get path(){return join(this.root,this.model.revision)}
 get executable(){return join(this.runtimeRoot,'daemonlet-voice-engine')}
 snapshot(){return {...this.status}}
 private update(value:Partial<VoiceInstallState>){const notify=value.phase!==undefined||value.error!==undefined||Date.now()-this.lastUpdate>150;Object.assign(this.status,value);if(notify){this.lastUpdate=Date.now();this.changed()}}
 private async runtime(signal?:AbortSignal){try{await (this.options.verifyRuntime?.(signal)??verifyRuntime(this.runtimeRoot,'darwin-arm64',{trusted:runtimeCatalog as any,signal}))}catch(e){if(signal?.aborted)throw e;throw Error('VOICE_BASE_RUNTIME')}}
 private assetIdentity(){return this.assets??=new VoiceAssetIdentity(JSON.stringify({model:this.model,runtimeCatalog,defaults}),this.options.verifyRuntime?[this.path]:[this.path,this.runtimeRoot],[...Object.entries(this.model.files).map(([name,f])=>({path:join(this.path,name),bytes:f.bytes})),{path:join(this.path,'model-receipt.json')},...(this.options.verifyRuntime?[]:[{path:join(this.runtimeRoot,'runtime-lock.json')},...Object.entries(runtimeCatalog.targets['darwin-arm64'].files).map(([name,f])=>({path:join(this.runtimeRoot,name),bytes:f.bytes}))])])}
 async identity(){try{return await this.assetIdentity().snapshot()}catch(e){this.update({installed:false});throw e}}
 async initialize(){if(!this.status.supported)return;try{const receipt=JSON.parse(await readFile(join(this.path,'model-receipt.json'),'utf8'));if(JSON.stringify(receipt)!==JSON.stringify(this.model))return;await this.assetIdentity().snapshot(false);this.status.installed=true}catch{} }
 async verify(signal?:AbortSignal){
  const info=await lstat(this.path);if(info.isSymbolicLink()||!info.isDirectory())throw Error('VOICE_BASE_CHANGED')
  for(const [name,f] of Object.entries(this.model.files)){const p=join(this.path,name),s=await lstat(p);if(!s.isFile()||s.isSymbolicLink()||s.size!==f.bytes||await digestFile(p,signal)!==f.sha256)throw Error('VOICE_BASE_CHANGED')}
  return this.path
 }
 ready():Promise<string>{
  if(this.verifying)return this.verifying
  const controller=this.verifyController=new AbortController()
  const task=this.verifying=(async()=>{try{await this.runtime(controller.signal);const path=await this.verify(controller.signal);this.update({installed:true});return path}catch(e){if(!controller.signal.aborted)this.update({installed:false});throw e}})().finally(()=>{if(this.verifying===task){this.verifying=null;this.verifyController=null}})
  return task
 }
 async cancelVerification(){this.verifyController?.abort();await this.verifying?.catch(()=>{})}
 async install(){
  if(this.operation)return this.operation
  if(!this.status.supported)throw Error('VOICE_BASE_UNSUPPORTED')
  await this.cancelVerification();this.assets?.invalidate()
  const controller=this.controller=new AbortController()
  const task=this.operation=this.download(controller.signal)
  try{await task;this.update({installed:true,phase:'idle',bytes:this.status.total,error:null})}
  catch(e){this.update({phase:'idle',error:controller.signal.aborted?null:e instanceof Error&&/^VOICE_[A-Z_]+$/.test(e.message)?e.message:'VOICE_DOWNLOAD_FAILED'});if(!controller.signal.aborted)throw e}
  finally{this.controller=null;this.operation=null}
 }
 async cancel(){this.controller?.abort();await Promise.allSettled([this.operation,this.cancelVerification()]);this.assets?.close()}
 private async download(signal:AbortSignal){
  await this.runtime(signal);await mkdir(this.root,{recursive:true,mode:0o700})
  if((await lstat(this.root)).isSymbolicLink())throw Error('VOICE_BASE_CHANGED')
  const stage=this.path+'.download';await mkdir(stage,{recursive:true,mode:0o700});if((await lstat(stage)).isSymbolicLink())throw Error('VOICE_BASE_CHANGED')
  const total=Object.values(this.model.files).reduce((n,f)=>n+f.bytes,0);this.update({phase:'downloading',bytes:0,total,error:null})
  let completed=0
  for(const [name,file] of Object.entries(this.model.files)){
   signal.throwIfAborted();const partial=join(stage,name);let offset=0
   try{const s=await lstat(partial);if(!s.isFile()||s.isSymbolicLink())throw Error('VOICE_BASE_CHANGED');offset=s.size}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e}
   if(offset>file.bytes){await rm(partial);offset=0}
   const disk=await statfs(this.root),free=this.options.freeBytes?await this.options.freeBytes():disk.bavail*disk.bsize
   if(free<total-completed-offset+256*1024**2)throw Error('VOICE_DISK_SPACE')
   this.update({phase:'downloading',bytes:completed+offset})
   if(offset<file.bytes){
    const response=await(this.options.fetch??fetch)(`https://huggingface.co/${this.model.repo}/resolve/${this.model.revision}/${name}`,{signal,headers:offset?{Range:`bytes=${offset}-`}:{}})
    if(response.status===401||response.status===403)throw Error('VOICE_DOWNLOAD_ACCESS')
    if(!response.ok||!response.body||![200,206].includes(response.status))throw Error('VOICE_DOWNLOAD_FAILED')
    if(response.status===206){const range=/^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range')||'');if(!range||Number(range[1])!==offset||Number(range[2])!==file.bytes-1||Number(range[3])!==file.bytes)throw Error('VOICE_DOWNLOAD_RANGE')}
    else offset=0
    const out=await open(partial,offset?'a':'w',0o600)
    try{for await(const bytes of streamChunks(response.body)){signal.throwIfAborted();if(offset+bytes.length>file.bytes)throw Error('VOICE_DOWNLOAD_SIZE');await out.writeFile(bytes);offset+=bytes.length;this.update({bytes:completed+offset})}await out.sync()}finally{await out.close()}
   }
   this.update({phase:'verifying'});signal.throwIfAborted()
   if(offset!==file.bytes||await digestFile(partial,signal)!==file.sha256){await rm(partial,{force:true});throw Error('VOICE_BASE_CHANGED')}
   completed+=offset
  }
  signal.throwIfAborted();await writeFile(join(stage,'model-receipt.json'),JSON.stringify(this.model)+'\n')
  // Never expose a partial installation. Preserve an older broken installation for recovery.
  let old:string|undefined
  try{await lstat(this.path);old=this.path+'.previous-'+randomUUID();await rename(this.path,old)}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e}
  try{await rename(stage,this.path)}catch(e){if(old)await rename(old,this.path);throw e}
 }
}
