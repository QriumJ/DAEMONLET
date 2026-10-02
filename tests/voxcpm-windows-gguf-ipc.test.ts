import {afterEach,expect,it,vi} from 'vitest'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {dialog} from 'electron'
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
 const root=await mkdtemp(join(tmpdir(),'vox-gguf-ipc-')),window:any={isDestroyed:()=>false,webContents:{isDestroyed:()=>false,send:vi.fn()}},state:any={epoch:1,character:{id:'test',revision:'1'},conversation:{id:'one'}}
 const chat:any={snapshot:()=>state,subscribeVoiceStart:()=>()=>{},subscribeVoice:()=>()=>{},subscribe:()=>()=>{}}
 const controller=new VoiceIpcController(root,'/worker',()=>window,chat);(controller.service as any).base=undefined;await controller.initialize()
 const configured=vi.fn().mockResolvedValue(undefined);(controller.service as any).configureVoxGguf=configured
 const publicConfigured=vi.fn().mockResolvedValue(undefined);(controller.service as any).configureVoxPublicGguf=publicConfigured
 cleanup.push(async()=>{await controller.close();await rm(root,{recursive:true,force:true})})
 let valid=true;return{controller,window,state,configured,publicConfigured,expire:()=>{valid=false},manage:(action:any)=>controller.manage(action,window,()=>valid)}
}
const paths=['C:\\tts\\python.exe','C:\\tts\\original-model','C:\\tts\\native-release','C:\\tts\\f16-derivatives','C:\\tts\\native-approval.json']
it('Vox GGUF settings forward only five OS-selected paths and preserve the original model separately',async()=>onPlatform('win32','x64',async()=>{
 const f=await fixture();for(const path of paths)vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({canceled:false,filePaths:[path]})
 await f.manage({type:'configureVoxGguf',python:'C:\\renderer.exe',model:'C:\\renderer-model',gguf:{runtimeDir:'C:\\renderer-runtime',derivativeDir:'C:\\renderer-derivative',receipt:'C:\\renderer-receipt.json'}})
 expect(dialog.showOpenDialog).toHaveBeenCalledTimes(5)
 const pickerCalls:ReadonlyArray<readonly unknown[]>=vi.mocked(dialog.showOpenDialog).mock.calls
 for(const call of pickerCalls)expect(call).toHaveLength(2)
 expect(pickerCalls.map(call=>call[1])).toEqual([
  {title:'VoxCPM2 Windows GGUF 환경의 Python 선택',properties:['openFile']},
  {title:'고정 원본 VoxCPM2 모델 폴더 선택',properties:['openDirectory']},
  {title:'검증된 VoxCPM2 Windows EXE·DLL 폴더 선택',properties:['openDirectory']},
  {title:'변환 기록과 BaseLM·Acoustic F16 GGUF 폴더 선택',properties:['openDirectory']},
  {title:'VoxCPM2 Windows GGUF 실행 승인 기록 선택',filters:[{name:'JSON',extensions:['json']}],properties:['openFile']}
 ])
 expect(f.configured).toHaveBeenCalledWith(paths[0],paths[1],{runtimeDir:paths[2],derivativeDir:paths[3],receipt:paths[4]},expect.any(Function));expect(f.configured.mock.calls[0][3]()).toBe(true)
}))
it('public Vox WAV setup selects four paths and preserves the trained connection separately',async()=>onPlatform('win32','x64',async()=>{
 const f=await fixture(),service=f.controller.service as any
 service.state.profiles=[{id:'wav-test',version:'1',kind:'wav-reference',name:'Reference',fingerprint:'a',referenceSha256:'b',reference:{durationMs:5000,sampleRate:48000,channels:1,encoding:'pcm16',samples:240000,bytes:480044}}];service.state.bindings={test:'wav-test@1'}
 for(const path of [paths[0],paths[3],paths[2],paths[4]])vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({canceled:false,filePaths:[path]})
 await f.manage({type:'configureVoxGguf'});expect(dialog.showOpenDialog).toHaveBeenCalledTimes(4);expect(f.configured).not.toHaveBeenCalled();expect(f.publicConfigured).toHaveBeenCalledWith(paths[0],paths[3],{runtimeDir:paths[2],derivativeDir:paths[3],receipt:paths[4]},expect.any(Function))
 const calls:ReadonlyArray<readonly unknown[]>=vi.mocked(dialog.showOpenDialog).mock.calls;expect(calls[1][1]).toMatchObject({title:'공개 VoxCPM2 F16 GGUF 모델 폴더 선택'});expect(JSON.stringify(calls)).not.toContain('고정 원본 VoxCPM2')
}))
for(const step of [0,1,2,3,4])for(const boundary of ['navigation','character','revision','conversation','close'] as const)it(`Vox GGUF step ${step+1} is revoked on ${boundary}`,async()=>onPlatform('win32','x64',async()=>{
 const f=await fixture(),replies:Array<(value:any)=>void>=[];vi.mocked(dialog.showOpenDialog).mockImplementation(()=>new Promise(resolve=>replies.push(resolve)) as any)
 const pending=f.manage({type:'configureVoxGguf'})
 for(let index=0;index<step;index++){await vi.waitFor(()=>expect(replies).toHaveLength(index+1));replies[index]({canceled:false,filePaths:[paths[index]]})}
 await vi.waitFor(()=>expect(replies).toHaveLength(step+1));await f.manage({type:'configureQwenGguf'});expect(dialog.showOpenDialog).toHaveBeenCalledTimes(step+1)
 if(boundary==='navigation')f.expire();else if(boundary==='character')f.state.character.id='other';else if(boundary==='revision')f.state.character.revision='2';else if(boundary==='conversation')f.state.conversation.id='two';else await f.controller.close()
 replies[step]({canceled:false,filePaths:[paths[step]]});await pending;expect(f.configured).not.toHaveBeenCalled();expect(dialog.showOpenDialog).toHaveBeenCalledTimes(step+1)
}))
for(const step of [0,1,2,3,4])for(const result of [{canceled:true,filePaths:[]},{canceled:false,filePaths:[]},{canceled:false,filePaths:['']},{canceled:false,filePaths:['C:\\one','C:\\two']}])it(`invalid/cancelled Vox GGUF step ${step+1} releases the picker without configuring`,async()=>onPlatform('win32','x64',async()=>{
 const f=await fixture();for(let index=0;index<step;index++)vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({canceled:false,filePaths:[paths[index]]})
 vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce(result);await f.manage({type:'configureVoxGguf'});expect(f.configured).not.toHaveBeenCalled();expect(dialog.showOpenDialog).toHaveBeenCalledTimes(step+1)
 for(const path of paths)vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({canceled:false,filePaths:[path]})
 await f.manage({type:'configureVoxGguf'});expect(f.configured).toHaveBeenCalledTimes(1)
}))
it.each([['darwin','arm64'],['win32','arm64'],['linux','x64']])('%s/%s rejects Vox GGUF configuration before any picker',async(host,arch)=>onPlatform(host,arch,async()=>{
 const f=await fixture();await expect(f.manage({type:'configureVoxGguf'})).rejects.toThrow('VOX_GGUF_UNSUPPORTED');expect(dialog.showOpenDialog).not.toHaveBeenCalled();expect(f.configured).not.toHaveBeenCalled()
}))
