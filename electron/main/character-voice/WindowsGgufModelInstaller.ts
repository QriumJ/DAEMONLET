import {createHash} from 'node:crypto'
import {lstat,mkdir,open,readFile,readdir,realpath,rename,statfs,writeFile} from 'node:fs/promises'
import {dirname,isAbsolute,join,resolve} from 'node:path'
import {GGUF_MODEL_CATALOG,type GgufModelCatalog,type GgufModelCatalogEntry,type GgufModelId,type GgufModelInstallState} from '../../shared/windows-gguf-model-catalog'
import {digestFile} from '../character-chat/ModelManager'
import {downloadVoiceFile} from './PinnedVoiceDownload'
import {managedModelRemoval,trashManagedModel,type ManagedModelManifest,type ManagedVoiceModelRemoval} from './ManagedVoiceModelRemoval'

export type GgufModelConnection={id:GgufModelId;model:string}
export interface WindowsGgufModelInstallation {snapshot():GgufModelInstallState[];initialize():Promise<void>;install(id:GgufModelId):Promise<GgufModelConnection|null>;cancel():Promise<void>;verify(id:GgufModelId):Promise<string>;modelRemoval(id:GgufModelId):Promise<ManagedVoiceModelRemoval|null>;removeModel(id:GgufModelId,planId:string,trashItem:(path:string)=>Promise<void>):Promise<void>}
type Options={platform?:string;catalog?:GgufModelCatalog;fetch?:typeof fetch;freeBytes?:()=>Promise<number>}
const changed=()=>Error('GGUF_MODEL_CHANGED')
const missing=(e:unknown)=>(e as NodeJS.ErrnoException).code==='ENOENT'
const receiptName='model-receipt.json',ownerName='ownership.json'
const stamp=(s:Awaited<ReturnType<typeof lstat>>)=>[String(s.dev),String(s.ino),s.size,s.mtimeMs,s.ctimeMs]

// Model-only installer. It never starts Python, a native executable or a GPU.
// All writes stay inside a fingerprinted app-owned public-model bundle; interrupted
// downloads remain resumable and only fully hashed bundles become visible.
export class WindowsGgufModelInstaller implements WindowsGgufModelInstallation {
 private catalog:GgufModelCatalog
 private states=new Map<GgufModelId,GgufModelInstallState>()
 private operation:Promise<GgufModelConnection|null>|null=null
 private operationId:GgufModelId|null=null
 private controller:AbortController|null=null
 private verification=new Map<GgufModelId,{task:Promise<string>;controller:AbortController}>()
 private removing=false
 private lastUpdate=0
 constructor(readonly root:string,private changed:()=>void,private options:Options={}){
  this.catalog=options.catalog??GGUF_MODEL_CATALOG
  const supported=(options.platform??process.platform+'-'+process.arch)==='win32-x64'
  for(const model of this.catalog.models){
   if(this.states.has(model.id)||!['qwen3-tts-06b-gguf','voxcpm2-gguf-f16'].includes(model.id)||!model.files.length||!Number.isSafeInteger(model.totalBytes)||model.totalBytes!==model.files.reduce((sum,f)=>sum+f.bytes,0)||!Number.isSafeInteger(model.minimumFreeBytes)||model.minimumFreeBytes<model.totalBytes)throw changed()
   const names=new Set<string>()
   for(const file of model.files){if(!/^[A-Za-z0-9][A-Za-z0-9._-]*\.gguf$/.test(file.name)||names.has(file.name)||!Number.isSafeInteger(file.bytes)||file.bytes<8||!/^[a-f0-9]{64}$/.test(file.sha256)||file.url!==`https://huggingface.co/${model.repository}/resolve/${model.revision}/${file.name}`)throw changed();names.add(file.name)}
   if(!/^[a-f0-9]{40}$/.test(model.revision)||!Number.isSafeInteger(model.minimumFreeBytes-model.totalBytes))throw changed()
   this.states.set(model.id,{id:model.id,supported,installed:false,verified:false,phase:'idle',bytes:0,total:model.totalBytes,error:null,verification:'sha256',runtimeIncluded:false})
  }
 }
 snapshot(){return [...this.states.values()].map(s=>({...s}))}
 private model(id:GgufModelId){const value=this.catalog.models.find(m=>m.id===id);if(!value)throw Error('GGUF_MODEL_UNKNOWN');return value}
 private update(id:GgufModelId,value:Partial<GgufModelInstallState>){const state=this.states.get(id);if(!state)throw Error('GGUF_MODEL_UNKNOWN');const notify=value.phase!==undefined||value.error!==undefined||Date.now()-this.lastUpdate>150;Object.assign(state,value);if(notify){this.lastUpdate=Date.now();this.changed()}}
 private fingerprint(model:GgufModelCatalogEntry){return createHash('sha256').update(JSON.stringify({schemaVersion:1,model})).digest('hex')}
 private bundle(model:GgufModelCatalogEntry){return join(this.root,model.id,this.fingerprint(model))}
 private target(model:GgufModelCatalogEntry){return join(this.bundle(model),'model')}
 private stage(model:GgufModelCatalogEntry){return join(this.bundle(model),'download')}
 private receipt(model:GgufModelCatalogEntry){return {schemaVersion:1,owner:'daemonlet-managed-public-gguf-model',scope:'public-base',id:model.id,fingerprint:this.fingerprint(model),repository:model.repository,revision:model.revision,files:model.files.map(({name,bytes,sha256})=>({name,bytes,sha256}))}}
 private matches(model:GgufModelCatalogEntry,value:unknown){return JSON.stringify(value)===JSON.stringify(this.receipt(model))}
 private async directory(path:string,create=false){
  if(!isAbsolute(path)||resolve(path)!==path)throw changed()
  const parents=[];for(let p=path;;p=dirname(p)){parents.unshift(p);if(dirname(p)===p)break}
  for(const p of parents){let s;try{s=await lstat(p)}catch(e){if(!create||!missing(e))throw e;try{await mkdir(p,{mode:0o700})}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e}s=await lstat(p)}if(!s.isDirectory()||s.isSymbolicLink()||await realpath(p)!==p)throw changed()}
 }
 private async readReceipt(path:string,model:GgufModelCatalogEntry){
  await this.directory(dirname(path));const before=await lstat(path)
  if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size>1024*1024)throw changed()
  let value;try{value=JSON.parse(await readFile(path,'utf8'))}catch{throw changed()}
  if(!this.matches(model,value)||JSON.stringify(stamp(before))!==JSON.stringify(stamp(await lstat(path))))throw changed()
 }
 private async ensureBundle(model:GgufModelCatalogEntry){
  const bundle=this.bundle(model);await this.directory(bundle,true)
  try{await this.readReceipt(join(bundle,ownerName),model)}catch(e){if(!missing(e))throw e;if((await readdir(bundle)).length)throw changed();await writeFile(join(bundle,ownerName),JSON.stringify(this.receipt(model))+'\n',{flag:'wx',mode:0o600});await this.readReceipt(join(bundle,ownerName),model)}
 }
 private async audit(path:string,model:GgufModelCatalogEntry,full:boolean,signal?:AbortSignal,partial=false){
  await this.directory(path);await this.readReceipt(join(path,receiptName),model)
  const allowed=new Set([receiptName,...model.files.map(f=>f.name)])
  for(const name of await readdir(path)){const s=await lstat(join(path,name));if(!allowed.has(name)||!s.isFile()||s.isSymbolicLink()||s.nlink!==1)throw changed()}
  for(const file of model.files){
   signal?.throwIfAborted();const name=join(path,file.name);let before
   try{before=await lstat(name)}catch(e){if(partial&&missing(e))continue;throw e}
   if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||!partial&&before.size!==file.bytes||partial&&before.size>file.bytes)throw changed()
   if(full){
    if(await digestFile(name,signal)!==file.sha256)throw changed()
    const handle=await open(name,'r');try{const magic=Buffer.alloc(4);if((await handle.read(magic,0,4,0)).bytesRead!==4||magic.toString('ascii')!=='GGUF')throw changed()}finally{await handle.close()}
   }
   if(JSON.stringify(stamp(before))!==JSON.stringify(stamp(await lstat(name))))throw changed()
  }
 }
 private async discover(model:GgufModelCatalogEntry){
  const state=this.states.get(model.id)!
  Object.assign(state,{installed:false,verified:false,modelPath:undefined,phase:'idle',bytes:0,error:null})
  if(!state.supported)return
  try{await this.readReceipt(join(this.bundle(model),ownerName),model);await this.audit(this.target(model),model,false);Object.assign(state,{installed:true,modelPath:this.target(model),bytes:model.totalBytes})}catch(e){if(!missing(e))state.error='GGUF_MODEL_CHANGED'}
 }
 async initialize(){for(const model of this.catalog.models)await this.discover(model)}
 install(id:GgufModelId):Promise<GgufModelConnection|null>{
  const model=this.model(id)
  if(this.removing)return Promise.reject(Error('VOICE_MODEL_REMOVAL_BUSY'))
  if(!this.states.get(id)?.supported)return Promise.reject(Error('GGUF_MODEL_UNSUPPORTED'))
  if(this.operation)return this.operationId===id?this.operation:Promise.reject(Error('GGUF_MODEL_BUSY'))
  const controller=this.controller=new AbortController();this.operationId=id
  const task:Promise<GgufModelConnection|null>=Promise.resolve().then(async()=>{
   this.update(id,{phase:'preparing',error:null});controller.signal.throwIfAborted()
   await this.cancelVerification(id);controller.signal.throwIfAborted()
   await this.ensureBundle(model);controller.signal.throwIfAborted()
   let exists=false;try{await lstat(this.target(model));exists=true}catch(e){if(!missing(e))throw e}
   if(exists){this.update(id,{phase:'verifying'});try{await this.audit(this.target(model),model,true,controller.signal)}catch(e){if(!controller.signal.aborted)this.update(id,{installed:false,verified:false,modelPath:undefined});throw e}}
   else await this.download(model,controller.signal)
   controller.signal.throwIfAborted();return {id,model:this.target(model)}
  }).then(value=>{if(this.operation===task)this.update(id,{installed:true,verified:true,modelPath:value.model,phase:'idle',bytes:model.totalBytes,error:null});return value}).catch(e=>{
   if(this.operation===task)this.update(id,{phase:'idle',error:controller.signal.aborted?null:e instanceof Error&&/^(GGUF_MODEL_|VOICE_DOWNLOAD_|VOICE_DISK_SPACE|VOICE_BASE_CHANGED)[A-Z_]*$/.test(e.message)?e.message:'GGUF_MODEL_INSTALL_FAILED'})
   if(controller.signal.aborted)return null;throw e
  }).finally(()=>{if(this.operation===task){this.operation=null;this.operationId=null;if(this.controller===controller)this.controller=null}})
  this.operation=task;Object.assign(this.states.get(id)!,{phase:'preparing',bytes:0,error:null});return task
 }
 async cancel(){const task=this.operation;this.controller?.abort();const checking=[...this.verification.values()];for(const value of checking)value.controller.abort();await Promise.allSettled([task,...checking.map(value=>value.task)])}
 private async cancelVerification(id:GgufModelId){const value=this.verification.get(id);value?.controller.abort();await value?.task.catch(()=>{})}
 verify(id:GgufModelId):Promise<string>{
  const model=this.model(id)
  if(!this.states.get(id)?.supported)return Promise.reject(Error('GGUF_MODEL_UNSUPPORTED'))
  if(this.removing)return Promise.reject(Error('VOICE_MODEL_REMOVAL_BUSY'))
  if(this.operation)return Promise.reject(Error('GGUF_MODEL_BUSY'))
  const previous=this.verification.get(id);if(previous)return previous.task
  const controller=new AbortController()
  const task=Promise.resolve().then(async()=>{this.update(id,{phase:'verifying',error:null});controller.signal.throwIfAborted();await this.readReceipt(join(this.bundle(model),ownerName),model);await this.audit(this.target(model),model,true,controller.signal);controller.signal.throwIfAborted();this.update(id,{installed:true,verified:true,modelPath:this.target(model),phase:'idle',bytes:model.totalBytes});return this.target(model)}).catch(e=>{this.update(id,{verified:false,...controller.signal.aborted?{}:{installed:false,modelPath:undefined},phase:'idle',error:controller.signal.aborted?null:'GGUF_MODEL_CHANGED'});throw e}).finally(()=>{if(this.verification.get(id)?.task===task)this.verification.delete(id)})
  this.verification.set(id,{task,controller});return task
 }
 private async download(model:GgufModelCatalogEntry,signal:AbortSignal){
  const stage=this.stage(model);await this.directory(stage,true)
  try{await this.readReceipt(join(stage,receiptName),model)}catch(e){if(!missing(e))throw e;if((await readdir(stage)).length)throw changed();await writeFile(join(stage,receiptName),JSON.stringify(this.receipt(model))+'\n',{flag:'wx',mode:0o600})}
  await this.audit(stage,model,false,signal,true)
  let retained=0;for(const file of model.files){try{retained+=(await lstat(join(stage,file.name))).size}catch(e){if(!missing(e))throw e}}
  const disk=await statfs(this.root),free=this.options.freeBytes?await this.options.freeBytes():disk.bavail*disk.bsize
  if(free<model.minimumFreeBytes-retained)throw Error('VOICE_DISK_SPACE')
  let completed=0;this.update(model.id,{phase:'downloading',bytes:0})
  for(const file of model.files){
   signal.throwIfAborted();await this.directory(stage);await this.readReceipt(join(this.bundle(model),ownerName),model);await this.audit(stage,model,false,signal,true)
   await downloadVoiceFile(join(stage,file.name),file,signal,bytes=>this.update(model.id,{bytes:completed+bytes}),this.options.fetch)
   signal.throwIfAborted();completed+=file.bytes
  }
  this.update(model.id,{phase:'verifying'});await this.audit(stage,model,true,signal);signal.throwIfAborted()
  this.update(model.id,{phase:'publishing'});await this.directory(this.bundle(model));await this.readReceipt(join(this.bundle(model),ownerName),model)
  try{await lstat(this.target(model));throw changed()}catch(e){if(!missing(e))throw e}
  signal.throwIfAborted();const identity=await lstat(stage);await rename(stage,this.target(model))
  try{await this.audit(this.target(model),model,true,signal);signal.throwIfAborted()}
  catch(e){
   // Cancellation never leaves a newly published bundle announced as complete.
   // Do not roll back a path whose inode was replaced by an unrelated writer.
   const now=await lstat(this.target(model));if(now.dev!==identity.dev||now.ino!==identity.ino)throw Error('GGUF_MODEL_RECOVERY')
   try{await lstat(stage);throw Error('GGUF_MODEL_RECOVERY')}catch(check){if(!missing(check))throw check}
   await rename(this.target(model),stage);throw e
  }
 }
 private manifest(model:GgufModelCatalogEntry):ManagedModelManifest{
  return {root:this.root,id:model.id,engine:model.engine,modelId:model.repository,revision:model.revision,ownership:[{path:join(this.bundle(model),ownerName),matches:value=>this.matches(model,value)}],directories:[this.target(model),this.stage(model)].map(path=>({path,files:[receiptName,...model.files.map(f=>f.name)],receipt:{name:receiptName,matches:value=>this.matches(model,value)}}))}
 }
 async modelRemoval(id:GgufModelId){
  const model=this.model(id);if(this.removing||this.operation||this.verification.size)throw Error('VOICE_MODEL_REMOVAL_BUSY')
  try{await lstat(this.bundle(model))}catch(e){if(missing(e))return null;throw e}
  return managedModelRemoval(this.manifest(model))
 }
 async removeModel(id:GgufModelId,planId:string,trashItem:(path:string)=>Promise<void>){
  const model=this.model(id);if(this.removing)throw Error('VOICE_MODEL_REMOVAL_BUSY');this.removing=true
  try{await this.cancel();await this.cancelVerification(id);await trashManagedModel(this.manifest(model),planId,trashItem);this.update(id,{installed:false,verified:false,modelPath:undefined,phase:'idle',bytes:0,error:null})}
  catch(e){
   // The OS may trash the installed copy successfully and reject the partial
   // copy. Reinspect only our model receipts/files; never announce the vanished
   // model as installed or run/download anything to repair it implicitly.
   await this.discover(model)
   this.update(id,{error:e instanceof Error&&/^VOICE_MODEL_REMOVAL_[A-Z_]+$/.test(e.message)?e.message:'VOICE_MODEL_REMOVAL_FAILED'})
   throw e
  }finally{this.removing=false}
 }
}
