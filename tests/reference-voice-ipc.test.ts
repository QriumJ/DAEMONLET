import {afterEach,expect,it,vi} from 'vitest'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {dialog,ipcMain} from 'electron'
import {VoiceIpcController} from '../electron/main/character-voice/VoiceIpcController'
import {VOICE_IPC} from '../electron/shared/character-voice-contract'
vi.mock('electron',()=>({ipcMain:{handle:vi.fn(),removeHandler:vi.fn()},dialog:{showOpenDialog:vi.fn(),showMessageBox:vi.fn()}}))
vi.mock('../electron/main/SecurityPolicy',()=>({isTrustedSender:()=>true}))
const cleanup:Array<()=>Promise<unknown>>=[]
afterEach(async()=>{for(const fn of cleanup.splice(0))await fn();vi.restoreAllMocks();vi.clearAllMocks()})
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'reference-ipc-')),window:any={isDestroyed:()=>false,webContents:{isDestroyed:()=>false,send:vi.fn()}},state:any={epoch:1,character:{id:'test',revision:'1'},conversation:{id:'one'}}
 const chat:any={snapshot:()=>state,subscribeVoiceStart:()=>()=>{},subscribeVoice:()=>()=>{},subscribe:()=>()=>{}}
 const controller=new VoiceIpcController(root,'/worker',()=>window,chat);(controller.service as any).base=undefined;await controller.initialize()
 const handler=vi.mocked(ipcMain.handle).mock.calls.filter(c=>c[0]===VOICE_IPC.action).at(-1)![1]
 cleanup.push(async()=>{await controller.close();await rm(root,{recursive:true,force:true})})
 let valid=true;return{controller,window,state,expire:()=>{valid=false},manage:(action:any)=>controller.manage(action,window,()=>valid),action:(action:any)=>handler({} as any,action)}
}
it.each(['cancel','navigation','character','revision','conversation','close'])('pending OS picker is revoked on %s and never imports or binds',async boundary=>{
 const f=await fixture();let reply!:(x:any)=>void;vi.mocked(dialog.showOpenDialog).mockImplementation(()=>new Promise(r=>{reply=r}) as any)
 const imported=vi.spyOn(f.controller.service,'importReference'),bound=vi.spyOn(f.controller.service,'bind'),first=f.manage({type:'importReference',name:'Reference',acknowledged:true})
 await vi.waitFor(()=>expect(reply).toBeTypeOf('function'));await f.manage({type:'importReference',name:'Duplicate',acknowledged:true});expect(dialog.showOpenDialog).toHaveBeenCalledTimes(1)
 if(boundary==='cancel')await f.manage({type:'cancelReferenceImport'});else if(boundary==='navigation')f.expire();else if(boundary==='character')f.state.character.id='other';else if(boundary==='revision')f.state.character.revision='2';else if(boundary==='conversation')f.state.conversation.id='two';else await f.controller.close()
 reply({canceled:false,filePaths:['/private/source.wav']});await first;expect(imported).not.toHaveBeenCalled();expect(bound).not.toHaveBeenCalled()
})
it('only the OS selected path reaches service; renderer path fields are ignored and consent is required',async()=>{
 const f=await fixture();vi.mocked(dialog.showOpenDialog).mockResolvedValue({canceled:false,filePaths:['/private/os-selected.wav']});const imported=vi.spyOn(f.controller.service,'importReference').mockResolvedValue()
 await expect(f.manage({type:'importReference',name:'x',path:'/private/renderer.wav',acknowledged:false})).rejects.toThrow('VOICE_REFERENCE_NAME');expect(dialog.showOpenDialog).not.toHaveBeenCalled()
 await f.manage({type:'importReference',name:'x',path:'/private/renderer.wav',acknowledged:true});expect(imported).toHaveBeenCalledWith('/private/os-selected.wav','x',expect.any(Function))
})
it('reference deletion is confirmed with affected bindings and expires with initiating owner',async()=>{
 const f=await fixture(),key='wav-'+'a'.repeat(36)+'@'+'b'.repeat(64);(f.controller.service as any).state.profiles=[{kind:'wav-reference',id:key.split('@')[0],version:key.split('@')[1],name:'Reference'}];(f.controller.service as any).state.bindings={one:key,two:key}
 const remove=vi.spyOn(f.controller.service,'remove').mockResolvedValue();let reply!:(x:any)=>void;vi.mocked(dialog.showMessageBox).mockImplementation(()=>new Promise(r=>{reply=r}) as any)
 const pending=f.manage({type:'remove',profile:key});await vi.waitFor(()=>expect(reply).toBeTypeOf('function'));expect((vi.mocked(dialog.showMessageBox).mock.calls.at(-1) as unknown as [unknown,{detail:string}])[1].detail).toContain('2');f.expire();reply({response:1});await pending;expect(remove).not.toHaveBeenCalled()
})
