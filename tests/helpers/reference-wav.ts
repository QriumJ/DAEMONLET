// Synthetic periodic PCM, generated in memory; never a recording or cloned voice.
export function referenceWav({rate=16000,seconds=2,bits=16,channels=1,float=false,silent=false}:{rate?:number;seconds?:number;bits?:number;channels?:number;float?:boolean;silent?:boolean}={}){
 const samples=Math.floor(rate*seconds),width=bits/8,data=Buffer.alloc(samples*channels*width),cycle=[0,8192,16384,-8192,-16384]
 for(let i=0;i<samples;i++)for(let ch=0;ch<channels;ch++){
  const v=silent?0:cycle[i%cycle.length],offset=(i*channels+ch)*width
  if(float)data.writeFloatLE(v/32768,offset);else data.writeIntLE(bits===24?v*256:v,offset,width)
 }
 const out=Buffer.alloc(44+data.length);out.write('RIFF');out.writeUInt32LE(out.length-8,4);out.write('WAVEfmt ',8);out.writeUInt32LE(16,16);out.writeUInt16LE(float?3:1,20);out.writeUInt16LE(channels,22);out.writeUInt32LE(rate,24);out.writeUInt32LE(rate*channels*width,28);out.writeUInt16LE(channels*width,32);out.writeUInt16LE(bits,34);out.write('data',36);out.writeUInt32LE(data.length,40);data.copy(out,44);return out
}
export function extraChunk(wav:Buffer,id:string,data:Buffer){const chunk=Buffer.alloc(8+data.length+(data.length&1));chunk.write(id);chunk.writeUInt32LE(data.length,4);data.copy(chunk,8);const out=Buffer.concat([wav.subarray(0,12),chunk,wav.subarray(12)]);out.writeUInt32LE(out.length-8,4);return out}
