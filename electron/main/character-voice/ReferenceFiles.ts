import {constants} from 'node:fs'
import {open,lstat,realpath} from 'node:fs/promises'
import {resolve,dirname} from 'node:path'
// OS temporary parent aliases are canonicalized once, never the selected leaf.
export async function ordinaryPath(path:string,directory=false){
 const absolute=resolve(path),leaf=await lstat(absolute)
 if(leaf.isSymbolicLink()||(directory?!leaf.isDirectory():!leaf.isFile()))throw Error('VOICE_REFERENCE_FILE')
 let parent=dirname(absolute)
 // macOS /var and /tmp are OS aliases, not user-selected package/file links.
 if(process.platform==='darwin')parent=await realpath(parent)
 for(let p=parent;;){const s=await lstat(p);if(!s.isDirectory()||s.isSymbolicLink())throw Error('VOICE_REFERENCE_FILE');const next=dirname(p);if(next===p)break;p=next}
 if(process.platform==='darwin'){
  for(let p=dirname(absolute);p!==dirname(p);p=dirname(p)){if((await lstat(p)).isSymbolicLink()&&!['/var','/tmp'].includes(p))throw Error('VOICE_REFERENCE_FILE')}
 }
 return absolute
}
export async function boundedReferenceRead(path:string,max:number){
 await ordinaryPath(path)
 const handle=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW||0))
 try{
  const before=await handle.stat({bigint:true});if(!before.isFile()||before.size<1||before.size>BigInt(max))throw Error('VOICE_REFERENCE_SIZE')
  const bytes=Buffer.alloc(Number(before.size));let offset=0
  while(offset<bytes.length){const {bytesRead}=await handle.read(bytes,offset,bytes.length-offset,offset);if(!bytesRead)throw Error('VOICE_REFERENCE_CHANGED');offset+=bytesRead}
  const after=await handle.stat({bigint:true});for(const key of ['dev','ino','size','mtimeNs','ctimeNs'] as const)if(before[key]!==after[key])throw Error('VOICE_REFERENCE_CHANGED')
  await ordinaryPath(path);const current=await lstat(path,{bigint:true});if(current.dev!==after.dev||current.ino!==after.ino||current.size!==after.size||current.mtimeNs!==after.mtimeNs||current.ctimeNs!==after.ctimeNs)throw Error('VOICE_REFERENCE_CHANGED')
  return bytes
 }finally{await handle.close()}
}
