import {afterEach,expect,it,vi} from 'vitest'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {dialog,ipcMain} from 'electron'
import {VoiceIpcController} from '../electron/main/character-voice/VoiceIpcController'
vi.mock('electron',()=>({ipcMain:{handle:vi.fn(),removeHandler:vi.fn(),on:vi.fn(),removeListener:vi.fn()},dialog:{showOpenDialog:vi.fn(),showMessageBox:vi.fn()}}))
vi.mock('../electron/main/SecurityPolicy',()=>({isTrustedSender:()=>true}))
const cleanup:Array<()=>Promise<unknown>>=[]
afterEach(async()=>{for(const fn of cleanup.splice(0))await fn();vi.restoreAllMocks();vi.clearAllMocks()})
async function onPlatform(host:string,arch:string,run:()=>Promise<void>){
 const platform=Object.getOwnPropertyDescriptor(process,'platform')!,architecture=Object.getOwnPropertyDescriptor(process,'arch')!
 try{Object.defineProperty(process,'platform',{value:host,configurable:true});Object.defineProperty(process,'arch',{value:arch,configurable:true});await run()}
 finally{Object.defineProperty(process,'platform',platform);Object.defineProperty(process,'arch',architecture)}
}
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'qwen-gguf-ipc-')),window:any={isDestroyed:()=>false,webContents:{isDestroyed:()=>false,send:vi.fn()}},state:any={epoch:1,character:{id:'test',revision:'1'},conversation:{id:'one'}}
 const chat:any={snapshot:()=>state,subscribeVoiceStart:()=>()=>{},subscribeVoice:()=>()=>{},subscribe:()=>()=>{}}
 const controller=new VoiceIpcController(root,'/worker',()=>window,chat);(controller.service as any).base=undefined;await controller.initialize()
 const configured=vi.fn().mockResolvedValue(undefined);(controller.service as any).configureQwenGguf=configured
 cleanup.push(async()=>{await controller.close();await rm(root,{recursive:true,force:true})})
 let valid=true;return{controller,window,state,configured,expire:()=>{valid=false},manage:(action:any)=>controller.manage(action,window,()=>valid)}
}
const paths=['C:\\tts\\python.exe','C:\\tts\\cuda-dlls','C:\\tts\\base-q8-models']
it('GGUF settings use only OS-selected paths and distinct Python, DLL and Base model steps',async()=>onPlatform('win32','x64',async()=>{
 const f=await fixture();for(const path of paths)vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({canceled:false,filePaths:[path]})
 await f.manage({type:'configureQwenGguf',python:'C:\\renderer.exe',model:'C:\\renderer-model',ggufRuntime:'C:\\renderer-dll'})
 expect(dialog.showOpenDialog).toHaveBeenCalledTimes(3)
 // Electron exposes a one-argument overload too; validate the actual owned-window calls.
 const pickerCalls:ReadonlyArray<readonly unknown[]>=vi.mocked(dialog.showOpenDialog).mock.calls
 for(const call of pickerCalls)expect(call).toHaveLength(2)
 expect(pickerCalls.map(call=>call[1])).toEqual([
  {title:'Qwen GGUF 환경의 Python 선택',properties:['openFile']},
  {title:'검증된 Qwen GGUF CUDA DLL 폴더 선택',properties:['openDirectory']},
  {title:'Qwen 0.6B Base Q8·codec Q8 모델 폴더 선택',properties:['openDirectory']}
 ])
 expect(f.configured).toHaveBeenCalledWith(paths[0],paths[2],paths[1],expect.any(Function));expect(f.configured.mock.calls[0][3]()).toBe(true)
}))
it('Qwen Vulkan configuration identifies its backend-specific DLL folder',async()=>onPlatform('win32','x64',async()=>{
 const f=await fixture(),snapshot=f.controller.service.snapshot();vi.spyOn(f.controller.service,'snapshot').mockReturnValue({...snapshot,executionProfile:'qwen-gguf-vulkan'})
 for(const path of paths)vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({canceled:false,filePaths:[path]});await f.manage({type:'configureQwenGguf'})
 const calls:ReadonlyArray<readonly unknown[]>=vi.mocked(dialog.showOpenDialog).mock.calls;expect(calls[1][1]).toMatchObject({title:'검증된 Qwen GGUF Vulkan DLL 폴더 선택'});expect(f.configured).toHaveBeenCalledWith(paths[0],paths[2],paths[1],expect.any(Function))
}))
for(const step of [0,1,2])for(const boundary of ['navigation','character','revision','conversation','close'] as const)it(`GGUF step ${step+1} is revoked on ${boundary}`,async()=>onPlatform('win32','x64',async()=>{
 const f=await fixture(),replies:Array<(value:any)=>void>=[]
 vi.mocked(dialog.showOpenDialog).mockImplementation(()=>new Promise(resolve=>replies.push(resolve)) as any)
 const pending=f.manage({type:'configureQwenGguf'})
 for(let index=0;index<step;index++){await vi.waitFor(()=>expect(replies).toHaveLength(index+1));replies[index]({canceled:false,filePaths:[paths[index]]})}
 await vi.waitFor(()=>expect(replies).toHaveLength(step+1))
 await f.manage({type:'configureQwenGguf'});expect(dialog.showOpenDialog).toHaveBeenCalledTimes(step+1)
 if(boundary==='navigation')f.expire();else if(boundary==='character')f.state.character.id='other';else if(boundary==='revision')f.state.character.revision='2';else if(boundary==='conversation')f.state.conversation.id='two';else await f.controller.close()
 replies[step]({canceled:false,filePaths:[paths[step]]});await pending
 expect(f.configured).not.toHaveBeenCalled();expect(dialog.showOpenDialog).toHaveBeenCalledTimes(step+1)
}))
for(const step of [0,1,2])for(const result of [{canceled:true,filePaths:[]},{canceled:false,filePaths:[]},{canceled:false,filePaths:['']},{canceled:false,filePaths:['C:\\one','C:\\two']}])it(`invalid/cancelled GGUF selection at step ${step+1} never configures and releases picker lock`,async()=>onPlatform('win32','x64',async()=>{
 const f=await fixture()
 for(let index=0;index<step;index++)vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({canceled:false,filePaths:[paths[index]]})
 vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce(result);await f.manage({type:'configureQwenGguf'})
 expect(f.configured).not.toHaveBeenCalled();expect(dialog.showOpenDialog).toHaveBeenCalledTimes(step+1)
 for(const path of paths)vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({canceled:false,filePaths:[path]})
 await f.manage({type:'configureQwenGguf'});expect(f.configured).toHaveBeenCalledTimes(1)
}))
it.each([['darwin','arm64'],['win32','arm64'],['linux','x64']])('%s/%s rejects GGUF configuration before opening any picker',async(host,arch)=>onPlatform(host,arch,async()=>{
 const f=await fixture();await expect(f.manage({type:'configureQwenGguf'})).rejects.toThrow('QWEN_GGUF_UNSUPPORTED');expect(dialog.showOpenDialog).not.toHaveBeenCalled();expect(f.configured).not.toHaveBeenCalled()
}))
