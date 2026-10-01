import type {ChatDraft} from '../../shared/character-chat-contract'
export function chatDraftKey(characterId:string,conversationId:string|null){return JSON.stringify([characterId,conversationId])}
/** Session-only: closing a window preserves drafts; quitting the app discards them. */
export class ChatDraftStore {
 private drafts=new Map<string,ChatDraft>()
 get(key:string):ChatDraft{return {...(this.drafts.get(key)??{key,text:'',revision:0})}}
 update(key:string,text:string,revision:number){
  if(typeof text!=='string'||text.length>6000||!Number.isSafeInteger(revision)||revision<1)throw Error('잘못된 초안')
  const old=this.get(key)
  if(revision<=old.revision)return
  if(!this.drafts.has(key)&&this.drafts.size>=512)throw Error('초안 보관 한도에 도달했습니다. 사용하지 않는 대화의 초안을 비워 주세요.')
  this.drafts.set(key,{key,text,revision})
 }
 accepted(key:string,revision:number|undefined,nextKey=key){
  const draft=this.get(key)
  if(revision!==undefined&&draft.revision===revision)draft.text=''
  if(nextKey!==key)this.drafts.delete(key)
  if(draft.revision)this.drafts.set(nextKey,{...draft,key:nextKey})
 }
 delete(key:string){this.drafts.delete(key)}
 clear(){this.drafts.clear()}
}
