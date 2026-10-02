import {createHash,randomUUID} from 'node:crypto'
import {lstat,readFile,readdir,realpath,rename} from 'node:fs/promises'
import {dirname,isAbsolute,join,relative,resolve} from 'node:path'
import type {ManagedVoiceModelRemoval} from '../../shared/character-voice-contract'
export type {ManagedVoiceModelRemoval} from '../../shared/character-voice-contract'

// Only installers construct these manifests. Renderer supplied paths never
// become deletion targets. Python, runtime caches and character packs are absent.
type Receipt={name:string;matches:(value:any)=>boolean}
export type ManagedModelDirectory={path:string;files:readonly string[];receipt?:Receipt}
export type ManagedModelManifest={root:string;id:ManagedVoiceModelRemoval['id'];engine:ManagedVoiceModelRemoval['engine'];modelId:string;revision:string;directories:ManagedModelDirectory[];ownership?:Array<{path:string;whenPresent?:string;matches:(value:any)=>boolean}>}
type Inspected={path:string;bytes:number;files:Array<{relativePath:string;bytes:number}>;identity:unknown[]}
const invalid=()=>Error('VOICE_MODEL_REMOVAL_CHANGED')
const absent=(e:unknown)=>(e as NodeJS.ErrnoException).code==='ENOENT'

function contained(root:string,path:string){const rel=relative(root,path);if(!rel||rel==='..'||rel.startsWith('../')||rel.startsWith('..\\')||isAbsolute(rel))throw invalid()}
async function directory(path:string){
 if(!isAbsolute(path)||resolve(path)!==path)throw invalid()
 const parents=[];for(let p=path;;p=dirname(p)){parents.unshift(p);if(dirname(p)===p)break}
 for(const p of parents){const s=await lstat(p);if(!s.isDirectory()||s.isSymbolicLink())throw invalid();if(await realpath(p)!==p)throw invalid()}
}
function stamp(s:Awaited<ReturnType<typeof lstat>>){return [String(s.dev),String(s.ino),String(s.size),String(s.mtimeMs),String(s.ctimeMs),String(s.birthtimeMs)]}
async function receipt(path:string,matches:(value:any)=>boolean){
 await directory(dirname(path));const before=await lstat(path)
 if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size>1024*1024)throw invalid()
 let value;try{value=JSON.parse(await readFile(path,'utf8'))}catch{throw invalid()}
 if(!matches(value)||JSON.stringify(stamp(before))!==JSON.stringify(stamp(await lstat(path))))throw invalid()
}
async function inspect(spec:ManagedModelDirectory,path=spec.path):Promise<Inspected|null>{
 try{await directory(path)}catch(e){if(absent(e))return null;throw e}
 const allowed=new Set(spec.files),parents=new Set<string>()
 for(const name of spec.files){if(!name||/[\\:]/.test(name)||name.split('/').some(p=>!p||p==='.'||p==='..'))throw invalid();const parts=name.split('/');for(let i=1;i<parts.length;i++)parents.add(parts.slice(0,i).join('/'))}
 const identity:unknown[]=[],files:Array<{relativePath:string;bytes:number}>=[]
 async function walk(current:string,prefix=''){
  for(const entry of (await readdir(current,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
   const name=prefix+entry.name,child=join(current,entry.name),s=await lstat(child)
   if(s.isSymbolicLink()||!s.isFile()&&!s.isDirectory())throw invalid()
   if(s.isDirectory()){if(!parents.has(name))throw invalid();identity.push([name,'directory',...stamp(s)]);await walk(child,name+'/')}
   else{if(!allowed.has(name)||!Number.isSafeInteger(s.size)||s.nlink!==1)throw invalid();identity.push([name,'file',...stamp(s)]);files.push({relativePath:name,bytes:s.size})}
  }
 }
 if(spec.receipt)await receipt(join(path,spec.receipt.name),spec.receipt.matches)
 await walk(path)
 // The directory inode also binds an empty or partial download cache. Rename
 // changes directory timestamps, so the post-rename check compares its inode.
 const rootStat=await lstat(path);identity.unshift(['root',String(rootStat.dev),String(rootStat.ino)])
 return {path,bytes:files.reduce((n,f)=>n+f.bytes,0),files,identity}
}
async function checked(manifest:ManagedModelManifest){
 const root=resolve(manifest.root)
 if(root!==manifest.root)throw invalid()
 try{await directory(root)}catch(e){if(absent(e))return [];throw e}
 for(const owner of manifest.ownership??[]){contained(root,owner.path);if(owner.whenPresent){contained(root,owner.whenPresent);try{await lstat(owner.whenPresent)}catch(e){if(absent(e))continue;throw e}}await receipt(owner.path,owner.matches)}
 const results:Inspected[]=[]
 if(new Set(manifest.directories.map(s=>s.path)).size!==manifest.directories.length)throw invalid()
 for(const spec of manifest.directories){contained(root,spec.path);for(const other of manifest.directories)if(spec!==other&&!relative(spec.path,other.path).startsWith('..')&&!isAbsolute(relative(spec.path,other.path)))throw invalid();const value=await inspect(spec);if(value)results.push(value)}
 return results
}
function token(manifest:ManagedModelManifest,entries:Inspected[]){return createHash('sha256').update(JSON.stringify({id:manifest.id,root:manifest.root,modelId:manifest.modelId,revision:manifest.revision,entries:entries.map(e=>({path:e.path,identity:e.identity}))})).digest('hex')}
export async function managedModelRemoval(manifest:ManagedModelManifest):Promise<ManagedVoiceModelRemoval|null>{
 const entries=await checked(manifest);if(!entries.length)return null
 return {id:manifest.id,engine:manifest.engine,modelId:manifest.modelId,revision:manifest.revision,planId:token(manifest,entries),totalBytes:entries.reduce((n,e)=>n+e.bytes,0),directories:entries.map(({path,bytes,files})=>({path,bytes,files}))}
}
export async function trashManagedModel(manifest:ManagedModelManifest,expectedPlanId:string,trashItem:(path:string)=>Promise<void>):Promise<void>{
 if(typeof expectedPlanId!=='string'||!/^[a-f0-9]{64}$/.test(expectedPlanId)||typeof trashItem!=='function')throw invalid()
 const entries=await checked(manifest)
 if(!entries.length||token(manifest,entries)!==expectedPlanId)throw invalid()
 // Quarantine every approved directory before trashing any. A changed/unknown
 // file or a renamed parent fails closed; rollback preserves the original path.
 const moved:Array<{from:string;to:string;entry:Inspected;spec:ManagedModelDirectory}>=[]
 const restore=async()=>{for(const item of [...moved].reverse()){try{await lstat(item.to)}catch(e){if(absent(e))continue;throw e}await directory(dirname(item.from));try{await lstat(item.from);throw invalid()}catch(e){if(!absent(e))throw e}await rename(item.to,item.from)}}
 try{
  for(const entry of entries){
   const spec=manifest.directories.find(s=>s.path===entry.path)!,current=await inspect(spec)
   if(!current||JSON.stringify(current.identity)!==JSON.stringify(entry.identity))throw invalid()
   const to=join(dirname(entry.path),'.remove-model-'+randomUUID());await directory(dirname(entry.path));await rename(entry.path,to)
   moved.push({from:entry.path,to,entry,spec})
   const after=await inspect(spec,to);if(!after||JSON.stringify(after.identity)!==JSON.stringify(entry.identity))throw invalid()
  }
 }catch(e){try{await restore()}catch{throw Error('VOICE_MODEL_REMOVAL_RECOVERY')}throw e}
 try{for(const item of moved){await directory(dirname(item.to));const after=await inspect(item.spec,item.to);if(!after||JSON.stringify(after.identity)!==JSON.stringify(item.entry.identity))throw invalid();await trashItem(item.to)}}
 catch{try{await restore()}catch{throw Error('VOICE_MODEL_REMOVAL_RECOVERY')}throw Error('VOICE_MODEL_REMOVAL_FAILED')}
}
