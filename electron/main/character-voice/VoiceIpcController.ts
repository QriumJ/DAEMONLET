import {DOT_IPC} from '../../shared/dot-presentation'
import {appText,appLanguage} from '../AppLanguage'
import {settingsContext,VOICE_MANAGEMENT_ACTIONS,type VoiceManagementAction} from '../../shared/chat-settings-contract'
import {join,dirname} from 'node:path'
import {WindowsVoiceInstaller} from './WindowsVoiceInstaller'
import {VoiceBaseInstaller} from './VoiceBaseInstaller'
import {dialog,ipcMain,type BrowserWindow} from 'electron'
import {isTrustedSender} from '../SecurityPolicy'
import {isReferenceProfile,VOICE_IPC,type VoiceAction} from '../../shared/character-voice-contract'
import type {CharacterChatService} from '../character-chat/CharacterChatService'
import {CharacterVoiceService} from './CharacterVoiceService'

export class VoiceIpcController {
 readonly service:CharacterVoiceService
 private initialized:Promise<void>|null=null
 private petOutput:BrowserWindow|null=null
 private petReady=false
 private presentationOutput=false
 private presentationGeneration=0
 attachPresentationWindow(win:BrowserWindow){
  this.petOutput=win
  const reset=()=>{this.petReady=false;if(this.presentationOutput){this.presentationOutput=false;this.service.setOutputReady(false)}}
  win.on('hide',reset);win.on('closed',reset);win.webContents.on('did-start-loading',reset);win.webContents.on('render-process-gone',reset)
  ipcMain.handle(DOT_IPC.volume,event=>{if(!isTrustedSender(event,this.petOutput,'pet',this.devServerUrl))throw Error('UNTRUSTED_SENDER');return this.service.snapshot().volume})
  ipcMain.handle(DOT_IPC.voiceAction,async(event,v:VoiceAction)=>{
   if(!isTrustedSender(event,this.petOutput,'pet',this.devServerUrl)||!v||!['played','scheduled','outputStopped'].includes(v.type)||!this.presentationOutput)throw Error('UNTRUSTED_SENDER')
   await this.action(v);return {epoch:this.service.snapshot().epoch} // no history/settings projection
  })
  ipcMain.handle(DOT_IPC.audio,(event,id:unknown,epoch:unknown)=>{
   if(!this.presentationOutput||!isTrustedSender(event,this.petOutput,'pet',this.devServerUrl)||typeof id!=='string'||id.length!==36||!Number.isSafeInteger(epoch))throw Error('UNTRUSTED_AUDIO')
   return this.service.audio(id,epoch as number)
  })
 }
 presentationReady(value:boolean){this.petReady=value;if(!value&&this.presentationOutput){this.presentationOutput=false;this.service.setOutputReady(false)}}
 presentationVoiceIssue(){const s=this.service.snapshot();return !this.petReady||!s.enabled||!s.runtimeConfigured||s.seedError||!s.availableProfiles?.length||!!s.error}
 async speakPresentation(text:string,signal:AbortSignal){
  if(this.playbackReady||!this.petOutput||this.petOutput.isDestroyed()||!this.petOutput.isVisible()||this.presentationVoiceIssue())throw Error('VOICE_PRESENTATION_UNAVAILABLE')
  const generation=++this.presentationGeneration;this.presentationOutput=true;this.service.setOutputReady(true)
  try{await this.service.speakPresentation(text,signal)}finally{if(generation===this.presentationGeneration)await this.stopPresentation()}
 }
 async stopPresentation(){const generation=++this.presentationGeneration;if(this.presentationOutput){try{await this.service.stop(true,false)}finally{if(generation===this.presentationGeneration){this.presentationOutput=false;this.service.setOutputReady(false);this.updateOutput()}}}}

 private managementListeners=new Set<()=>void>()
 subscribeManagement(listener:()=>void){this.managementListeners.add(listener);return()=>{this.managementListeners.delete(listener)}}
 get playbackReady(){const win=this.window();return !this.closing&&!!win&&win===this.attached&&!win.isDestroyed()&&!win.webContents.isDestroyed()&&win.isVisible()&&this.rendererReady}
 async manage(value:VoiceManagementAction,owner:BrowserWindow,current:()=>boolean){
  if(!VOICE_MANAGEMENT_ACTIONS.includes(value?.type as any))throw Error('VOICE_ACTION')
  await this.initialize();if(!current())throw Error('CHAT_SETTINGS_EXPIRED')
  if(value.type==='test'&&!this.playbackReady)throw Error('VOICE_OUTPUT_NOT_READY')
  return this.action(value,owner,current)
 }
 private referencePicker:{cancelled:boolean}|null=null
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
   try{await this.action(value,owner,()=>owner===this.window()&&generation===this.outputGeneration&&!!owner&&!owner.isDestroyed())}catch(e){this.service.error(e)}
   return this.service.snapshot()
  })
  ipcMain.handle(VOICE_IPC.audio,(event,id:unknown,epoch:unknown)=>{
   if(!isTrustedSender(event,this.window(),'character-chat',this.devServerUrl)||typeof id!=='string'||id.length!==36||!Number.isSafeInteger(epoch))throw Error('UNTRUSTED_AUDIO')
   return this.service.audio(id,epoch as number)
  })
 }
 private publishManagement(){for(const listener of this.managementListeners){try{listener()}catch{}}}
 private send(channel:string,value:unknown){
  if(channel===VOICE_IPC.changed)this.publishManagement()
  const win=this.presentationOutput?this.petOutput:this.window()
  if(win&&!win.isDestroyed()&&!win.webContents.isDestroyed()){
   try{win.webContents.send(this.presentationOutput?(channel===VOICE_IPC.event?DOT_IPC.voiceEvent:DOT_IPC.volumeChanged):channel,this.presentationOutput&&channel===VOICE_IPC.changed?(value as any).volume:value)}catch{console.warn('[voice] VOICE_NOTIFICATION_FAILED')}
  }
 }
 attachWindow(win:BrowserWindow){
  ++this.outputGeneration;this.attached=win;this.rendererReady=false;this.service.setOutputReady(false);this.publishManagement()
  const current=()=>this.attached===win
  const deny=()=>{if(current()){++this.outputGeneration;this.service.setOutputReady(false);this.publishManagement()}}
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
  // Readiness can change without a service snapshot (baseline/off skips preparation).
  this.publishManagement()
 }
 initialize(){return this.initialized??=this.service.initialize()}
 async stop(){try{await this.service.stop()}catch(e){this.service.error(e)}}
 private async action(v:VoiceAction,owner=this.window(),isCurrent=()=>this.window()===owner&&!!owner&&!owner.isDestroyed()){
  if(!v||typeof v!=='object')throw Error('VOICE_ACTION')
  const snapshot=this.chat.snapshot(),character=snapshot.character,context=settingsContext(snapshot)
  const contextCurrent=()=>isCurrent()&&Object.entries(settingsContext(this.chat.snapshot())).every(([key,value])=>context[key as keyof typeof context]===value)
  switch(v.type){
   case 'ready':this.rendererReady=true;this.updateOutput();return
   case 'snapshot':return
   case 'stop':return this.service.stop(true,false)
   case 'installBase':return this.service.installBase()
   case 'cancelInstallBase':return this.service.cancelInstallBase()
   case 'cancelReferenceImport':if(this.referencePicker)this.referencePicker.cancelled=true;return this.service.cancelReferenceImport()
   case 'prepare':return this.service.prepare()
   case 'executionProfile':if(!this.service.snapshot().availableProfiles?.includes(v.value))throw Error('VOICE_ACTION');return this.service.executionProfile(v.value)
   case 'enabled':case 'auto':if(typeof v.value!=='boolean')throw Error('VOICE_ACTION');return v.type==='enabled'?this.service.enabled(v.value):this.service.auto(v.value)
   case 'volume':if(!Number.isFinite(v.value)||v.value<0||v.value>1)throw Error('VOICE_ACTION');return this.service.volume(v.value)
   case 'bind':if(!character||v.profile!==null&&(typeof v.profile!=='string'||v.profile.length>170))throw Error('VOICE_ACTION');return this.service.bind(character.id,v.profile,contextCurrent)
   case 'renameReference':if(typeof v.profile!=='string'||v.profile.length>170||typeof v.name!=='string'||v.name.length>80)throw Error('VOICE_ACTION');return this.service.renameReference(v.profile,v.name,contextCurrent)
   case 'remove':{
    if(typeof v.profile!=='string'||v.profile.length>170)throw Error('VOICE_ACTION')
    const state=this.service.snapshot(),profile=state.profiles.find(p=>p.id+'@'+p.version===v.profile)
    if(isReferenceProfile(profile)){
     if(!owner||owner.isDestroyed())throw Error('VOICE_ACTION')
     const count=Object.values(state.bindings).filter(key=>key===v.profile).length
     const result=await dialog.showMessageBox(owner,{type:'question',buttons:[appText('취소'),appText('삭제')],defaultId:0,cancelId:0,message:appText('WAV 음성을 삭제할까요?'),detail:appLanguage()==='en'?`${count} character voice binding(s) will be removed. Active speech will stop. The original WAV will be kept.`:`연결된 캐릭터 ${count}개의 음성 연결이 해제됩니다. 현재 발화를 중단하며, 원본 WAV는 삭제하지 않습니다.`})
     if(result.response!==1||!contextCurrent())return
    }
    return this.service.remove(v.profile)
   }
   case 'importReference':{
    if(typeof v.name!=='string'||!v.name.trim()||v.name.trim().length>80||/[\x00-\x1f\x7f]/.test(v.name)||v.acknowledged!==true)throw Error('VOICE_REFERENCE_NAME')
    const win=owner;if(!win||win.isDestroyed()||this.referencePicker||this.picking)return
    const pick={cancelled:false};this.referencePicker=pick;this.picking=true
    try{
     const r=await dialog.showOpenDialog(win,{title:appText('기준 WAV 선택'),filters:[{name:'WAV',extensions:['wav']}],properties:process.platform==='darwin'?['openFile','noResolveAliases']:['openFile']})
     if(!pick.cancelled&&contextCurrent()&&!win.isDestroyed()&&!r.canceled&&r.filePaths.length===1)await this.service.importReference(r.filePaths[0],v.name,()=>!pick.cancelled&&contextCurrent()&&!win.isDestroyed())
    }finally{if(this.referencePicker===pick){this.referencePicker=null;this.picking=false}}
    return
   }
   case 'seedSettings':return this.service.seedSettings(v.value,contextCurrent)
   case 'replay':case 'reroll':case 'reproduce':if(typeof v.messageId!=='string'||v.messageId.length>80)throw Error('VOICE_ACTION');return this.service.readMessage(v.messageId,v.type)
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
  if(this.referencePicker)this.referencePicker.cancelled=true
  this.managementListeners.clear()
  const work=[()=>ipcMain.removeHandler(DOT_IPC.volume),()=>ipcMain.removeHandler(DOT_IPC.voiceAction),()=>ipcMain.removeHandler(DOT_IPC.audio),()=>ipcMain.removeHandler(VOICE_IPC.action),()=>ipcMain.removeHandler(VOICE_IPC.audio),...this.detach,()=>this.service.close()]
  this.detach=[]
  this.closing=Promise.allSettled(work.map(fn=>Promise.resolve().then(fn))).then(results=>{
   if(results.some(r=>r.status==='rejected'))throw Error('VOICE_CLOSE_FAILED')
  })
  return this.closing
 }
}
