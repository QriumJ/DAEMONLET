import {expect,it,vi} from 'vitest'
import {speechSegments,type VoiceApi} from '../electron/shared/character-voice-contract'
import {AudioPlaybackController} from '../src/character-chat/AudioPlaybackController'
import {verifyWav} from '../electron/main/character-voice/TtsRuntimeSupervisor'
it.each(['응.','"안녕!" 3.14는 숫자예요.\n다음 줄 👩‍👩‍👧‍👦!','한글과 English, Dr. Kim. 😀','가나다 '.repeat(100),'👨‍👩‍👧‍👦'.repeat(220)])('segments preserve every source character and contiguous offsets',text=>{const segments=speechSegments(text);expect(segments.map(s=>s.text).join('')).toBe(text);segments.forEach((s,i)=>{expect(s.start).toBe(i?segments[i-1].end:0);expect(text.slice(s.start,s.end)).toBe(s.text);expect(s.text).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u)})})
it('rejects empty and over-limit speech',()=>{expect(()=>speechSegments(' ')).toThrow();expect(()=>speechSegments('가'.repeat(6001))).toThrow()})
it('rejects empty/corrupt/wrong sample-rate audio',()=>{expect(()=>verifyWav(Buffer.alloc(44))).toThrow()})
it('discards audio decoding that completes after cancellation and rejects duplicate events',async()=>{
 let decoded!:(v:any)=>void;const start=vi.fn(),source={start,connect:vi.fn(),disconnect:vi.fn(),stop:vi.fn(),onended:null}
 const context={state:'running',destination:{},createGain:()=>({gain:{value:1},connect:vi.fn()}),decodeAudioData:()=>new Promise(r=>{decoded=r}),createBufferSource:()=>source,close:async()=>{}}
 const api={audio:vi.fn(async()=>new Uint8Array(44)),action:vi.fn(async()=>({}))} as unknown as VoiceApi
 const player=new AudioPlaybackController(api,()=>context as unknown as AudioContext),event={type:'audio' as const,epoch:1,audioId:'synthetic',binding:{} as any,segmentIndex:0}
 const pending=player.receive(event);await vi.waitFor(()=>expect(decoded).toBeTypeOf('function'));await player.receive({type:'stop',epoch:2});decoded({});await pending;await player.receive(event);expect(start).not.toHaveBeenCalled();expect(api.audio).toHaveBeenCalledTimes(1);player.dispose()
})
