import {afterEach,expect,it,vi} from 'vitest'
import {mkdtemp,rm,readFile} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {CharacterVoiceService} from '../electron/main/character-voice/CharacterVoiceService'
import type {LocalChatSnapshot,ChatMessage} from '../electron/shared/character-chat-contract'
import type {VoiceEvent} from '../electron/shared/character-voice-contract'
import type {TtsRuntimeSupervisor} from '../electron/main/character-voice/TtsRuntimeSupervisor'
const roots:string[]=[],services:CharacterVoiceService[]=[]
afterEach(async()=>{for(const s of services.splice(0))await s.close();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});vi.restoreAllMocks()})
async function fixture(){const root=await mkdtemp(join(tmpdir(),'voice-service-'));roots.push(root)
 const message:ChatMessage={id:'message',role:'assistant',status:'complete',text:'응. 다음 문장!',createdAt:'now',binding:{characterId:'actual-id',revision:'rev1',conversationId:'conversation',requestId:'request',epoch:1,modelId:'E4B',personaHash:'p',semanticHash:'s'}}
 const chat={epoch:1,model:'E4B',character:{id:'actual-id',revision:'rev1'},conversation:{id:'conversation',messages:[message]}} as LocalChatSnapshot
 let audio=0
 const runtime={sessionId:'session',running:false,start:vi.fn(async()=>{runtime.running=true}),stop:vi.fn(async()=>{runtime.running=false}),synthesize:vi.fn(async()=>({audioId:'audio-'+(++audio),bytes:new Uint8Array([1,2]),durationMs:10,generationMs:1,rtf:0.1}))}
 const events:VoiceEvent[]=[]
 const service=new CharacterVoiceService(root,'/worker',()=>chat,()=>{},e=>events.push(e),()=>runtime as unknown as TtsRuntimeSupervisor);services.push(service)
 await service.initialize();await service.configure('/python','/model');await service.enabled(true)
 ;(service as any).state.profiles=[{id:'voice',version:'1',name:'Synthetic',fingerprint:'fingerprint',adapterSha256:'adapter'}]
 await service.bind('actual-id','voice@1')
 const complete=async()=>{await vi.waitFor(()=>expect(events.some(e=>e.type==='audio')).toBe(true));for(let i=0;i<2;i++){await vi.waitFor(()=>expect(events.filter(e=>e.type==='audio').length).toBe(i+1));const e=events.filter(e=>e.type==='audio')[i];if(e.type==='audio'){service.audio(e.audioId,e.epoch);service.played(e.audioId,e.epoch)}}await vi.waitFor(()=>expect(service.snapshot().status).toBe('idle'))}
 return{root,service,chat,message,runtime,events,complete}
}
it('only explicit completion triggers speech, deduplicates and applies ordered backpressure',async()=>{const f=await fixture();f.service.onChatChanged();expect(f.runtime.synthesize).not.toHaveBeenCalled();f.service.completed(f.message);f.service.completed(f.message);await vi.waitFor(()=>expect(f.runtime.synthesize).toHaveBeenCalledTimes(1));await f.complete();expect(f.runtime.synthesize.mock.calls.map(args=>(args as unknown[])[0])).toEqual(['응.',' 다음 문장!']);f.service.onChatChanged();expect(f.runtime.synthesize).toHaveBeenCalledTimes(2)})
it('late synthesis is discarded on revision or conversation changes',async()=>{const f=await fixture();let release!:(v:any)=>void;f.runtime.synthesize.mockImplementationOnce(()=>new Promise(r=>{release=r}));f.service.completed(f.message);await vi.waitFor(()=>expect(release).toBeTypeOf('function'));f.chat.character!.revision='rev2';f.service.onChatChanged();release({audioId:'late',bytes:new Uint8Array(1),durationMs:1});await new Promise(r=>setTimeout(r,20));expect(f.events.some(e=>e.type==='audio')).toBe(false);expect(f.runtime.stop).toHaveBeenCalled()})
it('only bound audio can be claimed once and cancellation expires its capability',async()=>{const f=await fixture();f.service.completed(f.message);await vi.waitFor(()=>expect(f.events.some(e=>e.type==='audio')).toBe(true));const e=f.events.find(e=>e.type==='audio')!;if(e.type!=='audio')throw Error();expect(()=>f.service.audio('wrong',e.epoch)).toThrow();expect(f.service.audio(e.audioId,e.epoch)).toEqual(new Uint8Array([1,2]));expect(()=>f.service.audio(e.audioId,e.epoch)).toThrow();await f.service.stop();f.service.played(e.audioId,e.epoch);expect(()=>f.service.audio(e.audioId,e.epoch)).toThrow();expect(f.runtime.synthesize).toHaveBeenCalledTimes(1)})
it('worker failure affects voice state without changing completed text',async()=>{const f=await fixture();f.runtime.synthesize.mockRejectedValueOnce(Error('CUDA_OOM'));f.service.completed(f.message);await vi.waitFor(()=>expect(f.service.snapshot().error).toBe('CUDA_OOM'));expect(f.message.status).toBe('complete');expect(f.message.text).toBe('응. 다음 문장!')})
it('OFF cancels pending speech and bindings persist separately per actual character ID',async()=>{const f=await fixture();await f.service.bind('other-id','voice@1');await f.service.auto(false);f.service.completed(f.message);expect(f.runtime.synthesize).not.toHaveBeenCalled();await f.service.enabled(false);const settings=JSON.parse(await readFile(join(f.root,'settings.json'),'utf8'));expect(settings.bindings).toEqual({'actual-id':'voice@1','other-id':'voice@1'});expect(settings.enabled).toBe(false)})
it('warm worker remains available after playback and a completed text invalidation',async()=>{const f=await fixture();f.service.completed(f.message);await f.complete();f.runtime.stop.mockClear();f.service.cancel();await new Promise(r=>setTimeout(r,0));expect(f.runtime.stop).not.toHaveBeenCalled();await f.service.enabled(false);expect(f.runtime.stop).toHaveBeenCalled()})
