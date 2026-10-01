/** Standalone QA app: in-memory credential/consent/runtime mocks, no real Keychain/network/client. */
import {app,ipcMain} from 'electron'
import {readFile,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {setAppLanguage} from '../AppLanguage'
import {registerAppScheme,installAppProtocol} from '../AppProtocol'
import {SettingsWindowController} from '../SettingsWindowController'
import {BelleConnectionIpcController} from './BelleConnectionIpcController'
import {BelleConnectionManager} from './BelleConnectionManager'
import {SETUP_IPC} from '../../shared/codex-integration-contract'
import {BELLE_GUIDE_URLS} from '../../shared/belle-connection'
import {defaultDesktopSettings} from '../../shared/desktop-settings'
const root=process.env.BELLE_QA_ROOT!,dir=process.env.BELLE_QA_EVIDENCE!,profile=process.env.ELECTRON_SMOKE_USER_DATA!
if(process.env.ELECTRON_SMOKE_TEST!=='1'||!root||!dir||!profile)throw Error('BELLE_QA_ISOLATION')
app.setPath('userData',profile);registerAppScheme();app.enableSandbox()
let phase="initial"
const checks:Record<string,boolean>={},confirmations:Array<{message:string;detail:string}>=[]
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms))
const wait=async(test:()=>boolean|Promise<boolean>)=>{for(let i=0;i<150;i++){if(await test())return;await sleep(50)}throw Error('BELLE_UI_TIMEOUT')}
let key='',config:any=null,allow=false,secure=true,missing=false,delayed=false,starts=0,stops=0,healthy=true,guideFails=false,denyStore=false,guides:string[]=[],manager:BelleConnectionManager,settings:SettingsWindowController,ipc:BelleConnectionIpcController
app.whenReady().then(async()=>{
 installAppProtocol(join(root,'dist'))
 const setup={schemaVersion:1,app:{version:'QA',running:true,packaged:false,platform:'darwin'},storage:{userDataDisplayPath:'QA',receiptDirectoryDisplayPath:'QA'},onboarding:'skipped',discovery:null,configurationStatus:'not-installed',configurationWarnings:[],host:{available:false},hostSelfTest:{status:'not-tested'},adapter:{state:'STOPPED',ownership:'NONE',activeRunCount:0,activeTaskCount:0},hookReviewStatus:'unknown',reception:{status:'unavailable',lastReceivedAt:null,events:[]},live:{active:false,status:'not-tested'},hasRevert:false,checkedAt:Date.now(),issue:null}
 ipcMain.handle(SETUP_IPC.status,()=>({ok:true,value:setup}));ipcMain.handle(SETUP_IPC.settingsGet,()=>({ok:true,value:defaultDesktopSettings()}))
 manager=new BelleConnectionManager({store:{available:async()=>secure,has:async()=>Boolean(key),put:async value=>{if(denyStore)throw Error('STORE_DENIED');key=value},get:async()=>key,remove:async()=>{key=''}},metadata:{load:async()=>config,save:async value=>{config=value}},bridge:{start:async()=>({port:12345,token:'mock-session'}),stop:async()=>{}},runtime:{probe:async()=>{if(missing)throw Error('CLIENT_MISSING');return {clientVersion:'0.0.14',nodeVersion:'v22.23.0'}},start:async(_config,_key,_bridge,signal)=>{starts++;if(delayed)await new Promise<void>((_r,reject)=>{signal.addEventListener('abort',()=>reject(Error('CONNECTION_FAILED')),{once:true});if(signal.aborted)reject(Error('CONNECTION_FAILED'))});let stopped=false;return {ready:async()=>!stopped&&healthy,stop:async()=>{if(!stopped){stopped=true;stops++}}}}}})
 await manager.initialize()
 settings=new SettingsWindowController({preloadPath:join(root,'dist-electron/settings-preload.cjs'),onOpened:()=>{},onClosed:()=>{}})
 ipc=new BelleConnectionIpcController(manager,settings,undefined,async(message,detail)=>{confirmations.push({message,detail});return allow},async url=>{if(guideFails)throw Error('CONNECTION_FAILED');guides.push(url)});ipc.register()
 const win=settings.open();win.setTitle('DAEMONLET · 비밀 없는 연결 QA')
 await new Promise<void>(r=>win.webContents.once('did-finish-load',()=>r()))
 const js=(source:string)=>win.webContents.executeJavaScript(source)
 await wait(()=>js('Boolean(document.querySelector("#tab-belle"))'))
 await js('document.querySelector("#tab-belle").click()');await wait(()=>js('Boolean(document.querySelector(".belle-connection-page form"))'))
 await js('(()=>{const p=document.createElement("p");p.textContent="비밀 없는 mock QA · 실제 계정 연결 아님";p.style="background:#fff4d8;padding:12px";document.querySelector(".belle-connection-page").prepend(p)})()')
 const shot=async(name:string)=>{await sleep(600);await writeFile(join(dir,name+'.png'),(await win.webContents.capturePage()).toPNG())}
 const text=()=>js('document.body.textContent')
 const press=async(label:string)=>{phase=label;await wait(()=>js(`Array.from(document.querySelectorAll('.belle-connection-page button')).some(b=>b.textContent===${JSON.stringify(label)}&&!b.disabled)`));await js(`Array.from(document.querySelectorAll('.belle-connection-page button')).find(b=>b.textContent===${JSON.stringify(label)}).click()`);await sleep(100)}
 checks.emptyNoKey=await js('document.querySelector("input[type=password]").value===""')
 checks.autoDefaultOff=await js('!document.querySelector(".belle-connection-page input[type=checkbox]").checked')
 await shot('settings-empty')
 const fake='sk-'+Array.from({length:24},()=> 'm').join(''),ids={tunnelId:'tunnel_'+'a'.repeat(32),organizationId:'org-example123'}
 const submit=async()=>{await js(`(()=>{const inputs=document.querySelectorAll('.belle-connection-page form input');const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;[${JSON.stringify(ids.tunnelId)},${JSON.stringify(ids.organizationId)},${JSON.stringify(fake)}].forEach((v,i)=>{set.call(inputs[i],v);inputs[i].dispatchEvent(new Event('input',{bubbles:true}))});})()`);await sleep(100);await js('document.querySelector(".belle-connection-page form").requestSubmit()');await sleep(100)}
 await submit();checks.cancelDoesNotStore=key===''&&config===null&&starts===0;checks.clearedAfterCancel=await js('document.querySelector("input[type=password]").value===""')
 allow=true;await submit();await wait(()=>manager.snapshot().credentialStored)
 checks.savedOnly=starts===0&&config?.autoConnect===false;checks.noKeyInSnapshot=!JSON.stringify(manager.snapshot()).includes(fake);checks.noKeyInText=!(await text()).includes(fake);checks.passwordBlank=await js('document.querySelector("input[type=password]").value===""')
 await shot('settings-saved')
 await press('연결');await wait(()=>manager.snapshot().state==='ready');checks.connected=starts===1
 await wait(()=>text().then(t=>t.includes('터널 준비됨')));await shot('settings-ready')
 await js('document.querySelector(".belle-connection-page input[type=checkbox]").click()');await wait(()=>config.autoConnect===true);checks.autoExplicit=confirmations.some(c=>c.message.includes('자동 연결'))
 await press('연결 해제·자동 연결 끄기');await wait(()=>manager.snapshot().state==='disconnected');checks.disconnectStops=stops===1;checks.disconnectAutoOff=config.autoConnect===false
 delayed=true;await press('연결');await wait(()=>manager.snapshot().state==='connecting');await press('연결 해제·자동 연결 끄기');await wait(()=>manager.snapshot().state==='disconnected');checks.cancelWhileStarting=true;delayed=false
 for(const width of [800,1060]){win.setSize(width,820);await sleep(100);checks['width-'+width]=await js('document.documentElement.scrollWidth<=document.documentElement.clientWidth')}
 win.minimize();await wait(()=>win.isMinimized());settings.open();await wait(()=>!win.isMinimized());checks.reopen=true
 missing=true;await press('상태 다시 확인');await wait(()=>text().then(t=>t.includes('공식 tunnel-client가 필요')));checks.missingClientGuidance=true;missing=false
 // Wizard exercises the production renderer/preload with mock consent, store and runtime.
 await press('연결 마법사 열기');await wait(()=>text().then(t=>t.includes('준비 확인')))
 checks.wizardNoImplicitStart=manager.snapshot().state==='disconnected'
 await shot('wizard-prerequisites')
 guideFails=true;await press('공식 터널 안내 열기');await wait(()=>text().then(t=>t.includes('공식 페이지를 열지 못했습니다')));checks.guideFailureFixed=true;guideFails=false
 await press('공식 터널 안내 열기');checks.guideExact=guides.at(-1)===BELLE_GUIDE_URLS.tunnelDocs
 checks.guideRejectsUrl=await js('window.settingsDesktop.belleConnection.openGuide("https://evil.example/?key=fixture").then(()=>false,()=>true)')
 checks.guideDidNotOpenRejected=guides.length===1
 await press('다음');await wait(()=>text().then(t=>t.includes('기존 터널이 있으면')))
 win.setSize(800,650);await sleep(100);await shot('wizard-platform-small')
 checks.smallWizardNoOverflow=await js('document.documentElement.scrollWidth<=document.documentElement.clientWidth')
 checks.smallWizardControlsReachable=await js('(()=>{const b=Array.from(document.querySelectorAll("button")).find(b=>b.textContent==="중단·기존 설정으로");b.scrollIntoView();const r=b.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight})()')
 await press('다음');await wait(()=>js('Boolean(document.querySelector(".belle-wizard input[type=password]"))'))
 checks.existingKeySkip=await js('!Array.from(document.querySelectorAll(".belle-wizard button")).find(b=>b.textContent==="다음").disabled')
 await js('document.querySelector("input[type=password]").value="unsaved-fixture"');await press('뒤로');await press('다음')
 checks.backClearsInput=await js('document.querySelector("input[type=password]").value===""')
 await js('document.querySelector("input[type=password]").value="unsaved-fixture"');await press('중단·기존 설정으로')
 checks.pauseClearsInput=await js('document.querySelector("input[type=password]").value===""')
 checks.pausePreservesStored=key===fake&&config.tunnelId===ids.tunnelId
 await press('연결 마법사 열기');await wait(()=>js('Boolean(document.querySelector(".belle-wizard input[type=password]"))'))
 checks.resumeStepOnly=await js('localStorage.getItem("daemonlet.belle-wizard.step.v1")==="2"')
 await press('다음');await wait(()=>text().then(t=>t.includes('저장한 대상과 키로')))
 const beforeStarts=starts
 await js('(()=>{const b=Array.from(document.querySelectorAll(".belle-wizard button")).find(b=>b.textContent==="연결");b.click();b.click();b.click()})()')
 await wait(()=>manager.snapshot().state==='ready');checks.repeatedConnectOnce=starts===beforeStarts+1
 await press('다음');await wait(()=>text().then(t=>t.includes('ChatGPT Plugins의 +')))
 win.setSize(1060,820);await js('document.querySelector(".belle-wizard").scrollIntoView()');await shot('wizard-plugin')
 checks.runtimeNotInstallation=await js('!document.querySelector(".belle-wizard input[type=checkbox]").checked&&Array.from(document.querySelectorAll(".belle-wizard button")).find(b=>b.textContent==="다음").disabled')
 await press('ChatGPT Plugins 열기');checks.pluginsExact=guides.at(-1)===BELLE_GUIDE_URLS.plugins
 await js('document.querySelector(".belle-wizard input[type=checkbox]").click()');await press('다음')
 await wait(()=>text().then(t=>t.includes('사용자가 확인함')))
 checks.toolCallNotClaimed=(await text()).includes('미확인 · 앱에 지원되는 실호출 증거 없음')
 win.setSize(800,650);await js('document.querySelector(".belle-wizard").scrollIntoView()');await shot('wizard-diagnostics-small')
 setAppLanguage('en');await wait(()=>text().then(t=>t.includes('Acknowledged by you')));checks.englishWizard=(await text()).includes('Unverified · the app has no supported evidence of an actual call');await shot('wizard-diagnostics-en');setAppLanguage('ko');await wait(()=>text().then(t=>t.includes('사용자가 확인함')))
 const savedBefore=JSON.stringify(config),startBefore=starts,stopBefore=stops
 await press('안내 처음부터');await wait(()=>text().then(t=>t.includes('준비 확인')))
 checks.restartPreservesConnection=JSON.stringify(config)===savedBefore&&starts===startBefore&&stops===stopBefore
 await press('건너뛰고 진단 보기');checks.skipDoesNotInstall=(await text()).includes('사용자 재확인 필요')
 await press('중단·기존 설정으로');await press('연결 마법사 열기');await wait(()=>text().then(t=>t.includes('사용자 재확인 필요')))
 checks.reentryRechecksInstallation=true
 healthy=false;await press('진단 다시 확인');await wait(()=>manager.snapshot().state==='reconnecting');checks.freshReadiness=(await text()).includes('준비 상태 확인 필요')
 healthy=true;await press('진단 다시 확인');await wait(()=>manager.snapshot().state==='ready')
 checks.progressNoSecret=await js(`(()=>{const v=localStorage.getItem("daemonlet.belle-wizard.step.v1");return v==="5"&&!v.includes(${JSON.stringify(fake)})})()`)
 win.webContents.reload();await wait(()=>js('Boolean(document.querySelector("#tab-belle"))'))
 await js('document.querySelector("#tab-belle").click()');await wait(()=>js('Boolean(document.querySelector(".belle-connection-page form"))'))
 await press('연결 마법사 열기');await wait(()=>text().then(t=>t.includes('사용자 재확인 필요')));checks.reloadRestoresOnlyStep=true
 await press('뒤로');await wait(()=>text().then(t=>t.includes('ChatGPT Plugins의 +')))
 await js('document.querySelector(".belle-wizard input[type=checkbox]").click()')
 await press('연결 해제·자동 연결 끄기');await wait(()=>manager.snapshot().state==='disconnected')
 checks.disconnectClearsAcknowledgement=await js('!document.querySelector(".belle-wizard input[type=checkbox]").checked&&document.querySelector(".belle-wizard input[type=checkbox]").disabled')
 await press('뒤로');delayed=true;await press('연결');await wait(()=>manager.snapshot().state==='connecting')
 await press('중단·기존 설정으로');checks.pauseDuringConnect=manager.snapshot().state==='connecting'
 await press('연결 해제·자동 연결 끄기');await wait(()=>manager.snapshot().state==='disconnected');delayed=false
 await press('연결 마법사 열기');await wait(()=>text().then(t=>t.includes('저장한 대상과 키로')))
 await press('뒤로');await wait(()=>js('Boolean(document.querySelector(".belle-wizard input[type=password]"))'))
 allow=false;await submit();checks.wizardCancelKeepsConfig=key===fake&&config.tunnelId===ids.tunnelId
 allow=true;denyStore=true;await submit();await wait(()=>text().then(t=>t.includes('OS 보안 저장소 요청이 취소')));checks.wizardSaveFailureKeepsTarget=key===fake&&config.tunnelId===ids.tunnelId;checks.wizardSaveFailureClearsInput=await js('document.querySelector("input[type=password]").value===""');denyStore=false
 await press('저장한 키·설정 삭제');await wait(()=>config===null)
 checks.keyDeletionBlocksNext=await js('Array.from(document.querySelectorAll(".belle-wizard button")).find(b=>b.textContent==="다음").disabled')
 await press('중단·기존 설정으로')
 await wait(()=>config===null);checks.forgotOnlyLocal=key===''
 secure=false;await press('상태 다시 확인');await wait(()=>manager.snapshot().secureStore==='unavailable');checks.failClosed=await js('document.querySelector("input[type=password]").disabled&&document.querySelector(".belle-connection-page input[type=checkbox]").disabled')
 checks.dialogsNoKey=confirmations.every(v=>!JSON.stringify(v).includes(fake));checks.narrowBridgeTools=!(await text()).includes('키 표시')
 await manager.close();ipc.dispose();settings.destroy()
 await writeFile(join(dir,'result.json'),JSON.stringify({passed:Object.values(checks).every(Boolean),checks,confirmations:confirmations.map(v=>v.message),starts,stops,secretStore:'in-memory mock only; real Keychain untouched',connection:'mock runtime; no real Platform or helper connection',screenshots:['settings-empty.png','settings-saved.png','settings-ready.png','wizard-prerequisites.png','wizard-platform-small.png','wizard-diagnostics-small.png','wizard-plugin.png','wizard-diagnostics-en.png']}))
 app.exit(Object.values(checks).every(Boolean)?0:1)
}).catch(async()=>{await manager?.close();ipc?.dispose();settings?.destroy();await writeFile(join(dir,'result.json'),JSON.stringify({passed:false,error:'BELLE_UI_SMOKE_FAILED',phase,checks}));app.exit(1)})
