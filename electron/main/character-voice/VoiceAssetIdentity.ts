import {lstat,realpath,readdir} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {join} from 'node:path'

// Metadata is change detection for an already-loaded, verified worker, NOT a
// replacement for content hashes. No model bytes are read and no process is run.
// Include the runtime tree so a replaced dependency is not hidden by an unchanged
// top-level receipt. OFF/startup only checks the small required-file allowlist.
export class VoiceAssetIdentity {
 private generation=0
 constructor(private policy:string,private roots:string[],private files:Array<{path:string;bytes?:number}>){ }
 invalidate(){++this.generation}
 close(){this.invalidate()}
 async snapshot(inventory=true):Promise<string>{
  const directories=[]
  const paths=new Map<string,{bytes?:number;directory:boolean}>()
  for(const path of this.roots){
   const s=await lstat(path,{bigint:true});if(!s.isDirectory()||s.isSymbolicLink())throw Error('VOICE_BASE_CHANGED')
   const canonical=await realpath(path);directories.push([canonical,String(s.dev),String(s.ino),String(s.birthtimeNs)])
   if(inventory)for(const entry of await readdir(canonical,{recursive:true,withFileTypes:true})){
    if(!entry.isFile()&&!entry.isDirectory())throw Error('VOICE_BASE_CHANGED')
    paths.set(join(entry.parentPath,entry.name),{directory:entry.isDirectory()})
   }
  }
  for(const file of this.files)paths.set(await realpath(file.path),{bytes:file.bytes,directory:false})
  // Always reject required-file links even if their canonical targets are valid.
  for(const file of this.files)if((await lstat(file.path)).isSymbolicLink())throw Error('VOICE_BASE_CHANGED')
  const entries=[...paths.entries()].sort(([a],[b])=>a.localeCompare(b)),metadata:unknown[]=[]
  for(let offset=0;offset<entries.length;offset+=128)metadata.push(...await Promise.all(entries.slice(offset,offset+128).map(async([path,file])=>{
   const s=await lstat(path,{bigint:true})
   if(s.isSymbolicLink()||(file.directory?!s.isDirectory():!s.isFile()||file.bytes!==undefined&&s.size!==BigInt(file.bytes)))throw Error('VOICE_BASE_CHANGED')
   return [path,String(s.dev),String(s.ino),String(s.size),String(s.mtimeNs),String(s.ctimeNs)]
  })))
  return createHash('sha256').update(JSON.stringify({policy:this.policy,directories,metadata,generation:this.generation})).digest('hex')
 }
}
