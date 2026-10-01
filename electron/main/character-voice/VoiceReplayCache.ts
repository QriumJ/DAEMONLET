import {createHash} from 'node:crypto'
import type {VoiceGenerationPlan,VoiceResultInfo} from '../../shared/voice-seed'
import {verifyWav} from './TtsRuntimeSupervisor'
export const VOICE_REPLAY_LIMITS={results:8,bytes:64*1024*1024,resultBytes:16*1024*1024,metadata:128} as const
export type ReplayPart={bytes:Uint8Array;segmentIndex:number;stream?:{chunkIndex:number;sampleOffset:number;sampleCount:number};hash:string}
export type ReplayResult={identity:string;plan:VoiceGenerationPlan;parts:ReplayPart[];bytes:number;provenance:Record<string,unknown>}
export type ReplayCandidate=ReplayResult & {retained:boolean}
export class VoiceReplayCache {
 private audio=new Map<string,ReplayResult>()
 private metadata=new Map<string,{identity:string;info:VoiceResultInfo}>()
 private candidates=new Set<ReplayCandidate>()
 private scope=''
 private used=0
 setScope(scope:string){if(scope!==this.scope){this.clear();this.scope=scope;return true}return false}
 discardPending(){for(const c of [...this.candidates])this.discard(c)}
 clear(){this.audio.clear();this.metadata.clear();for(const c of this.candidates){c.retained=false;c.parts=[];c.bytes=0}this.candidates.clear();this.used=0}
 get retainedBytes(){return this.used}
 infos(){return Object.fromEntries([...this.metadata].map(([k,v])=>[k,{...v.info,cached:this.audio.get(k)?.plan.generationId===v.info.generationId}]))}
 previous(messageId:string,identity:string){const v=this.metadata.get(messageId);return v?.identity===identity?v.info:undefined}
 begin(identity:string,plan:VoiceGenerationPlan,provenance:Record<string,unknown>):ReplayCandidate{const c={identity,plan,provenance,parts:[],bytes:0,retained:true};this.candidates.add(c);return c}
 append(c:ReplayCandidate,bytes:Uint8Array,segmentIndex:number,stream?:ReplayPart['stream']){
  if(!this.candidates.has(c)||!c.retained)return
  if(bytes.byteLength+c.bytes>VOICE_REPLAY_LIMITS.resultBytes||this.used+bytes.byteLength>VOICE_REPLAY_LIMITS.bytes){this.discard(c);return}
  try{verifyWav(Buffer.from(bytes.buffer,bytes.byteOffset,bytes.byteLength))}catch{this.discard(c);return}
  const copy=Uint8Array.from(bytes);c.parts.push({bytes:copy,segmentIndex,stream,hash:createHash('sha256').update(copy).digest('hex')});c.bytes+=copy.byteLength;this.used+=copy.byteLength
 }
 discard(c:ReplayCandidate){if(this.candidates.delete(c)){this.used-=c.bytes;c.retained=false;c.parts=[];c.bytes=0}}
 publish(c:ReplayCandidate){
  const retained=this.candidates.delete(c)&&c.retained&&c.parts.length>0
  if(retained){const old=this.audio.get(c.plan.messageId);if(old)this.used-=old.bytes;this.audio.delete(c.plan.messageId);this.audio.set(c.plan.messageId,c);while(this.audio.size>VOICE_REPLAY_LIMITS.results)this.evict(this.audio.keys().next().value!)}
  const info={...c.plan,cached:!!retained,latestUnstored:!retained};this.metadata.delete(c.plan.messageId);this.metadata.set(c.plan.messageId,{identity:c.identity,info});while(this.metadata.size>VOICE_REPLAY_LIMITS.metadata){const key=this.metadata.keys().next().value!;this.metadata.delete(key);this.evict(key)}return info
 }
 forget(key:string){this.metadata.delete(key);this.evict(key)}
 private evict(key:string){const old=this.audio.get(key);if(old){this.used-=old.bytes;this.audio.delete(key)}}
 get(messageId:string,identity:string){const entry=this.audio.get(messageId),meta=this.previous(messageId,identity);if(!entry||!meta||entry.plan.generationId!==meta.generationId||entry.identity!==identity)return undefined;this.audio.delete(messageId);this.audio.set(messageId,entry);return entry}
}
