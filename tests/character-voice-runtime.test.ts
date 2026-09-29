import {afterEach,expect,it,vi} from 'vitest'
import {mkdtemp,rm,readdir} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {spawn} from 'node:child_process'
import {TtsRuntimeSupervisor} from '../electron/main/character-voice/TtsRuntimeSupervisor'
import type {SpeechBinding} from '../electron/shared/character-voice-contract'
const roots:string[]=[],workers:TtsRuntimeSupervisor[]=[]
afterEach(async()=>{for(const w of workers.splice(0))await w.stop();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true})})
async function worker(){const root=await mkdtemp(join(tmpdir(),'tts-runtime-'));roots.push(root)
 // Hosted Windows startup can exceed 500 ms under the full suite. Keep a bounded
 // failure deadline without turning process scheduling into a cancellation race.
 const w=new TtsRuntimeSupervisor({python:process.execPath,model:root,worker:resolve('tests/fixtures/voice-worker.cjs'),cacheRoot:root},2000,(_exe,_args,options)=>spawn(process.execPath,[resolve('tests/fixtures/voice-worker.cjs')],options));workers.push(w);return{w,root}}
const binding=(w:TtsRuntimeSupervisor)=>({effectiveSeed:42,runtimeSessionId:w.sessionId,characterId:'test',requestId:'request',speechEpoch:1}) as SpeechBinding
it('reuses a ready worker, validates WAV bytes and deletes generated files',async()=>{const {w,root}=await worker();await w.start(root,'fingerprint');const id=w.sessionId;await w.start(root,'fingerprint');expect(w.sessionId).toBe(id);const audio=await w.synthesize('synthetic',binding(w),0);expect(audio.durationMs).toBe(100);expect(audio.bytes.byteLength).toBe(9644);await w.stop();expect(w.running).toBe(false);expect(await readdir(root)).toEqual([])})
it.each(['crash','contaminate','partial'])('rejects %s without leaving an owned worker',async mode=>{const {w,root}=await worker();await expect(w.start(join(root,mode),'x')).rejects.toThrow();await w.stop();expect(w.running).toBe(false)})
it.each(['oom','corrupt','hang'])('rejects %s and recovers after restart',async text=>{const {w,root}=await worker();await w.start(root,'x');await expect(w.synthesize(text,binding(w),0)).rejects.toThrow();await w.stop();await w.start(root,'x');expect((await w.synthesize('valid',binding(w),0)).durationMs).toBe(100)})
it('cancels a blocking synthesis and waits for process exit before restart',async()=>{const {w,root}=await worker();await w.start(root,'x');const job=w.synthesize('hang',binding(w),0);const result=expect(job).rejects.toThrow('CANCELLED');await w.stop();await result;expect(w.running).toBe(false);await w.start(root,'x');expect((await w.synthesize('valid',binding(w),0)).durationMs).toBe(100)})
it('cancellation during cache creation cannot spawn a late worker',async()=>{const {w,root}=await worker();const job=w.start(root,'x');const rejected=expect(job).rejects.toThrow('CANCELLED');await w.stop();await rejected;expect(w.running).toBe(false);expect(await readdir(root)).toEqual([])})
it('an immediate restart drains cancelled initialization instead of inheriting its rejection',async()=>{const {w,root}=await worker();const old=w.start(root,'x').catch(e=>e.message);await w.stop();await w.start(root,'x');expect(await old).toBe('VOICE_CANCELLED');expect((await w.synthesize('valid',binding(w),0)).durationMs).toBe(100)})
it('streams silent chunks incrementally with bounded credits and final totals',async()=>{
 const {w,root}=await worker();await w.start(root,'x');const chunks:any[]=[],release:Array<()=>void>=[]
 const pending=w.stream('stream',binding(w),0,chunk=>{chunks.push(chunk);return new Promise<void>(r=>release.push(r))})
 await vi.waitFor(()=>expect(chunks).toHaveLength(3));expect(w.busy).toBe(true);expect(chunks.map(c=>c.sampleOffset)).toEqual([0,4800,9600]);release[0]()
 const done=await pending;expect(done.totalChunks).toBe(4);expect(chunks).toHaveLength(4);expect(w.busy).toBe(false);release.forEach(r=>r());await w.stop();expect(await readdir(root)).toEqual([])
})
it.each(['duplicate','offset','total'])('rejects invalid stream %s metadata',async mode=>{
 const {w,root}=await worker();await w.start(root,'x');await expect(w.stream(mode,binding(w),0,async()=>{})).rejects.toThrow();await w.stop();expect(w.running).toBe(false)
})
it('cancels credit-blocked generation and starts a clean replacement',async()=>{
 const {w,root}=await worker();await w.start(root,'x');let count=0
 const pending=w.stream('stream',binding(w),0,()=>{count++;return new Promise(()=>{})});const cancelled=expect(pending).rejects.toThrow('CANCELLED')
 await vi.waitFor(()=>expect(count).toBe(3));await w.stop();await cancelled;await w.start(root,'x');expect((await w.synthesize('valid',binding(w),0)).durationMs).toBe(100)
})
it('late playback rejection from an old session cannot stop its replacement',async()=>{
 const {w,root}=await worker();await w.start(root,'x');let rejectOld!:(error:Error)=>void
 await w.stream('stream',binding(w),0,chunk=>chunk.chunkIndex===3?new Promise<void>((_resolve,reject)=>{rejectOld=reject}):Promise.resolve())
 await w.stop();await w.start(root,'x');const replacement=w.sessionId,stop=vi.spyOn(w,'stop')
 rejectOld(Error('VOICE_PLAYBACK'));await new Promise(r=>setTimeout(r,30))
 expect(stop).not.toHaveBeenCalled();expect(w.running).toBe(true);expect(w.sessionId).toBe(replacement)
 expect((await w.synthesize('valid',binding(w),0)).durationMs).toBe(100)
})
it('retired same-session playback rejections cannot cancel repeated warm replacements',async()=>{
 const {w,root}=await worker();await w.start(root,'x');const session=w.sessionId,stop=vi.spyOn(w,'stop')
 for(let epoch=1;epoch<=3;epoch++){
  let rejectOld!:(e:Error)=>void
  await w.stream('stream',{...binding(w),speechEpoch:epoch},0,chunk=>chunk.chunkIndex===3?new Promise<void>((_r,reject)=>{rejectOld=reject}):Promise.resolve())
  w.retireSpeech()
  const next=w.synthesize('valid',{...binding(w),speechEpoch:epoch+1},0)
  rejectOld(Error('VOICE_PLAYBACK'));expect((await next).durationMs).toBe(100)
  expect(w.sessionId).toBe(session);expect(w.running).toBe(true);expect(stop).not.toHaveBeenCalled()
 }
})
it.each(['stream','cancel-terminal'])('R2 cancels %s and reuses its session without stopping',async mode=>{
 const {w,root}=await worker();await w.start(root,'x');const session=w.sessionId,stop=vi.spyOn(w,'stop');let chunks=0
 const old=w.stream(mode,binding(w),0,()=>{chunks++;return new Promise(()=>{})}).catch(e=>e.message)
 await vi.waitFor(()=>expect(chunks).toBe(3))
 const result=await w.cancelSpeech()
 expect(result.keptWarm).toBe(true);expect(await old).toBe('VOICE_CANCELLED');expect(stop).not.toHaveBeenCalled();expect(w.sessionId).toBe(session)
 expect((await w.synthesize('valid',{...binding(w),speechEpoch:2},0)).durationMs).toBe(100)
})
it.each(['cancel-timeout','cancel-wrong','cancel-crash'])('R2 %s falls back to owned exit before recovery',async mode=>{
 const {w,root}=await worker();await w.start(root,'x');const oldSession=w.sessionId;let chunks=0
 const old=w.stream(mode,binding(w),0,()=>{chunks++;return new Promise(()=>{})}).catch(e=>e.message)
 await vi.waitFor(()=>expect(chunks).toBe(3))
 const result=await w.cancelSpeech(100);expect(result.keptWarm).toBe(false);expect(w.running).toBe(false)
 expect(await old).toBe(mode==='cancel-wrong'?'VOICE_PROTOCOL':mode==='cancel-crash'?'VOICE_WORKER_EXIT':'VOICE_CANCELLED')
 await w.start(root,'x');expect(w.sessionId).not.toBe(oldSession);expect((await w.synthesize('valid',binding(w),0)).durationMs).toBe(100)
})
it.each(['initialization','baseline'])('R2 %s keeps owned-process termination fallback',async mode=>{
 const {w,root}=await worker()
 if(mode==='baseline')await w.start(root,'x')
 const pending=(mode==='baseline'?w.synthesize('hang',binding(w),0):w.start(root,'x')).catch(e=>e.message)
 const result=await w.cancelSpeech()
 expect(result.keptWarm).toBe(false);expect(result.fallback).toBe('non-streaming');expect(await pending).toBe('VOICE_CANCELLED');expect(w.running).toBe(false)
 await w.start(root,'x');expect((await w.synthesize('valid',binding(w),0)).durationMs).toBe(100)
})
it('rejects legacy seed capability before starting speech',async()=>{const {w,root}=await worker();await expect(w.start(join(root,'old-seed'),'old')).rejects.toThrow('VOICE_SEED_UNSUPPORTED');expect(w.running).toBe(false)})
it.each([0,-1,1.5,true,'42',undefined,2147483648])('rejects invalid supervisor seed %s',async seed=>{const {w,root}=await worker();await w.start(root,'valid');await expect(w.stream('stream',{...binding(w),effectiveSeed:seed} as any,0,async()=>{})).rejects.toThrow('VOICE_SEED_INVALID')})
it.each(['stream','synthesize'] as const)('rejects mismatched applied seed before %s audio delivery',async mode=>{const {w,root}=await worker();await w.start(root,'valid');const delivered=vi.fn(async()=>{});await expect(mode==='stream'?w.stream('wrong-seed',binding(w),0,delivered):w.synthesize('wrong-seed',binding(w),0)).rejects.toThrow('VOICE_SEED_MISMATCH');expect(delivered).not.toHaveBeenCalled()})
