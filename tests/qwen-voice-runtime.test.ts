import {afterEach,expect,it} from 'vitest'
import {mkdtemp,rm,readdir} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {spawn} from 'node:child_process'
import {TtsRuntimeSupervisor} from '../electron/main/character-voice/TtsRuntimeSupervisor'
import {isStreamingProfile,type SpeechBinding} from '../electron/shared/character-voice-contract'
const clean:Array<()=>Promise<unknown>>=[]
afterEach(async()=>{for(const fn of clean.splice(0))await fn()})
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'qwen-runtime-'))
 const w=new TtsRuntimeSupervisor({engine:'qwen3-tts-06b',qwen:{mode:'x-vector',transcript:''},python:process.execPath,model:root,worker:resolve('tests/fixtures/voice-worker.cjs'),cacheRoot:root,executionProfile:'qwen-complete'},3000,(_cmd,_args,opt)=>spawn(process.execPath,[resolve('tests/fixtures/voice-worker.cjs')],opt))
 clean.push(async()=>{await w.stop();await rm(root,{recursive:true,force:true})})
 const condition={kind:'wav-reference' as const,path:join(root,'reference.wav'),sha256:'a'.repeat(64),fingerprint:'b'.repeat(64),preprocessingVersion:'mono-pcm16-round-v1',sampleRate:24000,samples:48000}
 const start=()=>w.start(root,'qwen-reference',condition)
 const binding=()=>({engine:'qwen3-tts-06b',executionProfile:'qwen-complete',runtimeSessionId:w.sessionId,conditioningFingerprint:condition.fingerprint,effectiveSeed:42,speechEpoch:1}) as SpeechBinding
 return{w,root,start,binding}
}
it('Qwen capability routes only complete audio and prewarms separately',async()=>{
 expect(isStreamingProfile('qwen-complete')).toBe(false)
 const {w,start,binding}=await fixture();await start();expect(w.audit?.warmed).toBe(false)
 await w.prewarm();expect(w.audit?.warmed).toBe(true)
 expect((await w.synthesize('valid',binding(),0)).durationMs).toBe(100)
})
it('Qwen active cancellation terminates its owned worker and cache before a fresh session',async()=>{
 const {w,root,start,binding}=await fixture();await start();const old=w.sessionId
 const pending=w.synthesize('hang',binding(),0).catch(e=>e.message)
 const result=await w.cancelSpeech()
 expect(result).toMatchObject({keptWarm:false,fallback:'qwen-owned-process-termination'})
 expect(await pending).toBe('VOICE_CANCELLED');expect(w.running).toBe(false);expect(await readdir(root)).toEqual([])
 await start();expect(w.sessionId).not.toBe(old);expect((await w.synthesize('valid',binding(),0)).durationMs).toBe(100)
})
it('Qwen rejects stale reference and session before producing audio',async()=>{
 const {w,start,binding}=await fixture();await start()
 await expect(w.synthesize('valid',{...binding(),conditioningFingerprint:'c'.repeat(64)},0)).rejects.toThrow('VOICE_REFERENCE_BINDING')
 await expect(w.synthesize('valid',{...binding(),runtimeSessionId:'old'},0)).rejects.toThrow('VOICE_SESSION')
})

it('Qwen refuses a worker whose streaming capability does not match the backend',async()=>{
 const {w,root}=await fixture()
 await expect(w.start(root+'bad-qwen-capabilities','bad',{kind:'wav-reference',path:join(root,'reference.wav'),sha256:'a'.repeat(64),fingerprint:'b'.repeat(64),preprocessingVersion:'mono-pcm16-round-v1',sampleRate:24000,samples:48000})).rejects.toThrow('QWEN_CAPABILITIES')
 expect(w.running).toBe(false);expect(await readdir(root)).toEqual([])
})
