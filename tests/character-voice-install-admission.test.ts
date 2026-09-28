import {afterEach,expect,it,vi} from 'vitest'
import {mkdtemp,rm,mkdir,writeFile,readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {ipcMain} from 'electron'
import {VoiceIpcController} from '../electron/main/character-voice/VoiceIpcController'
import {VOICE_IPC} from '../electron/shared/character-voice-contract'
vi.mock('electron',()=>({ipcMain:{handle:vi.fn(),removeHandler:vi.fn()},dialog:{}}))
vi.mock('../electron/main/SecurityPolicy',()=>({isTrustedSender:()=>true}))
import {VoiceBaseInstaller} from '../electron/main/character-voice/VoiceBaseInstaller'
import {WindowsVoiceInstaller} from '../electron/main/character-voice/WindowsVoiceInstaller'
function gate(){let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {promise,resolve}}
const turn=()=>new Promise<void>(r=>setImmediate(r))
const cleanup:Array<()=>Promise<unknown>>=[]
function fixture(windows:boolean,verification=false){
 const pending=gate(),jobs:Array<{signal:AbortSignal;finish:()=>void;done:boolean}>=[],states:any[]=[]
 let notify=()=>{}
 const changed=()=>{states.push(installer.snapshot());notify()}
 const installer=windows?new WindowsVoiceInstaller('/unused','/resources',changed):new VoiceBaseInstaller('/unused','/resources',changed)
 const owner=installer as any;owner.status.supported=true
 if(verification){owner.verifyController=new AbortController();owner.verifying=pending.promise}
 const io=vi.spyOn(owner,windows?'prepare':'download').mockImplementation((...args:unknown[])=>new Promise<void>((resolve,reject)=>{
  const signal=args[0] as AbortSignal,job={signal,done:false,finish:()=>{job.done=true;resolve()}};jobs.push(job)
  if(signal.aborted){job.done=true;reject(signal.reason);return}
  signal.addEventListener('abort',()=>{job.done=true;reject(signal.reason)},{once:true})
 }))
 const f={installer,owner,pending,jobs,io,states,setNotify:(fn:()=>void)=>{notify=fn}};cleanup.push(async()=>{pending.resolve();jobs.forEach(j=>j.finish());await installer.cancel()});return f
}
afterEach(async()=>{for(const close of cleanup.splice(0))await close();vi.restoreAllMocks()})
for(const windows of [false,true]){
 const name=windows?'Windows':'Mac'
 it.each([false,true])(`${name}: same-turn installs own one task before verification cleanup (delayed=%s)`,async delayed=>{
  const f=fixture(windows,delayed),a=f.installer.install(),b=f.installer.install()
  try{
   expect(a).toBe(b);expect(f.owner.operation).not.toBeNull();expect(f.owner.controller).not.toBeNull();expect(f.installer.snapshot().phase).toBe('preparing')
   f.pending.resolve();await turn();expect(f.jobs).toHaveLength(1);f.jobs[0].finish();await Promise.all([a,b]);expect(f.installer.snapshot().installed).toBe(true)
  }finally{f.pending.resolve();await turn();f.jobs.forEach(j=>j.finish());await Promise.allSettled([a,b])}
 })
 it(`${name}: cancellation while verifier drains cannot start later IO or announce installation`,async()=>{
  const f=fixture(windows,true),installing=f.installer.install();await turn()
  let returned=false;const cancelling=f.installer.cancel().then(()=>{returned=true});await turn();expect(returned).toBe(false)
  f.pending.resolve();await cancelling;await installing;await turn()
  expect(f.io).not.toHaveBeenCalled();expect(f.owner.operation).toBeNull();expect(f.owner.controller).toBeNull();expect(f.installer.snapshot()).toMatchObject({phase:'idle',installed:false,error:null})
  expect(f.states.some(s=>s.installed)).toBe(false)
 })
 it(`${name}: immediate cancellation drains admission and a later explicit retry starts once`,async()=>{
  const f=fixture(windows),first=f.installer.install(),cancel=f.installer.cancel();await Promise.all([first,cancel]);expect(f.io).not.toHaveBeenCalled()
  const retry=f.installer.install();await turn();expect(f.jobs).toHaveLength(1);expect(f.jobs[0].signal.aborted).toBe(false);f.jobs[0].finish();await retry;expect(f.installer.snapshot().installed).toBe(true)
 })
 it(`${name}: cancel during IO owns every writer and retry waits for cleanup`,async()=>{
  const f=fixture(windows),a=f.installer.install();await turn();const b=f.installer.install();expect(f.jobs).toHaveLength(1)
  await f.installer.cancel();await Promise.all([a,b]);expect(f.jobs.every(j=>j.done&&j.signal.aborted)).toBe(true)
  const retry=f.installer.install();await turn();expect(f.jobs).toHaveLength(2);f.jobs[1].finish();await retry
 })
 it(`${name}: obsolete completion/finally cannot publish success or clear a replacement owner`,async()=>{
  const f=fixture(windows),old=f.installer.install();await turn()
  // Force the defensive stale-owner boundary; ordinary admission forbids overlap.
  const replacement=gate(),controller=new AbortController();f.owner.operation=replacement.promise;f.owner.controller=controller
  f.jobs[0].finish();await old
  expect(f.owner.operation).toBe(replacement.promise);expect(f.owner.controller).toBe(controller);expect(f.installer.snapshot().installed).toBe(false)
  replacement.resolve()
 })
}

async function ipcFixture(windows:boolean){
 const f=fixture(windows,true),root=await mkdtemp(join(tmpdir(),'voice-admission-ipc-'))
 const window={isDestroyed:()=>false,webContents:{isDestroyed:()=>false,send:vi.fn()}} as any
 const chat={snapshot:()=>({character:{id:'test'}}),subscribeVoiceStart:()=>()=>{},subscribeVoice:()=>()=>{},subscribe:()=>()=>{}} as any
 const controller=new VoiceIpcController(root,'/worker',()=>window,chat)
 ;(controller.service as any).base=f.installer;f.setNotify(()=>controller.service.refreshBase());vi.spyOn(f.installer,'initialize').mockResolvedValue()
 await controller.initialize()
 const prepare=vi.spyOn(controller.service,'prepare').mockResolvedValue()
 const handler=vi.mocked(ipcMain.handle).mock.calls.filter(c=>c[0]===VOICE_IPC.action).at(-1)![1]
 const action=(type:string)=>handler({} as any,{type})
 cleanup.push(async()=>{await controller.close();await rm(root,{recursive:true,force:true})})
 return {...f,controller,prepare,action,window}
}
for(const windows of [false,true]){
 const name=windows?'Windows':'Mac'
 it(`${name}: actual IPC/service shares admission and advertises cancellable preparation`,async()=>{
  const f=await ipcFixture(windows),a=f.action('installBase'),b=f.action('installBase')
  await vi.waitFor(()=>expect(f.installer.snapshot().phase).toBe('preparing'))
  expect(f.window.webContents.send.mock.calls.some((c:any[])=>c[0]===VOICE_IPC.changed&&c[1].baseInstall.phase==='preparing')).toBe(true)
  expect(f.io).not.toHaveBeenCalled();f.pending.resolve();await turn();expect(f.jobs).toHaveLength(1);f.jobs[0].finish();await Promise.all([a,b]);expect(f.prepare).toHaveBeenCalledTimes(1)
 })
 it.each(['cancel','close'] as const)(`${name}: IPC/service %s during verification drain has no late install or voice preparation`,async kind=>{
  const f=await ipcFixture(windows);f.owner.status.installed=true // preserve a healthy prior installation
  const a=f.action('installBase');await vi.waitFor(()=>expect(f.owner.verifyController.signal.aborted).toBe(true))
  let done=false;const stopped=(kind==='close'?f.controller.close():f.action('cancelInstallBase')).then(()=>{done=true});await turn();expect(done).toBe(false)
  f.pending.resolve();await turn();try{expect(f.io).not.toHaveBeenCalled()}finally{f.jobs.forEach(j=>j.finish());await Promise.all([a,stopped])}
  expect(f.prepare).not.toHaveBeenCalled();expect(f.installer.snapshot().installed).toBe(true)
  expect(f.window.webContents.send.mock.calls.filter((c:any[])=>c[0]===VOICE_IPC.event&&c[1].type==='audio')).toEqual([])
 })
 it(`${name}: service cancellation in the admission turn prevents even installer entry`,async()=>{
  const f=await ipcFixture(windows),install=vi.spyOn(f.installer,'install')
  const a=f.controller.service.installBase(),cancel=f.controller.service.cancelInstallBase();f.pending.resolve();await Promise.all([a,cancel]);expect(install).not.toHaveBeenCalled();expect(f.prepare).not.toHaveBeenCalled()
 })
 it(`${name}: cancellation before publication preserves the old installation and staged bytes`,async()=>{
  const root=await mkdtemp(join(tmpdir(),'voice-publish-'));cleanup.push(()=>rm(root,{recursive:true,force:true}))
  const installer=windows?new WindowsVoiceInstaller(root,'/resources',()=>{}):new VoiceBaseInstaller(root,'/resources',()=>{}),owner=installer as any
  owner.status.supported=true;owner.status.installed=true
  const stage=join(root,'stage'),target=windows?join(root,'runtime-target'):installer.path
  await mkdir(stage);await mkdir(target);await writeFile(join(stage,'asset'),'new verified bytes');await writeFile(join(target,'asset'),'old valid bytes')
  const pending=gate(),entered=gate()
  vi.spyOn(owner,windows?'prepare':'download').mockImplementation(async(...args:unknown[])=>{entered.resolve();await pending.promise;const signal=args[0] as AbortSignal;return windows?owner.publish(stage,target,signal):owner.publish(stage,signal)})
  const installed=installer.install();await entered.promise;const cancelled=installer.cancel();pending.resolve();await Promise.all([installed,cancelled])
  expect(await readFile(join(target,'asset'),'utf8')).toBe('old valid bytes');expect(await readFile(join(stage,'asset'),'utf8')).toBe('new verified bytes');expect(installer.snapshot().installed).toBe(true)
 })
}

for(const windows of [false,true])it(`${windows?'Windows':'Mac'}: preparation notification can reenter install/cancel without losing ownership`,async()=>{
 const f=fixture(windows);let duplicate:Promise<void>|undefined,cancelled:Promise<void>|undefined
 f.setNotify(()=>{if(f.installer.snapshot().phase==='preparing'){duplicate=f.installer.install();cancelled=f.installer.cancel()}})
 const accepted=f.installer.install();await turn();expect(duplicate).toBe(accepted);await Promise.all([accepted,cancelled]);expect(f.io).not.toHaveBeenCalled();expect(f.owner.operation).toBeNull()
})

for(const windows of [false,true])it(`${windows?'Windows':'Mac'}: failed atomic publication restores the prior valid installation`,async()=>{
 const root=await mkdtemp(join(tmpdir(),'voice-publish-failure-'));cleanup.push(()=>rm(root,{recursive:true,force:true}))
 const installer=windows?new WindowsVoiceInstaller(root,'/resources',()=>{}):new VoiceBaseInstaller(root,'/resources',()=>{}),owner=installer as any
 owner.status.supported=true;owner.status.installed=true
 const stage=join(root,'missing-stage'),target=windows?join(root,'target'):installer.path
 await mkdir(target);await writeFile(join(target,'asset'),'old valid bytes')
 vi.spyOn(owner,windows?'prepare':'download').mockImplementation(async(...args:unknown[])=>windows?owner.publish(stage,target,args[0]):owner.publish(stage,args[0]))
 await expect(installer.install()).rejects.toThrow();expect(await readFile(join(target,'asset'),'utf8')).toBe('old valid bytes')
 expect(installer.snapshot()).toMatchObject({installed:true,phase:'idle'});expect(owner.operation).toBeNull();expect(owner.controller).toBeNull()
})

for(const windows of [false,true])it(`${windows?'Windows':'Mac'}: a failed preparation observer cannot leave an unobserved installation`,async()=>{
 const f=fixture(windows);f.setNotify(()=>{if(f.installer.snapshot().phase==='preparing')throw Error('observer gone')})
 await expect(f.installer.install()).rejects.toThrow('observer gone');expect(f.io).not.toHaveBeenCalled();expect(f.owner.operation).toBeNull();expect(f.owner.controller).toBeNull()
})
