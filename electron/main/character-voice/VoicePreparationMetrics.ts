import {appendFile,lstat,mkdir} from 'node:fs/promises'
import {join} from 'node:path'

const events=new Set(['base-verification','runtime-ready','preparation-ready','model-full-check'])
const fields=['verifyMs','loadMs','metadataMs','elapsedMs','reused','modelCheckMs','environmentCheckMs','runtimeImportMs','modelLoadMs','conditioningMs','promptMs','warmupMs','prewarmMs','modelHashedBytes','modelSkippedWeightBytes','weightIntegrityChecked','modelVerification']
// Only preparation counters: never persist synthesis input, transcripts, paths,
// default-voice descriptions, upstream errors or unrestricted worker audit data.
export function preparationMetrics(root:string){
 let serial=Promise.resolve(),count=0
 return (value:Record<string,unknown>)=>{
  if(!events.has(String(value.type))||count++>=100)return
  const audit=value.audit&&typeof value.audit==='object'?value.audit as Record<string,unknown>:{}
  const record:Record<string,unknown>={type:value.type,at:Date.now()}
  for(const field of fields){const item=value[field]??audit[field];if(typeof item==='number'&&Number.isFinite(item)||typeof item==='boolean'||field==='modelVerification'&&['full','installed'].includes(String(item)))record[field]=item}
  serial=serial.then(async()=>{await mkdir(root,{recursive:true});const path=join(root,'preparation-metrics.jsonl');try{const s=await lstat(path);if(!s.isFile()||s.isSymbolicLink()||s.size>=1024*1024)return}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')return}await appendFile(path,JSON.stringify(record)+'\n')}).catch(()=>{})
 }
}
