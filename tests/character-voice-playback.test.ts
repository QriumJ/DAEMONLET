import {expect,it,vi} from 'vitest'
import {speechSegments,type VoiceApi} from '../electron/shared/character-voice-contract'
import {AudioPlaybackController} from '../src/character-chat/AudioPlaybackController'
import {verifyWav} from '../electron/main/character-voice/TtsRuntimeSupervisor'
function assertLossless(text:string) {
 const segments=speechSegments(text)
 expect(segments.map(s=>s.text).join('')).toBe(text)
 const boundaries=new Set([...new Intl.Segmenter('ko',{granularity:'grapheme'}).segment(text)].map(g=>g.index));boundaries.add(text.length)
 segments.forEach((s,i)=>{expect(s.start).toBe(i?segments[i-1].end:0);expect(s.end).toBeGreaterThan(s.start);expect(boundaries.has(s.end)).toBe(true);expect(s.text.length).toBeLessThanOrEqual(400)})
 expect(segments.at(-1)?.end).toBe(text.length)
}
it('F1 exact 180-character suffix reproduction',()=>assertLossless('가 '.repeat(89)+'끝말'))
it.each([179,180,181,359,360,361])('F1 lossless boundary %i',length=>{
 for(const prefix of ['가 ', '가'.repeat(30)+' ', '가']) {
  const text=prefix.repeat(length).slice(0,length-2)+'끝말';assertLossless(text);assertLossless(text.slice(0,-1)+' ')
 }
})
it('F1 seeded grapheme/whitespace corpus',()=>{
 let seed=260927;const units=['가',' ', '3.14', 'Dr. Kim', '“응.”','\r\n','\n','👩‍👩‍👧‍👦','e\u0301']
 for(let i=0;i<150;i++){let text='';for(let j=0;j<100;j++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;text+=units[seed%units.length]}assertLossless(text)}
})
it('F1 oversized indivisible grapheme is rejected',()=>expect(()=>speechSegments('a'+'\u0301'.repeat(401))).toThrow('VOICE_TEXT_LIMIT'))
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

it('F2 hidden/disposed renderer refuses new events and late decode',async()=>{
 let decoded!:(value:any)=>void;const start=vi.fn(),context={state:'running',destination:{},createGain:()=>({gain:{value:1},connect:vi.fn()}),decodeAudioData:()=>new Promise(r=>{decoded=r}),createBufferSource:()=>({start,connect:vi.fn()}),close:async()=>{}}
 const api={audio:vi.fn(async()=>new Uint8Array(44)),action:vi.fn(async()=>({}))} as unknown as VoiceApi
 const player=new AudioPlaybackController(api,()=>context as unknown as AudioContext),event={type:'audio' as const,epoch:1,audioId:'synthetic',binding:{} as any,segmentIndex:0}
 const pending=player.receive(event);await vi.waitFor(()=>expect(decoded).toBeTypeOf('function'));player.setVisible(false);decoded({});await pending
 await player.receive({...event,audioId:'hidden'});expect(api.audio).toHaveBeenCalledTimes(1);expect(start).not.toHaveBeenCalled()
 player.dispose();player.setVisible(true);await player.receive({...event,audioId:'disposed'});expect(api.audio).toHaveBeenCalledTimes(1)
})
