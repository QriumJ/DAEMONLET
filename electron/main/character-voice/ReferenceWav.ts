import policy from '../../voice/reference-policy.json'
export const REFERENCE_POLICY=Object.freeze(policy)
export type ReferenceAudio={durationMs:number;sampleRate:number;channels:1;encoding:'pcm16';samples:number;bytes:number}
export function canonicalReferenceWav(input:Buffer):{wav:Buffer;audio:ReferenceAudio}{
 const fail=(code='VOICE_REFERENCE_FORMAT'):never=>{throw Error(code)}
 if(input.length>policy.maxSourceBytes)fail('VOICE_REFERENCE_SIZE')
 if(input.length<44||input.toString('latin1',0,4)!=='RIFF'||input.toString('latin1',8,12)!=='WAVE'||input.readUInt32LE(4)+8!==input.length)fail()
 let fmt:Buffer|undefined,data:Buffer|undefined,chunks=0,pos=12
 while(pos<input.length){
  if(++chunks>policy.maxChunks||pos+8>input.length)fail()
  const size=input.readUInt32LE(pos+4),end=pos+8+size,next=end+(size&1),id=input.toString('latin1',pos,pos+4)
  if(end>input.length||next>input.length)fail()
  if(id==='fmt '){if(fmt||![16,18].includes(size))fail();fmt=input.subarray(pos+8,end);if(size===18&&fmt.readUInt16LE(16)!==0)fail()}
  if(id==='data'){if(data)fail();data=input.subarray(pos+8,end)}
  pos=next
 }
 if(!fmt||!data||!data.length)fail()
 const f=fmt!,d=data!,encoding=f.readUInt16LE(0),channels=f.readUInt16LE(2),rate=f.readUInt32LE(4),bits=f.readUInt16LE(14),width=bits/8
 if(!policy.sampleRates.includes(rate)||![1,2].includes(channels)||!(encoding===1&&[16,24].includes(bits)||encoding===3&&bits===32))fail('VOICE_REFERENCE_UNSUPPORTED')
 if(f.readUInt16LE(12)!==channels*width||f.readUInt32LE(8)!==rate*channels*width||d.length%(channels*width))fail()
 const samples=d.length/(channels*width),seconds=samples/rate
 if(seconds<policy.minSeconds||seconds>policy.maxSeconds)fail('VOICE_REFERENCE_DURATION')
 const wav=Buffer.alloc(44+samples*2);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(rate,24);wav.writeUInt32LE(rate*2,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(samples*2,40)
 let sum=0,squared=0
 for(let i=0;i<samples;i++){
  let v=0
  for(let ch=0;ch<channels;ch++){
   const offset=(i*channels+ch)*width,x=encoding===3?d.readFloatLE(offset):bits===16?d.readInt16LE(offset)/32768:d.readIntLE(offset,3)/8388608
   if(!Number.isFinite(x)||x< -1||x>1)fail('VOICE_REFERENCE_SAMPLES')
   v+=x/channels
  }
  const value=Math.max(-32768,Math.min(32767,Math.floor(v*32768+0.5)));wav.writeInt16LE(value,44+i*2);sum+=value/32768;squared+=(value/32768)**2
 }
 if(Math.sqrt(Math.max(0,squared/samples-(sum/samples)**2))<policy.minAcRms)fail('VOICE_REFERENCE_SILENT')
 return{wav,audio:{durationMs:seconds*1000,sampleRate:rate,channels:1,encoding:'pcm16',samples,bytes:wav.length}}
}
// Main only checks the small canonical header. Sample decoding stays in the import worker and inference worker.
export function canonicalHeaderMatches(bytes:Buffer,a:ReferenceAudio){return !!a&&bytes.length>=44&&policy.sampleRates.includes(a.sampleRate)&&Number.isSafeInteger(a.samples)&&a.samples>=a.sampleRate*policy.minSeconds&&a.samples<=a.sampleRate*policy.maxSeconds&&a.channels===1&&a.encoding==='pcm16'&&a.durationMs===a.samples/a.sampleRate*1000&&bytes.length===a.bytes&&bytes.length===44+a.samples*2&&bytes.toString('latin1',0,4)==='RIFF'&&bytes.readUInt32LE(4)===bytes.length-8&&bytes.toString('latin1',8,16)==='WAVEfmt '&&bytes.readUInt32LE(16)===16&&bytes.readUInt16LE(20)===1&&bytes.readUInt16LE(22)===1&&bytes.readUInt32LE(24)===a.sampleRate&&bytes.readUInt32LE(28)===a.sampleRate*2&&bytes.readUInt16LE(32)===2&&bytes.readUInt16LE(34)===16&&bytes.toString('latin1',36,40)==='data'&&bytes.readUInt32LE(40)===a.samples*2}
