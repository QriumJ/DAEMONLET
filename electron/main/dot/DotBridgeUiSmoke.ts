import { screen, BrowserWindow } from 'electron'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { DotPresentationService } from './DotPresentationService'
import type { ActivityBubbleWindowController } from '../ActivityBubbleWindowController'
import type { ActivityWindowController } from '../ActivityWindowController'
import type { TaskControlService } from '../control/TaskControlService'
import { ActivityStore } from '../activity/ActivityStore'
import { ACTIVITY_IPC } from '../../shared/activity-contract'
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms))
const wait=async(test:()=>boolean|Promise<boolean>,label='UI')=>{for(let i=0;i<200;i++){if(await test())return;await sleep(50)}throw Error('DOT_SMOKE_TIMEOUT: '+label)}
/** Isolated user data/ports. Optional owner-selected real Desktop follower never sends or stops a turn. */
export async function runDotBridgeUiSmoke(pet:BrowserWindow,bubble:ActivityBubbleWindowController,get:()=>DotPresentationService,layout:(value:boolean)=>void,list:ActivityWindowController,control:TaskControlService){
 if(process.env.ELECTRON_SMOKE_TEST!=='1'||!process.env.ELECTRON_SMOKE_USER_DATA||!process.env.ELECTRON_SMOKE_DOT_EVIDENCE)throw Error('DOT_SMOKE_ISOLATION')
 const speech=bubble.speech,checks:Record<string,boolean>={},port=Number(process.env.DAEMONLET_DOT_PORT),token=process.env.DAEMONLET_DOT_TOKEN
 const dir=process.env.ELECTRON_SMOKE_DOT_EVIDENCE!,geometry:Array<unknown>=[]
 const present=async(command:unknown)=>{const r=await fetch(`http://127.0.0.1:${port}/present`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify(command)});return {status:r.status,value:await r.json()}}
 // Pet readiness can precede the asynchronous server listen callback. Wait for the
 // isolated authenticated endpoint, rather than treating renderer readiness as transport readiness.
 await wait(async()=>{try{return (await present({type:'cancel'})).status===200}catch{return false}},'bridge endpoint')
 const service=get()
 const dom=(code:string)=>speech.window!.webContents.executeJavaScript(code)
 const shot=async(name:string)=>{await sleep(120);if(speech.window?.isVisible())await writeFile(join(dir,name+'.png'),(await speech.window.webContents.capturePage()).toPNG())}
 const text='오빠, 이제 긴 문장도 끝까지 읽을 수 있어.\n여러 줄로 보여도 음성에는 원문이 그대로 전달돼.\n'+('전체 보기를 누르면 나머지 문장을 스크롤해서 읽을 수 있고, 접기나 Escape로 돌아갈 수 있어. '.repeat(9))+'마지막 문장까지 보존했어.'
 const first=await present({type:'present',text,pose:'happy',state:'done',speak:true,durationMs:30000});checks.mutedAcceptance=first.status===200&&first.value.voice==='muted'
 await wait(()=>!!speech.window?.isVisible(),'native bubble')
 await wait(async()=>await dom('document.querySelector(".speech-text").textContent')===text,'full original')
 checks.fullText=await dom('document.querySelector(".speech-text").textContent')===text
 checks.noPrefix=!await dom('document.querySelector(".speech-text").textContent.startsWith("dot · ")')
 checks.newlines=await dom('getComputedStyle(document.querySelector(".speech-text")).whiteSpace==="pre-wrap"')
 checks.compactButton=await dom('!document.querySelector(".speech-expand").hidden')
 await shot('long-compact')
 const click=async()=>{
  const p=await dom('(()=>{const r=document.querySelector(".speech-expand").getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()')
  for(const type of ['mouseMove','mouseDown','mouseUp'] as const)speech.window!.webContents.sendInputEvent({type,...p,...(type==='mouseMove'?{}:{button:'left' as const,clickCount:1})})
  await sleep(180)
 }
 await click();await wait(async()=>await dom('document.querySelector(".speech-bubble").dataset.expanded==="true"'),'expand')
 checks.expanded=await dom('getComputedStyle(document.querySelector(".speech-text")).overflowY==="auto"')
 checks.focusAfterExpand=speech.window!.isFocusable()
 await dom('document.querySelector(".speech-text").scrollTop=100000')
 checks.scrollToEnd=await dom('(()=>{const n=document.querySelector(".speech-text");return n.scrollTop+n.clientHeight>=n.scrollHeight-1&&n.textContent.endsWith("마지막 문장까지 보존했어.")})()')
 await shot('long-expanded-end')
 speech.window!.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});speech.window!.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'})
 await wait(async()=>await dom('document.querySelector(".speech-bubble").dataset.expanded==="false"'),'Escape')
 checks.escapeCollapse=!speech.window!.isFocusable()
 await click();await click();checks.clickCollapse=await dom('document.querySelector(".speech-bubble").dataset.expanded==="false"')
 const original=pet.getBounds(),area=screen.getDisplayMatching(original).workArea
 for(const size of [280,720])for(const edge of ['left','right','top','bottom']){
  const x=edge==='left'?area.x:edge==='right'?area.x+area.width-size:area.x+Math.round((area.width-size)/2)
  const y=edge==='top'?area.y:edge==='bottom'?area.y+area.height-size:area.y+Math.round((area.height-size)/2)
  pet.setBounds({x,y,width:size,height:size});await sleep(250)
  await click();await sleep(100)
  const b=speech.window!.getBounds();geometry.push({size,edge,bounds:b,workArea:area})
  checks['edge-'+size+'-'+edge]=b.x>=area.x+8&&b.y>=area.y+8&&b.x+b.width<=area.x+area.width-8&&b.y+b.height<=area.y+area.height-8
  await click()
 }
 pet.setBounds(original);await sleep(100)
 await present({type:'cancel'});await wait(()=>!speech.window?.isVisible(),'cancel');checks.cancelClears=true
 const store=new ActivityStore();store.setConnection('READY');let seq=0
 const event=(type:string,runId:string)=>{store.accept({protocolVersion:1,frameType:'event',messageId:String(++seq),source:'codex-adapter',sourceInstanceId:'isolated-ui',sessionId:'synthetic-task',sequence:seq,sentAt:Date.now(),payload:{type,runId}} as never);const value={...store.view(),revision:seq,storage:'saved' as const,historyRecovered:false,navigation:'none' as const};bubble.update(value);bubble.send(ACTIVITY_IPC.changed,value);return value}
 event('run.started','mock-work');await wait(()=>!!bubble.window?.isVisible(),'task fixture')
 await sleep(260);await present({type:'present',text:'작업 상태는 보존하면서 말풍선만 표시해.',durationMs:30000});await wait(()=>!!speech.window?.isVisible(),'task+speech')
 checks.taskHiddenDuringSpeech=!bubble.window!.isVisible()
 event('run.completed','mock-work');checks.incomingCompletionRetained=store.view().entries.some(e=>e.unread&&e.state==='completed')
 const work=list.open();await wait(()=>!work.webContents.isLoading(),'work window');work.show();work.focus();await sleep(100)
 checks.explicitWorkStays=work.isVisible()&&!!speech.window?.isVisible()
 checks.passiveSpeechNoFocus=BrowserWindow.getFocusedWindow()===work&&!speech.window!.isFocusable()
 work.minimize();await wait(()=>work.isMinimized(),'minimize');checks.workMinimized=true;list.open();await wait(()=>!work.isMinimized()&&work.isVisible(),'restore');checks.workReopen=true
 bubble.setView('control',false);await sleep(120);checks.controlAndSpeech=!!bubble.window?.isVisible()&&!!speech.window?.isVisible()
 const controlBounds=bubble.window!.getBounds(),speechBounds=speech.window!.getBounds();checks.controlNoOverlap=speechBounds.x+speechBounds.width<=controlBounds.x||speechBounds.x>=controlBounds.x+controlBounds.width||speechBounds.y+speechBounds.height<=controlBounds.y||speechBounds.y>=controlBounds.y+controlBounds.height
 bubble.setView('activity',false);await service.cancel();await wait(()=>!speech.window?.isVisible()&&!!bubble.window?.isVisible(),'task restored')
 checks.taskRestored=store.view().entries.some(e=>e.unread)
 await sleep(260);await present({type:'present',text:'1초 뒤 작업 알림으로 돌아갈게.',durationMs:1000});await wait(()=>!service.snapshot(),'expiry');await wait(()=>!!bubble.window?.isVisible(),'expiry restoration');checks.expiryRestores=true
 for(let i=0;i<3;i++){await sleep(260);await present({type:'present',text:'반복 '+i});await wait(()=>!!speech.window?.isVisible(),'repeat');await service.cancel();await wait(()=>!speech.window?.isVisible(),'repeat cancel')};checks.rapidRepeat=true
 await sleep(260);await present({type:'present',text:'캐릭터 숨김 테스트'});await wait(()=>!!speech.window?.isVisible(),'before hide');pet.hide();await wait(()=>!service.snapshot()&&!speech.window?.isVisible(),'hide cancellation');checks.hideCancels=true;pet.showInactive();await sleep(400)
 let realDesktop:Record<string,unknown>={tested:false}
 if(process.env.ELECTRON_SMOKE_DOT_DESKTOP_HOME){
  await wait(()=>control.snapshot().connection==='ready','real Desktop connection')
  const matches=control.snapshot().threads.filter(t=>t.title===process.env.ELECTRON_SMOKE_DOT_DESKTOP_TITLE)
  if(matches.length!==1)throw Error('DOT_DESKTOP_TITLE_AMBIGUOUS_OR_UNAVAILABLE')
  await control.select(matches[0].key);bubble.setView('control',false)
  await wait(async()=>!!bubble.window?.isVisible()&&await bubble.window.webContents.executeJavaScript('document.querySelector("#control-thread")?.value!==""'),'real selected UI')
  const selected=control.snapshot().threads.find(t=>t.key===control.snapshot().selectedKey)!
  realDesktop={tested:true,title:selected.title,state:selected.state,source:control.snapshot().source,connection:control.snapshot().connection,writeActions:0}
  await sleep(260);await present({type:'present',text:'ㅎㅇ 작업에 연결한 상태에서도 표시해.',durationMs:30000});await wait(()=>!!speech.window?.isVisible(),'real+speech')
  checks.realConnectedPresentation=control.snapshot().connection==='ready'&&!!bubble.window?.isVisible()
  await writeFile(join(dir,'real-control.png'),(await bubble.window!.webContents.capturePage()).toPNG());await shot('real-connected-speech')
  await bubble.window!.webContents.executeJavaScript(`document.querySelector('[aria-label="작업 알림으로 돌아가기"]').click()`)
  await wait(()=>bubble.getView().view==='activity','control to task')
  bubble.setView('control',false);await service.cancel();await wait(()=>!speech.window?.isVisible(),'real cancel')
  checks.realSelectionPreserved=control.snapshot().selectedKey===matches[0].key&&control.snapshot().connection==='ready'
  await control.refresh();checks.realRefresh=control.snapshot().connection==='ready'
  realDesktop.finalState=control.snapshot().threads.find(t=>t.key===matches[0].key)?.state
 }
 work.close();bubble.setView('activity',false)
 await sleep(260);checks.unknownFallback=(await present({type:'present',pose:'unknown',state:'thinking'})).value.poseFallback===true
 await wait(async()=>!!speech.window?.isVisible()&&await dom('document.querySelector(".speech-text").textContent.includes("생각 중")'),'state-only');checks.statusVisible=true
 layout(true);await wait(()=>!service.snapshot(),'layout');checks.layoutCancels=true;layout(false)
 await service.setQuiet(true);await sleep(1100);checks.quietRejects=(await present({type:'present',text:'suppressed'})).value.error==='DOT_QUIET';await service.setQuiet(false)
 await service.setMuted(false);await sleep(260);checks.unavailableVoice=(await present({type:'present',text:'음성 없음',speak:true})).value.error==='DOT_VOICE_UNAVAILABLE';await service.setMuted(true)
 return {passed:Object.values(checks).every(Boolean),checks,geometry,realDesktop,incomingStatus:'synthetic ActivityStore completion only',voice:'muted UI; full original voice payload/cancellation covered by service tests; no audible replay',screenshots:['long-compact.png','long-expanded-end.png','real-control.png','real-connected-speech.png']}
}
