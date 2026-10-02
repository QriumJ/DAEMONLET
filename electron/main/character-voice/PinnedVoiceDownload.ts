import {constants,type BigIntStats} from 'node:fs'
import {createHash} from 'node:crypto'
import {lstat,mkdir,open,rm} from 'node:fs/promises'
import {dirname} from 'node:path'
import {streamChunks} from '../character-chat/stream'
export type PinnedVoiceFile={url:string;bytes:number;sha256:string}
export async function downloadVoiceFile(path:string,file:PinnedVoiceFile,signal:AbortSignal,progress:(bytes:number)=>void,fetcher:typeof fetch=fetch){
 const invalid=()=>Error('VOICE_BASE_CHANGED')
 // Windows file indices can exceed Number's exact integer range. Preserve the
 // complete inode and nanosecond stamps when comparing the handle to its name.
 const stamp=(s:BigIntStats)=>[s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].map(String)
 const ordinary=(s:BigIntStats)=>s.isFile()&&!s.isSymbolicLink()&&s.nlink===1n
 signal.throwIfAborted();await mkdir(dirname(path),{recursive:true})
 let before:BigIntStats|undefined
 try{before=await lstat(path,{bigint:true});if(!ordinary(before))throw invalid()}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e}
 // Acquire a non-destructive, exclusive file handle BEFORE awaiting the network.
 // Never open with O_TRUNC: a replaced hardlink could otherwise destroy a user's
 // external file before a later audit gets a chance to reject it. POSIX refuses
 // symlinks at open; Windows uses the bound handle and inode/link checks below.
 const noFollow=process.platform==='win32'?0:constants.O_NOFOLLOW
 const out=await open(path,constants.O_RDWR|noFollow|(before?0:constants.O_CREAT|constants.O_EXCL),0o600)
 let response:Response|undefined
 try{
  let expected=await out.stat({bigint:true}),offset=Number(expected.size)
  if(!Number.isSafeInteger(offset))throw invalid()
  if(!ordinary(expected)||before&&JSON.stringify(stamp(before))!==JSON.stringify(stamp(expected)))throw invalid()
  const owned=async()=>{
   signal.throwIfAborted();const actual=await out.stat({bigint:true}),named=await lstat(path,{bigint:true})
   if(!ordinary(actual)||!ordinary(named)||JSON.stringify(stamp(actual))!==JSON.stringify(stamp(expected))||JSON.stringify(stamp(named))!==JSON.stringify(stamp(actual)))throw invalid()
  }
  await owned()
  if(offset>file.bytes){await owned();await out.truncate(0);expected=await out.stat({bigint:true});offset=0}
  progress(offset)
  if(offset<file.bytes){
   signal.throwIfAborted()
   response=await fetcher(file.url,{signal,headers:offset?{Range:`bytes=${offset}-`}:{}})
   if(response.status===401||response.status===403)throw Error('VOICE_DOWNLOAD_ACCESS')
   if(!response.ok||!response.body||![200,206].includes(response.status))throw Error('VOICE_DOWNLOAD_FAILED')
   if(response.status===206){const m=/^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range')||'');if(!m||Number(m[1])!==offset||Number(m[2])!==file.bytes-1||Number(m[3])!==file.bytes)throw Error('VOICE_DOWNLOAD_RANGE')}
   else{await owned();await out.truncate(0);expected=await out.stat({bigint:true});offset=0}
   await owned()
   for await(const chunk of streamChunks(response.body)){
    signal.throwIfAborted();if(offset+chunk.length>file.bytes)throw Error('VOICE_DOWNLOAD_SIZE')
    // Explicit positions preserve the existing prefix for a 206 resume. Writes
    // remain bound to this descriptor even if the path changes concurrently.
    let written=0
    while(written<chunk.length){await owned();const result=await out.write(chunk,written,chunk.length-written,offset+written);if(!result.bytesWritten)throw Error('VOICE_DOWNLOAD_FAILED');written+=result.bytesWritten;expected=await out.stat({bigint:true})}
    offset+=chunk.length;progress(offset)
   }
   await owned();await out.sync();expected=await out.stat({bigint:true})
  }
  await owned();const hash=createHash('sha256'),buffer=Buffer.alloc(1024*1024)
  for(let position=0;position<offset;){await owned();const {bytesRead}=await out.read(buffer,0,Math.min(buffer.length,offset-position),position);if(!bytesRead)throw invalid();hash.update(buffer.subarray(0,bytesRead));position+=bytesRead}
  await owned()
  if(offset!==file.bytes||hash.digest('hex')!==file.sha256){await owned();await rm(path,{force:true});throw invalid()}
 }finally{
  // streamChunks releases its lock; cancelling an unfinished response prevents
  // a rejected range or changed path from leaving a background response alive.
  if(response?.body&&!response.body.locked)await response.body.cancel().catch(()=>{})
  await out.close()
 }
}
