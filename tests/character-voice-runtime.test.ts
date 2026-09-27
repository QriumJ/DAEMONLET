import {afterEach,expect,it} from 'vitest'
import {mkdtemp,rm,readdir} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {spawn} from 'node:child_process'
import {TtsRuntimeSupervisor} from '../electron/main/character-voice/TtsRuntimeSupervisor'
import type {SpeechBinding} from '../electron/shared/character-voice-contract'
const roots:string[]=[],workers:TtsRuntimeSupervisor[]=[]
afterEach(async()=>{for(const w of workers.splice(0))await w.stop();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true})})
async function worker(){const root=await mkdtemp(join(tmpdir(),'tts-runtime-'));roots.push(root)
 const w=new TtsRuntimeSupervisor({python:process.execPath,model:root,worker:resolve('tests/fixtures/voice-worker.cjs'),cacheRoot:root},500,(_exe,_args,options)=>spawn(process.execPath,[resolve('tests/fixtures/voice-worker.cjs')],options));workers.push(w);return{w,root}}
const binding=(w:TtsRuntimeSupervisor)=>({runtimeSessionId:w.sessionId,characterId:'test',requestId:'request',speechEpoch:1}) as SpeechBinding
it('reuses a ready worker, validates WAV bytes and deletes generated files',async()=>{const {w,root}=await worker();await w.start(root,'fingerprint');const id=w.sessionId;await w.start(root,'fingerprint');expect(w.sessionId).toBe(id);const audio=await w.synthesize('synthetic',binding(w),0);expect(audio.durationMs).toBe(100);expect(audio.bytes.byteLength).toBe(9644);await w.stop();expect(w.running).toBe(false);expect(await readdir(root)).toEqual([])})
it.each(['crash','contaminate','partial'])('rejects %s without leaving an owned worker',async mode=>{const {w,root}=await worker();await expect(w.start(join(root,mode),'x')).rejects.toThrow();await w.stop();expect(w.running).toBe(false)})
it.each(['oom','corrupt','hang'])('rejects %s and recovers after restart',async text=>{const {w,root}=await worker();await w.start(root,'x');await expect(w.synthesize(text,binding(w),0)).rejects.toThrow();await w.stop();await w.start(root,'x');expect((await w.synthesize('valid',binding(w),0)).durationMs).toBe(100)})
it('cancels a blocking synthesis and waits for process exit before restart',async()=>{const {w,root}=await worker();await w.start(root,'x');const job=w.synthesize('hang',binding(w),0);const result=expect(job).rejects.toThrow('CANCELLED');await w.stop();await result;expect(w.running).toBe(false);await w.start(root,'x');expect((await w.synthesize('valid',binding(w),0)).durationMs).toBe(100)})
it('cancellation during cache creation cannot spawn a late worker',async()=>{const {w,root}=await worker();const job=w.start(root,'x');const rejected=expect(job).rejects.toThrow('CANCELLED');await w.stop();await rejected;expect(w.running).toBe(false);expect(await readdir(root)).toEqual([])})
it('an immediate restart drains cancelled initialization instead of inheriting its rejection',async()=>{const {w,root}=await worker();const old=w.start(root,'x').catch(e=>e.message);await w.stop();await w.start(root,'x');expect(await old).toBe('VOICE_CANCELLED');expect((await w.synthesize('valid',binding(w),0)).durationMs).toBe(100)})
