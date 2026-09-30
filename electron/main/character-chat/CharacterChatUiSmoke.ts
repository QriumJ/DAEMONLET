/** Isolated actual renderer/preload/window/service QA. Model/audio/setup are mocks. */
import {app,ipcMain,BrowserWindow} from 'electron'
import {mkdir,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {registerAppScheme,installAppProtocol} from '../AppProtocol'
import {CharacterChatWindow} from './CharacterChatWindow'
import {ConversationStore} from './ConversationStore'
import {SettingsWindowController} from '../SettingsWindowController'
import {ChatSettingsIpcController} from './ChatSettingsIpcController'
import {defaultDesktopSettings} from '../../shared/desktop-settings'
import {SETUP_IPC} from '../../shared/codex-integration-contract'
import {neutralMeaning} from '../../shared/character-chat-semantics'
import {VOICE_IPC} from '../../shared/character-voice-contract'
const root=process.env.CHAT_QA_ROOT!,evidence=process.env.CHAT_QA_EVIDENCE!,profile=process.env.ELECTRON_SMOKE_USER_DATA!
if(process.env.ELECTRON_SMOKE_TEST!=='1'||!root||!evidence||!profile)throw Error('CHAT_QA_ISOLATION')
app.setPath('userData',profile);registerAppScheme();app.enableSandbox()
const checks:Record<string,boolean>={},sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms))
const wait=async(test:()=>Promise<boolean>|boolean)=>{for(let i=0;i<160;i++){if(await test())return;await sleep(30)}throw Error('CHAT_QA_TIMEOUT')}
let chat:CharacterChatWindow,settings:SettingsWindowController,management:ChatSettingsIpcController,stage='setup'
app.whenReady().then(async()=>{
 const keepAlive=new BrowserWindow({show:false,width:70,height:70,title:'DAEMONLET QA anchor',webPreferences:{sandbox:true,nodeIntegration:false,contextIsolation:true}})
 keepAlive.showInactive();installAppProtocol(join(root,'dist'));await mkdir(join(profile,'character-chat'),{recursive:true})
 const a=randomUUID(),b=randomUUID(),messages=Array.from({length:80},(_,i)=>({id:randomUUID(),role:i%2?'assistant' as const:'user' as const,text:'QA 합성 대화 '+i+' · 긴 한국어 문장과 줄바꿈을 확인합니다.\n두 번째 줄입니다.',status:'complete' as const,createdAt:new Date().toISOString()}))
 await new ConversationStore(join(profile,'character-chat')).save({version:2,model:'E4B',characterId:'gpichan',current:a,conversations:[{id:a,characterId:'gpichan',title:'QA 긴 대화',messages,updatedAt:new Date().toISOString()},{id:b,characterId:'synthetic-b',title:'QA 다른 캐릭터',messages:[],updatedAt:new Date().toISOString()}],memories:{}})
 const entries=['gpichan','synthetic-b'].map(id=>({id,name:id==='gpichan'?'QA 캐릭터 A':'QA 캐릭터 B',revision:'qa-'+id,status:'ready'})),registry:any={snapshot:()=>({entries}),get:(id:string)=>entries.find(e=>e.id===id),ensureReady:async(e:unknown)=>e,readPersonaAsset:async(e:{id:string})=>Buffer.from(JSON.stringify({schemaVersion:1,id:e.id,label:e.id,base:{source:'unused.png',psd:'unused.psd'},poses:[]}))}
 let selected='gpichan',loadingRelease:(()=>void)|null=null,generateRelease:(()=>void)|null=null,stream:((text:string)=>void)|null=null,fail=false
 chat=new CharacterChatWindow(join(root,'dist-electron'),registry,undefined,{pet:()=>keepAlive,reveal:()=>keepAlive.showInactive(),active:()=>{},select:async entry=>{selected=entry.id},selected:()=>selected})
 chat.service.models.installed=async()=>['E4B'];chat.service.runtime.available=async()=>true;chat.service.runtime.start=async()=>{};chat.service.runtime.count=async()=>1000;chat.service.runtime.stop=async()=>{loadingRelease?.();generateRelease?.()}
 chat.service.models.verify=async()=>{if(fail)throw Error('QA model unavailable');await new Promise<void>(r=>{loadingRelease=r});loadingRelease=null;return '/unused-qa-model'}
 chat.service.runtime.generate=async(_messages,onText)=>{stream=onText;await new Promise<void>(r=>{generateRelease=r});generateRelease=null;return {text:'QA 완료 답변 · 실제 모델 음성이 아닙니다.',meaning:neutralMeaning()}}
 const voice:any={epoch:1,status:'idle',enabled:true,autoRead:false,volume:.5,profiles:[{id:'qa-voice',version:'1',name:'QA 음성 (합성 없음)'}],bindings:{gpichan:'qa-voice@1','synthetic-b':'qa-voice@1'},runtimeConfigured:true,availableProfiles:['gguf-metal-f16','gguf-metal-f16-complete'],executionProfile:'gguf-metal-f16',results:{},baseInstall:{supported:true,installed:true,phase:'idle',bytes:0,total:0,error:null}}
 chat.voice.initialize=async()=>{};chat.voice.attachWindow=()=>{};chat.voice.service.snapshot=()=>structuredClone(voice);chat.voice.service.onChatChanged=()=>{};chat.voice.service.completed=()=>{};chat.voice.service.requestStarted=()=>{};chat.voice.service.cancel=()=>{}
 ipcMain.removeHandler(VOICE_IPC.action);ipcMain.handle(VOICE_IPC.action,()=>structuredClone(voice))
 chat.voice.manage=async()=>{} // no model/audio/install/file picker in this QA process
 const setup={schemaVersion:1,app:{version:'QA',running:true,packaged:false,platform:'darwin'},storage:{userDataDisplayPath:'QA',receiptDirectoryDisplayPath:'QA'},onboarding:'skipped',discovery:null,configurationStatus:'not-installed',configurationWarnings:[],host:{available:false},hostSelfTest:{status:'not-tested'},adapter:{state:'STOPPED',ownership:'NONE',activeRunCount:0,activeTaskCount:0},hookReviewStatus:'unknown',reception:{status:'unavailable',lastReceivedAt:null,events:[]},live:{active:false,status:'not-tested'},hasRevert:false,checkedAt:Date.now(),issue:null}
 ipcMain.handle(SETUP_IPC.status,()=>({ok:true,value:setup}));ipcMain.handle(SETUP_IPC.settingsGet,()=>({ok:true,value:defaultDesktopSettings()}))
 settings=new SettingsWindowController({preloadPath:join(root,'dist-electron/settings-preload.cjs'),onOpened:()=>{},onClosed:()=>{}});management=new ChatSettingsIpcController(settings,chat)
 const open=async()=>{await chat.open();await wait(()=>chat.window?.webContents.executeJavaScript('Boolean(document.querySelector("textarea"))')??false);await sleep(100)}
 const js=(source:string)=>chat.window!.webContents.executeJavaScript(source)
 const input=async(text:string)=>{await js(`(()=>{const e=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(text)});e.dispatchEvent(new Event('input',{bubbles:true}))})()`);await wait(()=>chat.service.snapshot().draft?.text===text)}
 const shot=async(name:string,win=chat.window!)=>{win.show();win.focus();await sleep(600);await writeFile(join(evidence,name+'.png'),(await win.webContents.capturePage()).toPNG())}
 stage='draft-reopen';await open();await input('미전송 초안 A · 다른 캐릭터로 새지 않습니다.')
 await js(`window.characterChat.action({type:'codex-mode'})`);await wait(()=>!chat.window);await open()
 checks.reopenDraft=await js(`document.querySelector('textarea').value==='미전송 초안 A · 다른 캐릭터로 새지 않습니다.'`)
 await js(`window.characterChat.action({type:'character',id:'synthetic-b'})`);checks.characterIsolated=await js(`document.querySelector('textarea').value===''`)
 await input('미전송 초안 B');await js(`window.characterChat.action({type:'character',id:'gpichan'})`);await sleep(60)
 checks.characterRestore=await js(`document.querySelector('textarea').value==='미전송 초안 A · 다른 캐릭터로 새지 않습니다.'`)
 stage='loading';await js(`document.querySelector('.send-button').click();document.querySelector('.send-button').click()`);await wait(()=>chat.service.snapshot().phase==='loading')
 checks.repeatedSendSingle=chat.service.snapshot().conversation!.messages.length===82;checks.acceptedClears=await js(`document.querySelector('textarea').value===''`);checks.actualLoading=await js(`document.body.textContent.includes('대화 모델 준비 중')`)
 await shot('chat-model-preparation');loadingRelease!();await wait(()=>chat.service.snapshot().phase==='generating')
 checks.actualGenerating=await js(`document.body.textContent.includes('답변 생성 중')`)
 stage='scroll';await js(`(()=>{const e=document.querySelector('.messages');e.scrollTop=0;e.dispatchEvent(new Event('scroll'));document.querySelector('textarea').focus()})()`);await sleep(50)
 const top=await js(`document.querySelector('.messages').scrollTop`)
 stream!('새 답변 첫 청크');await sleep(100)
 checks.streamingHolds=await js(`Math.abs(document.querySelector('.messages').scrollTop-${top})<2`)
 checks.newReplyButton=await js(`Boolean(document.querySelector('.new-reply'))`);checks.inputFocusHeld=await js(`document.activeElement===document.querySelector('textarea')`)
 await shot('chat-reading-history')
 await js(`document.querySelector('.new-reply').focus()`);chat.window!.webContents.sendInputEvent({type:'keyDown',keyCode:'Enter'});chat.window!.webContents.sendInputEvent({type:'char',keyCode:'\r'});chat.window!.webContents.sendInputEvent({type:'keyUp',keyCode:'Enter'});await sleep(100);checks.keyboardReturnFocus=await js(`document.activeElement===document.querySelector('.messages')`)
 checks.returnToLatest=await js(`(()=>{const e=document.querySelector('.messages');return e.scrollHeight-e.clientHeight-e.scrollTop<2&&!document.querySelector('.new-reply')})()`)
 stream!('새 답변 두 번째 청크\n문장 사이에도 마지막 위치를 유지합니다.');await sleep(80)
 checks.streamingFollows=await js(`(()=>{const e=document.querySelector('.messages');return e.scrollHeight-e.clientHeight-e.scrollTop<2})()`)
 await input('생성 중 작성한 다음 초안');generateRelease!();await wait(()=>chat.service.snapshot().phase==='idle');await sleep(60)
 checks.nextDraftPreserved=await js(`document.querySelector('textarea').value==='생성 중 작성한 다음 초안'`)
 checks.voicePrimary=await js(`(()=>{const e=document.querySelector('.message.assistant:last-child .message-voice-actions');return !!e&&e.querySelectorAll(':scope > button').length===1&&!e.querySelector('details').open})()`)
 await js(`document.querySelector('.message.assistant:last-child details').open=true`)
 checks.voiceAdvanced=await js(`document.querySelector('.message.assistant:last-child details').textContent.includes('다른 시드로 다시 읽기')`)
 await shot('chat-voice-options')
 stage='failed-admission' // fail before model scheduling
 const installed=chat.service.models.installed;chat.service.models.installed=async()=>[];await chat.service.refreshModels()
 // Real service admission rejection preserves text. The normal UI disables send when absent.
 await js(`window.characterChat.action({type:'send',text:'생성 중 작성한 다음 초안',draftKey:${JSON.stringify(chat.service.snapshot().draft!.key)},draftRevision:${chat.service.snapshot().draft!.revision}})`)
 checks.failedSendRetains=await js(`document.querySelector('textarea').value==='생성 중 작성한 다음 초안'`);chat.service.models.installed=installed;await chat.service.refreshModels()
 stage='sizes-keyboard';const beforeComposition=chat.service.snapshot().epoch;await js(`document.querySelector('textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true,isComposing:true}))`);await sleep(60);checks.compositionEnterGuard=chat.service.snapshot().epoch===beforeComposition;for(const [width,height] of [[350,360],[900,800]]){chat.window!.setSize(width,height);await sleep(80);checks['bounds-'+width]=await js(`document.documentElement.scrollWidth<=document.documentElement.clientWidth&&document.querySelector('.composer').getBoundingClientRect().bottom<=innerHeight`)}
 chat.window!.show();chat.window!.focus();chat.window!.webContents.focus();await sleep(50);await js(`document.querySelector('.messages').focus()`);chat.window!.webContents.sendInputEvent({type:'keyDown',keyCode:'Home'});chat.window!.webContents.sendInputEvent({type:'keyUp',keyCode:'Home'});await sleep(600)
 checks.keyboardHistoryHome=await js(`document.querySelector('.messages').scrollTop<2`);checks.keyboardHistoryFocus=await js(`document.activeElement===document.querySelector('.messages')`)
 stage='settings';const settingsWin=settings.open();await wait(()=>settingsWin.webContents.executeJavaScript('Boolean(document.querySelector("#tab-chat"))'))
 await settingsWin.webContents.executeJavaScript(`document.querySelector('#tab-chat').click()`);await wait(()=>settingsWin.webContents.executeJavaScript('Boolean(document.querySelector(".voice-settings"))'))
 const settingJs=(s:string)=>settingsWin.webContents.executeJavaScript(s)
 checks.settingsOrder=await settingJs(`(()=>{const wav=document.querySelector('.voice-reference-import'),volume=document.querySelector('input[aria-label="음량"]'),test=[...document.querySelectorAll('button')].find(e=>e.textContent==='시험 재생');return !wav.open&&!!(volume.compareDocumentPosition(wav)&Node.DOCUMENT_POSITION_FOLLOWING)&&!!(test.compareDocumentPosition(wav)&Node.DOCUMENT_POSITION_FOLLOWING)})()`)
 await shot('settings-everyday-voice',settingsWin)
 await settingJs(`document.querySelector('.voice-reference-import summary').click()`);checks.wavExpanded=await settingJs(`document.querySelector('.voice-reference-import').open&&!!document.querySelector('input[aria-label="새 음성 이름"]')`)
 await settingJs(`document.querySelector('input[aria-label="새 음성 이름"]').focus()`);settingsWin.webContents.sendInputEvent({type:'char',keyCode:'Q'});await settingJs(`document.querySelector('.voice-reference-import summary').click();document.querySelector('.voice-reference-import summary').click()`)
 checks.wavFormPreserved=await settingJs(`document.querySelector('input[aria-label="새 음성 이름"]').value==='Q'`)
 await shot('settings-wav-expanded',settingsWin)
 management.dispose();settings.destroy();await chat.dispose()
 await writeFile(join(evidence,'result.json'),JSON.stringify({passed:Object.values(checks).every(Boolean),checks,backend:'isolated real CharacterChatService + window/preload/renderer; mocked model/audio/setup only',credentials:'none; no Keychain/tunnel/real profile access'}));keepAlive.destroy();app.exit(Object.values(checks).every(Boolean)?0:1)
}).catch(async(error)=>{loadingCleanup();await writeFile(join(evidence,'result.json'),JSON.stringify({passed:false,stage,error:error instanceof Error?error.message:'CHAT_QA_FAILED',checks}));app.exit(1)})
function loadingCleanup(){try{management?.dispose();settings?.destroy()}catch{}}
