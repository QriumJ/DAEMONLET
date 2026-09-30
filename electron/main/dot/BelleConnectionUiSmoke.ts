/** Standalone QA app: in-memory credential/consent/runtime mocks, no real Keychain/network/client. */
import {app,ipcMain} from 'electron'
import {readFile,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {registerAppScheme,installAppProtocol} from '../AppProtocol'
import {SettingsWindowController} from '../SettingsWindowController'
import {BelleConnectionIpcController} from './BelleConnectionIpcController'
import {BelleConnectionManager} from './BelleConnectionManager'
import {SETUP_IPC} from '../../shared/codex-integration-contract'
import {defaultDesktopSettings} from '../../shared/desktop-settings'
const root=process.env.BELLE_QA_ROOT!,dir=process.env.BELLE_QA_EVIDENCE!,profile=process.env.ELECTRON_SMOKE_USER_DATA!
if(process.env.ELECTRON_SMOKE_TEST!=='1'||!root||!dir||!profile)throw Error('BELLE_QA_ISOLATION')
app.setPath('userData',profile);registerAppScheme();app.enableSandbox()
const checks:Record<string,boolean>={},confirmations:Array<{message:string;detail:string}>=[]
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms))
const wait=async(test:()=>boolean|Promise<boolean>)=>{for(let i=0;i<150;i++){if(await test())return;await sleep(50)}throw Error('BELLE_UI_TIMEOUT')}
let key='',config:any=null,allow=false,secure=true,missing=false,delayed=false,starts=0,stops=0,manager:BelleConnectionManager,settings:SettingsWindowController,ipc:BelleConnectionIpcController
app.whenReady().then(async()=>{
 installAppProtocol(join(root,'dist'))
 const setup={schemaVersion:1,app:{version:'QA',running:true,packaged:false,platform:'darwin'},storage:{userDataDisplayPath:'QA',receiptDirectoryDisplayPath:'QA'},onboarding:'skipped',discovery:null,configurationStatus:'not-installed',configurationWarnings:[],host:{available:false},hostSelfTest:{status:'not-tested'},adapter:{state:'STOPPED',ownership:'NONE',activeRunCount:0,activeTaskCount:0},hookReviewStatus:'unknown',reception:{status:'unavailable',lastReceivedAt:null,events:[]},live:{active:false,status:'not-tested'},hasRevert:false,checkedAt:Date.now(),issue:null}
 ipcMain.handle(SETUP_IPC.status,()=>({ok:true,value:setup}));ipcMain.handle(SETUP_IPC.settingsGet,()=>({ok:true,value:defaultDesktopSettings()}))
 manager=new BelleConnectionManager({store:{available:async()=>secure,has:async()=>Boolean(key),put:async value=>{key=value},get:async()=>key,remove:async()=>{key=''}},metadata:{load:async()=>config,save:async value=>{config=value}},bridge:{start:async()=>({port:12345,token:'mock-session'}),stop:async()=>{}},runtime:{probe:async()=>{if(missing)throw Error('CLIENT_MISSING');return {clientVersion:'0.0.14',nodeVersion:'v22.23.0'}},start:async(_config,_key,_bridge,signal)=>{starts++;if(delayed)await new Promise<void>((_r,reject)=>{signal.addEventListener('abort',()=>reject(Error('CONNECTION_FAILED')),{once:true});if(signal.aborted)reject(Error('CONNECTION_FAILED'))});let stopped=false;return {ready:async()=>!stopped,stop:async()=>{if(!stopped){stopped=true;stops++}}}}}})
 await manager.initialize()
 settings=new SettingsWindowController({preloadPath:join(root,'dist-electron/settings-preload.cjs'),onOpened:()=>{},onClosed:()=>{}})
 ipc=new BelleConnectionIpcController(manager,settings,undefined,async(message,detail)=>{confirmations.push({message,detail});return allow});ipc.register()
 const win=settings.open();win.setTitle('DAEMONLET · 비밀 없는 연결 QA')
 await new Promise<void>(r=>win.webContents.once('did-finish-load',()=>r()))
 const js=(source:string)=>win.webContents.executeJavaScript(source)
 await wait(()=>js('Boolean(document.querySelector("#tab-belle"))'))
 await js('document.querySelector("#tab-belle").click()');await wait(()=>js('Boolean(document.querySelector(".belle-connection-page form"))'))
 await js('(()=>{const p=document.createElement("p");p.textContent="비밀 없는 mock QA · 실제 계정 연결 아님";p.style="background:#fff4d8;padding:12px";document.querySelector(".belle-connection-page").prepend(p)})()')
 const shot=async(name:string)=>{await sleep(600);await writeFile(join(dir,name+'.png'),(await win.webContents.capturePage()).toPNG())}
 const text=()=>js('document.body.textContent')
 const press=async(label:string)=>{await js(`Array.from(document.querySelectorAll('.belle-connection-page button')).find(b=>b.textContent===${JSON.stringify(label)}).click()`);await sleep(100)}
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
 await press('저장한 키·설정 삭제');await wait(()=>config===null);checks.forgotOnlyLocal=key===''
 secure=false;await press('상태 다시 확인');await wait(()=>manager.snapshot().secureStore==='unavailable');checks.failClosed=await js('document.querySelector("input[type=password]").disabled&&document.querySelector(".belle-connection-page input[type=checkbox]").disabled')
 checks.dialogsNoKey=confirmations.every(v=>!JSON.stringify(v).includes(fake));checks.narrowBridgeTools=!(await text()).includes('키 표시')
 await manager.close();ipc.dispose();settings.destroy()
 await writeFile(join(dir,'result.json'),JSON.stringify({passed:Object.values(checks).every(Boolean),checks,confirmations:confirmations.map(v=>v.message),starts,stops,secretStore:'in-memory mock only; real Keychain untouched',connection:'mock runtime; no real Platform or helper connection',screenshots:['settings-empty.png','settings-saved.png','settings-ready.png']}))
 app.exit(Object.values(checks).every(Boolean)?0:1)
}).catch(async()=>{await manager?.close();ipc?.dispose();settings?.destroy();await writeFile(join(dir,'result.json'),JSON.stringify({passed:false,error:'BELLE_UI_SMOKE_FAILED',checks}));app.exit(1)})
