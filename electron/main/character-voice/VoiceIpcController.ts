import {VOICE_MANAGEMENT_ACTIONS,type VoiceManagementAction} from '../../shared/chat-settings-contract'
import {join,dirname} from 'node:path'
import {WindowsVoiceInstaller} from './WindowsVoiceInstaller'
import {VoiceBaseInstaller} from './VoiceBaseInstaller'
import {dialog,ipcMain,type BrowserWindow} from 'electron'
import {isTrustedSender} from '../SecurityPolicy'
import {VOICE_IPC,type VoiceAction} from '../../shared/character-voice-contract'
import type {CharacterChatService} from '../character-chat/CharacterChatService'
import {CharacterVoiceService} from './CharacterVoiceService'

export class VoiceIpcController {
 readonly service:CharacterVoiceService
 private initialized:Promise<void>|null=null
 private managementListeners=new Set<()=>void>()
 subscribeManagement(listener:()=>void){this.managementListeners.add(listener);return()=>{this.managementListeners.delete(listener)}}
 get playbackReady(){const win=this.window();return !this.closing&&!!win&&win===this.attached&&!win.isDestroyed()&&!win.webContents.isDestroyed()&&win.isVisible()&&this.rendererReady}
 async manage(value:VoiceManagementAction,owner:BrowserWindow,current:()=>boolean){
  if(!VOICE_MANAGEMENT_ACTIONS.includes(value?.type as any))throw Error('VOICE_ACTION')
  await this.initialize();if(!current())throw Error('CHAT_SETTINGS_EXPIRED')
  if(value.type==='test'&&!this.playbackReady)throw Error('VOICE_OUTPUT_NOT_READY')
  return this.action(value,owner,current)
 }
 private picking=false
 private rendererReady=false
 private outputGeneration=0
 private attached:BrowserWindow|null=null
 private closing:Promise<void>|null=null
 private detach:Array<()=>unknown>=[]
 constructor(root:string,worker:string,private window:()=>BrowserWindow|null,private chat:CharacterChatService,private devServerUrl?:string){
  this.service=new CharacterVoiceService(root,worker,()=>chat.snapshot(),s=>this.send(VOICE_IPC.changed,s),e=>this.send(VOICE_IPC.event,e),undefined,value=>console.info('[voice]',JSON.stringify(value)),process.platform==='win32'?new WindowsVoiceInstaller(join(root,'windows-base'),dirname(worker),()=>this.service.refreshBase()):new VoiceBaseInstaller(join(root,'base-model'),join(dirname(worker),'base-native'),()=>this.service.refreshBase()))
  this.detach.push(chat.subscribeVoiceStart(id=>this.service.requestStarted(id)),chat.subscribeVoice(message=>{if(message)this.service.completed(message);else this.service.cancel()}),chat.subscribe(()=>this.service.onChatChanged()))
  ipcMain.handle(VOICE_IPC.action,async(event,value:VoiceAction)=>{
   if(!isTrustedSender(event,this.window(),'character-chat',this.devServerUrl))throw Error('UNTRUSTED_SENDER')
   const owner=this.window(),generation=this.outputGeneration
   await this.initialize()
   if(owner!==this.window()||generation!==this.outputGeneration||!isTrustedSender(event,this.window(),'character-chat',this.devServerUrl))throw Error('VOICE_OUTPUT_EXPIRED')
   try{await this.action(value)}catch(e){this.service.error(e)}
   return this.service.snapshot()
  })
  ipcMain.handle(VOICE_IPC.audio,(event,id:unknown,epoch:unknown)=>{
   if(!isTrustedSender(event,this.window(),'character-chat',this.devServerUrl)||typeof id!=='string'||id.length!==36||!Number.isSafeInteger(epoch))throw Error('UNTRUSTED_AUDIO')
   return this.service.audio(id,epoch as number)
  })
 }
 private send(channel:string,value:unknown){
  if(channel===VOICE_IPC.changed)for(const listener of this.managementListeners){try{listener()}catch{}}
  const win=this.window()
  if(win&&!win.isDestroyed()&&!win.webContents.isDestroyed()){
   try{win.webContents.send(channel,value)}catch{console.warn('[voice] VOICE_NOTIFICATION_FAILED')}
  }
 }
 attachWindow(win:BrowserWindow){
  ++this.outputGeneration;this.attached=win;this.rendererReady=false;this.service.setOutputReady(false)
  const current=()=>this.attached===win
  const deny=()=>{if(current()){++this.outputGeneration;this.service.setOutputReady(false)}}
  const reset=()=>{if(current()){this.rendererReady=false;deny()}}
  win.on('hide',deny);win.on('close',reset);win.on('closed',reset)
  win.on('show',()=>{if(current())this.updateOutput()})
  win.webContents.on('did-start-loading',reset)
  win.webContents.on('render-process-gone',reset)
  win.webContents.on('destroyed',reset)
 }
 private updateOutput(){
  const win=this.window()
  this.service.setOutputReady(!this.closing&&!!win&&win===this.attached&&!win.isDestroyed()&&!win.webContents.isDestroyed()&&win.isVisible()&&this.rendererReady)
 }
 initialize(){return this.initialized??=this.service.initialize()}
 async stop(){try{await this.service.stop()}catch(e){this.service.error(e)}}
 private async action(v:VoiceAction,owner=this.window(),isCurrent=()=>this.window()===owner&&!!owner&&!owner.isDestroyed()){
  if(!v||typeof v!=='object')throw Error('VOICE_ACTION')
  const character=this.chat.snapshot().character
  switch(v.type){
   case 'ready':this.rendererReady=true;this.updateOutput();return
   case 'snapshot':return
   case 'stop':return this.service.stop(true,false)
   case 'installBase':return this.service.installBase()
   case 'cancelInstallBase':return this.service.cancelInstallBase()
   case 'prepare':return this.service.prepare()
   case 'executionProfile':if(!this.service.snapshot().availableProfiles?.includes(v.value))throw Error('VOICE_ACTION');return this.service.executionProfile(v.value)
   case 'enabled':case 'auto':if(typeof v.value!=='boolean')throw Error('VOICE_ACTION');return v.type==='enabled'?this.service.enabled(v.value):this.service.auto(v.value)
   case 'volume':if(!Number.isFinite(v.value)||v.value<0||v.value>1)throw Error('VOICE_ACTION');return this.service.volume(v.value)
   case 'bind':if(!character||v.profile!==null&&(typeof v.profile!=='string'||v.profile.length>170))throw Error('VOICE_ACTION');return this.service.bind(character.id,v.profile)
   case 'remove':if(typeof v.profile!=='string'||v.profile.length>170)throw Error('VOICE_ACTION');return this.service.remove(v.profile)
   case 'read':if(typeof v.messageId!=='string'||v.messageId.length>80)throw Error('VOICE_ACTION');return this.service.readMessage(v.messageId)
   case 'test':return this.service.test()
   case 'played':if(typeof v.audioId!=='string'||v.audioId.length!==36||!Number.isSafeInteger(v.epoch)||v.error!==undefined&&typeof v.error!=='boolean')throw Error('VOICE_ACTION');return this.service.played(v.audioId,v.epoch,v.error)
   case 'scheduled':if(typeof v.audioId!=='string'||v.audioId.length!==36||!Number.isSafeInteger(v.epoch)||!Number.isFinite(v.delayMs)||v.delayMs<0||v.delayMs>6000||!Number.isFinite(v.gapMs)||v.gapMs<0||v.gapMs>180_000)throw Error('VOICE_ACTION');return this.service.scheduled(v.audioId,v.epoch,v.delayMs,v.gapMs)
   case 'outputStopped':if(!Number.isSafeInteger(v.epoch)||!Number.isFinite(v.elapsedMs)||v.elapsedMs<0||v.elapsedMs>180_000)throw Error('VOICE_ACTION');return this.service.outputStopped(v.epoch,v.elapsedMs)
   case 'import':case 'configure':{
    const win=owner;if(!win||win.isDestroyed()||this.picking)return
    this.picking=true
    const current=()=>isCurrent()&&!win.isDestroyed()
    try{
     if(v.type==='import'){
      const r=await dialog.showOpenDialog(win,{title:process.platform==='darwin'?'LoRA 음성 패키지 폴더 가져오기':'채택된 음성 패키지 폴더 가져오기',properties:['openDirectory']})
      if(current()&&!r.canceled&&r.filePaths[0])await this.service.importPackage(r.filePaths[0])
     }else{
      const python=await dialog.showOpenDialog(win,{title:'독립 TTS 환경의 Python 선택',properties:process.platform==='darwin'?['openFile','noResolveAliases']:['openFile']})
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
 close():Promise<void>{
  if(this.closing)return this.closing
  this.rendererReady=false
  this.managementListeners.clear()
  const work=[()=>ipcMain.removeHandler(VOICE_IPC.action),()=>ipcMain.removeHandler(VOICE_IPC.audio),...this.detach,()=>this.service.close()]
  this.detach=[]
  this.closing=Promise.allSettled(work.map(fn=>Promise.resolve().then(fn))).then(results=>{
   if(results.some(r=>r.status==='rejected'))throw Error('VOICE_CLOSE_FAILED')
  })
  return this.closing
 }
}
