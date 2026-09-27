import {expect,it,vi} from 'vitest'
import {AudioPlaybackController} from '../src/character-chat/AudioPlaybackController'
import type {VoiceApi,VoiceEvent} from '../electron/shared/character-voice-contract'

function player(){
 const sources:any[]=[],context={currentTime:1,state:'running',destination:{},createGain:()=>({gain:{value:1},connect:vi.fn()}),decodeAudioData:vi.fn(async()=>({duration:0.16,sampleRate:48000,length:7680,numberOfChannels:1})),createBufferSource:()=>{const s={start:vi.fn(),stop:vi.fn(),connect:vi.fn(),disconnect:vi.fn(),onended:null as any};sources.push(s);return s},close:vi.fn(async()=>{})}
 const api={audio:vi.fn(async()=>new Uint8Array(44)),action:vi.fn(async()=>({}))} as unknown as VoiceApi
 return {controller:new AudioPlaybackController(api,()=>context as unknown as AudioContext),sources,context,api}
}
const chunk=(index:number,overrides:Record<string,unknown>={}):VoiceEvent=>({type:'audio',audioId:`audio-${index}`,epoch:1,segmentIndex:0,binding:{} as any,stream:{synthesisId:'speech',chunkIndex:index,sampleOffset:index*7680,sampleCount:7680,...overrides}})
it('appends and schedules first chunk before the utterance completes, without stopping earlier audio',async()=>{
 const f=player();await f.controller.receive(chunk(0));expect(f.sources).toHaveLength(1);expect(f.sources[0].start).toHaveBeenCalledWith(1.24)
 await f.controller.receive(chunk(1));expect(f.sources[0].stop).not.toHaveBeenCalled();expect(f.sources[1].start).toHaveBeenCalledWith(1.4)
 await f.controller.receive(chunk(2));expect(f.sources[2].start).toHaveBeenCalledWith(1.5599999999999998)
 f.controller.stop();for(const source of f.sources){expect(source.stop).toHaveBeenCalledOnce();expect(source.onended).toBeNull()}
})
it('rejects reverse offsets and duplicate indices; stop clears every future source',async()=>{
 const f=player();await f.controller.receive(chunk(0));await f.controller.receive(chunk(1,{sampleOffset:0}));expect(f.sources).toHaveLength(1);expect(f.sources[0].stop).toHaveBeenCalled();expect(f.api.action).toHaveBeenCalledWith(expect.objectContaining({error:true}))
})
it('a late decoder cannot append after hide or profile epoch change',async()=>{
 const f=player();let resolve!:(v:any)=>void;f.context.decodeAudioData.mockImplementationOnce(()=>new Promise(r=>{resolve=r}))
 const pending=f.controller.receive(chunk(0));await vi.waitFor(()=>expect(resolve).toBeTypeOf('function'));f.controller.setVisible(false);resolve({duration:.16,sampleRate:48000,length:7680,numberOfChannels:1});await pending;expect(f.sources).toHaveLength(0)
})
it('bounds scheduled chunks and allows device-rate resampling',async()=>{
 const f=player();f.context.decodeAudioData.mockResolvedValue({duration:.16,sampleRate:44100,length:7056,numberOfChannels:1})
 for(let i=0;i<7;i++)await f.controller.receive(chunk(i))
 expect(f.sources).toHaveLength(6);expect(f.sources.every(s=>s.stop.mock.calls.length===1)).toBe(true)
})
