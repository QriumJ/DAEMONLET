import type {DotFrame} from '../../electron/shared/dot-presentation'
import {neutralMeaning,resolveChatPose} from '../../electron/shared/character-chat-semantics'
import type {CharacterSession} from '../runtime/CharacterSession'
import type {DialogueSnapshot} from '../dialogue/types'
/** Keep the bounded original text; the native bubble owns preview/expansion. */
export function dotBubble(frame:DotFrame|null,now=Date.now(),t:(text:string)=>string=text=>text):DialogueSnapshot|null{
 if(!frame?.active||now>=frame.expiresAt)return null
 const text=frame.text||t(({idle:'준비됨',thinking:'생각 중…',speaking:'말하는 중…',done:'완료',error:'오류'} as const)[frame.state])
 return {enabled:true,characterId:frame.characterId,visible:true,phase:'shown',text,triggerId:null,priority:100,shownAt:now,hideAt:frame.expiresAt,fadeMs:0,queueLength:0,suppressedCount:0,lastDecision:null,history:[],warnings:[]}
}
export function dotPose(frame:DotFrame){
 const meaning={...neutralMeaning(),emotion:frame.pose==='happy'?'happy' as const:frame.pose==='sad'?'concerned' as const:'neutral' as const}
 const phase=frame.pose==='listening'?'attentive':frame.pose==='thinking'||frame.state==='thinking'?'generating':frame.pose==='error'||frame.state==='error'?'idle':frame.text||frame.pose==='happy'||frame.pose==='sad'||frame.state==='done'||frame.state==='speaking'?'replying':'idle'
 return resolveChatPose(frame.definition,phase,meaning)
}
export class DotPresentationController{
 private controller:AbortController|null=null
 private active=false
 private sequence=-1
 private key=''
 constructor(private session:CharacterSession){}
 update(frame:DotFrame|null){
  if(!frame){this.reset();return}
  const key=[frame.sequence,frame.pose,frame.state].join(':');if(this.key===key)return;this.key=key
  this.sequence=frame.sequence;this.controller?.abort();const ac=this.controller=new AbortController()
  this.active=true;this.session.behavior.setControlMode('MANUAL_POSE');this.session.behavior.setPresentationSuspended(true);this.session.setInteractionEnabled(false);this.session.dialogue.setEnabled(false);this.session.dialogue.clear()
  const selected=dotPose(frame);this.session.runtime.setChatMotionPolicy('chat-safe')
  void (selected.poseId?this.session.runtime.transitionToPose(selected.poseId,{signal:ac.signal}):this.session.runtime.exitPose({signal:ac.signal})).catch(()=>{if(!ac.signal.aborted)this.session.runtime.resetPose('dot pose fallback')})
 }
 reset(){this.controller?.abort();this.controller=null;this.sequence=-1;this.key='';if(!this.active)return;this.active=false;this.session.runtime.setChatMotionPolicy(null);this.session.behavior.setPresentationSuspended(false);this.session.behavior.setControlMode('AUTO_BEHAVIOR');this.session.setInteractionEnabled(true)}
 dispose(){this.reset()}
}
