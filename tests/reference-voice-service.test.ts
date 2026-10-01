import {afterEach,expect,it,vi} from 'vitest'
import {mkdtemp,mkdir,readFile,writeFile,rm,realpath} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createHash} from 'node:crypto'
import {CharacterVoiceService} from '../electron/main/character-voice/CharacterVoiceService'
import {ReferenceProfileStore} from '../electron/main/character-voice/ReferenceProfileStore'
import {canonicalReferenceWav} from '../electron/main/character-voice/ReferenceWav'
import {referenceWav} from './helpers/reference-wav'
const cleanup:Array<()=>Promise<unknown>>=[]
const hostPlatform=Object.getOwnPropertyDescriptor(process,'platform')!
afterEach(async()=>{try{for(const fn of cleanup.splice(0))await fn()}finally{Object.defineProperty(process,'platform',hostPlatform);vi.restoreAllMocks()}})
async function fixture(native=true,setupRuntime:(runtime:any)=>void=()=>{}){
 const root=await realpath(await mkdtemp(join(tmpdir(),'reference-service-'))),source=join(root,'input.wav');await writeFile(source,referenceWav())
 const store=new ReferenceProfileStore(join(root,'reference-profiles'),async(path,stage,signal)=>{if(signal.aborted)throw Error('VOICE_REFERENCE_CANCELLED');const bytes=await readFile(path),{wav,audio}=canonicalReferenceWav(bytes);await writeFile(join(stage,'reference.wav'),wav);return{sourceSha256:createHash('sha256').update(bytes).digest('hex'),referenceSha256:createHash('sha256').update(wav).digest('hex'),audio}})
 const base={native,profile:{kind:'base-default' as const,id:'voxcpm2_default',version:'base',name:'Default',fingerprint:'base',adapterSha256:'none' as const},executable:'/managed/runtime',path:'/managed/model',snapshot:()=>({supported:true,installed:true,phase:'idle' as const,bytes:1,total:1,error:null}),initialize:vi.fn(async()=>{}),identity:vi.fn(async()=>"stable"),ready:vi.fn(async()=>'/managed/model'),cancelVerification:vi.fn(async()=>{}),install:vi.fn(async()=>{}),cancel:vi.fn(async()=>{})}
 const message={id:'message',role:'assistant' as const,status:'complete' as const,text:'새로운 문장을 읽어요.',createdAt:'now',binding:{characterId:'test',revision:'1',conversationId:'chat',requestId:'request',epoch:1,modelId:'E4B' as const,personaHash:'p',semanticHash:'s'}}
 const chat:any={epoch:1,model:'E4B',character:{id:'test',revision:'1'},conversation:{id:'chat',messages:[message]}}
 const configs:any[]=[],runtimes:any[]=[],events:any[]=[]
 const worker=join(root,'workers','worker.py');await mkdir(join(root,'workers'));await writeFile(worker,'synthetic worker')
 const service=new CharacterVoiceService(root,worker,()=>chat,()=>{},event=>{events.push(event);if(event.type==='audio')queueMicrotask(()=>{service.audio(event.audioId,event.epoch);service.played(event.audioId,event.epoch)})},config=>{
  const runtime:any={config,prewarm:vi.fn(async()=>{runtime.audit.warmed=true}),synthesize:vi.fn(async(_text,binding)=>{expect(binding.engine).toBe('qwen3-tts-06b');expect(binding.conditioningFingerprint).toBe(runtime.audit.conditioningFingerprint);return {audioId:'audio-'+events.length,bytes:new Uint8Array(2),durationMs:100}}),sessionId:'session-'+runtimes.length,running:false,busy:false,audit:{},get ready(){return this.running},retireSpeech:vi.fn(),start:vi.fn(async(_path,_key,c)=>{runtime.running=true;runtime.audit={conditioningFingerprint:c?.fingerprint}}),stop:vi.fn(async()=>{runtime.running=false}),cancelSpeech:vi.fn(async()=>({keptWarm:true,elapsedMs:0})),stream:vi.fn(async(_text,binding,_segment,accept)=>{void accept({audioId:'audio-'+events.length,bytes:new Uint8Array(2),durationMs:100,synthesisId:'s',chunkIndex:0,sampleOffset:0,sampleCount:4800,firstChunkReadyMs:1});expect(binding.conditioningFingerprint).toBe(runtime.audit.conditioningFingerprint);return{totalSamples:4800,totalChunks:1}})};setupRuntime(runtime);configs.push(config);runtimes.push(runtime);return runtime
 },()=>{},base,undefined,store)
 cleanup.push(async()=>{await service.close();await rm(root,{recursive:true,force:true})});await service.initialize()
 // The injected native runtime is supported regardless of the test host.
 if(native)(service as any).state.availableProfiles=['gguf-metal-f16','gguf-metal-f16-complete']
 return{root,source,service,store,base,chat,message,configs,runtimes,events}
}
it.each([true,false])('managed WAV routing and warm reuse preserve reference across rename (native=%s)',async native=>{
 const f=await fixture(native);await f.service.importReference(f.source,'Reference')
 expect(f.service.snapshot().bindings).toEqual({});expect(f.base.install).not.toHaveBeenCalled();expect(f.runtimes).toHaveLength(0)
 const p=f.store.list()[0],key=p.id+'@'+p.version;await f.service.bind('test',key);await f.service.enabled(true);f.service.setOutputReady(true);await f.service.prepare()
 const runtime=f.runtimes[0];expect(f.configs[0]).toMatchObject({nativeBase:native,windowsBase:!native,model:'/managed/model'})
 const condition=runtime.start.mock.calls[0][2];expect(condition).toMatchObject({kind:'wav-reference',sha256:p.referenceSha256});expect(condition.fingerprint).not.toBe(p.fingerprint);expect(f.base.ready).toHaveBeenCalledTimes(1)
 for(let i=0;i<3;i++){f.service.readMessage('message');await vi.waitFor(()=>expect(runtime.stream).toHaveBeenCalledTimes(i+1));await vi.waitFor(()=>expect(f.service.snapshot().status).toBe('idle'))}
 await f.service.renameReference(key,'Renamed');f.service.readMessage('message');await vi.waitFor(()=>expect(runtime.stream).toHaveBeenCalledTimes(4));await vi.waitFor(()=>expect(f.service.snapshot().status).toBe('idle'))
 expect(runtime.start).toHaveBeenCalledTimes(1);expect(f.base.ready).toHaveBeenCalledTimes(1);expect(f.store.list()[0].fingerprint).toBe(p.fingerprint)
 await f.service.bind('test','voxcpm2_default@base');await f.service.prepare();expect(f.runtimes.at(-1).start.mock.calls[0][2]).toBeUndefined()
})
it.each([{platform:'darwin',arch:'arm64',native:true},{platform:'win32',arch:'x64',native:false}])('missing selected reference stays bound after restart on $platform and never loads default',async target=>{
 const platform=Object.getOwnPropertyDescriptor(process,'platform')!,arch=Object.getOwnPropertyDescriptor(process,'arch')!
 Object.defineProperty(process,'platform',{...platform,value:target.platform});Object.defineProperty(process,'arch',{...arch,value:target.arch})
 try{
  const f=await fixture(target.native);await f.service.importReference(f.source,'Missing');const p=f.store.list()[0],key=p.id+'@'+p.version;await f.service.bind('test',key);await f.service.enabled(true)
  await rm(join(f.store.root,'profiles',p.id),{recursive:true});await f.service.close()
  const restarted=new CharacterVoiceService(f.root,'/worker',()=>f.chat,()=>{},()=>{},()=>{throw Error('NO_DEFAULT_FALLBACK')},()=>{},f.base,undefined,new ReferenceProfileStore(f.store.root));cleanup.push(()=>restarted.close());await restarted.initialize()
  expect(restarted.snapshot()).toMatchObject({bindings:{test:key},status:'unavailable',runtimeConfigured:false});restarted.setOutputReady(true);await restarted.prepare();expect(f.base.ready).not.toHaveBeenCalled()
 }finally{Object.defineProperty(process,'platform',platform);Object.defineProperty(process,'arch',arch)}
})
it('tampering between warm utterances rejects voice without changing text or binding',async()=>{
 const f=await fixture();await f.service.importReference(f.source,'Reference');const p=f.store.list()[0],key=p.id+'@'+p.version;await f.service.bind('test',key);await f.service.enabled(true);f.service.setOutputReady(true);await f.service.prepare()
 const c=await f.store.resolve(key),bytes=await readFile(c.path);bytes[44]^=1;await writeFile(c.path,bytes);f.service.readMessage('message')
 await vi.waitFor(()=>expect(f.service.snapshot().error).toBe('VOICE_REFERENCE_CHANGED'));expect(f.service.snapshot().bindings.test).toBe(key);expect(f.message.text).toBe('새로운 문장을 읽어요.');expect(f.runtimes[0].stream).not.toHaveBeenCalled()
})
it('service admission deduplicates import and immediate cancellation publishes nothing',async()=>{
 const f=await fixture(),spy=vi.spyOn(f.store,'import'),a=f.service.importReference(f.source,'One'),b=f.service.importReference(f.source,'Two');expect(a).toBe(b);expect(f.service.snapshot().referenceImport?.busy).toBe(true)
 await f.service.cancelReferenceImport();await a;expect(f.store.list()).toEqual([]);expect(f.service.snapshot().profiles).toHaveLength(1);expect(f.service.snapshot().referenceImport).toEqual({busy:false,error:null})
 expect(spy).toHaveBeenCalledTimes(1)
})
it('stale apply after pending stop cannot bind a new character',async()=>{
 const f=await fixture();await f.service.importReference(f.source,'Reference');const p=f.store.list()[0],key=p.id+'@'+p.version;let valid=true,release!:()=>void
 vi.spyOn(f.service,'stop').mockImplementation(()=>new Promise<void>(r=>{release=r}));const pending=f.service.bind('test',key,()=>valid);await vi.waitFor(()=>expect(release).toBeTypeOf('function'));valid=false;release();await pending
 expect(f.service.snapshot().bindings).toEqual({});vi.restoreAllMocks()
})

it('Qwen explicit opt-in uses its own runtime/reference and returns complete audio without Vox installation',async()=>{
 const platform=Object.getOwnPropertyDescriptor(process,'platform')!;Object.defineProperty(process,'platform',{...platform,value:'win32'})
 try{
  const f=await fixture(false);expect(f.service.snapshot().engine).toBe('voxcpm2')
  await f.service.importReference(f.source,'Authorized reference');const ref=f.store.list()[0]
  await f.service.bind('test',ref.id+'@'+ref.version)
  await mkdir(join(f.root,'env','Scripts'),{recursive:true});await writeFile(join(f.root,'env','Scripts','python.exe'),'synthetic');await mkdir(join(f.root,'qwen-model'));await writeFile(join(f.root,'qwen-model','config.json'),'synthetic')
  await f.service.configureQwen(join(f.root,'env','Scripts','python.exe'),join(f.root,'qwen-model'))
  await f.service.engine('qwen3-tts-06b');await f.service.enabled(true);f.service.setOutputReady(true);await f.service.prepare()
  expect(f.service.snapshot()).toMatchObject({engine:'qwen3-tts-06b',availableProfiles:['qwen-complete'],runtimeConfigured:true,engineCapabilities:{synthesisStreaming:false,cancellation:'owned-process-termination'}})
  expect(f.base.ready).not.toHaveBeenCalled();expect(f.configs[0]).toMatchObject({engine:'qwen3-tts-06b',executionProfile:'qwen-complete'})
  f.service.readMessage('message');await vi.waitFor(()=>expect(f.runtimes[0].synthesize).toHaveBeenCalledTimes(1));await vi.waitFor(()=>expect(f.service.snapshot().status).toBe('idle'))
  expect(f.events.find(e=>e.type==='audio').stream).toBeUndefined();expect(f.runtimes[0].stream).not.toHaveBeenCalled()
  const old=f.runtimes[0],epoch=f.service.snapshot().epoch
  await f.service.engine('voxcpm2');expect(old.stop).toHaveBeenCalled();expect(f.service.snapshot().epoch).toBeGreaterThan(epoch)
  expect(f.service.snapshot().engine).toBe('voxcpm2');expect(f.base.ready).toHaveBeenCalled()
 }finally{Object.defineProperty(process,'platform',platform)}
})
it('Qwen ICL rejects missing transcript and clone changes expire replay scope',async()=>{
 const f=await fixture(false)
 expect(()=>f.service.qwenClone({mode:'icl',transcript:''})).toThrow('QWEN_TRANSCRIPT_REQUIRED')
 await f.service.qwenClone({mode:'icl',transcript:'실제로 말한 기준 문장.'})
 expect(f.service.snapshot().qwenClone).toEqual({mode:'icl',transcript:'실제로 말한 기준 문장.'})
 await f.service.qwenClone({mode:'x-vector',transcript:'ignored'})
 expect(f.service.snapshot().qwenClone).toEqual({mode:'x-vector',transcript:''})
})
it('Mac Qwen streams with its separate MLX worker, switches complete mode, and restores Vox profile',async()=>{
 const platform=Object.getOwnPropertyDescriptor(process,'platform')!,arch=Object.getOwnPropertyDescriptor(process,'arch')!
 Object.defineProperty(process,'platform',{...platform,value:'darwin'});Object.defineProperty(process,'arch',{...arch,value:'arm64'})
 try{
  const f=await fixture();await f.service.importReference(f.source,'Authorized reference');const ref=f.store.list()[0]
  await f.service.bind('test',ref.id+'@'+ref.version)
  await mkdir(join(f.root,'env','lib'),{recursive:true});await writeFile(join(f.root,'env','pyvenv.cfg'),'synthetic');await writeFile(join(f.root,'env','qwen-runtime.json'),'synthetic');await mkdir(join(f.root,'env','bin'),{recursive:true});await writeFile(join(f.root,'env','bin','python'),'synthetic');await mkdir(join(f.root,'qwen-model'));await writeFile(join(f.root,'qwen-model','config.json'),'synthetic')
  await f.service.configureQwen(join(f.root,'env','bin','python'),join(f.root,'qwen-model'));await f.service.engine('qwen3-tts-06b');await f.service.enabled(true);f.service.setOutputReady(true);await f.service.prepare()
  expect(f.service.snapshot()).toMatchObject({engine:'qwen3-tts-06b',availableProfiles:['qwen-mlx','qwen-mlx-complete'],executionProfile:'qwen-mlx',engineCapabilities:{synthesisStreaming:true}})
  expect(f.configs[0].worker).toMatch(/qwen_mlx_worker.py$/);expect(f.base.ready).not.toHaveBeenCalled()
  f.service.readMessage('message');await vi.waitFor(()=>expect(f.runtimes[0].stream).toHaveBeenCalledTimes(1));await vi.waitFor(()=>expect(f.service.snapshot().status).toBe('idle'))
  await f.service.executionProfile('qwen-mlx-complete');f.service.readMessage('message');await vi.waitFor(()=>expect(f.runtimes.at(-1).synthesize).toHaveBeenCalledTimes(1));await vi.waitFor(()=>expect(f.service.snapshot().status).toBe('idle'))
  await f.service.engine('voxcpm2');expect(f.service.snapshot().executionProfile).toBe('gguf-metal-f16')
  await f.service.engine('qwen3-tts-06b');expect(f.service.snapshot().executionProfile).toBe('qwen-mlx-complete')
 }finally{Object.defineProperty(process,'platform',platform);Object.defineProperty(process,'arch',arch)}
})
async function pendingQwenWarm(){
 // This fixture exercises the supported Windows Qwen path, including on Linux CI.
 Object.defineProperty(process,'platform',{...hostPlatform,value:'win32'})
 let warming=false,rejectWarm!:(e:Error)=>void,resolveWarm!:()=>void
 const f=await fixture(true,r=>{
  r.prewarm.mockImplementationOnce(()=>new Promise<void>((resolve,reject)=>{warming=true;rejectWarm=reject;resolveWarm=()=>{warming=false;resolve()}}))
  Object.defineProperty(r,'busy',{get:()=>warming})
  r.stop.mockImplementation(async()=>{r.running=false;if(warming){warming=false;rejectWarm(Error('VOICE_CANCELLED'))}})
  r.cancelSpeech.mockImplementation(async()=>{await r.stop();return{keptWarm:false,elapsedMs:0,fallback:'qwen-owned-process-termination'}})
  for(const method of ['synthesize','stream']){const original=r[method].getMockImplementation();r[method].mockImplementation(async(...args:any[])=>{if(warming)throw Error('VOICE_WORKER_BUSY');return original(...args)})}
 })
 await f.service.importReference(f.source,'Reference');const ref=f.store.list()[0];await f.service.bind('test',ref.id+'@'+ref.version)
 await mkdir(join(f.root,'env','lib'),{recursive:true});await writeFile(join(f.root,'env','pyvenv.cfg'),'synthetic');await writeFile(join(f.root,'env','qwen-runtime.json'),'synthetic');await mkdir(join(f.root,'env','bin'),{recursive:true});await writeFile(join(f.root,'env','bin','python'),'synthetic');await mkdir(join(f.root,'qwen-model'));await writeFile(join(f.root,'qwen-model','config.json'),'synthetic')
 await f.service.configureQwen(join(f.root,'env','bin','python'),join(f.root,'qwen-model'));await f.service.engine('qwen3-tts-06b');await f.service.enabled(true);f.service.setOutputReady(true)
 await vi.waitFor(()=>expect(warming).toBe(true))
 return {...f,resolveWarm,inference:f.service.snapshot().executionProfile==='qwen-complete'?f.runtimes[0].synthesize:f.runtimes[0].stream}
}
it.each(['manual','automatic'])('Qwen %s read during prewarm cancels owned preparation before fresh inference',async kind=>{
 const f=await pendingQwenWarm(),r=f.runtimes[0]
 if(kind==='automatic'){f.service.requestStarted(f.message.binding.requestId);f.service.completed(f.message)}else f.service.readMessage('message')
 await vi.waitFor(()=>expect(f.inference).toHaveBeenCalledTimes(1));await vi.waitFor(()=>expect(f.service.snapshot().status).toBe('idle'))
 expect(r.cancelSpeech).toHaveBeenCalled();expect(r.stop).toHaveBeenCalled();expect(f.service.snapshot().error).toBeNull();expect(f.events.filter(e=>e.type==='audio')).toHaveLength(1)
})
it('Qwen prewarm stop and engine switch cannot publish stale readiness',async()=>{
 const f=await pendingQwenWarm(),r=f.runtimes[0]
 await f.service.stop(true,false);expect(r.cancelSpeech).toHaveBeenCalled();expect(f.service.snapshot().status).toBe('stopped');expect(f.events.some(e=>e.type==='audio')).toBe(false)
 await f.service.engine('voxcpm2');expect(f.service.snapshot().engine).toBe('voxcpm2');expect(r.stop).toHaveBeenCalled();expect(f.service.snapshot().error).toBeNull()
})
it('only the latest read survives two requests arriving during Qwen prewarm',async()=>{
 const f=await pendingQwenWarm(),r=f.runtimes[0],next={...f.message,id:'newest',text:'가장 최근 문장이야.',binding:{...f.message.binding,requestId:'newest-request'}};f.chat.conversation.messages.push(next)
 f.service.readMessage('message');f.service.readMessage('newest')
 await vi.waitFor(()=>expect(f.inference).toHaveBeenCalledTimes(1));await vi.waitFor(()=>expect(f.service.snapshot().status).toBe('idle'))
 expect(f.inference.mock.calls[0][0]).toBe(next.text);expect(f.service.snapshot().error).toBeNull();expect(f.events.filter(e=>e.type==='audio')).toHaveLength(1)
})
