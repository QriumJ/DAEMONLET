import {ipcMain} from 'electron'
import type {SettingsWindowController} from '../SettingsWindowController'
import {isTrustedSender} from '../SecurityPolicy'
import {CHAT_SETTINGS_IPC,CHAT_MANAGEMENT_ACTIONS,VOICE_MANAGEMENT_ACTIONS,settingsContext,type ChatSettingsAction,type ChatSettingsSnapshot} from '../../shared/chat-settings-contract'
import type {CharacterChatWindow} from './CharacterChatWindow'

/** Management only: playback events, ready/credit and audio capabilities remain chat-owned. */
export class ChatSettingsIpcController{
 private revision=0
 private disposed=false
 private detach:Array<()=>void>=[]
 constructor(private settings:SettingsWindowController,private chat:CharacterChatWindow,private devServerUrl?:string){
  const publish=()=>{if(!this.disposed&&this.settings.currentOwner()){try{this.settings.send(CHAT_SETTINGS_IPC.changed,this.snapshot())}catch{}}}
  this.detach.push(chat.service.subscribe(publish),chat.voice.subscribeManagement(publish))
  ipcMain.handle(CHAT_SETTINGS_IPC.action,async(event,value:ChatSettingsAction)=>{
   const win=settings.window,owner=settings.currentOwner()
   if(this.disposed||!owner||!isTrustedSender(event,win,'settings',this.devServerUrl))throw Error('UNTRUSTED_SENDER')
   const valid=()=>!this.disposed&&settings.window===win&&settings.currentOwner()===owner&&isTrustedSender(event,win,'settings',this.devServerUrl)
   if(!value||typeof value!=='object'||!['snapshot','open-chat','chat','voice'].includes(value.type))throw Error('CHAT_SETTINGS_ACTION')
   if(value.type==='chat'&&!CHAT_MANAGEMENT_ACTIONS.includes(value.action?.type as any)||value.type==='voice'&&!VOICE_MANAGEMENT_ACTIONS.includes(value.action?.type as any))throw Error('CHAT_SETTINGS_ACTION')
   await chat.initializeSettings()
   if(!valid())throw Error('CHAT_SETTINGS_EXPIRED')
   if(value.type==='open-chat')await chat.open()
   else if(value.type==='chat'||value.type==='voice'){
    const context=value.context,current=()=>valid()&&!!context&&Object.entries(settingsContext(chat.service.snapshot())).every(([key,v])=>context[key as keyof typeof context]===v)
    if(!current())throw Error('CHAT_SETTINGS_CONTEXT_CHANGED')
    if(value.type==='chat')await chat.manage(value.action,win!,current)
    else await chat.voice.manage(value.action,win!,current)
   }
   if(!valid())throw Error('CHAT_SETTINGS_EXPIRED')
   return this.snapshot()
  })
 }
 private snapshot():ChatSettingsSnapshot{
  const {conversation,meaning:_,...chat}=this.chat.service.snapshot()
  return {revision:++this.revision,context:settingsContext(this.chat.service.snapshot()),chat:{...chat,conversation:conversation?{id:conversation.id,title:conversation.title,messageCount:conversation.messages.length}:null},voice:this.chat.voice.service.snapshot(),playbackReady:this.chat.voice.playbackReady}
 }
 dispose(){this.disposed=true;ipcMain.removeHandler(CHAT_SETTINGS_IPC.action);this.detach.splice(0).forEach(off=>off())}
}
