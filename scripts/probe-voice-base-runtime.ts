// Explicit integration probe: the application's supervisor and both playback modes.
import {mkdir,writeFile} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {createHash} from 'node:crypto'
import assert from 'node:assert/strict'
import {TtsRuntimeSupervisor} from '../electron/main/character-voice/TtsRuntimeSupervisor'
import type {SpeechBinding} from '../electron/shared/character-voice-contract'
import defaults from '../electron/voice/base-voice-defaults.json'
const [kind,executable,model,worker,output,compilerCache]=process.argv.slice(2)
if(!['metal','cuda'].includes(kind)||!output)throw Error('Pass metal|cuda, executable, model, worker, NEW private output')
const root=resolve(output);await mkdir(root)
const config={python:resolve(executable),model:resolve(model),worker:resolve(worker),cacheRoot:join(root,'cache'),compilerCache:compilerCache?resolve(compilerCache):join(root,'compiler-cache'),nativeBase:kind==='metal',windowsBase:kind==='cuda',executionProfile:kind==='metal'?'gguf-metal-f16' as const:'cuda-compiled' as const}
const runtime=new TtsRuntimeSupervisor(config)
const report:Record<string,any>={status:'RUNNING',scope:'application supervisor; no physical playback',kind,measurements:[]}
let epoch=0
const binding=()=>({runtimeSessionId:runtime.sessionId,characterId:'diagnostic',revision:'diagnostic',conversationId:'diagnostic',messageId:'diagnostic',requestId:'diagnostic',epoch:1,speechEpoch:++epoch,personaHash:'diagnostic',semanticHash:'diagnostic',modelId:'12B',voiceProfileId:'voxcpm2_default',voiceProfileVersion:'default',voiceFingerprint:'default',executionProfile:config.executionProfile}) as SpeechBinding
const text='응, 듣고 있어. 지금은 어떤 이야기를 할까?'
try{
 await runtime.start('', 'default-female');const session=runtime.sessionId
 report.audit=runtime.audit;assert.deepEqual(report.audit.defaultVoice,defaults)
 const chunks:Buffer[]=[]
 report.measurements.push(await runtime.stream(text,binding(),0,async c=>{chunks.push(Buffer.from(c.bytes.subarray(44)))}))
 const hash=createHash('sha256').update(Buffer.concat(chunks)).digest('hex')
 let unblock!:()=>void;const blocked=new Promise<void>(r=>unblock=r);let count=0
 const pending=runtime.stream('기본 모델의 음성 시험입니다. 잠시 중단했다가 다시 이야기할게요.',binding(),0,()=>{if(++count===3)unblock();return new Promise(()=>{})}).then(()=>{throw Error('Expected cancellation')},e=>e.message)
 await blocked;report.cancel=await runtime.cancelSpeech();assert.equal(await pending,'VOICE_CANCELLED');assert.equal(report.cancel.keptWarm,true);assert.equal(runtime.sessionId,session)
 // The complete mode collects the same worker stream before delivering one WAV.
 config.executionProfile=(kind==='metal'?'gguf-metal-f16-complete':'cuda-compiled-complete') as typeof config.executionProfile
 const full=await runtime.synthesize(text,binding(),0)
 assert.equal(createHash('sha256').update(full.bytes.subarray(44)).digest('hex'),hash)
 report.complete={rtf:full.rtf,generationMs:full.generationMs,durationMs:full.durationMs,bytes:full.bytes.length,sameSession:runtime.sessionId===session}
 await writeFile(join(root,'female-default.wav'),full.bytes)
 report.status='PASS'
}catch(e){report.status='FAIL';report.error=String(e);throw e}
finally{await runtime.stop();report.ownedWorkerExited=!runtime.running;await writeFile(join(root,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report))}
