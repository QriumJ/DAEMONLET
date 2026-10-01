import {afterEach,expect,it,vi} from 'vitest'
import {EventEmitter} from 'node:events'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
const registered=vi.hoisted(()=>new Map<string,Function>())
vi.mock('electron',()=>({dialog:{},ipcMain:{handle:vi.fn((key,handler)=>{if(registered.has(key))throw Error('Attempted to register a second handler');registered.set(key,handler)}),removeHandler:vi.fn(key=>registered.delete(key)),on:vi.fn(),removeListener:vi.fn()}}))
vi.mock('../electron/main/SecurityPolicy',()=>({isTrustedSender:vi.fn(()=>true)}))
vi.mock('../electron/main/character-voice/VoiceBaseInstaller',()=>({VoiceBaseInstaller:class{},BASE_KEY:'voxcpm2_default@1'}))
import {ipcMain} from 'electron'
import {isTrustedSender} from '../electron/main/SecurityPolicy'
import {VoiceIpcController} from '../electron/main/character-voice/VoiceIpcController'
import {DOT_IPC} from '../electron/shared/dot-presentation'
import {VOICE_IPC} from '../electron/shared/character-voice-contract'
const clean:Array<()=>Promise<void>>=[]
afterEach(async()=>{for(const f of clean.splice(0))await f();vi.clearAllMocks();vi.mocked(isTrustedSender).mockReturnValue(true)})
async function fixture(){const root=await mkdtemp(join(tmpdir(),'dot-voice-ipc-')),chat:any={snapshot:()=>({}),subscribeVoiceStart:()=>()=>{},subscribeVoice:()=>()=>{},subscribe:()=>()=>{}},send=vi.fn(),window:any=Object.assign(new EventEmitter(),{isDestroyed:()=>false,isVisible:()=>true,webContents:Object.assign(new EventEmitter(),{isDestroyed:()=>false,send})});const controller=new VoiceIpcController(root,'/worker',()=>null,chat);(controller.service as any).base=undefined;await controller.attachPresentationWindow(window);clean.push(async()=>{await controller.close();await rm(root,{recursive:true,force:true})});const handler=(key:string)=>vi.mocked(ipcMain.handle).mock.calls.filter(c=>c[0]===key).at(-1)![1];return{controller,window,send,handler}}
it('pet cannot enable or configure voice through presentation acknowledgements',async()=>{const f=await fixture();(f.controller as any).presentationOutput=true;for(const type of ['enabled','configure','read','snapshot','installBase'])await expect(f.handler(DOT_IPC.voiceAction)({} as any,{type,value:true})).rejects.toThrow('UNTRUSTED_SENDER')})
it('rejects untrusted senders and unowned audio; volume projects no settings',async()=>{const f=await fixture();expect(()=>f.handler(DOT_IPC.audio)({} as any,'a'.repeat(36),1)).toThrow('UNTRUSTED_AUDIO');expect(await f.handler(DOT_IPC.volume)({} as any)).toBe(.8);vi.mocked(isTrustedSender).mockReturnValue(false);expect(()=>f.handler(DOT_IPC.volume)({} as any)).toThrow('UNTRUSTED_SENDER')})
it('voice notifications to pet expose only volume and its own audio events',async()=>{const f=await fixture();(f.controller as any).presentationOutput=true;(f.controller as any).send(VOICE_IPC.changed,{volume:.35,bindings:{private:'secret'},results:{private:'history'}});expect(f.send).toHaveBeenLastCalledWith(DOT_IPC.volumeChanged,.35);(f.controller as any).send(VOICE_IPC.event,{type:'stop',epoch:2});expect(f.send).toHaveBeenLastCalledWith(DOT_IPC.voiceEvent,{type:'stop',epoch:2})})
it('cancel without dot ownership never stops unrelated local speech',async()=>{const f=await fixture(),stop=vi.spyOn(f.controller.service,'stop');await f.controller.stopPresentation();expect(stop).not.toHaveBeenCalled()})

it('worker cleanup failure still revokes the pet audio output lease',async()=>{const f=await fixture();(f.controller as any).presentationOutput=true;vi.spyOn(f.controller.service,'stop').mockRejectedValueOnce(Error('worker failed'));vi.spyOn(f.controller.service,'setOutputReady').mockImplementation(()=>{});await expect(f.controller.stopPresentation()).rejects.toThrow('worker failed');expect((f.controller as any).presentationOutput).toBe(false)})

it('mouth updates require trusted current chat playback and expose only level identity',async()=>{
 const f=await fixture(),chatWindow=f.window,pet={...f.window,webContents:{...f.window.webContents,send:vi.fn()}},controller=f.controller as any
 controller.window=()=>chatWindow;controller.petWindow=()=>pet;controller.attached=chatWindow;controller.rendererReady=true;controller.chat.snapshot=()=>({character:{id:'belle',revision:'revision'}})
 controller.service.state={...controller.service.state,epoch:8,status:'playing',volume:.8};controller.localAudioEpoch=8;controller.localAudioClaims.add('claimed-audio')
 const mouth=vi.mocked(ipcMain.on).mock.calls.filter(c=>c[0]==='character-voice.mouth').at(-1)![1]
 for(const value of [{epoch:7,level:2},{epoch:8,level:3},{epoch:8,level:2,text:'private'}])mouth({} as any,value)
 expect(pet.webContents.send).not.toHaveBeenCalled()
 mouth({} as any,{epoch:8,level:2});expect(pet.webContents.send).toHaveBeenLastCalledWith('character-voice.mouth',{epoch:8,level:2,characterId:'belle',revision:'revision'})
 pet.webContents.send.mockClear();vi.mocked(isTrustedSender).mockReturnValue(false);mouth({} as any,{epoch:8,level:2});expect(pet.webContents.send).not.toHaveBeenCalled()
 vi.mocked(isTrustedSender).mockReturnValue(true);controller.presentationOutput=true;mouth({} as any,{epoch:8,level:2});expect(pet.webContents.send).not.toHaveBeenCalled()
 controller.presentationOutput=false;controller.service.state.volume=0;mouth({} as any,{epoch:8,level:2});expect(pet.webContents.send).not.toHaveBeenCalled()
 controller.window=()=>null
})

it('next sentence synthesis does not reset the mouth while previous PCM still has playback ownership',async()=>{
 const f=await fixture(),c=f.controller as any,send=vi.fn(),win=f.window
 c.window=()=>win;c.petWindow=()=>({...win,webContents:{...win.webContents,send}});c.attached=win;c.rendererReady=true;c.chat.snapshot=()=>({character:{id:'belle',revision:'one'}})
 c.localAudioEpoch=9;c.localAudioClaims.add('a'.repeat(36));c.service.state={...c.service.state,epoch:9,status:'synthesizing',volume:.8}
 c.send(VOICE_IPC.changed,c.service.state);expect(send).not.toHaveBeenCalled()
 const mouth=vi.mocked(ipcMain.on).mock.calls.filter(c=>c[0]==='character-voice.mouth').at(-1)![1]
 mouth({} as any,{epoch:9,level:2});expect(send).toHaveBeenLastCalledWith('character-voice.mouth',{epoch:9,level:2,characterId:'belle',revision:'one'})
 c.send(VOICE_IPC.event,{type:'stop',epoch:10});expect(send).toHaveBeenLastCalledWith('character-voice.mouth',null)
 send.mockClear();mouth({} as any,{epoch:9,level:2});expect(send).not.toHaveBeenCalled();c.window=()=>null
})

it('settings preparation needs current settings context but no chat playback lease',async()=>{
 const f=await fixture();vi.spyOn(f.controller,'initialize').mockResolvedValue(undefined);const prepare=vi.spyOn(f.controller.service,'prepare').mockResolvedValue(undefined),output=vi.spyOn(f.controller.service,'setOutputReady')
 await f.controller.manage({type:'prepare'},f.window,()=>true);expect(prepare).toHaveBeenCalledWith(true);expect(output).not.toHaveBeenCalled();expect((f.controller as any).presentationOutput).toBe(false)
 await expect(f.controller.manage({type:'prepare'},f.window,()=>false)).rejects.toThrow('CHAT_SETTINGS_EXPIRED');await expect(f.controller.manage({type:'test'},f.window,()=>true)).rejects.toThrow('VOICE_OUTPUT_NOT_READY')
})
it('only announced and claimed trusted current pet audio starts the presentation clock once',async()=>{
 const f=await fixture(),c=f.controller as any,started=vi.fn(),abort=new AbortController(),id='a'.repeat(36);let finish!:()=>void
 vi.spyOn(c,'presentationVoiceIssue').mockReturnValue(false);vi.spyOn(c.service,'setOutputReady').mockImplementation(()=>{});vi.spyOn(c.service,'speakPresentation').mockImplementation(()=>new Promise<void>(r=>finish=r));vi.spyOn(c.service,'audio').mockReturnValue(new Uint8Array([1]));vi.spyOn(c.service,'scheduled').mockReturnValue(true)
 c.petReady=true;c.service.state.epoch=10;c.service.state.volume=0;const task=c.speakPresentation('synthetic',abort.signal,started)
 const scheduled=(audioId=id,epoch=10,delayMs=0)=>f.handler(DOT_IPC.voiceAction)({} as any,{type:'scheduled',audioId,epoch,delayMs,gapMs:0})
 await scheduled();expect(started).not.toHaveBeenCalled()
 c.send(VOICE_IPC.event,{type:'audio',audioId:id,epoch:10});await scheduled();expect(started).not.toHaveBeenCalled()
 f.handler(DOT_IPC.audio)({} as any,id,10)
 await scheduled(id,9);await expect(scheduled(id,10,6001)).rejects.toThrow('VOICE_ACTION');expect(started).not.toHaveBeenCalled()
 vi.mocked(isTrustedSender).mockReturnValue(false);await expect(scheduled()).rejects.toThrow('UNTRUSTED_SENDER');vi.mocked(isTrustedSender).mockReturnValue(true)
 const visible=vi.spyOn(f.window,'isVisible').mockReturnValue(false);await scheduled();expect(started).not.toHaveBeenCalled();visible.mockReturnValue(true)
 c.service.state.epoch=11;await scheduled();expect(started).not.toHaveBeenCalled();c.service.state.epoch=10
 await scheduled(id,10,240);await scheduled(id,10,500);expect(started).toHaveBeenCalledExactlyOnceWith(240)
 abort.abort();await scheduled();expect(started).toHaveBeenCalledTimes(1);finish();await task
})
it('cleanup preserves preparation failure instead of reporting a successful stopped voice',async()=>{
 const f=await fixture();vi.spyOn(f.controller,'presentationVoiceIssue').mockReturnValue(false);vi.spyOn(f.controller.service,'setOutputReady').mockImplementation(()=>{});(f.controller as any).petReady=true
 vi.spyOn(f.controller.service,'speakPresentation').mockRejectedValueOnce(Error('CUDA_OOM'))
 await expect(f.controller.speakPresentation('synthetic',new AbortController().signal)).rejects.toThrow('CUDA_OOM');expect(f.controller.service.snapshot().error).toBe('CUDA_OOM');expect(f.controller.service.snapshot().status).toBe('error');expect((f.controller as any).presentationOutput).toBe(false)
})

it.each(['pet-hidden','local-chat-return'] as const)('%s revokes Dots ownership before late playback acknowledgements',async reason=>{
 const f=await fixture(),c=f.controller as any,started=vi.fn(),id='b'.repeat(36);let finish!:()=>void
 vi.spyOn(c,'presentationVoiceIssue').mockReturnValue(false);vi.spyOn(c.service,'setOutputReady').mockImplementation(()=>{});vi.spyOn(c.service,'speakPresentation').mockImplementation(()=>new Promise<void>(r=>finish=r));vi.spyOn(c.service,'audio').mockReturnValue(new Uint8Array([1]));vi.spyOn(c.service,'scheduled').mockReturnValue(true)
 c.petReady=true;c.service.state.epoch=12;const task=c.speakPresentation('synthetic',new AbortController().signal,started);c.send(VOICE_IPC.event,{type:'audio',audioId:id,epoch:12});f.handler(DOT_IPC.audio)({} as any,id,12)
 if(reason==='pet-hidden')c.presentationReady(false)
 else{c.window=()=>f.window;c.attached=f.window;c.rendererReady=true;c.updateOutput();await vi.waitFor(()=>expect(c.presentationOutput).toBe(false))}
 await expect(f.handler(DOT_IPC.voiceAction)({} as any,{type:'scheduled',audioId:id,epoch:12,delayMs:0,gapMs:0})).rejects.toThrow('UNTRUSTED_SENDER');expect(started).not.toHaveBeenCalled()
 c.window=()=>null;finish();await task
})

it('disconnect/reconnect and retry reattach without duplicate IPC registration; unattached pet has no authority',async()=>{
 const f=await fixture()
 for(let i=0;i<4;i++){await f.controller.detachPresentationWindow();expect(()=>f.handler(DOT_IPC.volume)({} as any)).toThrow('UNTRUSTED_SENDER');await f.controller.attachPresentationWindow(f.window)}
 await f.controller.attachPresentationWindow(f.window)
 for(const key of [DOT_IPC.volume,DOT_IPC.voiceAction,DOT_IPC.audio])expect(vi.mocked(ipcMain.handle).mock.calls.filter(c=>c[0]===key)).toHaveLength(1)
 expect(f.window.listenerCount('hide')).toBe(1);expect(f.window.webContents.listenerCount('did-start-loading')).toBe(1)
})
it('replacement and controller shutdown remove window listeners; old window events cannot invalidate the new owner',async()=>{
 const f=await fixture(),next:any=Object.assign(new EventEmitter(),{isDestroyed:()=>false,isVisible:()=>true,webContents:Object.assign(new EventEmitter(),{isDestroyed:()=>false,send:vi.fn()})})
 await f.controller.attachPresentationWindow(next);f.controller.presentationReady(true);f.window.emit('hide');f.window.webContents.emit('render-process-gone')
 expect((f.controller as any).petReady).toBe(true);expect(f.window.listenerCount('hide')).toBe(0);expect(f.window.webContents.listenerCount('did-start-loading')).toBe(0)
 next.emit('closed');await vi.waitFor(()=>expect((f.controller as any).petOutput).toBeNull());expect(next.listenerCount('hide')).toBe(0)
 await f.controller.close();for(const key of [DOT_IPC.volume,DOT_IPC.voiceAction,DOT_IPC.audio])expect(registered.has(key)).toBe(false)
 await expect(f.controller.attachPresentationWindow(next)).rejects.toThrow('VOICE_OUTPUT_EXPIRED')
})
it('concurrent attachment replacement keeps only the latest listeners and rejects obsolete attachment',async()=>{
 const f=await fixture(),next:any=Object.assign(new EventEmitter(),{isDestroyed:()=>false,isVisible:()=>true,webContents:Object.assign(new EventEmitter(),{isDestroyed:()=>false,send:vi.fn()})})
 await f.controller.detachPresentationWindow();const old=f.controller.attachPresentationWindow(f.window),current=f.controller.attachPresentationWindow(next)
 await expect(old).rejects.toThrow('VOICE_OUTPUT_EXPIRED');await current;expect(f.window.listenerCount('hide')).toBe(0);expect(next.listenerCount('hide')).toBe(1)
})
