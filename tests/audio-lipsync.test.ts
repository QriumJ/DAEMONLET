import {expect,it,vi} from 'vitest'
import {AudioPlaybackController} from '../src/character-chat/AudioPlaybackController'
import {PlaybackMouthMeter,type MouthClock} from '../src/character-chat/PlaybackMouthMeter'
import type {VoiceApi,VoiceEvent} from '../electron/shared/character-voice-contract'
function fixture(){
 let amplitude=0,time=0,id=0
 const callbacks=new Map<number,FrameRequestCallback>(),listeners=new Set<()=>void>()
 const clock:MouthClock={request:callback=>{callbacks.set(++id,callback);return id},cancel:id=>{callbacks.delete(id)}}
 const analyser={fftSize:0,smoothingTimeConstant:0,connect:vi.fn(),disconnect:vi.fn(),getFloatTimeDomainData:(data:Float32Array)=>data.forEach((_,i)=>data[i]=i%2?amplitude:-amplitude)}
 const gain={gain:{value:1},connect:vi.fn()},sources:any[]=[]
 const context:any={state:'running',currentTime:0,destination:{},createAnalyser:()=>analyser,createGain:()=>gain,addEventListener:(_type:string,listener:()=>void)=>listeners.add(listener),removeEventListener:(_type:string,listener:()=>void)=>listeners.delete(listener),decodeAudioData:async()=>({sampleRate:48000,length:4800,numberOfChannels:1,duration:.1}),createBufferSource:()=>{const source={start:vi.fn(),stop:vi.fn(),disconnect:vi.fn(),connect:vi.fn(),onended:null};sources.push(source);return source},close:async()=>{}}
 const levels:Array<[number,number]>=[],sink=(level:number,epoch:number)=>levels.push([level,epoch])
 const api={audio:vi.fn(async()=>new Uint8Array(44)),action:vi.fn(async()=>({}))} as unknown as VoiceApi
 const player=new AudioPlaybackController(api,()=>context,{sink,clock})
 const tick=(value:number,frames=1)=>{amplitude=value;for(let i=0;i<frames;i++){time+=34;for(const [key,callback] of [...callbacks]){callbacks.delete(key);callback(time)}}}
 const event=(name:string,stream=false):VoiceEvent=>({type:'audio',epoch:1,audioId:name,binding:{} as any,segmentIndex:0,...(stream?{stream:{synthesisId:name,chunkIndex:0,sampleOffset:0,sampleCount:4800}}:{})})
 return{player,api,context,gain,analyser,sources,levels,clock,tick,event,callbacks,listeners,sink}
}
it('measures after gain, stays closed during scheduled future PCM, and follows only rendered samples',async()=>{
 const f=fixture();await f.player.receive(f.event('chunk',true))
 expect(f.gain.connect).toHaveBeenCalledWith(f.analyser);expect(f.analyser.connect).toHaveBeenCalledWith(f.context.destination)
 expect(f.sources[0].start).toHaveBeenCalledWith(.24);f.tick(0,3);expect(f.levels.at(-1)?.[0]).toBe(0)
 f.tick(.025,2);expect(f.levels.at(-1)).toEqual([1,1]);f.tick(.15,2);expect(f.levels.at(-1)).toEqual([2,1]);f.tick(0,12);expect(f.levels.at(-1)).toEqual([0,1])
 f.player.dispose();expect(f.callbacks.size).toBe(0);expect(f.listeners.size).toBe(0)
})
it('complete and cached replay use the same output graph and close immediately on end',async()=>{
 const f=fixture();await f.player.receive(f.event('complete'));f.tick(.15,2);expect(f.levels.at(-1)?.[0]).toBe(2)
 f.sources[0].onended();expect(f.levels.at(-1)?.[0]).toBe(0);expect(f.callbacks.size).toBe(0)
 await f.player.receive(f.event('cached-replay'));f.tick(.025,2);expect(f.levels.at(-1)?.[0]).toBe(1);expect(f.api.audio).toHaveBeenCalledTimes(2)
 f.player.dispose()
})
it.each(['stop','hide','mute','pause','dispose'])('closes immediately on %s with no orphan sampling loop',async boundary=>{
 const f=fixture();await f.player.receive(f.event('speech'));f.tick(.15,2);expect(f.levels.at(-1)?.[0]).toBe(2)
 if(boundary==='stop')await f.player.receive({type:'stop',epoch:2});else if(boundary==='hide')f.player.setVisible(false);else if(boundary==='mute')f.player.setVolume(0);else if(boundary==='pause'){f.context.state='suspended';for(const listener of f.listeners)listener()}else f.player.dispose()
 expect(f.levels.at(-1)?.[0]).toBe(0);expect(f.callbacks.size).toBe(0);f.tick(.15,3);expect(f.levels.at(-1)?.[0]).toBe(0)
 if(boundary==='mute'){f.player.setVolume(.8);f.tick(.025,2);expect(f.levels.at(-1)?.[0]).toBe(1)}
 if(boundary==='pause'){f.context.state='running';for(const listener of f.listeners)listener();f.tick(.025,2);expect(f.levels.at(-1)?.[0]).toBe(1)}
 f.player.dispose()
})
it('animation consumer failure cannot interrupt voice and constant DC is not speech energy',()=>{
 const f=fixture();f.analyser.getFloatTimeDomainData=data=>{data.fill(.5)}
 const meter=new PlaybackMouthMeter(f.context,f.analyser as any,()=>{throw Error('animation consumer failed')},()=>1,()=>true,f.clock)
 meter.start();expect(()=>f.tick(.1,3)).not.toThrow();meter.dispose();expect(f.callbacks.size).toBe(0)
})
it('invalid or cancelled stream never leaves a speaking mouth',async()=>{
 const f=fixture();await f.player.receive(f.event('stream',true));f.tick(.15,2)
 await f.player.receive({...f.event('bad',true),stream:{synthesisId:'stream',chunkIndex:4,sampleOffset:999,sampleCount:4800}} as VoiceEvent)
 expect(f.levels.at(-1)?.[0]).toBe(0);expect(f.callbacks.size).toBe(0);f.player.dispose()
})

it('mute emits one immediate close rather than a stream of zero callbacks',async()=>{
 const f=fixture();await f.player.receive(f.event('speech'));f.tick(.15,2);f.player.setVolume(0)
 const count=f.levels.length;f.tick(.15,180);expect(f.levels).toHaveLength(count);expect(f.callbacks.size).toBe(0);f.player.dispose()
})

it('starting new audio while already muted never creates repeated zero callbacks',async()=>{
 const f=fixture();f.player.setVolume(0);await f.player.receive(f.event('silent-output'));f.tick(.15,1)
 const count=f.levels.length;f.tick(.15,180);expect(f.levels).toHaveLength(count);expect(f.callbacks.size).toBe(0);f.player.dispose()
})
