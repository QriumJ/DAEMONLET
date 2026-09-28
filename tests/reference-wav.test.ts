import {describe,expect,it} from 'vitest'
import {canonicalReferenceWav,REFERENCE_POLICY as p} from '../electron/main/character-voice/ReferenceWav'
import {referenceWav,extraChunk} from './helpers/reference-wav'

describe('bounded reference WAV decoding',()=>{
 for(const rate of p.sampleRates)for(const channels of [1,2])for(const [bits,float] of [[16,false],[24,false],[32,true]] as const)it(`${rate}Hz ${channels}ch ${bits}bit ${float?'float':'PCM'} has the same deterministic canonical PCM`,()=>{
  const source=referenceWav({rate,channels,bits,float});const {wav,audio}=canonicalReferenceWav(source)
  expect(wav).toEqual(referenceWav({rate}));expect(audio).toMatchObject({sampleRate:rate,durationMs:2000,channels:1,encoding:'pcm16'});expect(canonicalReferenceWav(wav).wav).toEqual(wav)
 })
 it.each([2,20])('accepts exact duration boundary %s seconds',seconds=>expect(canonicalReferenceWav(referenceWav({seconds})).audio.durationMs).toBe(seconds*1000))
 it.each([2-1/16000,20+1/16000])('rejects duration outside the boundary %s',seconds=>expect(()=>canonicalReferenceWav(referenceWav({seconds}))).toThrow('VOICE_REFERENCE_DURATION'))
 it('bounds raw input before parsing and accepts exactly the byte cap',()=>{
  const input=referenceWav(),pad=p.maxSourceBytes-input.length-8;const max=extraChunk(input,'JUNK',Buffer.alloc(pad));expect(max.length).toBe(p.maxSourceBytes);expect(canonicalReferenceWav(max).wav).toEqual(input)
  expect(()=>canonicalReferenceWav(Buffer.concat([max,Buffer.alloc(1)]))).toThrow('VOICE_REFERENCE_SIZE')
 })
 it('bounds chunk count and checks odd padding',()=>{
  let input=referenceWav();for(let i=0;i<p.maxChunks-2;i++)input=extraChunk(input,'JUNK',Buffer.alloc(0));expect(()=>canonicalReferenceWav(input)).not.toThrow();expect(()=>canonicalReferenceWav(extraChunk(input,'JUNK',Buffer.alloc(0)))).toThrow()
  expect(canonicalReferenceWav(extraChunk(referenceWav(),'JUNK',Buffer.from([1]))).audio.durationMs).toBe(2000)
  const invalid=Buffer.concat([referenceWav(),Buffer.from('JUNK'),Buffer.from([1,0,0,0,0])]);invalid.writeUInt32LE(invalid.length-8,4);expect(()=>canonicalReferenceWav(invalid)).toThrow()
 })
 it.each(['RF64','RIFX','FAKE'])('rejects %s containers',id=>{const b=referenceWav();b.write(id);expect(()=>canonicalReferenceWav(b)).toThrow()})
 it.each([0,1,2,43,44,45,1024])('rejects truncated input at %s',length=>expect(()=>canonicalReferenceWav(referenceWav().subarray(0,length))).toThrow())
 it('rejects duplicate required chunks and missing data',()=>{
  expect(()=>canonicalReferenceWav(extraChunk(referenceWav(),'fmt ',Buffer.alloc(16)))).toThrow()
  expect(()=>canonicalReferenceWav(extraChunk(referenceWav(),'data',Buffer.alloc(0)))).toThrow()
  const b=referenceWav();b.write('JUNK',36);expect(()=>canonicalReferenceWav(b)).toThrow()
 })
 it.each([6,7,0xfffe])('rejects unsupported format %s',format=>{const b=referenceWav();b.writeUInt16LE(format,20);expect(()=>canonicalReferenceWav(b)).toThrow('UNSUPPORTED')})
 it('rejects oversized chunks, byte rate and frame alignment lies',()=>{
  for(const [offset,value] of [[40,0xffffffff],[28,1]]){const b=referenceWav();b.writeUInt32LE(value,offset);expect(()=>canonicalReferenceWav(b)).toThrow()}
  const b=referenceWav();b.writeUInt16LE(4,32);expect(()=>canonicalReferenceWav(b)).toThrow()
 })
 it.each([NaN,Infinity,-Infinity,1.01,-1.01])('rejects invalid float sample %s',value=>{const b=referenceWav({bits:32,float:true});b.writeFloatLE(value,44);expect(()=>canonicalReferenceWav(b)).toThrow('SAMPLES')})
 it('rejects silence, near silence and DC; downmix does not normalize cancellation',()=>{
  expect(()=>canonicalReferenceWav(referenceWav({silent:true}))).toThrow('SILENT')
  const b=referenceWav();for(let i=44;i<b.length;i+=2)b.writeInt16LE(1000,i);expect(()=>canonicalReferenceWav(b)).toThrow('SILENT')
  const quiet=referenceWav();for(let i=44;i<quiet.length;i+=2)quiet.writeInt16LE((i%4)?1:-1,i);expect(()=>canonicalReferenceWav(quiet)).toThrow('SILENT')
  const stereo=referenceWav({channels:2});for(let i=44;i<stereo.length;i+=4)stereo.writeInt16LE(-stereo.readInt16LE(i),i+2);expect(()=>canonicalReferenceWav(stereo)).toThrow('SILENT')
 })
})
