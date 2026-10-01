export const CHAT_BOTTOM_TOLERANCE=36
export type ScrollMetrics={scrollTop:number;scrollHeight:number;clientHeight:number}
/** Track the user's intent before a render grows the content, not the new distance. */
export class ConversationViewport {
 following=true
 unread=false
 private key:string|null=null
 private reply=''
 scroll(metrics:ScrollMetrics){this.following=metrics.scrollHeight-metrics.clientHeight-metrics.scrollTop<=CHAT_BOTTOM_TOLERANCE;if(this.following)this.unread=false}
 content(key:string,reply:string){
  if(this.key!==key){this.key=key;this.following=true;this.unread=false}
  else if(reply!==this.reply&&!this.following)this.unread=true
  this.reply=reply
  return this.following
 }
 latest(){this.following=true;this.unread=false}
}
