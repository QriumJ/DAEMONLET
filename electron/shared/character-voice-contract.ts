import type {GenerationBinding} from './character-chat-contract'

export const VOICE_IPC = {action:'character-voice.action', changed:'character-voice.changed', audio:'character-voice.audio', event:'character-voice.event'} as const
export type VoiceProfile = {id:string;version:string;name:string;fingerprint:string;adapterSha256:string}
export type ExecutionProfile='baseline'|'cached'|'compiled'|'mps-fp32-baseline'|'mps-fp32'
export function isStreamingProfile(profile:ExecutionProfile|undefined){return !!profile&&profile!=='baseline'&&profile!=='mps-fp32-baseline'}
export function voiceCapabilities(platform:string,arch:string):ExecutionProfile[]{return platform==='win32'?['baseline','cached','compiled']:platform==='darwin'&&arch==='arm64'?['mps-fp32-baseline','mps-fp32']:[]}
export type SpeechBinding = GenerationBinding & {messageId:string;speechEpoch:number;voiceProfileId:string;voiceProfileVersion:string;voiceFingerprint:string;runtimeSessionId:string;executionProfile?:ExecutionProfile}
export type VoiceSnapshot = {epoch:number;enabled:boolean;autoRead:boolean;volume:number;profiles:VoiceProfile[];bindings:Record<string,string>;status:'off'|'idle'|'loading'|'synthesizing'|'playing'|'stopped'|'error';error:string|null;runtimeConfigured:boolean;availableProfiles?:ExecutionProfile[];executionProfile?:ExecutionProfile}
export type VoiceAction = {type:'ready'|'snapshot'|'import'|'configure'|'test'|'stop'|'prepare'}|{type:'executionProfile';value:ExecutionProfile}|{type:'enabled'|'auto';value:boolean}|{type:'volume';value:number}|{type:'bind';profile:string|null}|{type:'remove';profile:string}|{type:'read';messageId:string}|{type:'played';audioId:string;epoch:number;error?:boolean}|{type:'scheduled';audioId:string;epoch:number;delayMs:number;gapMs:number}|{type:'outputStopped';epoch:number;elapsedMs:number}
export type VoiceEvent = {type:'stop';epoch:number;requestedAt?:number}|{type:'audio';epoch:number;audioId:string;binding:SpeechBinding;segmentIndex:number;stream?:{synthesisId:string;chunkIndex:number;sampleOffset:number;sampleCount:number}}
export interface VoiceApi {action(value:VoiceAction):Promise<VoiceSnapshot>;audio(id:string,epoch:number):Promise<Uint8Array>;subscribe(listener:(state:VoiceSnapshot)=>void):()=>void;onEvent(listener:(event:VoiceEvent)=>void):()=>void}

// Lossless UTF-16 offsets; grapheme boundaries are preserved even at the hard limit.
export function speechSegments(text:string,max=180) {
 if(!text.trim()||text.length>6000||!Number.isSafeInteger(max)||max<16||max>400)throw Error('VOICE_TEXT_LIMIT')
 const graphemes=[...new Intl.Segmenter('ko',{granularity:'grapheme'}).segment(text)]
 const result:Array<{text:string;start:number;end:number;index:number}>=[]
 let start=0,boundary=0
 const flush=(end:number)=>{
  if(end>start)result.push({text:text.slice(start,end),start,end,index:result.length})
  start=end;boundary=end
 }
 for(let i=0;i<graphemes.length;i++) {
  const g=graphemes[i],end=g.index+g.segment.length,next=graphemes[i+1]?.segment||''
  if(g.segment.length>400)throw Error('VOICE_TEXT_LIMIT')
  // Never split a grapheme, including one larger than the preferred chunk size.
  if(end-start>400)flush(g.index)
  if(/\s/u.test(g.segment))boundary=end
  const sentence=/[!?。！？\n]/u.test(g.segment)||g.segment==='.'&&(!next||/\s/u.test(next))
  if(sentence||end-start>=max)flush(!sentence&&boundary>start?boundary:end)
 }
 // A preferred whitespace cut may leave a suffix on the final iteration.
 flush(text.length)
 return result
}
