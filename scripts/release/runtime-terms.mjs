// Treat all runtime and document artifacts as data; never execute them here.
import {createHash} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {join} from 'node:path'
export async function verifyRuntimeTermsDocuments(voiceDirectory) {
 const policy=JSON.parse(await readFile(join(voiceDirectory,'managed-runtime-terms.json'),'utf8'))
 const pins=policy.groups.flatMap(group=>[group.original,group.text,...(group.koreanOriginal?[group.koreanOriginal]:[]),...(group.koreanText?[group.koreanText]:[])]).concat(policy.cuda.original)
 for(const pin of pins){
  if(!/^[\w.-]+$/.test(pin.file))throw Error('GGUF_RUNTIME_TERMS_CHANGED')
  const bytes=await readFile(join(voiceDirectory,'runtime-terms',pin.file))
  if(bytes.length!==pin.bytes||createHash('sha256').update(bytes).digest('hex')!==pin.sha256)throw Error('GGUF_RUNTIME_TERMS_CHANGED: '+pin.file)
 }
 return {documents:pins.length,bytes:pins.reduce((n,pin)=>n+pin.bytes,0)}
}
