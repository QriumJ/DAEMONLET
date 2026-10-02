import {afterEach,expect,it,vi} from 'vitest'
import {EventEmitter} from 'node:events'
import {PassThrough} from 'node:stream'
import {mkdtemp,rm,readdir,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {randomUUID} from 'node:crypto'
import type {SpeechBinding} from '../electron/shared/character-voice-contract'

// No Python, native library, inference or actual taskkill is executed here.
const treeKill=vi.hoisted(()=>vi.fn())
vi.mock('node:child_process',async importOriginal=>({...await importOriginal<typeof import('node:child_process')>(),spawn:treeKill}))
import {TtsRuntimeSupervisor,type TtsConfig} from '../electron/main/character-voice/TtsRuntimeSupervisor'

const clean:Array<()=>Promise<unknown>>=[]
afterEach(async()=>{for(const fn of clean.splice(0))await fn();vi.unstubAllGlobals();treeKill.mockReset()})
const capabilities={engine:'qwen3-tts-06b-gguf',synthesisStreaming:true,cancellation:'cooperative-with-process-fallback',warmCancellationReuse:true,backend:'cuda:0',backendDevice:'CUDA0',abiVersion:5}
const wav=()=>{const bytes=Buffer.alloc(9644);bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(48000,24);bytes.writeUInt32LE(96000,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(9600,40);return bytes}
async function fixture(options:{capabilities?:Record<string,unknown>;shutdown?:'hang';cancel?:'hang'|'wrong-target';badChunk?:boolean;initialChunkBarrier?:Promise<void>;config?:Partial<TtsConfig>}={}){
 vi.stubGlobal('process',{...process,platform:'win32',arch:'x64'})
 const root=await mkdtemp(join(tmpdir(),'qwen-gguf-supervisor-')),requests:any[]=[],children:any[]=[]
 const condition={kind:'wav-reference' as const,path:join(root,'reference.wav'),sha256:'a'.repeat(64),fingerprint:'b'.repeat(64),preprocessingVersion:'mono-pcm16-round-v1',sampleRate:24000,samples:48000}
 let active:any,cache=''
 const config:TtsConfig={engine:'qwen3-tts-06b-gguf',qwen:{mode:'x-vector',transcript:''},ggufRuntime:join(root,'dll'),python:process.execPath,model:root,worker:join(root,'worker.py'),cacheRoot:join(root,'cache'),executionProfile:'qwen-gguf',...options.config}
 const runtime=new TtsRuntimeSupervisor(config,2000,()=>{
  const child:any=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.pid=24680+children.length;child.exitCode=null;child.signalCode=null
  child.close=()=>{if(child.exitCode!==null)return;child.exitCode=0;queueMicrotask(()=>child.emit('close',0))};child.kill=vi.fn(()=>{child.close();return true});children.push(child)
  const send=(r:any,type:string,extra:object={})=>child.stdout.write(JSON.stringify({protocolVersion:1,requestId:r.requestId,type,...(r.seed===undefined?{}:{effectiveSeed:r.seed}),...extra})+'\n')
  const chunk=async(r:any,index:number)=>{const audioId=randomUUID();await writeFile(join(cache,audioId+'.wav'),wav());send(r,'audio-chunk',{synthesisId:r.synthesisId,audioId,binding:r.binding,segmentIndex:r.segmentIndex,chunkIndex:options.badChunk?999:index,sampleOffset:index*4800,sampleCount:4800,sampleRate:48000,firstChunkReadyMs:1})}
  child.stdin.on('data',(bytes:Buffer)=>{for(const line of bytes.toString().trim().split('\n')){
   const r=JSON.parse(line);requests.push(r)
   if(r.type==='init'){cache=r.cache;queueMicrotask(()=>send(r,'ready',{seedContract:1,capabilities:{...capabilities,...options.capabilities},mode:'wav-reference',referenceContract:1,referenceSha256:condition.sha256,conditioningFingerprint:condition.fingerprint,referenceCacheBuilds:1,adapterSha256:null,defaultVoice:null,loaded:true,warmed:false,modelVerification:r.modelVerification}))}
   if(r.type==='prewarm')queueMicrotask(()=>send(r,'warmed',{loaded:true,warmed:true,ready:true}))
   if(r.type==='synthesize'&&r.text!=='hang')void writeFile(join(cache,r.audioId+'.wav'),wav()).then(()=>send(r,'audio-ready',{audioId:r.audioId,binding:r.binding,segmentIndex:r.segmentIndex,generationMs:1,rtf:.01}))
   if(r.type==='stream'){
    const producer={request:r,initial:Promise.resolve(),completion:null as Promise<void>|null};active=producer
    producer.initial=(async()=>{for(let i=0;i<3;i++){if(i===1)await options.initialChunkBarrier;if(active!==producer)return;await chunk(r,i);if(options.badChunk)return}})()
   }
   if(r.type==='credit'&&r.chunkIndex===0&&active?.request.requestId===r.requestId&&!active.completion){
    const producer=active
    // Credits permit the next chunk; they never race a second producer against
    // the three initial writes. The native worker also has one ordered producer.
    producer.completion=producer.initial.then(async()=>{if(active!==producer)return;await chunk(producer.request,3);if(active!==producer)return;active=null;send(producer.request,'synthesis-finished',{synthesisId:producer.request.synthesisId,totalSamples:19200,totalChunks:4})})
   }
   if(r.type==='cancel-stream'&&options.cancel!=='hang'){active=null;queueMicrotask(()=>send(r,'cancelled',{target:options.cancel==='wrong-target'?{...r.target,speechEpoch:999}:r.target,cleanupComplete:true,keptWarm:true,boundary:'native-return',reuseAudit:{nativeContextRetained:true}}))}
   if(r.type==='shutdown'&&options.shutdown!=='hang'){send(r,'shutdown-complete',{cleanupComplete:true});child.close()}
  }})
  return child
 })
 treeKill.mockImplementation((_exe,args)=>{const killer=new EventEmitter();queueMicrotask(()=>{children.find(child=>String(child.pid)===args[1])?.close();killer.emit('exit',0)});return killer})
 clean.push(async()=>{await runtime.stop();await rm(root,{recursive:true,force:true})})
 const start=()=>runtime.start('', 'gguf-fingerprint',condition)
 const binding=(epoch=1)=>({engine:config.engine,executionProfile:config.executionProfile,runtimeSessionId:runtime.sessionId,conditioningFingerprint:condition.fingerprint,effectiveSeed:42,speechEpoch:epoch}) as SpeechBinding
 return{runtime,root,condition,config,requests,children,start,binding}
}

it('admits pinned GGUF capabilities, forces full model checks and retains a prewarmed session',async()=>{
 const f=await fixture({config:{modelVerification:'installed'}});await f.start();const session=f.runtime.sessionId
 expect(f.requests[0]).toMatchObject({ggufRuntime:f.config.ggufRuntime,engine:'qwen3-tts-06b-gguf',executionProfile:'qwen-gguf',conditioning:f.condition,modelVerification:'full'})
 await f.runtime.prewarm();expect(f.runtime.audit?.warmed).toBe(true);await f.start();expect(f.children).toHaveLength(1);expect(f.runtime.sessionId).toBe(session)
 await expect(f.runtime.stream('valid',{...f.binding(),conditioningFingerprint:'old'},0,async()=>{})).rejects.toThrow('VOICE_REFERENCE_BINDING')
 expect(f.requests.some(r=>r.type==='stream')).toBe(false)
})

it.each(['qwen-gguf-vulkan','qwen-gguf-vulkan-complete'] as const)('requires the selected Vulkan backend for %s',async executionProfile=>{
 const f=await fixture({config:{executionProfile},capabilities:{backend:'vulkan:0',backendDevice:'Vulkan0'}});await f.start()
 expect(f.requests[0]).toMatchObject({engine:'qwen3-tts-06b-gguf',ggufRuntime:f.config.ggufRuntime,executionProfile});expect(f.runtime.ready).toBe(true)
 const wrong=await fixture({config:{executionProfile}});await expect(wrong.start()).rejects.toThrow('QWEN_GGUF_CAPABILITIES');expect(wrong.runtime.running).toBe(false)
})

it.each([{engine:'qwen3-tts-06b'},{synthesisStreaming:false},{cancellation:'owned-process-termination'},{warmCancellationReuse:false},{backend:'cpu'},{backend:'cuda:1'},{backend:'vulkan:0',backendDevice:'Vulkan0'},{backendDevice:'CPU'},{abiVersion:4}])('rejects unsupported GGUF readiness %j and owns its cleanup',async bad=>{
 const f=await fixture({capabilities:bad});await expect(f.start()).rejects.toThrow('QWEN_GGUF_CAPABILITIES')
 expect(f.runtime.running).toBe(false);expect(treeKill).toHaveBeenCalledWith('taskkill.exe',['/PID','24680','/T','/F'],expect.objectContaining({shell:false}))
 expect(await readdir(join(f.root,'cache'))).toEqual([])
})

it.each([{ggufRuntime:undefined},{ggufRuntime:'relative'},{executionProfile:'qwen-complete' as const},{nativeBase:true},{windowsBase:true}])('refuses GGUF config before spawning %j',async config=>{
 const f=await fixture({config});await expect(f.start()).rejects.toThrow('QWEN_GGUF_RUNTIME_CONFIG');expect(f.children).toHaveLength(0)
})

it.each([{platform:'darwin',arch:'arm64'},{platform:'win32',arch:'arm64'},{platform:'linux',arch:'x64'}])('refuses unsupported native platform %j',async platform=>{
 const f=await fixture();vi.stubGlobal('process',{...process,...platform});await expect(f.start()).rejects.toThrow('QWEN_GGUF_RUNTIME_CONFIG');expect(f.children).toHaveLength(0)
})

it('requires WAV reference conditioning and all runtime paths to be absolute',async()=>{
 const f=await fixture();await expect(f.runtime.start('','key')).rejects.toThrow('VOICE_REFERENCE_RUNTIME');expect(f.children).toHaveLength(0)
 f.config.model='relative';await expect(f.start()).rejects.toThrow('VOICE_RUNTIME_CONFIG');expect(f.children).toHaveLength(0)
})

it('cancels credit-blocked GGUF generation only after cleanup ack, then reuses the native session',async()=>{
 const f=await fixture();await f.start();const session=f.runtime.sessionId;let delivered=0
 const old=f.runtime.stream('blocked',f.binding(),0,()=>{delivered++;return new Promise(()=>{})}).catch(e=>e.message)
 await vi.waitFor(()=>expect(delivered).toBe(3));const result=await f.runtime.cancelSpeech()
 expect(result).toMatchObject({keptWarm:true,boundary:'native-return',reuseAudit:{nativeContextRetained:true}});expect(await old).toBe('VOICE_CANCELLED');expect(treeKill).not.toHaveBeenCalled();expect(f.runtime.sessionId).toBe(session)
 const chunks:any[]=[];const complete=await f.runtime.stream('replacement',f.binding(2),0,async chunk=>{chunks.push(chunk)})
 expect(complete.totalChunks).toBe(4);expect(chunks.map(c=>c.sampleOffset)).toEqual([0,4800,9600,14400]);expect(f.children).toHaveLength(1)
})

it('an early producer credit cannot overtake pending initial chunk writes',async()=>{
 let release!:()=>void;const initialChunkBarrier=new Promise<void>(resolve=>{release=resolve})
 const f=await fixture({initialChunkBarrier});await f.start();const chunks:any[]=[]
 const pending=f.runtime.stream('early-credit',f.binding(),0,async chunk=>{chunks.push(chunk)})
 try{
  await vi.waitFor(()=>expect(f.requests.filter(r=>r.type==='credit'&&r.chunkIndex===0)).toHaveLength(1))
  expect(chunks.map(c=>c.chunkIndex)).toEqual([0]);expect(f.runtime.busy).toBe(true)
 }finally{release()}
 expect((await pending).totalChunks).toBe(4);expect(chunks.map(c=>c.chunkIndex)).toEqual([0,1,2,3])
})

it.each(['hang','wrong-target'] as const)('GGUF cancel %s falls back to its exact owned tree before a replacement',async cancel=>{
 const f=await fixture({cancel});await f.start();const session=f.runtime.sessionId;let delivered=0
 const old=f.runtime.stream('blocked',f.binding(),0,()=>{delivered++;return new Promise(()=>{})}).catch(e=>e.message)
 await vi.waitFor(()=>expect(delivered).toBe(3));expect((await f.runtime.cancelSpeech(50)).keptWarm).toBe(false);await old
 expect(f.runtime.running).toBe(false);expect(treeKill.mock.calls[0].slice(0,2)).toEqual(['taskkill.exe',['/PID','24680','/T','/F']])
 await f.start();expect(f.runtime.sessionId).not.toBe(session);expect((await f.runtime.synthesize('valid',f.binding(2),0)).durationMs).toBe(100)
})

it('complete GGUF requests retain the bounded non-streaming owned-tree cancellation fallback',async()=>{
 const f=await fixture({config:{executionProfile:'qwen-gguf-complete'}});await f.start();const old=f.runtime.synthesize('hang',f.binding(),0).catch(e=>e.message)
 expect(await f.runtime.cancelSpeech()).toMatchObject({keptWarm:false,fallback:'non-streaming'});expect(await old).toBe('VOICE_CANCELLED');expect(f.requests.some(r=>r.type==='shutdown')).toBe(false)
})

it('a GGUF stream protocol failure cannot clear native activity and enter graceful shutdown',async()=>{
 const f=await fixture({badChunk:true});await f.start();const delivered=vi.fn(async()=>{})
 await expect(f.runtime.stream('bad-sequence',f.binding(),0,delivered)).rejects.toThrow('VOICE_PROTOCOL');await f.runtime.stop()
 expect(delivered).not.toHaveBeenCalled();expect(treeKill).toHaveBeenCalledOnce();expect(f.requests.some(r=>r.type==='shutdown')).toBe(false)
})

it('idle GGUF shutdown drains native cleanup and removes cache without taskkill',async()=>{
 const f=await fixture();await f.start();await f.runtime.stop()
 expect(f.requests.filter(r=>r.type==='shutdown')).toHaveLength(1);expect(treeKill).not.toHaveBeenCalled();expect(f.children[0].kill).not.toHaveBeenCalled();expect(f.runtime.running).toBe(false);expect(await readdir(join(f.root,'cache'))).toEqual([])
})

it('a stalled idle GGUF shutdown reaches a short deadline and terminates only the owned tree',async()=>{
 const f=await fixture({shutdown:'hang'});await f.start();await f.runtime.stop()
 expect(f.requests.filter(r=>r.type==='shutdown')).toHaveLength(1);expect(treeKill).toHaveBeenCalledOnce();expect(treeKill.mock.calls[0].slice(0,2)).toEqual(['taskkill.exe',['/PID','24680','/T','/F']]);expect(f.runtime.running).toBe(false)
})
