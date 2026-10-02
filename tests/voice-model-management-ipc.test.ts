import {afterEach,expect,it,vi} from 'vitest'
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {dialog} from 'electron'
import {VoiceIpcController} from '../electron/main/character-voice/VoiceIpcController'
import type {ManagedVoiceModelRemoval} from '../electron/shared/character-voice-contract'
import runtimePolicy from '../electron/voice/runtime-qwen-gguf-windows.json'
vi.mock('electron',()=>({ipcMain:{handle:vi.fn(),removeHandler:vi.fn(),on:vi.fn(),removeListener:vi.fn()},dialog:{showOpenDialog:vi.fn(),showMessageBox:vi.fn()}}))
vi.mock('../electron/main/SecurityPolicy',()=>({isTrustedSender:()=>true}))
const cleanup:Array<()=>Promise<unknown>>=[]
afterEach(async()=>{for(const fn of cleanup.splice(0))await fn();vi.restoreAllMocks();vi.clearAllMocks();vi.unstubAllGlobals()})
const plan:ManagedVoiceModelRemoval={id:'qwen3-tts-06b-gguf',engine:'qwen3-tts-06b-gguf',modelId:'Serveurperso/Qwen3-TTS-GGUF',revision:'pinned-revision',planId:'main-fresh-plan',totalBytes:1234,directories:[{path:'/sample/app-managed/model',bytes:1000,files:[]},{path:'/sample/app-managed/download',bytes:234,files:[]}]}
async function fixture(options:{catalog?:'valid'|'modified'}={}){
 const root=await mkdtemp(join(tmpdir(),'voice-model-ipc-')),window:any={isDestroyed:()=>false,webContents:{isDestroyed:()=>false,send:vi.fn()}},state:any={epoch:1,character:{id:'test',revision:'1'},conversation:{id:'one'}}
 let worker='/worker'
 const previousReceipt=join(root,'gguf-runtimes','previous-catalog','active.json')
 if(options.catalog){
  const bridge=join(root,'bridge');await mkdir(bridge,{recursive:true});worker=join(bridge,'worker.py')
  const bytes=await readFile(new URL('../electron/voice/managed-gguf-runtime-catalog.json',import.meta.url))
  await writeFile(join(bridge,runtimePolicy.managedRuntimeCatalog.filename),options.catalog==='valid'?bytes:Buffer.concat([bytes,Buffer.from('\n')]))
  await mkdir(join(root,'gguf-runtimes','previous-catalog'),{recursive:true});await writeFile(previousReceipt,'old owned fixture; preserve')
 }
 const chat:any={snapshot:()=>state,subscribeVoiceStart:()=>()=>{},subscribeVoice:()=>()=>{},subscribe:()=>()=>{}}
 const controller=new VoiceIpcController(root,worker,()=>window,chat);(controller.service as any).base=undefined;await controller.initialize()
 const service=controller.service as any,inspect=service.inspectManagedModelRemoval=vi.fn().mockResolvedValue(plan),remove=service.removeManagedModel=vi.fn().mockResolvedValue(undefined),install=service.installGgufModel=vi.fn().mockResolvedValue(undefined),verify=service.verifyGgufModel=vi.fn().mockResolvedValue(undefined),runtimeSetup=service.setupGgufRuntime=vi.fn().mockResolvedValue(undefined),runtimeCancel=service.cancelInstallGgufRuntime=vi.fn().mockResolvedValue(undefined)
 cleanup.push(async()=>{await controller.close();await rm(root,{recursive:true,force:true})});let valid=true
 return{root,previousReceipt,controller,state,inspect,remove,install,verify,runtimeSetup,runtimeCancel,expire:()=>{valid=false},manage:(action:any)=>controller.manage(action,window,()=>valid)}
}
it('model removal is confirmed with current main-owned paths, model, revision and exact bytes',async()=>{
 const f=await fixture();vi.mocked(dialog.showMessageBox).mockResolvedValue({response:1,checkboxChecked:false})
 await f.manage({type:'removeManagedModel',id:plan.id,path:'/renderer/injected',planId:'renderer-stale-plan'})
 const calls:ReadonlyArray<readonly unknown[]>=vi.mocked(dialog.showMessageBox).mock.calls,options=calls[0][1] as Electron.MessageBoxOptions
 expect(options.defaultId).toBe(0);expect(options.cancelId).toBe(0);expect(options.detail).toContain(plan.modelId);expect(options.detail).toContain(plan.revision);expect(options.detail).toContain('1,234 bytes');for(const directory of plan.directories)expect(options.detail).toContain(directory.path)
 expect(options.detail).toContain('학습팩, 기준 WAV와 외부 모델은 보존');expect(options.detail).not.toContain('/renderer/injected');expect(f.remove).toHaveBeenCalledWith(plan.id,plan.planId,expect.any(Function))
})
it.each(['cancel','navigation','character','revision','conversation','close'] as const)('pending model removal is revoked on %s',async boundary=>{
 const f=await fixture();let reply!:(value:any)=>void;vi.mocked(dialog.showMessageBox).mockImplementation(()=>new Promise(resolve=>reply=resolve) as any)
 const pending=f.manage({type:'removeManagedModel',id:plan.id});await vi.waitFor(()=>expect(reply).toBeTypeOf('function'))
 if(boundary==='navigation')f.expire();else if(boundary==='character')f.state.character.id='other';else if(boundary==='revision')f.state.character.revision='2';else if(boundary==='conversation')f.state.conversation.id='two';else if(boundary==='close')await f.controller.close()
 reply({response:boundary==='cancel'?0:1});await pending;expect(f.remove).not.toHaveBeenCalled()
})
it('expiring during fresh inspection never opens a confirmation dialog',async()=>{
 const f=await fixture();let reply!:(value:any)=>void;f.inspect.mockImplementation(()=>new Promise(resolve=>reply=resolve));const pending=f.manage({type:'removeManagedModel',id:plan.id});await vi.waitFor(()=>expect(reply).toBeTypeOf('function'));f.expire();reply(plan);await pending;expect(dialog.showMessageBox).not.toHaveBeenCalled();expect(f.remove).not.toHaveBeenCalled()
})
it.each(['installGgufModel','verifyGgufModel'] as const)('%s forwards only the pinned catalog ID and current context',async type=>{
 const f=await fixture();await f.manage({type,id:plan.id,path:'/renderer/model',url:'https://renderer.invalid/model'});expect(type==='installGgufModel'?f.install:f.verify).toHaveBeenCalledWith(plan.id,expect.any(Function));await expect(f.manage({type,id:'external-private-model'})).rejects.toThrow('VOICE_ACTION')
})
it('arbitrary model deletion IDs are rejected before inspection',async()=>{
 const f=await fixture();await expect(f.manage({type:'removeManagedModel',id:'/external/model'})).rejects.toThrow('VOICE_ACTION');expect(f.inspect).not.toHaveBeenCalled();expect(f.remove).not.toHaveBeenCalled()
})
it.each([['installGgufRuntime','install'],['repairGgufRuntime','repair'],['verifyGgufRuntime','verify']] as const)('%s forwards only the selected runtime ID and revocable main context',async(type,mode)=>{
 const f=await fixture();await f.manage({type,id:'qwen-cuda',python:'/renderer/python',runtimeDir:'/renderer/native',url:'https://renderer.invalid/archive'})
 expect(f.runtimeSetup).toHaveBeenCalledWith('qwen-cuda',mode,expect.any(Function));const current=f.runtimeSetup.mock.calls[0][2] as ()=>boolean;expect(current()).toBe(true);f.expire();expect(current()).toBe(false)
 const invalid=await fixture();await expect(invalid.manage({type,id:'renderer-native'})).rejects.toThrow('VOICE_ACTION');expect(invalid.runtimeSetup).not.toHaveBeenCalled()
})
it('runtime cancellation crosses IPC while ordinary runtime setup remains pending',async()=>{
 const f=await fixture();let done!:()=>void;f.runtimeSetup.mockImplementation(()=>new Promise<void>(resolve=>done=resolve))
 const pending=f.manage({type:'installGgufRuntime',id:'vox-vulkan'});await vi.waitFor(()=>expect(done).toBeTypeOf('function'))
 await f.manage({type:'cancelInstallGgufRuntime'});expect(f.runtimeCancel).toHaveBeenCalledOnce();done();await pending
})
it('keeps the current pinned runtime catalog in a separate owned root and preserves older catalog receipts',async()=>{
 vi.stubGlobal('process',{...process,platform:'win32',arch:'x64'})
 const f=await fixture({catalog:'valid'}),installer=(f.controller.service as any).ggufRuntimeInstaller
 expect(installer.root).toBe(join(f.root,'rt',runtimePolicy.managedRuntimeCatalog.sha256.slice(0,16)));expect(await readFile(f.previousReceipt,'utf8')).toBe('old owned fixture; preserve')
 const states=f.controller.service.snapshot().ggufRuntimeInstall;expect(states).toHaveLength(4);expect(states?.every(s=>!s.available&&!s.installed&&s.blockedReason==='GGUF_RUNTIME_ARTIFACT_PENDING')).toBe(true)
})
it('rejects a changed bundled catalog before creating or enabling its installer',async()=>{
 vi.stubGlobal('process',{...process,platform:'win32',arch:'x64'})
 const f=await fixture({catalog:'modified'});expect((f.controller.service as any).ggufRuntimeInstaller).toBeUndefined();expect(f.controller.service.snapshot().ggufRuntimeSetup).toMatchObject({busy:false,error:'GGUF_RUNTIME_CHANGED'});expect(await readFile(f.previousReceipt,'utf8')).toBe('old owned fixture; preserve')
})
