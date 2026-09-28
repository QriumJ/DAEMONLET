import {lstat,mkdir,open,rm} from 'node:fs/promises'
import {dirname} from 'node:path'
import {digestFile} from '../character-chat/ModelManager'
import {streamChunks} from '../character-chat/stream'
export type PinnedVoiceFile={url:string;bytes:number;sha256:string}
export async function downloadVoiceFile(path:string,file:PinnedVoiceFile,signal:AbortSignal,progress:(bytes:number)=>void,fetcher:typeof fetch=fetch){
 await mkdir(dirname(path),{recursive:true});let offset=0
 try{const s=await lstat(path);if(!s.isFile()||s.isSymbolicLink())throw Error('VOICE_BASE_CHANGED');offset=s.size}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e}
 if(offset>file.bytes){await rm(path);offset=0}
 if(file.bytes===0){const empty=await open(path,'a',0o600);await empty.close()}
 progress(offset)
 if(offset<file.bytes){
  const response=await fetcher(file.url,{signal,headers:offset?{Range:`bytes=${offset}-`}:{}})
  if(response.status===401||response.status===403)throw Error('VOICE_DOWNLOAD_ACCESS')
  if(!response.ok||!response.body||![200,206].includes(response.status))throw Error('VOICE_DOWNLOAD_FAILED')
  if(response.status===206){const m=/^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range')||'');if(!m||Number(m[1])!==offset||Number(m[2])!==file.bytes-1||Number(m[3])!==file.bytes)throw Error('VOICE_DOWNLOAD_RANGE')}else offset=0
  const out=await open(path,offset?'a':'w',0o600)
  try{for await(const chunk of streamChunks(response.body)){signal.throwIfAborted();if(offset+chunk.length>file.bytes)throw Error('VOICE_DOWNLOAD_SIZE');await out.writeFile(chunk);offset+=chunk.length;progress(offset)}await out.sync()}finally{await out.close()}
 }
 signal.throwIfAborted();if(offset!==file.bytes||await digestFile(path,signal)!==file.sha256){await rm(path,{force:true});throw Error('VOICE_BASE_CHANGED')}
}
