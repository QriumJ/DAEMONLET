// Synthetic process fixture: never produces Belle audio or runs Python/GPU inference.
const readline=require('node:readline'),fs=require('node:fs'),path=require('node:path')
let cache
const send=(r,type,extra={})=>process.stdout.write(JSON.stringify({protocolVersion:1,requestId:r.requestId,type,...extra})+'\n')
readline.createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line)
 if(r.type==='init'){
  cache=r.cache
  if(r.package.endsWith('crash')){process.exit(2);return}
  if(r.package.endsWith('contaminate')){process.stdout.write('upstream log\n');return}
  if(r.package.endsWith('partial')){process.stdout.write('{"protocolVersion":');return}
  send(r,'ready');return
 }
 if(r.type==='synthesize'){
  if(r.text==='hang')return
  if(r.text==='oom'){send(r,'error',{code:'CUDA_OOM'});return}
  const bytes=Buffer.alloc(44+9600);bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(48000,24);bytes.writeUInt32LE(96000,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(9600,40)
  fs.writeFileSync(path.join(cache,r.audioId+'.wav'),r.text==='corrupt'?Buffer.alloc(3):bytes)
  send(r,'audio-ready',{audioId:r.audioId,binding:r.binding,segmentIndex:r.segmentIndex,generationMs:1,rtf:0.01})
 }
})
