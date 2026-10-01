// Synthetic process fixture: never produces Belle audio or runs Python/GPU inference.
const readline=require('node:readline'),fs=require('node:fs'),path=require('node:path')
let cache
let stream
let cancelMode=''
const send=(r,type,extra={})=>process.stdout.write(JSON.stringify({protocolVersion:1,requestId:r.requestId,type,...(r.seed===undefined?{}:{effectiveSeed:r.text==='wrong-seed'?r.seed+1:r.seed}),...extra})+'\n')
readline.createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line)
 if(r.type==='cancel-stream'){
  if(cancelMode==='cancel-timeout')return
  if(cancelMode==='cancel-crash'){process.exit(2);return}
  if(cancelMode==='cancel-wrong'){send(r,'cancelled',{target:{...r.target,speechEpoch:999},cleanupComplete:true,keptWarm:true});return}
  if(cancelMode==='cancel-terminal')send(stream.request,'synthesis-finished',{synthesisId:stream.request.synthesisId,totalSamples:14400,totalChunks:3})
  stream=null;send(r,'cancelled',{target:r.target,cleanupComplete:true,keptWarm:true});return
 }
 if(r.type==='credit'){
  if(stream&&r.chunkIndex===0){stream.sendChunk(3);send(stream.request,'synthesis-finished',{synthesisId:stream.request.synthesisId,totalSamples:stream.request.text==='total'?1:19200,totalChunks:4});stream=null}
  return
 }
 if(r.type==='init'){
  cache=r.cache
  if(r.package.endsWith('crash')){process.exit(2);return}
  if(r.package.endsWith('contaminate')){process.stdout.write('upstream log\n');return}
  if(r.package.endsWith('partial')){process.stdout.write('{"protocolVersion":');return}
  if(r.engine==='qwen3-tts-06b'){send(r,'ready',{capabilities:{engine:r.engine,synthesisStreaming:r.package.endsWith('bad-qwen-capabilities')?true:r.executionProfile.startsWith('qwen-mlx'),cancellation:'owned-process-termination',warmCancellationReuse:false},seedContract:1,referenceContract:1,mode:'wav-reference',referenceSha256:r.conditioning.sha256,conditioningFingerprint:r.conditioning.fingerprint,referenceCacheBuilds:1,adapterSha256:null,defaultVoice:null,loaded:true,warmed:false});return}
  send(r,'ready',r.package.endsWith('old-seed')?{}:{seedContract:1});return
 }
 if(r.type==='prewarm'){send(r,'warmed',{loaded:true,warmed:true,ready:true});return}
 if(r.type==='synthesize'){
  if(r.text==='hang')return
  if(r.text==='oom'){send(r,'error',{code:'CUDA_OOM'});return}
  const bytes=Buffer.alloc(44+9600);bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(48000,24);bytes.writeUInt32LE(96000,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(9600,40)
  fs.writeFileSync(path.join(cache,r.audioId+'.wav'),r.text==='corrupt'?Buffer.alloc(3):bytes)
  send(r,'audio-ready',{audioId:r.audioId,binding:r.binding,segmentIndex:r.segmentIndex,generationMs:1,rtf:0.01})
 }
 if(r.type==='stream'){
  cancelMode=r.text
  const sendChunk=index=>{
   const audioId=require('node:crypto').randomUUID(),bytes=Buffer.alloc(9644);bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(48000,24);bytes.writeUInt32LE(96000,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(9600,40)
   fs.writeFileSync(path.join(cache,audioId+'.wav'),bytes)
   send(r,'audio-chunk',{synthesisId:r.synthesisId,audioId,binding:r.binding,segmentIndex:r.segmentIndex,chunkIndex:r.text==='duplicate'?0:index,sampleOffset:r.text==='offset'?1:index*4800,sampleCount:4800,sampleRate:48000,firstChunkReadyMs:10})
  }
  stream={request:r,sendChunk};send(r,'synthesis-started');for(let i=0;i<3;i++)sendChunk(i)
 }
})
