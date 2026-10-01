import {mkdir,open,rename,rm,lstat,readdir} from 'node:fs/promises'
import {join,dirname} from 'node:path'
import {randomUUID,createHash} from 'node:crypto'
import {Worker} from 'node:worker_threads'
import type {ReferenceVoiceProfile} from '../../shared/character-voice-contract'
import {REFERENCE_POLICY as policy,canonicalHeaderMatches,type ReferenceAudio} from './ReferenceWav'
import {boundedReferenceRead,ordinaryPath} from './ReferenceFiles'
import {replaceFile} from '../character-chat/replaceFile'

const keyPattern=/^wav-[a-f0-9-]{36}@[a-f0-9]{64}$/
const hashPattern=/^[a-f0-9]{64}$/
const digest=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex')
export const referenceKey=(key:string)=>keyPattern.test(key)
export function referenceName(name:unknown){if(typeof name!=='string'||!name.trim()||name.trim().length>80||/[\x00-\x1f\x7f]/.test(name))throw Error('VOICE_REFERENCE_NAME');return name.trim()}
type Manifest={schemaVersion:1;kind:'wav-reference';id:string;revision:string;displayName:string;reference:'reference.wav';sourceSha256:string;referenceSha256:string;audio:ReferenceAudio;preprocessingVersion:string;modelContract:string;createdAt:string}
type Entry={id:string;revision:string;name:string}
export type ReferenceCondition={kind:'wav-reference';path:string;sha256:string;preprocessingVersion:string;fingerprint:string;sampleRate:number;samples:number}
type Converted={sourceSha256:string;referenceSha256:string;audio:ReferenceAudio}
export type ReferenceConverter=(source:string,staging:string,signal:AbortSignal)=>Promise<Converted>
export function workerReferenceConverter(workerPath:string):ReferenceConverter{return(source,staging,signal)=>new Promise((resolve,reject)=>{
 if(signal.aborted){reject(Error('VOICE_REFERENCE_CANCELLED'));return}
 const worker=new Worker(workerPath,{workerData:{source,staging},resourceLimits:{maxOldGenerationSizeMb:64,maxYoungGenerationSizeMb:16,stackSizeMb:4}});let settled=false
 const finish=async(error?:Error,value?:Converted)=>{if(settled)return;settled=true;clearTimeout(timer);signal.removeEventListener('abort',abort);await worker.terminate();if(error)reject(error);else resolve(value!)}
 const abort=()=>{void finish(Error('VOICE_REFERENCE_CANCELLED'))},timer=setTimeout(()=>{void finish(Error('VOICE_REFERENCE_TIMEOUT'))},20_000)
 signal.addEventListener('abort',abort,{once:true});worker.once('error',()=>{void finish(Error('VOICE_REFERENCE_IMPORT'))});worker.once('exit',()=>{if(!settled)void finish(Error('VOICE_REFERENCE_IMPORT'))})
 worker.once('message',v=>{if(v?.ok===true)void finish(undefined,v);else void finish(Error(typeof v?.error==='string'&&/^VOICE_REFERENCE_[A-Z_]+$/.test(v.error)?v.error:'VOICE_REFERENCE_IMPORT'))})
 if(signal.aborted)abort()
})}
export class ReferenceProfileStore{
 private entries:Entry[]=[]
 private profiles:ReferenceVoiceProfile[]=[]
 private manifests=new Map<string,Manifest>()
 private verified=new Map<string,{identity:string;condition:ReferenceCondition}>()
 private serial:Promise<unknown>=Promise.resolve()
 private registryError=false
 constructor(readonly root:string,private convert:ReferenceConverter=workerReferenceConverter(join(__dirname,'reference-import-worker.cjs')),private limits={maxProfiles:policy.maxProfiles,maxStoreBytes:policy.maxStoreBytes}){}
 list(){return structuredClone(this.profiles)}
 private location(key:string){if(!referenceKey(key))throw Error('VOICE_REFERENCE_PROFILE');const [id,revision]=key.split('@');return join(this.root,'profiles',id,revision)}
 private fingerprint(m:Manifest){return digest(JSON.stringify({kind:m.kind,id:m.id,revision:m.revision,referenceSha256:m.referenceSha256,preprocessingVersion:m.preprocessingVersion,modelContract:m.modelContract}))}
 private dto(m:Manifest,name:string):ReferenceVoiceProfile{return{kind:'wav-reference',id:m.id,version:m.revision,name,fingerprint:this.fingerprint(m),referenceSha256:m.referenceSha256,reference:m.audio}}
 private unavailable(e:Entry):ReferenceVoiceProfile{return{kind:'wav-reference',id:e.id,version:e.revision,name:e.name,fingerprint:'unavailable',referenceSha256:e.revision,reference:{durationMs:0,sampleRate:0,channels:1,encoding:'pcm16',samples:0,bytes:0},error:'VOICE_REFERENCE_UNAVAILABLE'}}
 private transaction<T>(work:()=>Promise<T>){const task=this.serial.then(work);this.serial=task.catch(()=>{});return task}
 private async commit(entries:Entry[],check=()=>{}){
  await ordinaryPath(this.root,true);const temp=join(this.root,'registry-'+randomUUID()+'.tmp'),f=await open(temp,'wx',0o600)
  try{await f.writeFile(JSON.stringify({schemaVersion:1,entries})+'\n');await f.sync()}finally{await f.close()}
  try{check();await replaceFile(temp,join(this.root,'registry.json'));this.entries=entries}finally{await rm(temp,{force:true}).catch(()=>{})}
 }
 async initialize(){
  await mkdir(this.root,{recursive:true});await ordinaryPath(this.root,true)
  for(const name of ['profiles','staging']){await mkdir(join(this.root,name),{recursive:true});await ordinaryPath(join(this.root,name),true)}
  // Only abandoned app-owned transaction folders are removed; published data is never inferred from directory names.
  for(const e of await readdir(join(this.root,'staging'),{withFileTypes:true}))if(e.isDirectory()&&/^tx-[a-f0-9-]{36}$/.test(e.name))await rm(join(this.root,'staging',e.name),{recursive:true,force:true})
  this.profiles=[];this.manifests.clear();this.verified.clear()
  try{
   const path=join(this.root,'registry.json');const d=JSON.parse((await boundedReferenceRead(path,65536)).toString('utf8'))
   if(Object.keys(d).sort().join(',')!=='entries,schemaVersion'||d.schemaVersion!==1||!Array.isArray(d.entries)||d.entries.length>policy.maxProfiles)throw Error('VOICE_REFERENCE_STORAGE')
   const seen=new Set<string>();this.entries=d.entries.map((e:Entry)=>{const key=e.id+'@'+e.revision;if(Object.keys(e).sort().join(',')!=='id,name,revision'||!referenceKey(key)||seen.has(e.id))throw Error('VOICE_REFERENCE_STORAGE');seen.add(e.id);return{id:e.id,revision:e.revision,name:referenceName(e.name)}})
   this.registryError=false
  }catch(e){this.entries=[];this.registryError=(e as NodeJS.ErrnoException).code!=='ENOENT'}
  for(const e of this.entries){const key=e.id+'@'+e.revision;try{const m=await this.manifest(key);this.manifests.set(key,m);this.profiles.push(this.dto(m,e.name))}catch{this.profiles.push(this.unavailable(e))}}
 }
 private async manifest(key:string):Promise<Manifest>{
  const path=this.location(key);await ordinaryPath(path,true)
  const m=JSON.parse((await boundedReferenceRead(join(path,'profile.json'),8192)).toString()) as Manifest
  if(Object.keys(m).sort().join(',')!==['schemaVersion','kind','id','revision','displayName','reference','sourceSha256','referenceSha256','audio','preprocessingVersion','modelContract','createdAt'].sort().join(',')||m.schemaVersion!==1||m.kind!=='wav-reference'||m.id+'@'+m.revision!==key||m.reference!=='reference.wav'||!hashPattern.test(m.sourceSha256)||m.referenceSha256!==m.revision||m.preprocessingVersion!==policy.preprocessingVersion||m.modelContract!==policy.contract||!Number.isFinite(Date.parse(m.createdAt)))throw Error('VOICE_REFERENCE_CHANGED')
  referenceName(m.displayName)
  const a=m.audio;if(!a||Object.keys(a).sort().join(',')!=='bytes,channels,durationMs,encoding,sampleRate,samples'||!policy.sampleRates.includes(a.sampleRate)||!Number.isSafeInteger(a.samples)||a.samples<a.sampleRate*policy.minSeconds||a.samples>a.sampleRate*policy.maxSeconds||a.durationMs!==a.samples/a.sampleRate*1000||a.channels!==1||a.encoding!=='pcm16'||a.bytes!==44+a.samples*2)throw Error('VOICE_REFERENCE_CHANGED')
  const stat=await lstat(join(path,'reference.wav'));if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==a.bytes)throw Error('VOICE_REFERENCE_CHANGED')
  return m
 }
 private async identity(key:string){const dir=this.location(key);await ordinaryPath(dir,true);const result=[];for(const name of ['profile.json','reference.wav']){const p=join(dir,name);await ordinaryPath(p);const s=await lstat(p,{bigint:true});result.push([name,...(['dev','ino','size','mtimeNs','ctimeNs'] as const).map(k=>String(s[k]))])}return digest(JSON.stringify(result))}
 async resolve(key:string):Promise<ReferenceCondition>{
  if(!this.entries.some(e=>e.id+'@'+e.revision===key))throw Error('VOICE_REFERENCE_UNAVAILABLE')
  try{
   const identity=await this.identity(key),cached=this.verified.get(key);if(cached?.identity===identity)return {...cached.condition}
   const m=await this.manifest(key),path=join(this.location(key),'reference.wav'),bytes=await boundedReferenceRead(path,44+policy.maxSeconds*48000*2)
   if(digest(bytes)!==m.referenceSha256)throw Error('VOICE_REFERENCE_CHANGED')
   if(!canonicalHeaderMatches(bytes,m.audio))throw Error('VOICE_REFERENCE_CHANGED')
   if(identity!==await this.identity(key))throw Error('VOICE_REFERENCE_CHANGED')
   const condition:ReferenceCondition={kind:'wav-reference',path,sha256:m.referenceSha256,preprocessingVersion:m.preprocessingVersion,fingerprint:this.fingerprint(m),sampleRate:m.audio.sampleRate,samples:m.audio.samples}
   this.verified.set(key,{identity,condition});return {...condition}
  }catch{this.verified.delete(key);throw Error('VOICE_REFERENCE_CHANGED')}
 }
 import(source:string,name:string,signal:AbortSignal,current=()=>true){return this.transaction(async()=>{
  name=referenceName(name);if(this.registryError)throw Error('VOICE_REFERENCE_STORAGE');if(this.entries.length>=this.limits.maxProfiles)throw Error('VOICE_REFERENCE_COUNT')
  const check=()=>{if(signal.aborted||!current())throw Error('VOICE_REFERENCE_CANCELLED')};check()
  const stage=join(this.root,'staging','tx-'+randomUUID());await ordinaryPath(join(this.root,'staging'),true);await mkdir(stage,{mode:0o700});let published:string|undefined
  try{
   const data=await this.convert(source,stage,signal);check()
   if(!hashPattern.test(data.sourceSha256)||!hashPattern.test(data.referenceSha256))throw Error('VOICE_REFERENCE_IMPORT')
   const bytes=await boundedReferenceRead(join(stage,'reference.wav'),44+policy.maxSeconds*48000*2)
   if(digest(bytes)!==data.referenceSha256||!canonicalHeaderMatches(bytes,data.audio))throw Error('VOICE_REFERENCE_IMPORT')
   // Include orphaned published data in storage accounting after an interrupted registry commit.
   let total=0,count=0;const queue=[{path:join(this.root,'profiles'),depth:0}]
   while(queue.length){const dir=queue.pop()!;await ordinaryPath(dir.path,true);const files=await readdir(dir.path,{withFileTypes:true});count+=files.length;if(count>512)throw Error('VOICE_REFERENCE_STORAGE');for(const e of files){const path=join(dir.path,e.name);if(e.isDirectory()){if(dir.depth>=2)throw Error('VOICE_REFERENCE_STORAGE');queue.push({path,depth:dir.depth+1})}else if(e.isFile()){await ordinaryPath(path);total+=(await lstat(path)).size}else throw Error('VOICE_REFERENCE_STORAGE')}}
   const id='wav-'+randomUUID(),m:Manifest={schemaVersion:1,kind:'wav-reference',id,revision:data.referenceSha256,displayName:name,reference:'reference.wav',sourceSha256:data.sourceSha256,referenceSha256:data.referenceSha256,audio:data.audio,preprocessingVersion:policy.preprocessingVersion,modelContract:policy.contract,createdAt:new Date().toISOString()}
   const json=JSON.stringify(m)+'\n';if(total+bytes.length+Buffer.byteLength(json)>this.limits.maxStoreBytes)throw Error('VOICE_REFERENCE_STORAGE_LIMIT')
   const f=await open(join(stage,'profile.json'),'wx',0o600);try{await f.writeFile(json);await f.sync()}finally{await f.close()};check()
   const parent=join(this.root,'profiles',id);await ordinaryPath(join(this.root,'profiles'),true);await mkdir(parent,{mode:0o700});published=join(parent,m.revision);await rename(stage,published);check()
   const entries=[...this.entries,{id,revision:m.revision,name}];await this.commit(entries,check)
   const profile=this.dto(m,name);this.profiles.push(profile);this.manifests.set(id+'@'+m.revision,m);published=undefined;return profile
  }finally{await rm(stage,{recursive:true,force:true}).catch(()=>{});if(published)await rm(dirname(published),{recursive:true,force:true}).catch(()=>{})}
 })}
 rename(key:string,name:string,current=()=>true){return this.transaction(async()=>{const check=()=>{if(!current())throw Error('CHAT_SETTINGS_EXPIRED')};check();name=referenceName(name);const entry=this.entries.find(e=>e.id+'@'+e.revision===key);if(!entry)throw Error('VOICE_REFERENCE_UNAVAILABLE');await this.commit(this.entries.map(e=>e===entry?{...e,name}:e),check);this.profiles=this.profiles.map(p=>p.id+'@'+p.version===key?{...p,name}:p)})}
 remove(key:string){return this.transaction(async()=>{if(this.registryError)throw Error('VOICE_REFERENCE_STORAGE');const path=this.location(key);await this.commit(this.entries.filter(e=>e.id+'@'+e.revision!==key));this.profiles=this.profiles.filter(p=>p.id+'@'+p.version!==key);this.verified.delete(key);this.manifests.delete(key);await ordinaryPath(join(this.root,'profiles'),true);await rm(dirname(path),{recursive:true,force:true,maxRetries:2})})}
}
