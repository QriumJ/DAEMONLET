import {beforeEach as seedBeforeEach} from 'vitest'
import {afterEach,expect,it,vi} from 'vitest'
import {EventEmitter} from 'node:events'
import {PassThrough} from 'node:stream'
import {randomUUID} from 'node:crypto'
import {writeFileSync} from 'node:fs'
import {mkdtemp,readdir,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {TtsRuntimeSupervisor,type SpawnWorker} from '../electron/main/character-voice/TtsRuntimeSupervisor'
import {CharacterVoiceService} from '../electron/main/character-voice/CharacterVoiceService'
import type {LocalChatSnapshot} from '../electron/shared/character-chat-contract'
import type {VoiceEvent,SpeechPolicy} from '../electron/shared/character-voice-contract'

const io=vi.hoisted(()=>({remaining:0,entered:()=>{},wait:Promise.resolve()}))
vi.mock('node:fs/promises',async importOriginal=>{
 const fs=await importOriginal<typeof import('node:fs/promises')>()
 return {...fs,readFile:async(...args:Parameters<typeof fs.readFile>)=>{
  const bytes=await fs.readFile(...args)
  if(String(args[0]).endsWith('.wav')&&io.remaining>0&&--io.remaining===0){io.entered();await io.wait}
  return bytes
 }}
})
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {promise,resolve}}
function blockRead(n:number){const entered=deferred(),release=deferred();io.remaining=n;io.entered=entered.resolve;io.wait=release.promise;return {entered:entered.promise,release:release.resolve}}
function wav(){const b=Buffer.alloc(9644);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(48000,24);b.writeUInt32LE(96000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(9600,40);return b}
const cleanup:Array<()=>Promise<void>>=[]
afterEach(async()=>{io.remaining=0;for(const close of cleanup.splice(0))await close();vi.restoreAllMocks()})
async function fixture(policy:SpeechPolicy='legacy-sentence-v1'){
 const root=await mkdtemp(join(tmpdir(),'voice-ownership-')),requests:any[]=[],events:VoiceEvent[]=[]
 let cache='',spawns=0,kills=0,hold=false,finish=()=>{},cancelReply=()=>{}
 const spawn:SpawnWorker=()=>{
  ++spawns
  const child:any=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.exitCode=null
  child.kill=()=>{++kills;child.exitCode=0;queueMicrotask(()=>child.emit('close',0));return true}
  const send=(r:any,type:string,extra={})=>child.stdout.write(JSON.stringify({protocolVersion:1,requestId:r.requestId,type,effectiveSeed:r.seed,...extra})+'\n')
  child.stdin.on('data',(bytes:Buffer)=>{for(const line of bytes.toString().trim().split('\n')){
   const r=JSON.parse(line);requests.push(r)
   if(r.type==='cancel-stream')cancelReply=()=>send(r,'cancelled',{target:r.target,cleanupComplete:true,keptWarm:true})
   if(r.type==='init'){cache=r.cache;queueMicrotask(()=>send(r,'ready',{seedContract:1}))}
   if(r.type==='synthesize'){
    finish=()=>{writeFileSync(join(cache,r.audioId+'.wav'),wav());send(r,'audio-ready',{audioId:r.audioId,binding:r.binding,segmentIndex:r.segmentIndex,generationMs:1,rtf:.01})}
    if(!hold)queueMicrotask(finish)
   }
   if(r.type==='stream'){
    finish=()=>send(r,'synthesis-finished',{synthesisId:r.synthesisId,totalChunks:2,totalSamples:9600})
    queueMicrotask(()=>{
     for(let i=0;i<2;i++){const id=randomUUID();writeFileSync(join(cache,id+'.wav'),r.text.includes('corrupt')?Buffer.alloc(3):wav());send(r,'audio-chunk',{synthesisId:r.synthesisId,audioId:id,binding:r.binding,segmentIndex:r.segmentIndex,chunkIndex:r.text.includes('duplicate')?0:i,sampleOffset:i*4800,sampleCount:4800,sampleRate:48000,firstChunkReadyMs:1})}
     if(!hold)finish()
    })
   }
  }})
  return child
 }
 const runtime=new TtsRuntimeSupervisor({python:process.execPath,model:root,worker:join(root,'synthetic'),cacheRoot:join(root,'cache')},2000,spawn)
 const message={id:'message',role:'assistant',status:'complete',text:'응.',createdAt:'now',binding:{characterId:'test',revision:'rev',conversationId:'chat',requestId:'req',epoch:1,modelId:'E4B',personaHash:'p',semanticHash:'s'}}
 const chat={epoch:1,model:'E4B',character:{id:'test',revision:'rev'},conversation:{id:'chat',messages:[message]}} as LocalChatSnapshot
 const service=new CharacterVoiceService(root,join(root,'synthetic'),()=>chat,()=>{},e=>events.push(e),()=>runtime,undefined,undefined,policy)
 cleanup.push(async()=>{await service.close();await rm(root,{recursive:true,force:true})})
 await service.initialize();(service as any).state.executionProfile='baseline';await service.configure(process.execPath,root);await service.enabled(true)
 ;(service as any).state.profiles=[{id:'voice',version:'1',fingerprint:'fingerprint'}]
 await service.bind('test','voice@1');service.setOutputReady(true)
 ;(service as any).state.executionProfile='cached'
 const read=()=>service.readMessage('message')
 const audio=()=>events.filter((e):e is Extract<VoiceEvent,{type:'audio'}>=>e.type==='audio')
 const consume=()=>{for(const e of audio()){try{service.audio(e.audioId,e.epoch);service.played(e.audioId,e.epoch)}catch{}}}
 return {runtime,service,read,audio,consume,requests,message,cache:()=>cache,spawns:()=>spawns,kills:()=>kills,hold:()=>{hold=true},finish:()=>finish(),cancelReply:()=>cancelReply()}
}

it.each(['stop','reread'])('R2 real service %s waits for cleanup ack before replacement',async boundary=>{
 const f=await fixture();f.hold();f.read();await vi.waitFor(()=>expect(f.audio()).toHaveLength(2))
 const session=f.runtime.sessionId,old=f.audio()[0]
 const stopped=boundary==='stop'?f.service.stop(true,false):Promise.resolve();f.read()
 await vi.waitFor(()=>expect(f.requests.filter(r=>r.type==='cancel-stream')).toHaveLength(1))
 expect(f.requests.filter(r=>r.type==='stream')).toHaveLength(1)
 expect(f.requests.filter(r=>r.type==='credit')).toHaveLength(0)
 expect(()=>f.service.audio(old.audioId,old.epoch)).toThrow('VOICE_AUDIO_EXPIRED')
 f.cancelReply();await stopped
 await vi.waitFor(()=>expect(f.requests.filter(r=>r.type==='stream')).toHaveLength(2))
 expect(f.kills()).toBe(0);expect(f.spawns()).toBe(1);expect(f.runtime.sessionId).toBe(session)
 f.finish();await vi.waitFor(()=>{f.consume();expect(f.service.snapshot().status).toBe('idle')})
})

it('R2 unload during cancellation kills the owned worker and forbids late replacement',async()=>{
 const f=await fixture();f.hold();f.read();await vi.waitFor(()=>expect(f.audio()).toHaveLength(2))
 const cancel=f.service.stop(true,false);f.read()
 await vi.waitFor(()=>expect(f.requests.filter(r=>r.type==='cancel-stream')).toHaveLength(1))
 await f.service.close();await cancel;f.cancelReply()
 expect(f.runtime.running).toBe(false);expect(f.kills()).toBe(1);expect(f.requests.filter(r=>r.type==='stream')).toHaveLength(1)
})

it.each(['baseline','cached'] as const)('R1 real service retires terminal IO before same-worker %s replacement',async profile=>{
 const f=await fixture(),barrier=blockRead(2);f.read()
 await barrier.entered
 expect(f.runtime.busy).toBe(false);const session=f.runtime.sessionId,old=f.audio()[0]
 await f.service.stop(true,false)
 expect(()=>f.service.audio(old.audioId,old.epoch)).toThrow('VOICE_AUDIO_EXPIRED')
 // Exercise a new pending request on the SAME child/session, not respawn recovery.
 f.hold()
 const baseline=profile==='baseline'?f.runtime.synthesize('replacement',{...f.requests.find(r=>r.type==='stream').binding,speechEpoch:f.service.snapshot().epoch},0).then(value=>({value,error:null}),error=>({value:null,error})):null
 if(!baseline)f.read()
 await vi.waitFor(()=>expect(f.requests.filter(r=>r.type==='stream'||r.type==='synthesize')).toHaveLength(2))
 expect(f.runtime.busy).toBe(true);expect(f.spawns()).toBe(1);expect(f.runtime.sessionId).toBe(session);barrier.release()
 await vi.waitFor(()=>expect(f.runtime.deliveryPending).toBe(false))
 await vi.waitFor(async()=>expect((await readdir(f.cache())).filter(p=>p.endsWith('.wav'))).toEqual([]))
 expect(f.kills()).toBe(0);expect(f.spawns()).toBe(1);expect(f.runtime.sessionId).toBe(session)
 f.finish()
 if(baseline){const result=await baseline;expect(result.error).toBeNull();expect(result.value?.durationMs).toBe(100)}
 else await vi.waitFor(()=>{f.consume();expect(f.service.snapshot().status).toBe('idle')})
 expect(f.service.snapshot().error).toBeNull();expect(f.runtime.running).toBe(true)
 expect(f.audio().filter(e=>e.epoch===old.epoch)).toHaveLength(1)
 const oldRequest=f.requests.find(r=>r.type==='stream').requestId
 expect(f.requests.filter(r=>r.type==='credit'&&r.requestId===oldRequest).map(r=>r.chunkIndex)).toEqual([0,1])
})

it('R1 no-cancel control finishes delayed IO without changing worker ownership',async()=>{
 const f=await fixture(),barrier=blockRead(2);f.read();await barrier.entered
 expect(f.runtime.busy).toBe(false);barrier.release()
 await vi.waitFor(()=>{f.consume();expect(f.service.snapshot().status).toBe('idle')})
 expect(f.audio()).toHaveLength(2);expect(f.spawns()).toBe(1);expect(f.kills()).toBe(0)
})

it('R1 explicit reread retires old IO without a preceding stop button',async()=>{
 const f=await fixture(),barrier=blockRead(2);f.read();await barrier.entered
 const old=f.audio()[0],session=f.runtime.sessionId;f.hold();f.read()
 await vi.waitFor(()=>expect(f.requests.filter(r=>r.type==='stream')).toHaveLength(2))
 expect(()=>f.service.audio(old.audioId,old.epoch)).toThrow('VOICE_AUDIO_EXPIRED')
 barrier.release();await vi.waitFor(()=>expect(f.runtime.deliveryPending).toBe(false))
 expect(f.kills()).toBe(0);expect(f.spawns()).toBe(1);expect(f.runtime.sessionId).toBe(session)
 f.finish();await vi.waitFor(()=>{f.consume();expect(f.service.snapshot().status).toBe('idle')})
 expect(f.service.snapshot().error).toBeNull()
})

it.each(['corrupt','duplicate'])('current utterance %s still fails closed',async text=>{
 const f=await fixture();f.message.text=text;f.read()
 await vi.waitFor(()=>expect(f.service.snapshot().status).toBe('error'))
 await vi.waitFor(()=>expect(f.runtime.running).toBe(false));expect(f.kills()).toBe(1)
 expect(f.message.status).toBe('complete')
})

it('a predecessor playback error still cancels the same answer successor',async()=>{
 const f=await fixture();f.message.text='응. 다음!';const barrier=blockRead(2);f.read();await barrier.entered
 f.hold();barrier.release()
 await vi.waitFor(()=>expect(f.requests.filter(r=>r.type==='stream')).toHaveLength(2))
 expect(f.runtime.busy).toBe(true);const old=f.audio()[0]
 f.service.audio(old.audioId,old.epoch);f.service.played(old.audioId,old.epoch,true)
 await vi.waitFor(()=>expect(f.service.snapshot().error).toBe('VOICE_PLAYBACK'))
 expect(f.runtime.running).toBe(false);expect(f.kills()).toBe(1)
 for(const e of f.audio())expect(()=>f.service.audio(e.audioId,e.epoch)).toThrow('VOICE_AUDIO_EXPIRED')
})

it.each(['stop','reread'])('grouped R2 real service %s waits for cleanup ack before replacement',async boundary=>{
 const f=await fixture('transition-v1');f.message.text='비가 오는 날이야. 오늘은 따뜻한 차를 마시면서 천천히 이야기하자. 아... 잠깐만.';f.hold();f.read();await vi.waitFor(()=>expect(f.audio()).toHaveLength(2))
 const session=f.runtime.sessionId,old=f.audio()[0]
 const stopped=boundary==='stop'?f.service.stop(true,false):Promise.resolve();f.read()
 await vi.waitFor(()=>expect(f.requests.filter(r=>r.type==='cancel-stream')).toHaveLength(1))
 expect(f.requests.filter(r=>r.type==='stream')).toHaveLength(1)
 expect(f.requests.filter(r=>r.type==='credit')).toHaveLength(0)
 expect(()=>f.service.audio(old.audioId,old.epoch)).toThrow('VOICE_AUDIO_EXPIRED')
 f.cancelReply();await stopped
 await vi.waitFor(()=>expect(f.requests.filter(r=>r.type==='stream')).toHaveLength(2))
 expect(f.kills()).toBe(0);expect(f.spawns()).toBe(1);expect(f.runtime.sessionId).toBe(session)
 f.finish();await vi.waitFor(()=>{f.consume();expect(f.service.snapshot().status).toBe('idle')})
})

it.each(['baseline','cached'] as const)('grouped R1 real service retires terminal IO before same-worker %s replacement',async profile=>{
 const f=await fixture('transition-v1');f.message.text='비가 오는 날이야. 오늘은 따뜻한 차를 마시면서 천천히 이야기하자. 아... 잠깐만.';const barrier=blockRead(2);f.read()
 await barrier.entered
 expect(f.runtime.busy).toBe(false);const session=f.runtime.sessionId,old=f.audio()[0]
 await f.service.stop(true,false)
 expect(()=>f.service.audio(old.audioId,old.epoch)).toThrow('VOICE_AUDIO_EXPIRED')
 // Exercise a new pending request on the SAME child/session, not respawn recovery.
 f.hold()
 const baseline=profile==='baseline'?f.runtime.synthesize('replacement',{...f.requests.find(r=>r.type==='stream').binding,speechEpoch:f.service.snapshot().epoch},0).then(value=>({value,error:null}),error=>({value:null,error})):null
 if(!baseline)f.read()
 await vi.waitFor(()=>expect(f.requests.filter(r=>r.type==='stream'||r.type==='synthesize')).toHaveLength(2))
 expect(f.runtime.busy).toBe(true);expect(f.spawns()).toBe(1);expect(f.runtime.sessionId).toBe(session);barrier.release()
 await vi.waitFor(()=>expect(f.runtime.deliveryPending).toBe(false))
 await vi.waitFor(async()=>expect((await readdir(f.cache())).filter(p=>p.endsWith('.wav'))).toEqual([]))
 expect(f.kills()).toBe(0);expect(f.spawns()).toBe(1);expect(f.runtime.sessionId).toBe(session)
 f.finish()
 if(baseline){const result=await baseline;expect(result.error).toBeNull();expect(result.value?.durationMs).toBe(100)}
 else await vi.waitFor(()=>{f.consume();expect(f.service.snapshot().status).toBe('idle')})
 expect(f.service.snapshot().error).toBeNull();expect(f.runtime.running).toBe(true)
 expect(f.audio().filter(e=>e.epoch===old.epoch)).toHaveLength(1)
 const oldRequest=f.requests.find(r=>r.type==='stream').requestId
 expect(f.requests.filter(r=>r.type==='credit'&&r.requestId===oldRequest).map(r=>r.chunkIndex)).toEqual([0,1])
})

// These service fixtures use synthetic paths and no installed model/runtime.
seedBeforeEach(()=>{vi.spyOn(CharacterVoiceService.prototype as any,'replayAssets').mockResolvedValue('synthetic-asset-identity')})
