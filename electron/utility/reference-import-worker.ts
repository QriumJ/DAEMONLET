import {parentPort,workerData} from 'node:worker_threads'
import {createHash} from 'node:crypto'
import {open} from 'node:fs/promises'
import {join} from 'node:path'
import {canonicalReferenceWav,REFERENCE_POLICY} from '../main/character-voice/ReferenceWav'
import {boundedReferenceRead,ordinaryPath} from '../main/character-voice/ReferenceFiles'
async function main(){
 const {source,staging}=workerData as {source:string;staging:string}
 await ordinaryPath(staging,true)
 const input=await boundedReferenceRead(source,REFERENCE_POLICY.maxSourceBytes),{wav,audio}=canonicalReferenceWav(input)
 const path=join(staging,'reference.wav'),f=await open(path,'wx',0o600)
 try{await f.writeFile(wav);await f.sync()}finally{await f.close()}
 parentPort!.postMessage({ok:true,sourceSha256:createHash('sha256').update(input).digest('hex'),referenceSha256:createHash('sha256').update(wav).digest('hex'),audio})
}
void main().catch(error=>parentPort!.postMessage({ok:false,error:error instanceof Error&&/^VOICE_REFERENCE_[A-Z_]+$/.test(error.message)?error.message:'VOICE_REFERENCE_IMPORT'}))
