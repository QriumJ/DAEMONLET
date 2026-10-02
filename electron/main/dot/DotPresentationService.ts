import {parseDotCommand,DOT_VOICE_PREPARATION_TIMEOUT_MS,type DotFrame} from '../../shared/dot-presentation'
import {emptyChat,type CharacterChatDefinition} from '../../shared/character-chat-semantics'
export type DotContext={characterId:string;revision:string;definition:CharacterChatDefinition}
export type DotResult={accepted:true;sequence:number;poseFallback:boolean;voice:'muted'|'off'|'requested'}
/** Session-only ownership. Preparation is bounded separately from the requested playback/display lifetime. */
export class DotPresentationService{
 muted=true;quiet=false
 private sequence=0
 private request=0
 private muteSequence=0
 private frame:DotFrame|null=null
 private controller:AbortController|null=null
 private timer:ReturnType<typeof setTimeout>|null=null
 private closed=false
 constructor(private context:()=>DotContext|null,private publish:(frame:DotFrame|null)=>void,private speak:(text:string,signal:AbortSignal,onPlaybackScheduled:(delayMs:number)=>void)=>Promise<void>,private stop:(failure?:'preparation-timeout'|'failed')=>Promise<void>,private changed:()=>void=()=>{},private voiceIssue:()=>boolean=()=>false,private muteVoice:(value:boolean)=>Promise<void>=async()=>{}){}
 snapshot(){return this.frame?structuredClone(this.frame):null}
 private arm(sequence:number,ms:number,expired:()=>void){if(this.timer)clearTimeout(this.timer);this.timer=setTimeout(()=>{this.timer=null;if(sequence===this.sequence)expired()},ms)}
 async present(value:unknown):Promise<DotResult>{
  const cmd=parseDotCommand(value)
  if(this.closed)throw Error('DOT_UNAVAILABLE')
  if(cmd.type==='cancel'){await this.cancel();return {accepted:true,sequence:this.sequence,poseFallback:false,voice:'off'}}
  if(this.quiet)throw Error('DOT_QUIET')
  const context=this.context();if(!context)throw Error('DOT_UNAVAILABLE')
  if(cmd.speak&&!this.muted&&this.voiceIssue())throw Error('DOT_VOICE_UNAVAILABLE')
  const request=++this.request;await this.retire();if(request!==this.request)throw Error('DOT_CANCELLED')
  if(this.closed||this.quiet||this.context()?.characterId!==context.characterId||this.context()?.revision!==context.revision)throw Error('DOT_UNAVAILABLE')
  const controller=this.controller=new AbortController(),sequence=++this.sequence,voiced=cmd.speak&&!this.muted
  const lifetime=voiced?DOT_VOICE_PREPARATION_TIMEOUT_MS:cmd.durationMs
  this.frame={sequence,active:true,characterId:context.characterId,revision:context.revision,text:voiced?'':cmd.text??'',pose:cmd.pose,state:cmd.state,definition:{...emptyChat(),presentation:structuredClone(context.definition.presentation)},expiresAt:Date.now()+lifetime,muted:this.muted,...(voiced?{voicePhase:'preparing' as const}:{})}
  try{this.publish(this.snapshot())}catch{await this.cancel();throw Error('DOT_UNAVAILABLE')}this.changed()
  const current=()=>sequence===this.sequence&&this.controller===controller&&!controller.signal.aborted&&!this.closed&&!this.quiet&&!this.muted&&this.context()?.characterId===context.characterId&&this.context()?.revision===context.revision
  const failed=(timeout=false)=>{
   if(!current())return
   controller.abort(Error(timeout?'VOICE_PRESENTATION_PREPARATION_TIMEOUT':'VOICE_PRESENTATION_FAILED'))
   this.frame={...this.frame!,text:'',state:'error',voicePhase:'error',voiceError:timeout?'preparation-timeout':'failed',expiresAt:Date.now()+cmd.durationMs}
   try{this.publish(this.snapshot())}catch{void this.cancel();return}this.changed()
   void this.stop(timeout?'preparation-timeout':'failed').catch(()=>{this.quiet=true;this.changed()})
   this.arm(sequence,cmd.durationMs,()=>{void this.cancel()})
  }
  this.arm(sequence,lifetime,()=>{if(voiced)failed(true);else void this.cancel()})
  const result:DotResult={accepted:true,sequence,poseFallback:cmd.fallback,voice:cmd.speak?(this.muted?'muted':'requested'):'off'}
  if(voiced){
   let started=false
   const scheduled=(delayMs:number)=>{
    if(started||!current()||!Number.isFinite(delayMs)||delayMs<0||delayMs>6000)return
    started=true;this.frame={...this.frame!,text:cmd.text??'',voicePhase:'playing',expiresAt:Date.now()+Math.ceil(delayMs)+cmd.durationMs}
    try{this.publish(this.snapshot())}catch{void this.cancel();return}this.changed()
    this.arm(sequence,Math.ceil(delayMs)+cmd.durationMs,()=>{void this.cancel()})
   }
   // Only Main's validated, claimed current-epoch pet playback acknowledgement starts this clock.
   void this.speak(cmd.text!,controller.signal,scheduled).then(()=>{if(current()){if(started)void this.cancel();else failed()}}).catch(e=>{if(current()){if(e instanceof Error&&e.message==='VOICE_CANCELLED')void this.cancel();else failed()}})
  }
  return result
 }
 async cancel(){++this.request;await this.retire()}
 private async retire(){
  ++this.sequence;this.controller?.abort();this.controller=null
  if(this.timer)clearTimeout(this.timer);this.timer=null
  const owned=!!this.frame;this.frame=null;try{this.publish(null)}catch{}
  if(owned){try{await this.stop()}catch{this.quiet=true}}this.changed()
 }
 async setQuiet(value:boolean){this.quiet=value;if(value)await this.cancel();this.changed()}
 async setMuted(value:boolean){
  const sequence=++this.muteSequence;this.muted=value
  const cleanup=this.muteVoice(value);void cleanup.catch(()=>{})
  try{if(value)await this.cancel();await cleanup}catch(e){if(sequence===this.muteSequence)this.quiet=true;throw e}finally{this.changed()}
 }
 async close(){this.closed=true;await this.setMuted(true)}
}
