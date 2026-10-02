import {constants,type BigIntStats} from 'node:fs'
import {createHash,randomUUID} from 'node:crypto'
import {lstat,mkdir,open,readFile,readdir,realpath,rename,rm,statfs,writeFile} from 'node:fs/promises'
import {dirname,isAbsolute,join,resolve} from 'node:path'
import * as yauzl from 'yauzl'
import {isDeepStrictEqual} from 'node:util'
import {parseUniqueJson} from '../../../adapter/codex/hooks/HookJson'
import {downloadVoiceFile} from './PinnedVoiceDownload'
import {replaceFile} from '../character-chat/replaceFile'
import type {GgufRuntimeCatalog,GgufRuntimeComponent,GgufRuntimeConnection,GgufRuntimeId,GgufRuntimeInstallState} from '../../shared/windows-gguf-runtime-catalog'
export type {GgufRuntimeCatalog,GgufRuntimeConnection,GgufRuntimeId,GgufRuntimeInstallState} from '../../shared/windows-gguf-runtime-catalog'

type Options={catalog:GgufRuntimeCatalog;catalogSha256:string;layout?:'compact-v1';bundledRoot?:string;platform?:string;fetch?:typeof fetch;freeBytes?:()=>Promise<number>}
export interface WindowsGgufRuntimeInstallation {initialize():Promise<void>;snapshot():GgufRuntimeInstallState[];install(id:GgufRuntimeId):Promise<GgufRuntimeConnection|null>;repair(id:GgufRuntimeId):Promise<GgufRuntimeConnection|null>;verify(id:GgufRuntimeId):Promise<GgufRuntimeConnection>;cancel(id?:GgufRuntimeId):Promise<void>}
type Published={id:string;target:string;previous?:string;identity:BigIntStats;previousIdentity?:BigIntStats;recordPublished?:boolean;recordBefore?:string}
const ids:GgufRuntimeId[]=['qwen-cuda','qwen-vulkan','vox-cuda','vox-vulkan']
const missing=(e:unknown)=>(e as NodeJS.ErrnoException).code==='ENOENT'
const invalid=()=>Error('GGUF_RUNTIME_CHANGED')
const hash64=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)
const stamp=(s:BigIntStats)=>[s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].map(String)
const ordinary=(s:BigIntStats)=>s.isFile()&&!s.isSymbolicLink()&&s.nlink===1n
function installationError(error:unknown){
 const message=error instanceof Error?error.message:'',code=(error as NodeJS.ErrnoException|undefined)?.code
 const download:Record<string,string>={VOICE_DOWNLOAD_FAILED:'GGUF_RUNTIME_DOWNLOAD_FAILED',VOICE_DOWNLOAD_ACCESS:'GGUF_RUNTIME_DOWNLOAD_ACCESS',VOICE_DOWNLOAD_RANGE:'GGUF_RUNTIME_DOWNLOAD_RANGE',VOICE_DOWNLOAD_SIZE:'GGUF_RUNTIME_DOWNLOAD_SIZE',VOICE_BASE_CHANGED:'GGUF_RUNTIME_CHANGED'}
 const known=['GGUF_RUNTIME_ARTIFACT_PENDING','GGUF_RUNTIME_UNSUPPORTED','GGUF_RUNTIME_BUSY','GGUF_RUNTIME_CHANGED','GGUF_RUNTIME_DISK_SPACE','GGUF_RUNTIME_PATH_TOO_LONG','GGUF_RUNTIME_INSTALL_FAILED','GGUF_RUNTIME_RECOVERY','GGUF_RUNTIME_UNKNOWN','GGUF_RUNTIME_DOWNLOAD_FAILED','GGUF_RUNTIME_DOWNLOAD_ACCESS','GGUF_RUNTIME_DOWNLOAD_RANGE','GGUF_RUNTIME_DOWNLOAD_SIZE','GGUF_RUNTIME_FILESYSTEM_FAILED']
 const name=Object.hasOwn(download,message)?download[message]:known.includes(message)?message:code==='ENOSPC'?'GGUF_RUNTIME_DISK_SPACE':code==='ELOOP'?'GGUF_RUNTIME_CHANGED':code&&['EACCES','EPERM','EIO','EBUSY','EMFILE','ENFILE','ENOTDIR','EROFS','EEXIST','ENOENT'].includes(code)?'GGUF_RUNTIME_FILESYSTEM_FAILED':'GGUF_RUNTIME_INSTALL_FAILED'
 return error instanceof Error&&message===name?error:Error(name,{cause:error})
}
function safe(name:string,allowDot=false){
 if(allowDot&&name==='.')return name
 if(!name||name.length>1024||name.split('/').some(p=>!p||p==='.'||p==='..'||/[<>:"\\|?*\x00-\x1f]/.test(p)||/[. ]$/.test(p)||/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i.test(p)))throw invalid()
 return name
}
async function directory(path:string,create=false){
 if(!isAbsolute(path)||resolve(path)!==path)throw invalid()
 const parents=[];for(let p=path;;p=dirname(p)){parents.unshift(p);if(dirname(p)===p)break}
 for(const p of parents){let s;try{s=await lstat(p)}catch(e){if(!create||!missing(e))throw e;try{await mkdir(p,{mode:0o700})}catch(next){if((next as NodeJS.ErrnoException).code!=='EEXIST')throw next}s=await lstat(p)}if(!s.isDirectory()||s.isSymbolicLink()||await realpath(p)!==p)throw invalid()}
}
async function fileHash(path:string,signal?:AbortSignal){
 await directory(dirname(path));const before=await lstat(path,{bigint:true});if(!ordinary(before))throw invalid()
 const handle=await open(path,constants.O_RDONLY|(process.platform==='win32'?0:constants.O_NOFOLLOW))
 try{const first=await handle.stat({bigint:true});if(!isDeepStrictEqual(stamp(first),stamp(before)))throw invalid();const hash=createHash('sha256'),buffer=Buffer.alloc(1024*1024);let offset=0
  for(;;){signal?.throwIfAborted();const {bytesRead}=await handle.read(buffer,0,buffer.length,offset);if(!bytesRead)break;hash.update(buffer.subarray(0,bytesRead));offset+=bytesRead}
  if(!isDeepStrictEqual(stamp(first),stamp(await handle.stat({bigint:true})))||!isDeepStrictEqual(stamp(first),stamp(await lstat(path,{bigint:true}))))throw invalid()
  return {sha256:hash.digest('hex'),bytes:offset,identity:first}
 }finally{await handle.close()}
}
async function json(path:string){await directory(dirname(path));const before=await lstat(path,{bigint:true});if(!ordinary(before)||before.size>1024n*1024n)throw invalid();const text=await readFile(path,'utf8');if(!isDeepStrictEqual(stamp(before),stamp(await lstat(path,{bigint:true}))))throw invalid();let value;try{value=parseUniqueJson(text)}catch{throw invalid()}return {value,text,identity:before}}

// Archives and installed payloads are data here. No executable, interpreter,
// driver, SDK, shell, service or GPU is launched by this installer.
export class WindowsGgufRuntimeInstaller {
 private catalog:GgufRuntimeCatalog
 private states=new Map<GgufRuntimeId,GgufRuntimeInstallState>()
 private operation:{id:GgufRuntimeId;controller:AbortController;task:Promise<GgufRuntimeConnection|null>}|null=null
 private checking:{id:GgufRuntimeId;controller:AbortController;task:Promise<GgufRuntimeConnection>}|null=null
 private removing=false
 private lastUpdate=0
 constructor(readonly root:string,private changed:()=>void,private options:Options){
  this.catalog=structuredClone(options.catalog)
  if(!isAbsolute(root)||resolve(root)!==root||this.catalog.schemaVersion!==1||!hash64(options.catalogSha256)||options.layout!==undefined&&options.layout!=='compact-v1')throw invalid()
  for(const [id,c] of Object.entries(this.catalog.components)){
   if(c.id!==id||!/^[a-z][a-z0-9-]{0,63}$/.test(id)||c.archive.format!=='zip'||!hash64(c.archive.sha256)||!Number.isSafeInteger(c.archive.bytes)||c.archive.bytes<22||c.archive.bytes>4*1024**3||!c.provenance||!Object.keys(c.provenance).length||!Object.keys(c.files).length||Object.keys(c.files).length>100000)throw invalid()
   safe(c.archive.name);if(c.archive.bundledPath)safe(c.archive.bundledPath)
   if(c.archive.url){const u=new URL(c.archive.url);if(u.protocol!=='https:'||u.username||u.password||u.hash)throw invalid()}
   const names=new Set<string>();let total=0
   for(const [name,f] of Object.entries(c.files)){safe(name);if(names.has(name.toLowerCase())||!hash64(f.sha256)||!Number.isSafeInteger(f.bytes)||f.bytes<0)throw invalid();names.add(name.toLowerCase());total+=f.bytes}
   if(!Number.isSafeInteger(total)||total>4*1024**3)throw invalid()
  }
  if(Object.keys(this.catalog.runtimes).length!==4)throw invalid()
  for(const id of ids){const r=this.catalog.runtimes[id];if(!r||r.id!==id||r.engine!==(id.startsWith('qwen-')?'qwen3-tts-06b-gguf':'voxcpm2')||r.backend!==(id.endsWith('-cuda')?'CUDA0':'Vulkan0')||typeof r.available!=='boolean'||r.pythonVersion!=='3.11.15'||new Set(r.components).size!==r.components.length)throw invalid()
   if(r.available){if(!r.components.length||r.components.some(c=>!Object.hasOwn(this.catalog.components,c)))throw invalid();for(const location of [r.python,r.native,...r.dependencyDirs,...(r.receipt?[r.receipt]:[])]){if(!r.components.includes(location.component))throw invalid();safe(location.path,true)}if(!Object.hasOwn(this.catalog.components[r.python.component].files,r.python.path)||r.receipt&&!Object.hasOwn(this.catalog.components[r.receipt.component].files,r.receipt.path))throw invalid()}
   const total=r.components.reduce((n,c)=>n+(this.catalog.components[c]?.archive.bytes||0),0)
   this.states.set(id,{id,supported:(options.platform??process.platform+'-'+process.arch)==='win32-x64',available:r.available&&r.components.every(c=>!!this.component(c).archive.url),repairAvailable:r.available&&r.components.every(c=>!!this.component(c).archive.url),blockedReason:r.available&&r.components.every(c=>!!this.component(c).archive.url)?undefined:r.blockedReason||'GGUF_RUNTIME_ARTIFACT_PENDING',installed:false,verified:false,phase:'idle',bytes:0,total,error:null})
  }
 }
 snapshot(){return [...this.states.values()].map(s=>structuredClone(s))}
 private runtime(id:GgufRuntimeId){const r=this.catalog.runtimes[id];if(!r)throw Error('GGUF_RUNTIME_UNKNOWN');return r}
 private admit(id:GgufRuntimeId){const r=this.runtime(id);if(!this.states.get(id)!.supported)throw Error('GGUF_RUNTIME_UNSUPPORTED');if(!r.available)throw Error('GGUF_RUNTIME_ARTIFACT_PENDING');return r}
 private update(id:GgufRuntimeId,value:Partial<GgufRuntimeInstallState>){Object.assign(this.states.get(id)!,value);if(value.phase!==undefined||value.error!==undefined||value.installed!==undefined||value.verified!==undefined||Date.now()-this.lastUpdate>150){this.lastUpdate=Date.now();this.changed()}}
 private component(id:string){return this.catalog.components[id]}
 private target(id:string){return this.options.layout==='compact-v1'?join(this.root,'c',id,this.component(id).archive.sha256.slice(0,12)):join(this.root,'components',id,this.component(id).archive.sha256)}
 private pathsFit(id:GgufRuntimeId){return this.options.layout!=='compact-v1'||this.runtime(id).components.every(c=>Object.keys(this.component(c).files).every(name=>join(this.target(c),name).length<=259))}
 private catalogIdentity(){return {schemaVersion:1,owner:'daemonlet-managed-gguf-runtime-catalog',catalogSha256:this.options.catalogSha256,layout:'compact-v1'}}
 private async verifyCatalogIdentity(){if(this.options.layout==='compact-v1'){const saved=await json(join(this.root,'.catalog.json'));if(!isDeepStrictEqual(saved.value,this.catalogIdentity()))throw invalid();return saved}}
 private async claimCatalog(){if(this.options.layout!=='compact-v1')return;try{await this.verifyCatalogIdentity()}catch(e){if(!missing(e))throw e;if((await readdir(this.root)).length)throw invalid();await this.atomicJson(join(this.root,'.catalog.json'),this.catalogIdentity())}}
 private recordPath(id:string){return join(this.root,'component-receipts',id+'-'+this.component(id).archive.sha256+'.json')}
 private record(id:string){return {schemaVersion:1,owner:'daemonlet-managed-gguf-runtime-component',id,fingerprint:this.component(id).archive.sha256,provenance:this.component(id).provenance}}
 private activePath(id:GgufRuntimeId){return join(this.root,'active',id+'.json')}
 private active(id:GgufRuntimeId){return {schemaVersion:this.options.layout==='compact-v1'?2:1,...(this.options.layout==='compact-v1'?{layout:'compact-v1'}:{}),owner:'daemonlet-managed-gguf-runtime',id,catalogSha256:this.options.catalogSha256,components:this.runtime(id).components.map(c=>({id:c,fingerprint:this.component(c).archive.sha256}))}}
 private connection(id:GgufRuntimeId):GgufRuntimeConnection{const r=this.runtime(id),location=(v:{component:string;path:string})=>join(this.target(v.component),v.path);return {id,python:location(r.python),runtimeDir:location(r.native),...(r.receipt?{receipt:location(r.receipt)}:{}),dependencyDirs:r.dependencyDirs.map(location),managedRuntime:{root:this.root,receipt:this.activePath(id),runtimeId:id}}}
 private async ownedRecord(id:string){const saved=await json(this.recordPath(id));if(!isDeepStrictEqual(saved.value,this.record(id)))throw invalid();return saved}
 private async payload(id:string,path=this.target(id),full=true,signal?:AbortSignal,complete=true){
  await directory(path);const files=this.component(id).files,parents=new Set<string>()
  for(const name of Object.keys(files)){const parts=name.split('/');for(let i=1;i<parts.length;i++)parents.add(parts.slice(0,i).join('/'))}
  const found=new Set<string>();async function walk(current:string,prefix=''){
   for(const name of await readdir(current)){signal?.throwIfAborted();const rel=prefix+name,p=join(current,name),s=await lstat(p,{bigint:true});if(s.isSymbolicLink())throw invalid();if(s.isDirectory()){if(!parents.has(rel))throw invalid();await directory(p);await walk(p,rel+'/')}else{if(!ordinary(s)||!Object.hasOwn(files,rel))throw invalid();found.add(rel);if(complete&&s.size!==BigInt(files[rel].bytes))throw invalid();if(full){const result=await fileHash(p,signal);if(result.sha256!==files[rel].sha256||result.bytes!==files[rel].bytes)throw invalid()}}}
  }
  await walk(path);if(complete&&found.size!==Object.keys(files).length)throw invalid()
 }
 private async validate(id:GgufRuntimeId,signal?:AbortSignal,full=true){
  if(!this.pathsFit(id))throw Error('GGUF_RUNTIME_PATH_TOO_LONG')
  const marker=await this.verifyCatalogIdentity(),active=await json(this.activePath(id))
  if(!isDeepStrictEqual(active.value,this.active(id)))throw invalid()
  const metadata:Array<{path:string;saved:Awaited<ReturnType<typeof json>>}>=[{path:this.activePath(id),saved:active},...(marker?[{path:join(this.root,'.catalog.json'),saved:marker}]:[])]
  for(const c of this.runtime(id).components){signal?.throwIfAborted();metadata.push({path:this.recordPath(c),saved:await this.ownedRecord(c)});await this.payload(c,undefined,full,signal)}
  for(const dir of [this.runtime(id).native,...this.runtime(id).dependencyDirs])await directory(join(this.target(dir.component),dir.path))
  for(const {path,saved} of metadata){signal?.throwIfAborted();const after=await json(path);if(after.text!==saved.text||!isDeepStrictEqual(stamp(after.identity),stamp(saved.identity)))throw invalid()}
  return this.connection(id)
 }
 private async archivePresent(component:string){const c=this.component(component);if(c.archive.url)return true;const paths=[join(this.root,'downloads',c.archive.sha256+'.zip'),...(this.options.bundledRoot?[join(this.options.bundledRoot,c.archive.bundledPath||c.archive.name)]:[])];for(const path of paths)try{await directory(dirname(path));const s=await lstat(path,{bigint:true});if(ordinary(s)&&s.size===BigInt(c.archive.bytes))return true}catch{}return false}
 private async discover(id:GgufRuntimeId){const s=this.states.get(id)!,r=this.runtime(id);Object.assign(s,{available:false,repairAvailable:false,blockedReason:r.blockedReason||'GGUF_RUNTIME_ARTIFACT_PENDING',installed:false,verified:false,python:undefined,runtimeDir:undefined,receipt:undefined,dependencyDirs:undefined,managedRuntime:undefined,phase:'idle',bytes:0,error:null});if(!s.supported||!r.available)return
  if(!this.pathsFit(id)){s.blockedReason=s.error='GGUF_RUNTIME_PATH_TOO_LONG';return}
  try{Object.assign(s,await this.validate(id,undefined,false),{installed:true})}catch(e){if(!missing(e))s.error='GGUF_RUNTIME_CHANGED'}
  s.repairAvailable=(await Promise.all(r.components.map(c=>this.archivePresent(c)))).every(Boolean)
  const existing=await Promise.all(r.components.map(async c=>{try{await this.ownedRecord(c);await this.payload(c,undefined,false);return true}catch{return false}}))
  s.available=s.repairAvailable||existing.every(Boolean);if(s.available)s.blockedReason=undefined
 }
 async initialize(){for(const id of ids)await this.discover(id)}
 verify(id:GgufRuntimeId):Promise<GgufRuntimeConnection>{
  try{this.admit(id)}catch(e){return Promise.reject(e)}
  if(this.operation||this.removing)return Promise.reject(Error('GGUF_RUNTIME_BUSY'))
  if(this.checking)return this.checking.id===id?this.checking.task:Promise.reject(Error('GGUF_RUNTIME_BUSY'))
  const controller=new AbortController(),task=Promise.resolve().then(async()=>{this.update(id,{phase:'verifying',error:null});const connection=await this.validate(id,controller.signal);controller.signal.throwIfAborted();this.update(id,{...connection,installed:true,verified:true,available:true,blockedReason:undefined,phase:'idle'});return connection}).catch(async e=>{await this.discover(id);this.update(id,{error:controller.signal.aborted?null:e instanceof Error&&e.message==='GGUF_RUNTIME_PATH_TOO_LONG'?e.message:'GGUF_RUNTIME_CHANGED'});throw e}).finally(()=>{if(this.checking?.task===task)this.checking=null})
  this.checking={id,controller,task};return task
 }
 install(id:GgufRuntimeId){return this.begin(id,false)}
 repair(id:GgufRuntimeId){return this.begin(id,true)}
 private begin(id:GgufRuntimeId,repair:boolean):Promise<GgufRuntimeConnection|null>{
  try{this.admit(id)}catch(e){return Promise.reject(e)}
  if(this.removing||this.checking)return Promise.reject(Error('GGUF_RUNTIME_BUSY'))
  if(this.operation)return this.operation.id===id?this.operation.task:Promise.reject(Error('GGUF_RUNTIME_BUSY'))
  const controller=new AbortController(),task=Promise.resolve().then(()=>this.setup(id,controller.signal,repair)).catch(async e=>{await this.discover(id);const error=installationError(e),cancelled=controller.signal.aborted&&error.message!=='GGUF_RUNTIME_RECOVERY';this.update(id,{error:cancelled?null:error.message});if(cancelled)return null;throw error}).finally(()=>{if(this.operation?.task===task)this.operation=null})
  this.operation={id,controller,task};Object.assign(this.states.get(id)!,{phase:'preparing',bytes:0,error:null});return task
 }
 async cancel(id?:GgufRuntimeId){const op=this.operation,check=this.checking;if(op&&(!id||op.id===id))op.controller.abort();if(check&&(!id||check.id===id))check.controller.abort();await Promise.allSettled([op&&(!id||op.id===id)?op.task:undefined,check&&(!id||check.id===id)?check.task:undefined])}
 private async atomicJson(path:string,value:unknown){await directory(dirname(path),true);try{if(!isDeepStrictEqual((await json(path)).value,value))throw invalid()}catch(e){if(!missing(e))throw e}const temporary=join(dirname(path),'.write-'+randomUUID());await writeFile(temporary,JSON.stringify(value)+'\n',{flag:'wx',mode:0o600});try{await replaceFile(temporary,path)}finally{await rm(temporary,{force:true})}}
 private async archive(id:string,signal:AbortSignal,progress:(n:number)=>void){
  const c=this.component(id),path=join(this.root,'downloads',c.archive.sha256+'.zip');await directory(dirname(path),true)
  let bundle:string|undefined;if(this.options.bundledRoot){const source=join(this.options.bundledRoot,c.archive.bundledPath||c.archive.name);try{await directory(this.options.bundledRoot);const result=await fileHash(source,signal);if(result.bytes!==c.archive.bytes||result.sha256!==c.archive.sha256)throw invalid();bundle=source}catch(e){if(!missing(e))throw e}}
  if(bundle){
   // The same guarded downloader handles pinned, resumable bytes from the local
   // archive. No HTTP request is made when a valid bundled archive is present.
   const source=bundle
   await downloadVoiceFile(path,{url:'https://bundled.invalid/'+c.archive.name,bytes:c.archive.bytes,sha256:c.archive.sha256},signal,progress,async(_url,init)=>{
    const range=new Headers(init?.headers).get('Range'),offset=range?Number(/^bytes=(\d+)-$/.exec(range)?.[1]):0
    const handle=await open(source,constants.O_RDONLY|(process.platform==='win32'?0:constants.O_NOFOLLOW)),before=await handle.stat({bigint:true});if(!ordinary(before)){await handle.close();throw invalid()}
    let position=offset,closed=false;const close=async()=>{if(!closed){closed=true;await handle.close()}}
    return new Response(new ReadableStream<Uint8Array>({async pull(controller){try{signal.throwIfAborted();const b=Buffer.alloc(128*1024),{bytesRead}=await handle.read(b,0,b.length,position);if(!bytesRead){if(!isDeepStrictEqual(stamp(before),stamp(await handle.stat({bigint:true}))))throw invalid();await close();controller.close();return}position+=bytesRead;controller.enqueue(b.subarray(0,bytesRead))}catch(e){await close();controller.error(e)}},async cancel(){await close()}}),{status:range?206:200,headers:range?{'content-range':`bytes ${offset}-${c.archive.bytes-1}/${c.archive.bytes}`}:{}})
   })
  }else if(c.archive.url)await downloadVoiceFile(path,{url:c.archive.url,bytes:c.archive.bytes,sha256:c.archive.sha256},signal,progress,this.options.fetch)
  else {try{const h=await fileHash(path,signal);if(h.bytes!==c.archive.bytes||h.sha256!==c.archive.sha256)throw invalid()}catch(e){if(missing(e))throw Error('GGUF_RUNTIME_ARTIFACT_PENDING');throw e}}
  const h=await fileHash(path,signal);if(h.bytes!==c.archive.bytes||h.sha256!==c.archive.sha256)throw invalid();return path
 }
 private async extract(id:string,archive:string,stage:string,signal:AbortSignal){
  await directory(stage,true);const c=this.component(id),allowed=c.files,parents=new Set<string>();for(const name of Object.keys(allowed)){const parts=name.split('/');for(let i=1;i<parts.length;i++)parents.add(parts.slice(0,i).join('/'))}
  const zip=await new Promise<yauzl.ZipFile>((yes,no)=>yauzl.open(archive,{lazyEntries:true,autoClose:false,strictFileNames:true,validateEntrySizes:true},(e,z)=>e||!z?no(e||invalid()):yes(z))),seen=new Set<string>(),found=new Set<string>()
  let active:Promise<void>|undefined,reject!:(e:unknown)=>void;const aborted=()=>reject(signal.reason||invalid())
  try{await new Promise<void>((yes,no)=>{reject=no;zip.on('error',no);zip.on('end',()=>found.size===Object.keys(allowed).length?yes():no(invalid()));zip.on('entry',(entry:yauzl.Entry)=>{active=(async()=>{
    signal.throwIfAborted();const dir=entry.fileName.endsWith('/'),name=safe(dir?entry.fileName.slice(0,-1):entry.fileName),fold=name.toLowerCase(),mode=entry.externalFileAttributes>>>16,type=mode&0xf000
    if(seen.has(fold)||entry.isEncrypted()||type!==0&&type!==(dir?0x4000:0x8000)||entry.generalPurposeBitFlag&1)throw invalid();seen.add(fold)
    if(dir){if(!parents.has(name)||entry.uncompressedSize!==0)throw invalid();await directory(join(stage,name),true)}
    else {const f=allowed[name];if(!Object.hasOwn(allowed,name)||entry.uncompressedSize!==f.bytes)throw invalid();found.add(name);const path=join(stage,name);await directory(dirname(path),true);const out=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|(process.platform==='win32'?0:constants.O_NOFOLLOW),0o600),hash=createHash('sha256');let size=0
     try{const stream=await new Promise<import('node:stream').Readable>((resolve,reject)=>zip.openReadStream(entry,(e,s)=>e?reject(e):resolve(s)));const abort=()=>stream.destroy(Error('GGUF_RUNTIME_CANCELLED'));signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();try{for await(const chunk of stream){signal.throwIfAborted();const data=Buffer.from(chunk);size+=data.length;if(size>f.bytes)throw invalid();const named=await lstat(path,{bigint:true}),actual=await out.stat({bigint:true});if(!ordinary(actual)||!ordinary(named)||actual.dev!==named.dev||actual.ino!==named.ino)throw invalid();hash.update(data);await out.writeFile(data)}await out.sync()}finally{signal.removeEventListener('abort',abort)}}finally{await out.close()}
     if(size!==f.bytes||hash.digest('hex')!==f.sha256)throw invalid()
    }
    signal.throwIfAborted();zip.readEntry()
   })();void active.catch(no)});signal.addEventListener('abort',aborted,{once:true});if(signal.aborted)aborted();else zip.readEntry()})}finally{signal.removeEventListener('abort',aborted);zip.close();await active?.catch(()=>{})}
  await this.payload(id,stage,true,signal)
 }
 private async cleanup(id:string,path:string){await this.payload(id,path,false,undefined,false);await rm(path,{recursive:true})}
 private async setup(id:GgufRuntimeId,signal:AbortSignal,repair:boolean){
  if(!this.pathsFit(id))throw Error('GGUF_RUNTIME_PATH_TOO_LONG')
  this.update(id,{phase:'preparing',error:null});signal.throwIfAborted();await directory(this.root,true);await this.claimCatalog()
  const r=this.runtime(id),published:Published[]=[],stages:Array<{id:string;path:string}>=[];let oldActive:string|undefined,activePublished=false,committed=false
  try{oldActive=(await json(this.activePath(id))).text;if(!isDeepStrictEqual(JSON.parse(oldActive),this.active(id)))throw invalid()}catch(e){if(!missing(e))throw e}
  let completed=0
  try{
   for(const component of r.components){
    signal.throwIfAborted();let exists=false,componentRecordBefore:string|undefined
    try{const saved=await json(this.recordPath(component));if(!isDeepStrictEqual(saved.value,this.record(component)))throw invalid();componentRecordBefore=saved.text}catch(e){if(!missing(e))throw e}
    try{await lstat(this.target(component));exists=true;await this.ownedRecord(component);await this.payload(component,undefined,true,signal);completed+=this.component(component).archive.bytes;continue}catch(e){if(signal.aborted)throw e;if(exists){await this.ownedRecord(component);await this.payload(component,undefined,false,undefined,false);if(!repair)throw invalid()}else if(!missing(e))throw e}
    const c=this.component(component),expanded=Object.values(c.files).reduce((n,f)=>n+f.bytes,0),disk=await statfs(this.root),free=this.options.freeBytes?await this.options.freeBytes():disk.bavail*disk.bsize;if(free<c.archive.bytes+expanded+64*1024**2)throw Error('GGUF_RUNTIME_DISK_SPACE')
    this.update(id,{phase:'downloading'});const archive=await this.archive(component,signal,n=>this.update(id,{bytes:completed+n}));signal.throwIfAborted()
    const stage=join(this.root,'staging',component+'-'+randomUUID());stages.push({id:component,path:stage});this.update(id,{phase:'extracting'});await this.extract(component,archive,stage,signal);signal.throwIfAborted();this.update(id,{phase:'publishing'});signal.throwIfAborted()
    const target=this.target(component);await directory(dirname(target),true);let previous:string|undefined,previousIdentity:BigIntStats|undefined,recordBefore=componentRecordBefore
    if(exists){await this.ownedRecord(component);await this.payload(component,target,false,undefined,false);previous=join(dirname(target),'.previous-'+randomUUID());previousIdentity=await lstat(target,{bigint:true});await rename(target,previous)}
    try{await rename(stage,target)}catch(e){if(previous)await rename(previous,target);throw e}
    const identity=await lstat(target,{bigint:true});const publication={id:component,target,previous,identity,previousIdentity,recordBefore,recordPublished:false};published.push(publication);await this.atomicJson(this.recordPath(component),this.record(component));publication.recordPublished=true;completed+=c.archive.bytes;signal.throwIfAborted()
   }
   this.update(id,{phase:'verifying'});for(const component of r.components){await this.ownedRecord(component);await this.payload(component,undefined,true,signal)}signal.throwIfAborted()
   this.update(id,{phase:'publishing'});signal.throwIfAborted();await this.atomicJson(this.activePath(id),this.active(id));activePublished=true;signal.throwIfAborted()
   const connection=await this.validate(id,signal);signal.throwIfAborted();committed=true
   // After this verified activation checkpoint installation is committed. Late
   // cancellation cannot roll back files already cleaned; UI context guards
   // still prevent applying a result to a cancelled selection. Retire only the
   // recorded old inode, with exact-file/link guards, to avoid backup growth.
   for(const item of published)if(item.previous){const old=await lstat(item.previous,{bigint:true});if(old.dev!==item.previousIdentity!.dev||old.ino!==item.previousIdentity!.ino)throw invalid();await this.cleanup(item.id,item.previous)}
   this.update(id,{...connection,installed:true,verified:true,available:true,blockedReason:undefined,phase:'idle',bytes:this.states.get(id)!.total,error:null});return connection
  }catch(e){
   if(committed)throw e
   try{if(activePublished){if(!isDeepStrictEqual((await json(this.activePath(id))).value,this.active(id)))throw invalid();if(oldActive)await this.atomicJson(this.activePath(id),JSON.parse(oldActive));else await rm(this.activePath(id))}
    for(const item of [...published].reverse()){const now=await lstat(item.target,{bigint:true});if(now.dev!==item.identity.dev||now.ino!==item.identity.ino)throw invalid();await this.cleanup(item.id,item.target);if(item.previous)await rename(item.previous,item.target);if(item.recordPublished){if(!isDeepStrictEqual((await json(this.recordPath(item.id))).value,this.record(item.id)))throw invalid();if(item.recordBefore)await this.atomicJson(this.recordPath(item.id),JSON.parse(item.recordBefore));else await rm(this.recordPath(item.id),{force:true})}}
   }catch{throw Error('GGUF_RUNTIME_RECOVERY')}throw e
  }finally{let cleanupError:unknown;for(const stage of stages)try{await this.cleanup(stage.id,stage.path)}catch(e){if(!missing(e))cleanupError=e}if(cleanupError)throw Error('GGUF_RUNTIME_RECOVERY',{cause:cleanupError})}
 }
 // Deactivation trashes only this backend's active receipt. Cached immutable
 // components (including shared Python/VC/CUDA) are deliberately preserved.
 async remove(id:GgufRuntimeId,trashItem:(path:string)=>Promise<void>){
  this.admit(id);if(this.removing||this.operation||this.checking)throw Error('GGUF_RUNTIME_BUSY');this.removing=true
  const from=this.activePath(id),to=join(dirname(from),'.remove-'+id+'-'+randomUUID()+'.json')
  try{if(!isDeepStrictEqual((await json(from)).value,this.active(id)))throw invalid();await rename(from,to);try{if(!isDeepStrictEqual((await json(to)).value,this.active(id)))throw invalid();await trashItem(to)}catch(e){try{await lstat(to);try{await lstat(from);throw invalid()}catch(check){if(!missing(check))throw check}await rename(to,from)}catch(restore){if(!missing(restore))throw Error('GGUF_RUNTIME_RECOVERY')}throw e}}
  finally{this.removing=false;await this.discover(id);this.changed()}
 }
}
