import type {GenerationBinding} from './character-chat-contract'

export const VOICE_IPC = {action:'character-voice.action', changed:'character-voice.changed', audio:'character-voice.audio', event:'character-voice.event'} as const
export type VoiceProfile = {id:string;version:string;name:string;fingerprint:string;adapterSha256:string}
export type SpeechBinding = GenerationBinding & {messageId:string;speechEpoch:number;voiceProfileId:string;voiceProfileVersion:string;voiceFingerprint:string;runtimeSessionId:string}
export type VoiceSnapshot = {epoch:number;enabled:boolean;autoRead:boolean;volume:number;profiles:VoiceProfile[];bindings:Record<string,string>;status:'off'|'idle'|'loading'|'synthesizing'|'playing'|'stopped'|'error';error:string|null;runtimeConfigured:boolean}
export type VoiceAction = {type:'snapshot'|'import'|'configure'|'test'|'stop'}|{type:'enabled'|'auto';value:boolean}|{type:'volume';value:number}|{type:'bind';profile:string|null}|{type:'remove';profile:string}|{type:'read';messageId:string}|{type:'played';audioId:string;epoch:number;error?:boolean}
export type VoiceEvent = {type:'stop';epoch:number}|{type:'audio';epoch:number;audioId:string;binding:SpeechBinding;segmentIndex:number}
export interface VoiceApi {action(value:VoiceAction):Promise<VoiceSnapshot>;audio(id:string,epoch:number):Promise<Uint8Array>;subscribe(listener:(state:VoiceSnapshot)=>void):()=>void;onEvent(listener:(event:VoiceEvent)=>void):()=>void}

// Lossless UTF-16 offsets; grapheme boundaries are preserved even at the hard limit.
export function speechSegments(text:string,max=180) {
 if(!text.trim()||text.length>6000||max<16)throw Error('VOICE_TEXT_LIMIT')
 const graphemes=[...new Intl.Segmenter('ko',{granularity:'grapheme'}).segment(text)]
 const result:Array<{text:string;start:number;end:number;index:number}>=[]
 let start=0, count=0, boundary=0
 for(let i=0;i<graphemes.length;i++) {
  const g=graphemes[i],end=g.index+g.segment.length,next=graphemes[i+1]?.segment||''
  count+=g.segment.length
  if(/\s/u.test(g.segment))boundary=end
  const sentence=/[!?。！？\n]/u.test(g.segment)||g.segment==='.'&&(!next||/\s/u.test(next))
  if(sentence||count>=max||i===graphemes.length-1) {
   const cut=!sentence&&count>=max&&boundary>start?boundary:end
   result.push({text:text.slice(start,cut),start,end:cut,index:result.length});start=cut;count=end-start;boundary=start
  }
 }
 return result
}
