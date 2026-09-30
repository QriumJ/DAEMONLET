import {parseDotCommand,type DotFrame} from '../../shared/dot-presentation'
import {emptyChat,type CharacterChatDefinition} from '../../shared/character-chat-semantics'
export type DotContext={characterId:string;revision:string;definition:CharacterChatDefinition}
export type DotResult={accepted:true;sequence:number;poseFallback:boolean;voice:'muted'|'off'|'requested'}
/** Session-only ownership. No conversation writes and no queue to replay after hiding. */
export class DotPresentationService{
 muted=true;quiet=false
 private sequence=0
 private request=0
 private frame:DotFrame|null=null
 private controller:AbortController|null=null
 private timer:ReturnType<typeof setTimeout>|null=null
 private closed=false
 constructor(private context:()=>DotContext|null,private publish:(frame:DotFrame|null)=>void,private speak:(text:string,signal:AbortSignal)=>Promise<void>,private stop:()=>Promise<void>,private changed:()=>void=()=>{},private voiceIssue:()=>boolean=()=>false){}
 snapshot(){return this.frame?structuredClone(this.frame):null}
 async present(value:unknown):Promise<DotResult>{
  const cmd=parseDotCommand(value)
  if(this.closed)throw Error('DOT_UNAVAILABLE')
  if(cmd.type==='cancel'){await this.cancel();return {accepted:true,sequence:this.sequence,poseFallback:false,voice:'off'}}
  if(this.quiet)throw Error('DOT_QUIET')
  const context=this.context();if(!context)throw Error('DOT_UNAVAILABLE')
  if(cmd.speak&&!this.muted&&this.voiceIssue())throw Error('DOT_VOICE_UNAVAILABLE')
  const request=++this.request;await this.retire();if(request!==this.request)throw Error('DOT_CANCELLED')
  if(this.closed||this.quiet||this.context()?.characterId!==context.characterId||this.context()?.revision!==context.revision)throw Error('DOT_UNAVAILABLE')
  const controller=this.controller=new AbortController(),sequence=++this.sequence
  this.frame={sequence,active:true,characterId:context.characterId,revision:context.revision,text:cmd.text??'',pose:cmd.pose,state:cmd.state,definition:{...emptyChat(),presentation:structuredClone(context.definition.presentation)},expiresAt:Date.now()+cmd.durationMs,muted:this.muted}
  try{this.publish(this.snapshot())}catch{await this.cancel();throw Error('DOT_UNAVAILABLE')}this.changed()
  this.timer=setTimeout(()=>{if(sequence===this.sequence)void this.cancel()},cmd.durationMs)
  const result:DotResult={accepted:true,sequence,poseFallback:cmd.fallback,voice:cmd.speak?(this.muted?'muted':'requested'):'off'}
  // Acknowledgement is acceptance, not a claim that sound has played.
  if(cmd.speak&&!this.muted)void this.speak(cmd.text!,controller.signal).catch(e=>{if(!controller.signal.aborted&&sequence===this.sequence){this.frame={...this.frame!,text:'',state:'error'};try{this.publish(this.snapshot())}catch{void this.cancel()}this.changed()}})
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
 async setMuted(value:boolean){this.muted=value;if(value)await this.cancel();this.changed()}
 async close(){this.closed=true;await this.cancel()}
}
