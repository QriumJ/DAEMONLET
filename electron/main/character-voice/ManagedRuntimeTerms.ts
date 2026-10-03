import {createHash,randomUUID} from 'node:crypto'
import {mkdir,readFile,rm,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import policyJson from '../../voice/managed-runtime-terms.json'
import type {GgufRuntimeCatalog,GgufRuntimeId} from '../../shared/windows-gguf-runtime-catalog'
import type {ManagedRuntimeTermsState,RuntimeTermsView} from '../../shared/managed-runtime-terms'
import {replaceFile} from '../character-chat/replaceFile'
type Pin={file:string;bytes:number;sha256:string}
type Group={id:string;title:string;version:string;sourceUrl:string;original:Pin;text:Pin;koreanOriginal?:Pin;koreanText?:Pin;files:Record<string,{bytes:number;sha256:string}>}
type Policy={schemaVersion:1;component:string;groups:Group[];cuda:{id:string;title:string;sourceUrl:string;original:Pin}}
const hash=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex')
// Acceptance concerns only the pinned Microsoft files in the managed prefix.
// This record supplies no redistribution grant and is never inferred from an
// existing installation, settings migration, model download or worker receipt.
export class ManagedRuntimeTerms {
 private accepted=false
 private initialized=false
 private error:string|null=null
 private validScope=false
 readonly fingerprint:string
 constructor(private root:string,private documentsRoot:string,private catalog:GgufRuntimeCatalog,private policy:Policy=policyJson as unknown as Policy){
  this.fingerprint=hash(JSON.stringify({schemaVersion:policy.schemaVersion,component:policy.component,groups:policy.groups}))
  const expected=Object.fromEntries(policy.groups.flatMap(g=>Object.entries(g.files)))
  const actual=Object.fromEntries(Object.entries(catalog.components).flatMap(([component,c])=>Object.entries(c.files).filter(([p])=>/(?:^|\/)(?:vcomp140|vcruntime140(?:_1)?|msvcp140(?:-[a-f0-9]+)?)\.dll$/i.test(p)).map(([p,pin])=>[component+'\0'+p,pin])))
  const wanted=Object.fromEntries(Object.entries(expected).map(([p,pin])=>[policy.component+'\0'+p,pin]))
  this.validScope=policy.schemaVersion===1&&Object.keys(wanted).length>0&&Object.keys(actual).length===Object.keys(wanted).length&&Object.entries(wanted).every(([p,pin])=>actual[p]?.bytes===pin.bytes&&actual[p]?.sha256===pin.sha256)&&Object.values(catalog.runtimes).every(r=>r.components.includes(policy.component))
  if(!this.validScope)this.error='GGUF_RUNTIME_TERMS_CHANGED'
 }
 private pins(){return this.policy.groups.flatMap(g=>[g.original,g.text,...(g.koreanOriginal?[g.koreanOriginal]:[]),...(g.koreanText?[g.koreanText]:[])])}
 private async verifyDocument(pin:Pin){
  if(!/^[\w.-]+$/.test(pin.file))throw Error('GGUF_RUNTIME_TERMS_CHANGED')
  const data=await readFile(join(this.documentsRoot,pin.file))
  if(data.length!==pin.bytes||hash(data)!==pin.sha256)throw Error('GGUF_RUNTIME_TERMS_CHANGED')
  return join(this.documentsRoot,pin.file)
 }
 async initialize(){
  this.accepted=false;this.initialized=false
  if(!this.validScope)return
  try{
   await Promise.all(this.pins().map(pin=>this.verifyDocument(pin)))
   this.initialized=true;this.error=null
   try{const receipt=JSON.parse(await readFile(join(this.root,'managed-runtime-terms.json'),'utf8'));this.accepted=receipt.version===1&&receipt.fingerprint===this.fingerprint&&typeof receipt.acceptedAt==='string'&&Number.isFinite(Date.parse(receipt.acceptedAt))}catch{/* Missing/invalid receipts require an explicit new acceptance. */}
  }catch{this.error='GGUF_RUNTIME_TERMS_CHANGED'}
 }
 snapshot(id:GgufRuntimeId):ManagedRuntimeTermsState{return {fingerprint:this.fingerprint,accepted:this.accepted&&this.initialized,error:this.error,documents:this.policy.groups.map(g=>({id:g.id,title:g.title,version:g.version,files:Object.keys(g.files),originalSha256:g.original.sha256,koreanAvailable:!!g.koreanOriginal})),...(id.endsWith('cuda')?{cudaNotice:{id:this.policy.cuda.id,title:this.policy.cuda.title}}:{})}}
 assertAccepted(){if(!this.initialized||this.error)throw Error('GGUF_RUNTIME_TERMS_CHANGED');if(!this.accepted)throw Error('GGUF_RUNTIME_TERMS_REQUIRED')}
 async accept(fingerprint:string,current:()=>boolean){
  if(!this.initialized||this.error||fingerprint!==this.fingerprint)throw Error('GGUF_RUNTIME_TERMS_CHANGED')
  if(!current())throw Error('CHAT_SETTINGS_EXPIRED')
  await Promise.all(this.pins().map(pin=>this.verifyDocument(pin)))
  await mkdir(this.root,{recursive:true})
  const temp=join(this.root,'managed-runtime-terms-'+randomUUID()+'.tmp')
  try{await writeFile(temp,JSON.stringify({version:1,fingerprint,acceptedAt:new Date().toISOString()})+'\n',{flag:'wx'});if(!current())throw Error('CHAT_SETTINGS_EXPIRED');await replaceFile(temp,join(this.root,'managed-runtime-terms.json'));this.accepted=true}finally{await rm(temp,{force:true})}
 }
 async document(id:string,view:RuntimeTermsView,runtime:GgufRuntimeId){
  if(!this.initialized||this.error)throw Error('GGUF_RUNTIME_TERMS_CHANGED')
  const group=this.policy.groups.find(g=>g.id===id)
  const pin=group?(view==='original'?group.original:view==='text'?group.text:view==='korean-original'?group.koreanOriginal:view==='korean-text'?group.koreanText:undefined):id===this.policy.cuda.id&&runtime.endsWith('cuda')&&view==='original'?this.policy.cuda.original:undefined
  if(!pin)throw Error('VOICE_ACTION')
  return this.verifyDocument(pin)
 }
}
