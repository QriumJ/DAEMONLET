#!/usr/bin/env node
import {pathToFileURL} from 'node:url'
import {StringDecoder} from 'node:string_decoder'
export const tools=[
 {name:'present',description:'Show a dot message (readable multiline bubble with full-text expansion; speech receives the full text), semantic pose or status on the opted-in DAEMONLET pet. Replaces the previous presentation. Text/muted presentations expire durationMs after acceptance. Unmuted speech may prepare for up to 15 minutes; durationMs (max 30 seconds) then limits display and playback from the first validated scheduled audio start. Completion releases ownership earlier; long speech may be cut at this limit. Voice requires local unmute and a configured local engine. Acceptance does not guarantee playback. No chat history is read or written.',inputSchema:{type:'object',additionalProperties:false,properties:{text:{type:'string',minLength:1,maxLength:600},pose:{type:'string',enum:['neutral','listening','thinking','happy','sad','error']},state:{type:'string',enum:['idle','thinking','speaking','done','error']},speak:{type:'boolean',default:false},durationMs:{type:'integer',description:'Maximum text/muted lifetime after acceptance, or voiced display/playback lifetime from first audio start (preparation has a separate 15-minute bound).',minimum:1000,maximum:30000,default:12000}},anyOf:[{required:['text']},{required:['pose']},{required:['state']}]},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false}},
 {name:'cancel',description:'Stop only the current dot presentation and its voice; release the pet back to normal behavior.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false}}
]
export function createMcpHandler(forward){
 let initialized=false,ready=false
 return async message=>{
  let modern=false
  const serverInfo={name:'daemonlet-presentation',version:'1.0.0'},supportedVersions=['2026-07-28','2025-06-18']
  const id=message?.id,result=value=>({jsonrpc:'2.0',id,result:modern?{resultType:'complete',...value,_meta:{'io.modelcontextprotocol/serverInfo':serverInfo}}:value}),error=(code,text,data)=>({jsonrpc:'2.0',id:id??null,error:{code,message:text,...(data===undefined?{}:{data})}})
  if(!message||Array.isArray(message)||message.jsonrpc!=='2.0'||typeof message.method!=='string'||id!==undefined&&typeof id!=='string'&&!(typeof id==='number'&&Number.isSafeInteger(id)))return error(-32600,'Invalid request')
  if(id===undefined){if(message.method==='notifications/initialized'&&initialized)ready=true;return null}
  const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)
  const params=message.params===undefined?{}:message.params
  if(!object(params))return error(-32602,'Invalid params')
  const meta=params._meta
  if(meta!==undefined&&!object(meta))return error(-32602,'Invalid metadata')
  modern=message.method==='server/discover'||meta!==undefined&&(Object.hasOwn(meta,'io.modelcontextprotocol/protocolVersion')||Object.hasOwn(meta,'io.modelcontextprotocol/clientCapabilities'))
  if(modern){
   const version=meta?.['io.modelcontextprotocol/protocolVersion'],capabilities=meta?.['io.modelcontextprotocol/clientCapabilities']
   if(typeof version!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(version)||!object(capabilities))return error(-32602,'Invalid metadata')
   if(version!=='2026-07-28')return error(-32022,'Unsupported protocol version',{supported:supportedVersions,requested:version})
   const clientInfo=meta['io.modelcontextprotocol/clientInfo']
   if(clientInfo!==undefined&&(!object(clientInfo)||typeof clientInfo.name!=='string'||typeof clientInfo.version!=='string'||!clientInfo.name||!clientInfo.version||clientInfo.name.length>128||clientInfo.version.length>128))return error(-32602,'Invalid client info')
   if(message.method==='server/discover'){
    if(Object.keys(params).some(key=>key!=='_meta'))return error(-32602,'Invalid discovery params')
    return result({supportedVersions,capabilities:{tools:{}}})
   }
  }
  if(message.method==='initialize'){
   if(modern)return error(-32601,'Method not found')
   if(initialized||typeof params.protocolVersion!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(params.protocolVersion))return error(-32602,'Invalid initialize')
   // Legacy negotiation always selects our implemented revision, never the offered unknown revision.
   initialized=true;return result({protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo})
  }
  if(message.method==='ping')return result({})
  if(!modern&&!ready)return error(-32000,'Initialize first')
  if(message.method==='tools/list'){
   if(Object.keys(params).some(key=>key!=='_meta'))return error(-32602,'Invalid list params')
   return result({tools})
  }
  if(message.method!=='tools/call')return error(-32601,'Method not found')
  if(Object.keys(params).some(key=>!['name','arguments','_meta'].includes(key)))return error(-32602,'Invalid tool params')
  const {name,arguments:args={}}=params
  if(!tools.some(t=>t.name===name)||!args||typeof args!=='object'||Array.isArray(args)||name==='cancel'&&Object.keys(args).length||Object.hasOwn(args,'type'))return error(-32602,'Invalid tool arguments')
  try{return result({content:[{type:'text',text:JSON.stringify(await forward({type:name,...args}))}]})}
  catch(e){const text=e instanceof Error&&/^DOT_[A-Z_]+$/.test(e.message)?e.message:'DOT_UNAVAILABLE';return result({content:[{type:'text',text}],isError:true})}
 }
}
export function localForward(env=process.env){
 const port=Number(env.DAEMONLET_DOT_PORT??39471),token=env.DAEMONLET_DOT_TOKEN??''
 if(!Number.isInteger(port)||port<1024||port>65535||!/^[a-zA-Z0-9_-]{32,128}$/.test(token))throw Error('DOT_CONFIG')
 return async command=>{
  try{const response=await fetch(`http://127.0.0.1:${port}/present`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify(command),signal:AbortSignal.timeout(6000),redirect:'error'});const reader=response.body?.getReader();if(!reader)throw Error('DOT_UNAVAILABLE');let bytes=0;const chunks=[];for(;;){const {value,done}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>4096){await reader.cancel();throw Error('DOT_UNAVAILABLE')}chunks.push(Buffer.from(value))}const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!response.ok)throw Error(value.error);if(value.accepted!==true||!Number.isSafeInteger(value.sequence)||typeof value.poseFallback!=='boolean'||!['off','muted','requested'].includes(value.voice))throw Error('DOT_UNAVAILABLE');return {accepted:true,sequence:value.sequence,poseFallback:value.poseFallback,voice:value.voice}}
  catch(e){throw Error(e instanceof Error&&/^DOT_[A-Z_]+$/.test(e.message)?e.message:'DOT_UNAVAILABLE')}
 }
}
export function runStdio(input,output,handler){
 let buffer='',pending=0;const decoder=new StringDecoder('utf8')
 const write=value=>{if(value&&!output.write(JSON.stringify(value)+'\n')){input.pause();output.once('drain',()=>input.resume())}}
 input.on('data',chunk=>{
  buffer+=decoder.write(chunk)
  if(Buffer.byteLength(buffer)>16384){write({jsonrpc:'2.0',id:null,error:{code:-32600,message:'Message too large'}});input.destroy();buffer='';return}
  let index
  while((index=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);if(!line.trim())continue
   let value;try{value=JSON.parse(line)}catch{write({jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error'}});continue}
   if(pending>=4){write({jsonrpc:'2.0',id:value.id??null,error:{code:-32000,message:'Busy'}});continue}
   ++pending;void handler(value).then(write).catch(()=>write({jsonrpc:'2.0',id:value.id??null,error:{code:-32603,message:'Internal error'}})).finally(()=>--pending)
  }
 })
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{runStdio(process.stdin,process.stdout,createMcpHandler(localForward()))}catch{process.stderr.write('DOT_CONFIG: supply session DAEMONLET_DOT_TOKEN and optional port.\n');process.exitCode=1}
}
