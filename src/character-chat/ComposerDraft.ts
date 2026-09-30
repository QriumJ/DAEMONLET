import type {ChatDraft,LocalChatSnapshot} from '../../electron/shared/character-chat-contract'
/** Renderer mirror: late snapshots never replace text typed after submission. */
export class ComposerDraft {
 value:ChatDraft={key:'',text:'',revision:0}
 receive(state:LocalChatSnapshot){
  const next=state.draft
  if(!next)return this.value
  if(next.key!==this.value.key){const accepted=state.acceptedDraft;this.value=accepted?.key===this.value.key&&this.value.revision>accepted.revision?{...this.value,key:next.key}:{...next}}
  else if(state.acceptedDraft?.key===this.value.key&&state.acceptedDraft.revision===this.value.revision&&next.text==='')this.value={...next}
  return this.value
 }
 edit(text:string){this.value={...this.value,text,revision:this.value.revision+1};return this.value}
}
