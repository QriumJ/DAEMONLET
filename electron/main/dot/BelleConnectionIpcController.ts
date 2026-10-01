import {dialog,ipcMain,shell,type IpcMainInvokeEvent} from 'electron'
import {appText} from '../AppLanguage'
import {isTrustedSender} from '../SecurityPolicy'
import type {SettingsWindowController} from '../SettingsWindowController'
import {BELLE_CONNECTION_IPC,belleGuideUrl,connectionIds,validRuntimeKey} from '../../shared/belle-connection'
import {connectionError,type BelleConnectionManager} from './BelleConnectionManager'
/** Secret write only, no key read API. Every privileged action comes from the exact settings main frame. */
export class BelleConnectionIpcController{
 private channels:string[]=[];private off:(()=>void)|null=null;private busy=false;private bucket={at:0,count:0}
 constructor(private manager:BelleConnectionManager,private settings:SettingsWindowController,private dev?:string,private confirmation?:(message:string,detail:string)=>Promise<boolean>,private openGuide:(url:string)=>Promise<void>=url=>shell.openExternal(url)){}
 private bind(channel:string,arity:number,action:(args:unknown[],owner:string)=>Promise<unknown>){
  this.channels.push(channel);ipcMain.handle(channel,async(event:IpcMainInvokeEvent,...args:unknown[])=>{
   if(!isTrustedSender(event,this.settings.window,'settings',this.dev)||!this.settings.currentOwner())return {ok:false,code:'UNTRUSTED_SENDER'}
   const now=Date.now();if(now-this.bucket.at>=1000)this.bucket={at:now,count:0};if(++this.bucket.count>12)return {ok:false,code:'REQUEST_LIMITED'}
   if(args.length!==arity)return {ok:false,code:'INVALID_CONFIG'}
   const owner=this.settings.currentOwner()!
   try{return {ok:true,value:await action(args,owner)}}catch(e){return {ok:false,code:connectionError(e)}}finally{for(const arg of args)if(arg&&typeof arg==='object'&&Object.hasOwn(arg,'key'))(arg as {key:unknown}).key=''}
  })
 }
 private async confirm(owner:string,message:string,detail:string){
  if(this.confirmation)return await this.confirmation(message,detail)&&this.settings.currentOwner()===owner
  if(this.busy)throw Error('CONNECTION_FAILED');this.busy=true
  try{const win=this.settings.window;if(!win||win.isDestroyed())return false;const result=await dialog.showMessageBox(win,{type:'warning',title:appText('벨 연결 확인'),message:appText(message),detail,buttons:[appText('취소'),appText('허용')],defaultId:0,cancelId:0,noLink:true});return result.response===1&&this.settings.currentOwner()===owner}catch{return false}finally{this.busy=false}
 }
 private detail(ids:{tunnelId:string;organizationId:string}){return `${appText('대상 터널')}: ${ids.tunnelId}\n${appText('Platform 조직')}: ${ids.organizationId}\n\n${appText('허용 기능은 문장·포즈·상태 표시와 취소입니다. 파일 읽기나 명령 실행은 제공하지 않습니다. Restricted Tunnels Read+Use 전용 키만 사용하세요. 키 권한은 앱에서 검증할 수 없습니다. 연결은 OpenAI로 나가는 HTTPS만 사용하며 앱 종료 시 끝납니다.')}`}
 register(){if(this.channels.length)return
  this.bind(BELLE_CONNECTION_IPC.guide,1,async([guide])=>{const url=belleGuideUrl(guide);if(!url)throw Error('INVALID_CONFIG');await this.openGuide(url)})
  this.bind(BELLE_CONNECTION_IPC.snapshot,0,async()=>this.manager.snapshot())
  this.bind(BELLE_CONNECTION_IPC.refresh,0,async()=>this.manager.refresh())
  this.bind(BELLE_CONNECTION_IPC.configure,1,async([value],owner)=>{
   const ids=connectionIds(value);if(!ids||!value||typeof value!=='object'||Object.keys(value).some(k=>!['tunnelId','organizationId','key'].includes(k))||!validRuntimeKey((value as {key?:unknown}).key))throw Error('INVALID_CONFIG')
   if(!await this.confirm(owner,'이 키를 OS 보안 저장소에 저장할까요?',this.detail(ids)+'\n\n'+appText('키는 삭제할 때까지 이 앱의 OS 보안 저장소 항목에 보관됩니다. JSON·파일·로그에는 저장하지 않으며 다시 표시하지 않습니다. 저장만으로 연결하거나 자동 연결을 켜지 않습니다.')))return this.manager.snapshot()
   return this.manager.configure(value as {tunnelId:string;organizationId:string;key:string})
  })
  this.bind(BELLE_CONNECTION_IPC.connect,0,async(_args,owner)=>{const config=this.manager.snapshot().config;if(!config)throw Error('INVALID_CONFIG');if(!await this.confirm(owner,'저장한 키로 벨을 연결할까요?',this.detail(config)))return this.manager.snapshot();return this.manager.connect()})
  this.bind(BELLE_CONNECTION_IPC.disconnect,0,async()=>this.manager.disconnect())
  this.bind(BELLE_CONNECTION_IPC.auto,1,async([enabled],owner)=>{if(typeof enabled!=='boolean')throw Error('INVALID_CONFIG');const config=this.manager.snapshot().config;if(!config)throw Error('INVALID_CONFIG');if(enabled&&!await this.confirm(owner,'앱을 시작할 때 자동 연결을 허용할까요?',this.detail(config)+'\n\n'+appText('이 옵션을 끌 때까지 앱을 직접 열 때마다 저장한 키로 연결합니다. OS 로그인 서비스는 만들지 않습니다.')))return this.manager.snapshot();return this.manager.setAutoConnect(enabled)})
  this.bind(BELLE_CONNECTION_IPC.forget,0,async(_args,owner)=>{const config=this.manager.snapshot().config;if(!config&&!this.manager.snapshot().credentialStored)return this.manager.snapshot();if(!await this.confirm(owner,'연결을 끊고 이 앱의 저장한 키를 삭제할까요?',(config?this.detail(config):appText('연결 대상 설정이 없습니다. 이 앱의 OS 보안 저장소 항목만 삭제합니다.'))+'\n\n'+appText('이 앱의 OS 보안 저장소 항목과 연결 설정만 삭제합니다. Platform의 키나 터널 권한은 취소하지 않으므로 필요하면 직접 해제하세요.')))return this.manager.snapshot();return this.manager.forget()})
  this.off=this.manager.subscribe(value=>this.settings.send(BELLE_CONNECTION_IPC.changed,value))
 }
 dispose(){this.off?.();this.off=null;for(const channel of this.channels.splice(0))ipcMain.removeHandler(channel)}
}
