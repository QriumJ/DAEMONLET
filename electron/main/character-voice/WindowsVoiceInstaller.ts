import {execFile} from 'node:child_process'
import {createHash,randomUUID} from 'node:crypto'
import {lstat,mkdir,readFile,writeFile,rename,rm,statfs,copyFile} from 'node:fs/promises'
import {join} from 'node:path'
import policy from '../../voice/runtime-windows-base.json'
import {VoiceAssetIdentity} from './VoiceAssetIdentity'
import defaults from '../../voice/base-voice-defaults.json'
import lock from '../../voice/install-windows-base.json'
import {digestFile} from '../character-chat/ModelManager'
import {safeRelative} from './VoicePackage'
import {downloadVoiceFile,type PinnedVoiceFile} from './PinnedVoiceDownload'
import type {BaseVoiceInstallation} from './VoiceBaseInstaller'
import type {VoiceInstallState,VoiceProfile} from '../../shared/character-voice-contract'
import {managedModelRemoval,trashManagedModel,type ManagedModelManifest} from './ManagedVoiceModelRemoval'
const fingerprint=createHash('sha256').update(JSON.stringify({policy,lock})).digest('hex')
export class WindowsVoiceInstaller implements BaseVoiceInstallation {
 readonly native=false
 readonly profile:VoiceProfile={id:'voxcpm2_default',version:policy.model.revision,name:'기본 음성 · VoxCPM2',fingerprint:createHash('sha256').update(JSON.stringify({fingerprint,defaults})).digest('hex'),adapterSha256:'none'}
 private assetsIdentity:VoiceAssetIdentity|null=null
 private verifying:Promise<string>|null=null
 private verifyController:AbortController|null=null
 private operation:Promise<void>|null=null
 private controller:AbortController|null=null
 private removing:Promise<void>|null=null
 private lastUpdate=0
 private status:VoiceInstallState={supported:process.platform==='win32'&&process.arch==='x64',installed:false,phase:'idle',bytes:0,total:0,error:null}
 constructor(readonly root:string,private resources:string,private changed:()=>void){this.status.total=this.assets().reduce((n,a)=>n+a.file.bytes,0)}
 private get runtime(){return join(this.root,'runtime',fingerprint)}
 get path(){return join(this.root,'models',policy.model.revision)}
 get executable(){return join(this.runtime,'python','python.exe')}
 snapshot(){return {...this.status}}
 recordModelCheck(valid:boolean){if(!valid)this.assetsIdentity?.invalidate();this.update({installed:valid,error:valid?null:'VOICE_BASE_CHANGED'})}
 private assetIdentity(){return this.assetsIdentity??=new VoiceAssetIdentity(JSON.stringify({fingerprint,defaults,resources:this.resources}),[this.path,this.runtime,this.resources],[
  ...Object.entries(policy.model.files).map(([name,f])=>({path:join(this.path,name),bytes:f.bytes})),
  {path:join(this.runtime,'install-receipt.json')},{path:this.executable},{path:join(this.runtime,'python','voice-runtime.json')},
  ...Object.keys(policy.sourceFiles).map(name=>({path:join(this.runtime,'python','Lib','site-packages','voxcpm',name)})),
  ...['worker.py','engine.py','backend.py','control.py','windows_base_worker.py','base-voice-defaults.json','runtime-windows-base.json','install-windows-base.json','install_windows_base.py'].map(name=>({path:join(this.resources,name)})),
 ])}
 async identity(){try{return await this.assetIdentity().snapshot()}catch(e){this.update({installed:false});throw e}}
 private update(value:Partial<VoiceInstallState>){const notify=value.phase!==undefined||value.error!==undefined||Date.now()-this.lastUpdate>150;Object.assign(this.status,value);if(notify){this.lastUpdate=Date.now();this.changed()}}
 private assets():Array<{name:string;file:PinnedVoiceFile}>{return [
  {name:'python.tar.gz',file:lock.python},...lock.wheels.map(f=>({name:'wheels/'+f.filename,file:f})),
  ...Object.entries(policy.sourceDownloads).map(([name,file])=>({name:'source/'+name,file})),{name:'source/VOXCPM-LICENSE',file:policy.sourceLicense},
  ...Object.entries(policy.model.files).map(([name,f])=>({name:'model/'+name,file:{...f,url:`https://huggingface.co/${policy.model.repo}/resolve/${policy.model.revision}/${name}`}})),
 ]}
 private run(command:string,args:string[],signal?:AbortSignal){return new Promise<string>((resolve,reject)=>{
  let closed=false,result:{error:Error|null;stdout:string;stderr:string}|undefined
  const finish=()=>{if(!closed||!result)return;const {error,stdout,stderr}=result;error?reject(new Error(signal?.aborted?'VOICE_INSTALL_CANCELLED':'VOICE_RUNTIME_INSTALL',{cause:stderr.slice(-8000)||error.message})):resolve(stdout)}
  const child=execFile(command,args,{signal,windowsHide:true,timeout:600000,maxBuffer:8*1024**2,env:{...process.env,PYTHONPATH:'',PYTHONNOUSERSITE:'1',PYTHONDONTWRITEBYTECODE:'1',PYTHONUTF8:'1'}},(error,stdout,stderr)=>{result={error,stdout,stderr};finish()})
  // Abort's error callback can precede process close. Never report cleanup early.
  child.once('close',()=>{closed=true;finish()})
 })}
 private async checkFile(path:string,bytes:number,sha256:string,signal?:AbortSignal){const s=await lstat(path);if(!s.isFile()||s.isSymbolicLink()||s.size!==bytes||await digestFile(path,signal)!==sha256)throw Error('VOICE_BASE_CHANGED')}
 ready(modelVerification:'full'|'installed'='full'):Promise<string>{
  if(this.removing)return Promise.reject(Error('VOICE_MODEL_REMOVAL_BUSY'))
  if(this.verifying)return this.verifying
  const controller=this.verifyController=new AbortController()
  const task=this.verifying=this.verifyReady(controller.signal,modelVerification).finally(()=>{if(this.verifying===task){this.verifying=null;this.verifyController=null}})
  return task
 }
 private async verifyReady(signal:AbortSignal,modelVerification:'full'|'installed'){
  try{
   const receipt=JSON.parse(await readFile(join(this.runtime,'install-receipt.json'),'utf8'));if(receipt.fingerprint!==fingerprint)throw Error('VOICE_BASE_CHANGED')
   await this.run(this.executable,['-I','-B',join(this.resources,'install_windows_base.py'),'--downloads',join(this.root,'downloads'),'--policy',join(this.resources,'runtime-windows-base.json'),'--lock',join(this.resources,'install-windows-base.json'),'--verify','--metadata-only'],signal)
   for(const [name,f] of Object.entries(policy.model.files))if(modelVerification==='full'||! /\.(safetensors|pth|pt|bin)$/i.test(name))await this.checkFile(join(this.path,name),f.bytes,f.sha256,signal)
   await this.assetIdentity().snapshot(false)
   this.update({installed:true});return this.path
  }catch(e){if(!signal.aborted)this.update({installed:false});throw e}
 }
 async initialize(){if(!this.status.supported)return;try{const receipt=JSON.parse(await readFile(join(this.runtime,'install-receipt.json'),'utf8'));if(receipt.fingerprint!==fingerprint)return;await this.assetIdentity().snapshot(false);this.status.installed=true}catch{}}
 async cancelVerification(){this.verifyController?.abort();await this.verifying?.catch(()=>{})}
 async cancel(){const operation=this.operation;this.controller?.abort();await Promise.allSettled([operation,this.cancelVerification()]);if(!this.operation||this.operation===operation)this.assetsIdentity?.close()}
 install():Promise<void>{
  if(this.removing)return Promise.reject(Error('VOICE_MODEL_REMOVAL_BUSY'))
  if(this.operation)return this.operation
  if(!this.status.supported)return Promise.reject(Error('VOICE_BASE_UNSUPPORTED'))
  // Admission owns cancellation before any await or observer callback can reenter.
  const controller=this.controller=new AbortController()
  const task:Promise<void>=Promise.resolve().then(async()=>{
   this.update({phase:'preparing'})
   await this.cancelVerification()
   controller.signal.throwIfAborted()
   if(this.operation!==task)return
   this.assetsIdentity?.invalidate()
   await this.prepare(controller.signal)
   controller.signal.throwIfAborted()
   if(this.operation===task)this.update({installed:true,phase:'idle',bytes:this.status.total,error:null})
  }).catch(e=>{
   if(this.operation===task)this.update({phase:'idle',error:controller.signal.aborted?null:e instanceof Error&&/^VOICE_[A-Z_]+$/.test(e.message)?e.message:'VOICE_RUNTIME_INSTALL'})
   if(!controller.signal.aborted)throw e
  }).finally(()=>{
   if(this.operation===task){this.operation=null;if(this.controller===controller)this.controller=null}
  })
  this.operation=task
  // Snapshot is cancellable immediately; notification runs inside the owned task.
  Object.assign(this.status,{phase:'preparing',bytes:0,error:null})
  return task
 }
 private async publish(stage:string,target:string,signal:AbortSignal){signal.throwIfAborted();let old:string|undefined;await mkdir(join(target,'..'),{recursive:true});try{await lstat(target);signal.throwIfAborted();old=target+'.previous-'+randomUUID();await rename(target,old)}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e}try{signal.throwIfAborted();await rename(stage,target)}catch(e){if(old)await rename(old,target);throw e}}
 private removalManifest():ManagedModelManifest{
  const files=Object.keys(policy.model.files),matches=(receipt:any)=>receipt?.model_id===policy.model.repo&&receipt.revision===policy.model.revision&&JSON.stringify(receipt.files)===JSON.stringify(Object.fromEntries(Object.entries(policy.model.files).map(([name,file])=>[name,file.sha256])))
  return {root:this.root,id:'voxcpm2-base',engine:'voxcpm2',modelId:policy.model.repo,revision:policy.model.revision,
   directories:[{path:this.path,files:[...files,'snapshot-provenance.json'],receipt:{name:'snapshot-provenance.json',matches}},{path:join(this.root,'downloads','model'),files}]}
 }
 modelRemoval(){if(this.removing||this.operation||this.verifying)return Promise.reject(Error('VOICE_MODEL_REMOVAL_BUSY'));return managedModelRemoval(this.removalManifest())}
 removeModel(expectedPlanId:string,trashItem:(path:string)=>Promise<void>):Promise<void>{
  if(this.removing)return Promise.reject(Error('VOICE_MODEL_REMOVAL_BUSY'))
  const task=Promise.resolve().then(async()=>{await this.cancel();await trashManagedModel(this.removalManifest(),expectedPlanId,trashItem);this.assetsIdentity?.invalidate();this.update({installed:false,bytes:0,error:null})}).catch(async e=>{
   this.status.installed=false;this.assetsIdentity?.invalidate();await this.initialize().catch(()=>{});this.update({error:e instanceof Error&&/^VOICE_MODEL_REMOVAL_[A-Z_]+$/.test(e.message)?e.message:'VOICE_MODEL_REMOVAL_FAILED'});throw e
  }).finally(()=>{if(this.removing===task)this.removing=null})
  this.removing=task;return task
 }
 private async prepare(signal:AbortSignal){
  signal.throwIfAborted()
  await mkdir(this.root,{recursive:true});if((await lstat(this.root)).isSymbolicLink())throw Error('VOICE_BASE_CHANGED')
  const disk=await statfs(this.root);if(disk.bavail*disk.bsize<30*1024**3)throw Error('VOICE_DISK_SPACE')
  const downloads=join(this.root,'downloads');let completed=0;this.update({phase:'downloading',bytes:0,error:null})
  for(const asset of this.assets()){
   safeRelative(asset.name);await downloadVoiceFile(join(downloads,asset.name),asset.file,signal,bytes=>this.update({bytes:completed+bytes}));completed+=asset.file.bytes
  }
  const stage=join(this.root,'.install-'+randomUUID()),modelStage=join(this.root,'.model-'+randomUUID());await mkdir(stage);await mkdir(modelStage)
  try{
   this.update({phase:'installing'});signal.throwIfAborted()
   const tar=join(process.env.SystemRoot||'C:/Windows','System32','tar.exe'),archive=join(downloads,'python.tar.gz')
   // The archive is pinned, and its full member list is checked before extraction.
   const entries=await this.run(tar,['-tf',archive],signal)
   for(const entry of entries.trim().split(/\r?\n/)){const name=entry.replace(/\/$/,'');safeRelative(name);if(!name.startsWith('python/')&&name!=='python')throw Error('VOICE_ARCHIVE_PATH')}
   const detail=await this.run(tar,['-tvf',archive],signal);if(detail.split(/\r?\n/).some(line=>line&&!['-','d'].includes(line[0])))throw Error('VOICE_ARCHIVE_PATH')
   await this.run(tar,['-xf',archive,'-C',stage],signal)
   const python=join(stage,'python','python.exe')
   await this.run(python,['-I','-B',join(this.resources,'install_windows_base.py'),'--downloads',downloads,'--policy',join(this.resources,'runtime-windows-base.json'),'--lock',join(this.resources,'install-windows-base.json')],signal)
   await copyFile(join(downloads,'source/VOXCPM-LICENSE'),join(stage,'VOXCPM-LICENSE'))
   this.update({phase:'verifying'});signal.throwIfAborted()
   for(const [name,f] of Object.entries(policy.model.files)){await copyFile(join(downloads,'model',name),join(modelStage,name));await this.checkFile(join(modelStage,name),f.bytes,f.sha256,signal)}
   await writeFile(join(modelStage,'snapshot-provenance.json'),JSON.stringify({model_id:policy.model.repo,revision:policy.model.revision,files:Object.fromEntries(Object.entries(policy.model.files).map(([n,f])=>[n,f.sha256]))}))
   await writeFile(join(stage,'install-receipt.json'),JSON.stringify({schemaVersion:1,fingerprint}))
   signal.throwIfAborted();await this.publish(stage,this.runtime,signal);await this.publish(modelStage,this.path,signal)
  }finally{await rm(stage,{recursive:true,force:true}).catch(()=>{});await rm(modelStage,{recursive:true,force:true}).catch(()=>{})}
 }
}
