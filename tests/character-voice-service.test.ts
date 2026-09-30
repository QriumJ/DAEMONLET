import {beforeEach as seedBeforeEach} from 'vitest'
import {afterEach,expect,it,vi} from 'vitest'
import {mkdtemp,rm,readFile,mkdir,writeFile,stat} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {CharacterVoiceService} from '../electron/main/character-voice/CharacterVoiceService'
import type {LocalChatSnapshot,ChatMessage} from '../electron/shared/character-chat-contract'
import {isStreamingProfile,planSpeech,type SpeechPolicy,type ExecutionProfile,type VoiceEvent} from '../electron/shared/character-voice-contract'
import type {TtsRuntimeSupervisor} from '../electron/main/character-voice/TtsRuntimeSupervisor'
const roots:string[]=[],services:CharacterVoiceService[]=[]
it.each(['event','changed','diagnostic'])('F3 %s callback cannot skip worker cleanup',async callback=>{
 const f=await fixture();f.service.completed(f.message);await vi.waitFor(()=>expect(f.runtime.synthesize).toHaveBeenCalled())
 ;(f.service as any)[callback]=()=>{throw Error('Object has been destroyed')}
 await expect(f.service.close()).resolves.toBeUndefined();expect(f.runtime.stop).toHaveBeenCalled()
 ;(f.service as any)[callback]=()=>{}
})
it('F3 failed worker stop is reported, not marked successful',async()=>{
 const f=await fixture();f.service.completed(f.message);await vi.waitFor(()=>expect(f.runtime.synthesize).toHaveBeenCalled())
 f.runtime.stop.mockRejectedValueOnce(Error('VOICE_WORKER_STOP_TIMEOUT'))
 await expect(f.service.close()).rejects.toThrow('VOICE_WORKER_STOP_TIMEOUT');expect(f.service.snapshot().error).toBe('VOICE_WORKER_STOP_TIMEOUT');expect(f.service.snapshot().status).toBe('error')
})
it('F4 removal commits once and never resurrects a deleted profile',async()=>{
 const f=await fixture(),original=(f.service as any).save.bind(f.service)
 const saves=vi.spyOn(f.service as any,'save').mockImplementationOnce(original).mockRejectedValueOnce(Error('VOICE_STORAGE'))
 await f.service.remove('voice@1')
 expect(saves).toHaveBeenCalledTimes(1);expect(f.service.snapshot().profiles).toEqual([]);expect(f.service.snapshot().bindings).toEqual({})
 expect(JSON.parse(await readFile(join(f.root,'settings.json'),'utf8')).bindings).toEqual({})
})
it('F4 failed pre-delete persistence preserves registration',async()=>{
 const f=await fixture();vi.spyOn(f.service as any,'save').mockRejectedValueOnce(Error('VOICE_STORAGE'))
 await f.service.remove('voice@1');expect(f.service.snapshot().profiles).toHaveLength(1);expect(f.service.snapshot().bindings['actual-id']).toBe('voice@1')
 expect(JSON.parse(await readFile(join(f.root,'settings.json'),'utf8')).bindings['actual-id']).toBe('voice@1')
})
afterEach(async()=>{for(const s of services.splice(0))await s.close();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});vi.restoreAllMocks()})
async function fixture(policy:SpeechPolicy='legacy-sentence-v1'){const root=await mkdtemp(join(tmpdir(),'voice-service-'));roots.push(root)
 const message:ChatMessage={id:'message',role:'assistant',status:'complete',text:'응. 다음 문장!',createdAt:'now',binding:{characterId:'actual-id',revision:'rev1',conversationId:'conversation',requestId:'request',epoch:1,modelId:'E4B',personaHash:'p',semanticHash:'s'}}
 const chat={epoch:1,model:'E4B',character:{id:'actual-id',revision:'rev1'},conversation:{id:'conversation',messages:[message]}} as LocalChatSnapshot
 let audio=0
 const runtime={sessionId:'session',running:false,get ready(){return runtime.running},retireSpeech:vi.fn(),start:vi.fn(async()=>{runtime.running=true}),stop:vi.fn(async()=>{runtime.running=false}),synthesize:vi.fn(async()=>({audioId:'audio-'+(++audio),bytes:new Uint8Array([1,2]),durationMs:10,generationMs:1,rtf:0.1}))}
 const cancelSpeech=vi.fn(async()=>{await runtime.stop();return {keptWarm:false,elapsedMs:0}});Object.assign(runtime,{cancelSpeech})
 const events:VoiceEvent[]=[]
 const service=new CharacterVoiceService(root,'/worker',()=>chat,()=>{},e=>events.push(e),()=>runtime as unknown as TtsRuntimeSupervisor,undefined,undefined,policy);services.push(service)
 await service.initialize();
 // Synthetic external runtime supports these modes independently of the test host.
 ;(service as any).state.availableProfiles=['baseline','cached','compiled'];(service as any).state.executionProfile='baseline';await service.configure('/python','/model');await service.enabled(true)
 ;(service as any).state.profiles=[{id:'voice',version:'1',name:'Synthetic',fingerprint:'fingerprint',adapterSha256:'adapter'}]
 await service.bind('actual-id','voice@1')
 service.setOutputReady(true);service.requestStarted(message.binding!.requestId)
 const complete=async()=>{await vi.waitFor(()=>expect(events.some(e=>e.type==='audio')).toBe(true));for(let i=0;i<2;i++){await vi.waitFor(()=>expect(events.filter(e=>e.type==='audio').length).toBe(i+1));const e=events.filter(e=>e.type==='audio')[i];if(e.type==='audio'){service.audio(e.audioId,e.epoch);service.played(e.audioId,e.epoch)}}await vi.waitFor(()=>expect(service.snapshot().status).toBe('idle'))}
 const completeOne=async()=>{await vi.waitFor(()=>expect(events.some(e=>e.type==='audio'&&(service as any).active?.id===e.audioId)).toBe(true));const e=events.find(e=>e.type==='audio'&&(service as any).active?.id===e.audioId)!;if(e.type==='audio'){service.audio(e.audioId,e.epoch);service.played(e.audioId,e.epoch)}}
 return{root,service,chat,message,runtime,events,complete,completeOne}
}
it('only explicit completion triggers speech, deduplicates and applies ordered backpressure',async()=>{const f=await fixture();f.service.onChatChanged();expect(f.runtime.synthesize).not.toHaveBeenCalled();f.service.completed(f.message);f.service.completed(f.message);await vi.waitFor(()=>expect(f.runtime.synthesize).toHaveBeenCalledTimes(1));await f.complete();expect(f.runtime.synthesize.mock.calls.map(args=>(args as unknown[])[0])).toEqual(['응.',' 다음 문장!']);f.service.onChatChanged();expect(f.runtime.synthesize).toHaveBeenCalledTimes(2)})
it('late synthesis is discarded on revision or conversation changes',async()=>{const f=await fixture();let release!:(v:any)=>void;f.runtime.synthesize.mockImplementationOnce(()=>new Promise(r=>{release=r}));f.service.completed(f.message);await vi.waitFor(()=>expect(release).toBeTypeOf('function'));f.chat.character!.revision='rev2';f.service.onChatChanged();release({audioId:'late',bytes:new Uint8Array(1),durationMs:1});await new Promise(r=>setTimeout(r,20));expect(f.events.some(e=>e.type==='audio')).toBe(false);expect(f.runtime.stop).toHaveBeenCalled()})
it('only bound audio can be claimed once and cancellation expires its capability',async()=>{const f=await fixture();f.service.completed(f.message);await vi.waitFor(()=>expect(f.events.some(e=>e.type==='audio')).toBe(true));const e=f.events.find(e=>e.type==='audio')!;if(e.type!=='audio')throw Error();expect(()=>f.service.audio('wrong',e.epoch)).toThrow();expect(f.service.audio(e.audioId,e.epoch)).toEqual(new Uint8Array([1,2]));expect(()=>f.service.audio(e.audioId,e.epoch)).toThrow();await f.service.stop();f.service.played(e.audioId,e.epoch);expect(()=>f.service.audio(e.audioId,e.epoch)).toThrow();expect(f.runtime.synthesize).toHaveBeenCalledTimes(1)})
it('worker failure affects voice state without changing completed text',async()=>{const f=await fixture();f.runtime.synthesize.mockRejectedValueOnce(Error('CUDA_OOM'));f.service.completed(f.message);await vi.waitFor(()=>expect(f.service.snapshot().error).toBe('CUDA_OOM'));expect(f.message.status).toBe('complete');expect(f.message.text).toBe('응. 다음 문장!')})
it('OFF cancels pending speech and bindings persist separately per actual character ID',async()=>{const f=await fixture();await f.service.bind('other-id','voice@1');await f.service.auto(false);f.service.completed(f.message);expect(f.runtime.synthesize).not.toHaveBeenCalled();await f.service.enabled(false);const settings=JSON.parse(await readFile(join(f.root,'settings.json'),'utf8'));expect(settings.bindings).toEqual({'actual-id':'voice@1','other-id':'voice@1'});expect(settings.enabled).toBe(false)})
it('warm worker remains available after playback and a completed text invalidation',async()=>{const f=await fixture();f.service.completed(f.message);await f.complete();f.runtime.stop.mockClear();f.service.cancel();await new Promise(r=>setTimeout(r,0));expect(f.runtime.stop).not.toHaveBeenCalled();await f.service.enabled(false);expect(f.runtime.stop).toHaveBeenCalled()})

it.each(['loading','synthesizing','playing'])('F2 hide during %s discards pending audio and explicit reread recovers',async stage=>{
 const f=await fixture();let release!:(v:any)=>void
 if(stage==='loading')f.runtime.start.mockImplementationOnce(()=>new Promise(r=>{release=r}))
 if(stage==='synthesizing')f.runtime.synthesize.mockImplementationOnce(()=>new Promise(r=>{release=r}))
 f.service.completed(f.message)
 await vi.waitFor(()=>expect(f.service.snapshot().status).toBe(stage))
 f.service.setOutputReady(false);f.service.setOutputReady(true)
 if(release)release({audioId:'late',bytes:new Uint8Array(1),durationMs:1})
 await new Promise(r=>setTimeout(r,10))
 const count=f.events.filter(e=>e.type==='audio').length
 expect(count).toBe(stage==='playing'?1:0)
 f.service.completed(f.message);await new Promise(r=>setTimeout(r,0));expect(f.events.filter(e=>e.type==='audio')).toHaveLength(count)
 f.events.splice(0);f.service.readMessage(f.message.id);await f.complete()
})
it('F2 hidden requests never acquire permission on show; new visible requests do',async()=>{
 const f=await fixture();f.service.setOutputReady(false);f.service.requestStarted('hidden');f.message.binding!.requestId='hidden'
 f.service.setOutputReady(true);f.service.completed(f.message);await new Promise(r=>setTimeout(r,10));expect(f.runtime.start).not.toHaveBeenCalled()
 f.message.binding!.requestId='new';f.message.id='new';f.service.requestStarted('new');f.service.completed(f.message);await f.complete()
})
it('F3 repeated stop/close refuses subsequent requests',async()=>{
 const f=await fixture();f.service.completed(f.message);await vi.waitFor(()=>expect(f.runtime.synthesize).toHaveBeenCalled())
 await Promise.all([f.service.close(),f.service.close()]);f.runtime.start.mockClear()
 f.service.setOutputReady(true);f.service.readMessage(f.message.id);await new Promise(r=>setTimeout(r,0));expect(f.runtime.start).not.toHaveBeenCalled()
})
it('F4 failed file cleanup remains unbound across restart and retry',async()=>{
 const f=await fixture(),folder=join(f.root,'profiles','voice@1');await mkdir(folder);await writeFile(join(folder,'synthetic.txt'),'fixture')
 const remove=vi.spyOn(f.service as any,'removeFiles').mockRejectedValueOnce(Error('locked'))
 await f.service.remove('voice@1');expect(f.service.snapshot().profiles).toEqual([]);expect(f.service.snapshot().bindings).toEqual({});expect(f.service.snapshot().error).toBe('VOICE_CLEANUP_PENDING');expect((await stat(folder)).isDirectory()).toBe(true)
 const saved=JSON.parse(await readFile(join(f.root,'settings.json'),'utf8'));expect(saved.pendingRemoval).toEqual(['voice@1']);expect(saved.bindings).toEqual({})
 const restarted=new CharacterVoiceService(f.root,'/worker',()=>f.chat,()=>{},()=>{});services.push(restarted);await restarted.initialize()
 expect(restarted.snapshot().profiles).toEqual([]);expect(restarted.snapshot().bindings).toEqual({});await expect(stat(folder)).rejects.toThrow()
 remove.mockRestore();await f.service.remove('voice@1');await f.service.remove('voice@1');expect(f.service.snapshot().profiles).toEqual([])
})
it('F4 pre-delete save failure preserves actual package bytes',async()=>{
 const f=await fixture(),folder=join(f.root,'profiles','voice@1');await mkdir(folder);await writeFile(join(folder,'synthetic.txt'),'unchanged')
 vi.spyOn(f.service as any,'save').mockRejectedValueOnce(Error('VOICE_STORAGE'));await f.service.remove('voice@1')
 expect(await readFile(join(folder,'synthetic.txt'),'utf8')).toBe('unchanged');expect(f.service.snapshot().profiles).toHaveLength(1)
})
it('F5 unsupported device preserves text and exposes the precise UI error code',async()=>{
 const f=await fixture();f.runtime.start.mockRejectedValueOnce(Error('UNSUPPORTED_DEVICE'));f.service.completed(f.message)
 await vi.waitFor(()=>expect(f.service.snapshot().error).toBe('UNSUPPORTED_DEVICE'));expect(f.message.status).toBe('complete');expect(f.message.text).toBe('응. 다음 문장!')
})

it('F2 hiding revokes a ready WAV before retrieval and late acknowledgement',async()=>{
 const f=await fixture();f.service.completed(f.message);await vi.waitFor(()=>expect(f.events.some(e=>e.type==='audio')).toBe(true))
 const event=f.events.find(e=>e.type==='audio')!;if(event.type!=='audio')throw Error()
 f.service.setOutputReady(false)
 expect(()=>f.service.audio(event.audioId,event.epoch)).toThrow('VOICE_AUDIO_EXPIRED');f.service.played(event.audioId,event.epoch)
 await new Promise(r=>setTimeout(r,0));expect(f.runtime.synthesize).toHaveBeenCalledTimes(1)
})
it('streaming overlaps only the immediate next sentence and keeps separate audio capabilities',async()=>{
 const f=await fixture('transition-v1');(f.service as any).state.executionProfile='cached';f.message.text=('가'.repeat(85)+'. ').repeat(3);expect(planSpeech(f.message.text).segments).toHaveLength(3)
 let index=0
 const stream=vi.fn(async(_text:string,_binding:any,_segment:number,accept:any)=>{
  const id=++index;void accept({audioId:`chunk-${id}`,bytes:new Uint8Array(20),durationMs:100,generationMs:1,rtf:.01,synthesisId:`s${id}`,chunkIndex:0,sampleOffset:0,sampleCount:4800,firstChunkReadyMs:1}).catch(()=>{})
  return {totalChunks:1,totalSamples:4800}
 });Object.assign(f.runtime,{stream,busy:false})
 f.service.completed(f.message);await vi.waitFor(()=>expect(stream).toHaveBeenCalledTimes(2));await new Promise(r=>setTimeout(r,10));expect(stream).toHaveBeenCalledTimes(2)
 const consume=(id:string)=>{const epoch=f.service.snapshot().epoch;f.service.audio(id,epoch);f.service.played(id,epoch)}
 consume('chunk-1');await vi.waitFor(()=>expect(stream).toHaveBeenCalledTimes(3));consume('chunk-2');consume('chunk-3');await vi.waitFor(()=>expect(f.service.snapshot().status).toBe('idle'))
})
it('warm idle GPU survives voice-only stop, but hide still unloads it',async()=>{
 const f=await fixture();Object.assign(f.runtime,{busy:false});f.service.completed(f.message);await vi.waitFor(()=>expect(f.events.some(e=>e.type==='audio')).toBe(true))
 f.runtime.stop.mockClear();await f.service.stop(true,false);expect(f.runtime.stop).not.toHaveBeenCalled();f.service.setOutputReady(false);await vi.waitFor(()=>expect(f.runtime.stop).toHaveBeenCalled())
})
it('hide revokes current and prefetched stream capabilities and prevents a third sentence',async()=>{
 const f=await fixture();(f.service as any).state.executionProfile='cached';f.message.text='첫 문장. 다음 문장. 마지막 문장.'
 let count=0
 const stream=vi.fn(async(_text:string,_binding:any,_segment:number,accept:any)=>{
  const id=++count;void accept({audioId:`hidden-${id}`,bytes:new Uint8Array(20),durationMs:100,synthesisId:`s${id}`,chunkIndex:0,sampleOffset:0,sampleCount:4800,firstChunkReadyMs:1}).catch(()=>{})
  return {totalChunks:1,totalSamples:4800}
 });Object.assign(f.runtime,{stream,busy:false})
 f.service.completed(f.message);await vi.waitFor(()=>expect(stream).toHaveBeenCalledTimes(2))
 const epoch=f.service.snapshot().epoch;f.service.setOutputReady(false)
 for(const id of ['hidden-1','hidden-2']){expect(()=>f.service.audio(id,epoch)).toThrow('VOICE_AUDIO_EXPIRED');f.service.played(id,epoch)}
 await vi.waitFor(()=>expect(f.runtime.stop).toHaveBeenCalled());await new Promise(r=>setTimeout(r,0))
 expect(stream).toHaveBeenCalledTimes(2);expect(f.message.status).toBe('complete')
})
it('voice-only stop cancels an explicit preparation even before speech exists',async()=>{
 const f=await fixture();(f.service as any).state.executionProfile='compiled';Object.assign(f.runtime,{busy:true})
 let release!:()=>void;f.runtime.start.mockImplementationOnce(()=>new Promise<void>(r=>{release=r}))
 const ready=f.service.prepare();await vi.waitFor(()=>expect(release).toBeTypeOf('function'));f.runtime.stop.mockClear()
 await f.service.stop(true,false);expect(f.runtime.stop).toHaveBeenCalledOnce()
 release();await ready;expect(f.service.snapshot().status).toBe('stopped')
})

it('removal deletes only the selected voice derivative and preserves another voice cache',async()=>{
 const f=await fixture(),own=join(f.root,'gguf-cache','voice@1'),other=join(f.root,'gguf-cache','other@1')
 await mkdir(own,{recursive:true});await mkdir(other,{recursive:true});await writeFile(join(own,'derived'),'own');await writeFile(join(other,'derived'),'other')
 await f.service.remove('voice@1');await expect(stat(own)).rejects.toThrow();expect(await readFile(join(other,'derived'),'utf8')).toBe('other')
})

it('Windows builtin voice needs no package or manual runtime and keeps two compiled modes',async()=>{
 const root=await mkdtemp(join(tmpdir(),'voice-windows-base-'));roots.push(root)
 const base={native:false,profile:{id:'voxcpm2_default',version:'base',name:'Default',fingerprint:'base',adapterSha256:'none'},executable:'/managed/python',path:'/managed/model',snapshot:()=>({supported:true,installed:true,phase:'idle' as const,bytes:1,total:1,error:null}),initialize:async()=>{},identity:async()=>"stable",cancelVerification:async()=>{},ready:async()=>'/managed/model',install:async()=>{},cancel:async()=>{}}
 const configs:any[]=[];const runtime={config:null as any,sessionId:'base-session',running:false,start:vi.fn(async()=>{runtime.running=true}),stop:vi.fn(async()=>{runtime.running=false}),retireSpeech:vi.fn(),cancelSpeech:vi.fn(async()=>({keptWarm:true,elapsedMs:0}))}
 const service=new CharacterVoiceService(root,'/worker',()=>({character:{id:'test',revision:'1'}}) as any,()=>{},()=>{},config=>{configs.push(config);runtime.config=config;return runtime as any},()=>{},base);services.push(service)
 await service.initialize();expect(service.snapshot()).toMatchObject({defaultProfile:'voxcpm2_default@base',runtimeConfigured:true,executionProfile:'cuda-compiled',availableProfiles:['cuda-compiled','cuda-compiled-complete']})
 await service.enabled(true);service.setOutputReady(true);await service.prepare();expect(configs[0]).toMatchObject({windowsBase:true,nativeBase:false,python:'/managed/python',model:'/managed/model',executionProfile:'cuda-compiled'})
 await service.executionProfile('cuda-compiled-complete');expect(service.snapshot().executionProfile).toBe('cuda-compiled-complete');expect(JSON.parse(await readFile(join(root,'settings.json'),'utf8')).baseExecutionProfile).toBe('cuda-compiled-complete')
 expect(configs.at(-1).executionProfile).toBe('cuda-compiled-complete')
})

it.each(['baseline','cached','compiled'] as const)('F1: Windows installer cannot replace external %s or persist a different mode',async mode=>{
 const f=await fixture(),base={native:false,profile:{id:'voxcpm2_default',version:'base',name:'Default',fingerprint:'base',adapterSha256:'none'},snapshot:()=>({supported:true,installed:false}),cancelVerification:async()=>{},cancel:async()=>{}}
 ;(f.service as any).base=base;(f.service as any).state.executionProfile=mode
 expect(f.service.snapshot()).toMatchObject({executionProfile:mode,availableProfiles:['baseline','cached','compiled']})
 await f.service.volume(0.4)
 expect(JSON.parse(await readFile(join(f.root,'settings.json'),'utf8')).executionProfile).toBe(mode)
 await f.service.prepare();expect(f.runtime.start).toHaveBeenCalledTimes(mode==='baseline'?0:1)
 if(mode!=='baseline')expect((f.runtime.start.mock.calls[0] as unknown[])[1]).toBe('fingerprint:'+mode)
})
it('F2: three warm default utterances validate once; a new worker or changed identity validates again',async()=>{
 const f=await fixture();let identity='generation-1'
 const base={native:false,profile:{id:'voxcpm2_default',version:'base',name:'Default',fingerprint:'base',adapterSha256:'none'},executable:'/python',path:'/model',snapshot:()=>({supported:true,installed:true}),identity:vi.fn(async()=>identity),ready:vi.fn(async()=>'/model'),cancelVerification:async()=>{},cancel:async()=>{}}
 ;(f.service as any).base=base;(f.service as any).state.profiles.push(base.profile);(f.service as any).state.bindings['actual-id']='voxcpm2_default@base';(f.service as any).state.executionProfile='cuda-compiled-complete';(f.service as any).baseExecutionProfile='cuda-compiled-complete'
 Object.assign(f.runtime,{config:{python:'/python',model:'/model',nativeBase:false,windowsBase:true},busy:false})
 for(let i=0;i<3;i++){f.message.text='서로 다른 문장 '+i;const task=(f.service as any).read(f.message);await f.completeOne();await task}
 expect(base.ready).toHaveBeenCalledTimes(1)
 f.runtime.running=false;const reloaded=(f.service as any).read(f.message);await f.completeOne();await reloaded;expect(base.ready).toHaveBeenCalledTimes(2)
 identity='generation-2';const replaced=(f.service as any).read(f.message);await f.completeOne();await replaced;expect(base.ready).toHaveBeenCalledTimes(3)
})

it.each(['stop','hide','off','close','question'] as const)('F2: %s during base verification forbids late start and audio',async action=>{
 const f=await fixture();let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>release=r),begun=new Promise<void>(r=>entered=r)
 const base={native:false,profile:{id:'voxcpm2_default',version:'base',name:'Default',fingerprint:'base',adapterSha256:'none'},executable:'/python',path:'/model',snapshot:()=>({supported:true,installed:true}),identity:async()=> 'stable',ready:vi.fn(async()=>{entered();await gate;return '/model'}),cancelVerification:vi.fn(async()=>{}),cancel:async()=>{}}
 ;(f.service as any).base=base;(f.service as any).state.profiles.push(base.profile);(f.service as any).state.bindings['actual-id']='voxcpm2_default@base';Object.assign(f.runtime,{config:{nativeBase:false},busy:false})
 const preparing=f.service.prepare();await begun
 if(action==='hide')f.service.setOutputReady(false)
 else if(action==='off')await f.service.enabled(false)
 else if(action==='close')await f.service.close()
 else if(action==='question')f.service.cancel()
 else await f.service.stop()
 release();await preparing
 expect(base.cancelVerification).toHaveBeenCalled();expect(f.runtime.start).not.toHaveBeenCalled();expect(f.runtime.synthesize).not.toHaveBeenCalled();expect(f.events.filter(e=>e.type==='audio')).toEqual([])
})
it('F2: validation failure stops the old worker and recovery validates before loading',async()=>{
 const f=await fixture();let identity='first'
 const base={native:false,profile:{id:'voxcpm2_default',version:'base',name:'Default',fingerprint:'base',adapterSha256:'none'},executable:'/python',path:'/model',snapshot:()=>({supported:true,installed:true}),identity:async()=>identity,ready:vi.fn(async()=>'/model'),cancelVerification:async()=>{},cancel:async()=>{}}
 ;(f.service as any).base=base;(f.service as any).state.profiles.push(base.profile);(f.service as any).state.bindings['actual-id']='voxcpm2_default@base';Object.assign(f.runtime,{config:{nativeBase:false},busy:false})
 await f.service.prepare();identity='tampered';base.ready.mockRejectedValueOnce(Error('VOICE_BASE_CHANGED'));await f.service.prepare()
 expect(f.runtime.running).toBe(false);expect(f.runtime.start).toHaveBeenCalledTimes(1);expect(f.service.snapshot().error).toBe('VOICE_BASE_CHANGED')
 identity='repaired';await f.service.prepare();expect(base.ready).toHaveBeenCalledTimes(3);expect(f.runtime.start).toHaveBeenCalledTimes(2);expect(f.service.snapshot().error).toBeNull()
})

it.each(['baseline','cached','compiled'] as const)('F1: default/external switch and restart retain external %s independently',async mode=>{
 const f=await fixture(),external=(f.service as any).state.profiles[0],base={native:false,profile:{id:'voxcpm2_default',version:'base',name:'Default',fingerprint:'base',adapterSha256:'none'},executable:'/base/python',path:'/base/model',snapshot:()=>({supported:true,installed:false,phase:'idle' as const,bytes:0,total:1,error:null}),initialize:async()=>{},identity:async()=> 'stable',ready:async()=>'/base/model',cancelVerification:async()=>{},install:async()=>{},cancel:async()=>{}}
 ;(f.service as any).base=base;(f.service as any).state.executionProfile=mode;(f.service as any).state.profiles.push(base.profile)
 await f.service.bind('actual-id','voxcpm2_default@base');await f.service.executionProfile('cuda-compiled-complete');await f.service.volume(0.4)
 expect(f.service.snapshot().executionProfile).toBe('cuda-compiled-complete')
 await f.service.bind('actual-id','voice@1');expect(f.service.snapshot().executionProfile).toBe(mode)
 const descriptor=Object.getOwnPropertyDescriptor(process,'platform')!
 let restored!:CharacterVoiceService
 try{Object.defineProperty(process,'platform',{value:'win32',configurable:true});restored=new CharacterVoiceService(f.root,'/worker',()=>f.chat,()=>{},()=>{},()=>f.runtime as any,()=>{},base);services.push(restored);await restored.initialize()}finally{Object.defineProperty(process,'platform',descriptor)}
 ;(restored as any).state.profiles.push(external);await restored.bind('actual-id','voice@1')
 expect(restored.snapshot().executionProfile).toBe(mode)
 await restored.bind('actual-id','voxcpm2_default@base');expect(restored.snapshot().executionProfile).toBe('cuda-compiled-complete')
})

const groupingTexts=[
 '비 소리 들으니까 밖은 진짜 축축하겠다. 우리 오늘은 그냥 가게 문 닫고 좀 쉴까? 아, 그래도 손님 오실 수도 있으니까 가게는 열어두고 안에서 쉬자. 그럼 내가 따뜻한 차라도 좀 더 끓여올게. 오빠도 옆에 앉아서 좀 쉬어, 오늘 고생 많았잖아.',
 '아... 하, 안 돼... 그만...',
]
const groupingProfiles:ExecutionProfile[]=['baseline','cached','compiled','cuda-compiled','cuda-compiled-complete','gguf-metal-f16','gguf-metal-f16-complete']
for(const policy of ['legacy-sentence-v1','utterance-v1','transition-v1'] as const)for(const profile of groupingProfiles)for(const builtin of [false,true])it(`${policy} grouping service ${profile} ${builtin?'default':'trained'} uses the same lossless inputs in both delivery modes`,async()=>{
 const f=await fixture(policy);(f.service as any).state.executionProfile=profile
 if(builtin){
  const base={native:profile.startsWith('gguf'),profile:{id:'voxcpm2_default',version:'base',name:'Default',fingerprint:'base',adapterSha256:'none'},executable:'/python',path:'/model',snapshot:()=>({supported:true,installed:true}),identity:async()=> 'stable',ready:async()=>'/model',cancelVerification:async()=>{},cancel:async()=>{}}
  ;(f.service as any).base=base;(f.service as any).state.profiles.push(base.profile);(f.service as any).state.bindings['actual-id']='voxcpm2_default@base';(f.service as any).baseExecutionProfile=profile
  Object.assign(f.runtime,{config:{python:'/python',model:'/model',nativeBase:base.native,windowsBase:!base.native}})
 }
 const stream=vi.fn(async(_text:string,_binding:any,_index:number,accept:any)=>{await accept({audioId:'group-'+Math.random(),bytes:new Uint8Array(20),durationMs:100,generationMs:1,rtf:.01,synthesisId:'group',chunkIndex:0,sampleOffset:0,sampleCount:4800,firstChunkReadyMs:1});return {totalChunks:1,totalSamples:4800}});Object.assign(f.runtime,{stream,busy:false})
 ;(f.service as any).event=(e:VoiceEvent)=>{f.events.push(e);if(e.type==='audio')queueMicrotask(()=>{f.service.audio(e.audioId,e.epoch);f.service.played(e.audioId,e.epoch)})}
 for(const text of groupingTexts){
  f.message.text=text;stream.mockClear();f.runtime.synthesize.mockClear();await (f.service as any).read(f.message)
  const used=isStreamingProfile(profile)?stream:f.runtime.synthesize,unused=isStreamingProfile(profile)?f.runtime.synthesize:stream
  const expected=planSpeech(text,policy).segments.map(s=>s.text);expect(used).toHaveBeenCalledTimes(expected.length);expect(used.mock.calls.map((args:any)=>args[0])).toEqual(expected);expect(unused).not.toHaveBeenCalled();expect(f.service.snapshot().error).toBeNull()
 }
})
for(const policy of ['utterance-v1','transition-v1'] as const)it.each(['auto','reread','test'])(`${policy} %s entry uses the common plan`,async mode=>{
 const f=await fixture(policy);f.message.text=groupingTexts[0]
 ;(f.service as any).event=(e:VoiceEvent)=>{if(e.type==='audio')queueMicrotask(()=>{f.service.audio(e.audioId,e.epoch);f.service.played(e.audioId,e.epoch)})}
 if(mode==='auto')f.service.completed(f.message);else if(mode==='test')f.service.test();else f.service.readMessage(f.message.id)
 const expected=planSpeech(mode==='test'?'응, 듣고 있어. 지금은 어떤 이야기를 할까?':groupingTexts[0],policy).segments.map(s=>s.text)
 await vi.waitFor(()=>expect(f.runtime.synthesize).toHaveBeenCalledTimes(expected.length));await vi.waitFor(()=>expect(f.service.snapshot().status).toBe('idle'))
 expect(f.runtime.synthesize.mock.calls.map((args:any)=>args[0])).toEqual(expected)
})
it.each(['stop','hide','off','close'])('grouped large input %s cancels while generation is pending',async action=>{
 const f=await fixture('utterance-v1');f.message.text=groupingTexts[0];let release!:(value:any)=>void
 f.runtime.synthesize.mockImplementationOnce(()=>new Promise(r=>{release=r}));f.service.readMessage(f.message.id)
 await vi.waitFor(()=>expect(release).toBeTypeOf('function'))
 if(action==='hide')f.service.setOutputReady(false);else if(action==='off')await f.service.enabled(false);else await (f.service as any)[action]()
 release({audioId:'late-group',bytes:new Uint8Array(1),durationMs:1});await new Promise(r=>setTimeout(r,10));expect(f.events.some(e=>e.type==='audio')).toBe(false);expect(f.runtime.synthesize).toHaveBeenCalledTimes(1)
})

// These service fixtures use synthetic paths and no installed model/runtime.
seedBeforeEach(()=>{vi.spyOn(CharacterVoiceService.prototype as any,'replayAssets').mockResolvedValue('synthetic-asset-identity')})
