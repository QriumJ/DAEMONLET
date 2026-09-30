import {afterEach,expect,it,vi} from 'vitest'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
vi.mock('electron',()=>({dialog:{},ipcMain:{handle:vi.fn(),removeHandler:vi.fn(),on:vi.fn(),removeListener:vi.fn()}}))
vi.mock('../electron/main/SecurityPolicy',()=>({isTrustedSender:vi.fn(()=>true)}))
vi.mock('../electron/main/character-voice/VoiceBaseInstaller',()=>({VoiceBaseInstaller:class{},BASE_KEY:'voxcpm2_default@1'}))
import {ipcMain} from 'electron'
import {isTrustedSender} from '../electron/main/SecurityPolicy'
import {VoiceIpcController} from '../electron/main/character-voice/VoiceIpcController'
import {DOT_IPC} from '../electron/shared/dot-presentation'
import {VOICE_IPC} from '../electron/shared/character-voice-contract'
const clean:Array<()=>Promise<void>>=[]
afterEach(async()=>{for(const f of clean.splice(0))await f();vi.clearAllMocks();vi.mocked(isTrustedSender).mockReturnValue(true)})
async function fixture(){const root=await mkdtemp(join(tmpdir(),'dot-voice-ipc-')),chat:any={snapshot:()=>({}),subscribeVoiceStart:()=>()=>{},subscribeVoice:()=>()=>{},subscribe:()=>()=>{}},send=vi.fn(),window:any={on:vi.fn(),isDestroyed:()=>false,isVisible:()=>true,webContents:{on:vi.fn(),isDestroyed:()=>false,send}};const controller=new VoiceIpcController(root,'/worker',()=>null,chat);(controller.service as any).base=undefined;controller.attachPresentationWindow(window);clean.push(async()=>{await controller.close();await rm(root,{recursive:true,force:true})});const handler=(key:string)=>vi.mocked(ipcMain.handle).mock.calls.filter(c=>c[0]===key).at(-1)![1];return{controller,window,send,handler}}
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
