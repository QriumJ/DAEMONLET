import {dialog,ipcMain,type BrowserWindow} from 'electron'
import {isTrustedSender} from '../SecurityPolicy'
import {VOICE_IPC,type VoiceAction} from '../../shared/character-voice-contract'
import type {CharacterChatService} from '../character-chat/CharacterChatService'
import {CharacterVoiceService} from './CharacterVoiceService'

export class VoiceIpcController {
 readonly service:CharacterVoiceService
 private initialized:Promise<void>|null=null
 private picking=false
 private detach:Array<()=>unknown>=[]
 constructor(root:string,worker:string,private window:()=>BrowserWindow|null,private chat:CharacterChatService,private devServerUrl?:string){
  this.service=new CharacterVoiceService(root,worker,()=>chat.snapshot(),s=>this.window()?.webContents.send(VOICE_IPC.changed,s),e=>this.window()?.webContents.send(VOICE_IPC.event,e),undefined,value=>console.info('[voice]',JSON.stringify(value)))
  this.detach.push(chat.subscribeVoice(message=>{if(message)this.service.completed(message);else this.service.cancel()}),chat.subscribe(()=>this.service.onChatChanged()))
  ipcMain.handle(VOICE_IPC.action,async(event,value:VoiceAction)=>{
   if(!isTrustedSender(event,this.window(),'character-chat',this.devServerUrl))throw Error('UNTRUSTED_SENDER')
   await this.initialize()
   try{await this.action(value)}catch(e){this.service.error(e)}
   return this.service.snapshot()
  })
  ipcMain.handle(VOICE_IPC.audio,(event,id:unknown,epoch:unknown)=>{
   if(!isTrustedSender(event,this.window(),'character-chat',this.devServerUrl)||typeof id!=='string'||id.length!==36||!Number.isSafeInteger(epoch))throw Error('UNTRUSTED_AUDIO')
   return this.service.audio(id,epoch as number)
  })
 }
 initialize(){return this.initialized??=this.service.initialize()}
 async stop(){try{await this.service.stop()}catch(e){this.service.error(e)}}
 private async action(v:VoiceAction){
  if(!v||typeof v!=='object')throw Error('VOICE_ACTION')
  const character=this.chat.snapshot().character
  switch(v.type){
   case 'snapshot':return
   case 'stop':return this.stop()
   case 'enabled':case 'auto':if(typeof v.value!=='boolean')throw Error('VOICE_ACTION');return v.type==='enabled'?this.service.enabled(v.value):this.service.auto(v.value)
   case 'volume':if(!Number.isFinite(v.value)||v.value<0||v.value>1)throw Error('VOICE_ACTION');return this.service.volume(v.value)
   case 'bind':if(!character||v.profile!==null&&(typeof v.profile!=='string'||v.profile.length>170))throw Error('VOICE_ACTION');return this.service.bind(character.id,v.profile)
   case 'remove':if(typeof v.profile!=='string'||v.profile.length>170)throw Error('VOICE_ACTION');return this.service.remove(v.profile)
   case 'read':if(typeof v.messageId!=='string'||v.messageId.length>80)throw Error('VOICE_ACTION');return this.service.readMessage(v.messageId)
   case 'test':return this.service.test()
   case 'played':if(typeof v.audioId!=='string'||v.audioId.length!==36||!Number.isSafeInteger(v.epoch)||v.error!==undefined&&typeof v.error!=='boolean')throw Error('VOICE_ACTION');return this.service.played(v.audioId,v.epoch,v.error)
   case 'import':case 'configure':{
    const win=this.window();if(!win||win.isDestroyed()||this.picking)return
    this.picking=true
    const current=()=>this.window()===win&&!win.isDestroyed()
    try{
     if(v.type==='import'){
      const r=await dialog.showOpenDialog(win,{title:'채택된 음성 패키지 폴더 가져오기',properties:['openDirectory']})
      if(current()&&!r.canceled&&r.filePaths[0])await this.service.importPackage(r.filePaths[0])
     }else{
      const python=await dialog.showOpenDialog(win,{title:'독립 TTS 환경의 Python 선택',properties:['openFile']})
      if(!current()||python.canceled||!python.filePaths[0])return
      const model=await dialog.showOpenDialog(win,{title:'고정 VoxCPM2 로컬 모델 폴더 선택',properties:['openDirectory']})
      if(current()&&!model.canceled&&model.filePaths[0])await this.service.configure(python.filePaths[0],model.filePaths[0])
     }
    }finally{this.picking=false}
    return
   }
   default:throw Error('VOICE_ACTION')
  }
 }
 async close(){ipcMain.removeHandler(VOICE_IPC.action);ipcMain.removeHandler(VOICE_IPC.audio);this.detach.forEach(fn=>fn());await this.service.close()}
}
