import {afterEach,expect,it,vi} from 'vitest'
import {ipcMain} from 'electron'
import {CHAT_SETTINGS_IPC,settingsContext} from '../electron/shared/chat-settings-contract'
const env=vi.hoisted(()=>({trusted:true}))
vi.mock('electron',()=>({ipcMain:{handle:vi.fn(),removeHandler:vi.fn()}}))
vi.mock('../electron/main/SecurityPolicy',()=>({isTrustedSender:(_e:any,w:any,role:string)=>env.trusted&&!!w&&role==='settings'}))
import {ChatSettingsIpcController} from '../electron/main/character-chat/ChatSettingsIpcController'
const closes:Array<()=>void>=[]
afterEach(()=>{closes.splice(0).forEach(fn=>fn());env.trusted=true;vi.restoreAllMocks()})
function fixture(){
 let owner:string|null='settings-1',chatListener=()=>{},voiceListener=()=>{}
 const state:any={epoch:1,character:{id:'belle',revision:'1'},conversation:{id:'c1',title:'synthetic',messages:[{text:'PRIVATE_DIALOGUE'}]},conversations:[],model:'E4B',phase:'idle',installed:[],error:null,download:null,runtimeAvailable:true,characters:[]}
 const stop=vi.fn(),settings:any={window:{isDestroyed:()=>false},currentOwner:()=>owner,send:vi.fn()}
 const chat:any={initializeSettings:vi.fn(async()=>{}),open:vi.fn(async()=>{}),manage:vi.fn(async()=>{}),service:{snapshot:()=>state,subscribe:(f:()=>void)=>{chatListener=f;return vi.fn()}},voice:{playbackReady:false,manage:vi.fn(async()=>{}),service:{snapshot:()=>({epoch:1,status:'off'}),stop},subscribeManagement:(f:()=>void)=>{voiceListener=f;return vi.fn()}}}
 const controller=new ChatSettingsIpcController(settings,chat);closes.push(()=>controller.dispose())
 const handle=vi.mocked(ipcMain.handle).mock.calls.filter(c=>c[0]===CHAT_SETTINGS_IPC.action).at(-1)![1]
 return {state,chat,settings,controller,call:(v:any)=>handle({} as any,v),context:()=>settingsContext(state),expire:()=>{owner='settings-2'},emit:()=>{chatListener();voiceListener()},stop}
}
it('settings snapshot carries management state without conversation text or audio',async()=>{
 const f=fixture();f.state.draft={key:'private',text:'PRIVATE_DRAFT',revision:1};f.state.acceptedDraft={key:'private',revision:1};const s=await f.call({type:'snapshot'});expect(s.chat.conversation).toEqual({id:'c1',title:'synthetic',messageCount:1});expect(JSON.stringify(s)).not.toContain('PRIVATE_DIALOGUE');expect(JSON.stringify(s)).not.toContain('PRIVATE_DRAFT');expect(s.chat).not.toHaveProperty('draft');expect(s.chat).not.toHaveProperty('acceptedDraft');expect(s.playbackReady).toBe(false);expect(s).not.toHaveProperty('audio')
})
it.each(['ready','read','replay','reroll','reproduce','played','scheduled','outputStopped'])('settings cannot acquire playback operation %s',async type=>{
 const f=fixture();await expect(f.call({type:'voice',action:{type},context:f.context()})).rejects.toThrow('CHAT_SETTINGS_ACTION');expect(f.chat.voice.manage).not.toHaveBeenCalled()
})
it.each(['send','character','conversation','attention','codex-mode','import-pack'])('settings rejects unexposed chat action %s',async type=>{
 const f=fixture();await expect(f.call({type:'chat',action:{type},context:f.context()})).rejects.toThrow('CHAT_SETTINGS_ACTION');expect(f.chat.manage).not.toHaveBeenCalled()
})
it('requires exact settings sender and revalidates owner after initialization',async()=>{
 const f=fixture();env.trusted=false;await expect(f.call({type:'snapshot'})).rejects.toThrow('UNTRUSTED_SENDER');env.trusted=true
 let release!:()=>void;f.chat.initializeSettings.mockImplementation(()=>new Promise<void>(r=>release=r));const pending=f.call({type:'voice',action:{type:'enabled',value:true},context:f.context()});f.expire();release();await expect(pending).rejects.toThrow('CHAT_SETTINGS_EXPIRED');expect(f.chat.voice.manage).not.toHaveBeenCalled()
})
it.each(['character','conversation'])('rejects stale %s context after asynchronous initialization',async field=>{
 const f=fixture(),context=f.context();let release!:()=>void;f.chat.initializeSettings.mockImplementation(()=>new Promise<void>(r=>release=r));const pending=f.call({type:'chat',action:{type:'memory-save',text:'synthetic'},context});f.state[field].id='other';release();await expect(pending).rejects.toThrow('CONTEXT_CHANGED');expect(f.chat.manage).not.toHaveBeenCalled()
})
it('installation cancellation bypasses the pending install request',async()=>{
 const f=fixture();let release!:()=>void;f.chat.voice.manage.mockImplementation((v:any)=>v.type==='installBase'?new Promise<void>(r=>release=r):Promise.resolve());const pending=f.call({type:'voice',action:{type:'installBase'},context:f.context()});await vi.waitFor(()=>expect(release).toBeTypeOf('function'))
 await f.call({type:'voice',action:{type:'cancelInstallBase'},context:f.context()});expect(f.chat.voice.manage.mock.calls.map((c:any)=>c[0].type)).toEqual(['installBase','cancelInstallBase']);release();await pending
})
it('closing settings does not revoke chat playback; updates are management-only',async()=>{
 const f=fixture();f.emit();expect(f.settings.send).toHaveBeenCalledWith(CHAT_SETTINGS_IPC.changed,expect.anything());f.controller.dispose();expect(f.stop).not.toHaveBeenCalled();await expect(f.call({type:'snapshot'})).rejects.toThrow('UNTRUSTED_SENDER')
})
it('dialog operations receive the initiating settings owner and live guard',async()=>{
 const f=fixture();await f.call({type:'chat',action:{type:'import-model',id:'12B'},context:f.context()});const [,owner,current]=f.chat.manage.mock.calls[0];expect(owner).toBe(f.settings.window);expect(current()).toBe(true);f.expire();expect(current()).toBe(false)
})

it('Qwen managed installation and cancel are admitted through the production settings contract',async()=>{
 const f=fixture();let release!:()=>void;f.chat.voice.manage.mockImplementation((v:any)=>v.type==='installQwen'?new Promise<void>(r=>release=r):Promise.resolve());const pending=f.call({type:'voice',action:{type:'installQwen'},context:f.context()});await vi.waitFor(()=>expect(release).toBeTypeOf('function'))
 await f.call({type:'voice',action:{type:'cancelInstallQwen'},context:f.context()});expect(f.chat.voice.manage.mock.calls.map((c:any)=>c[0].type)).toEqual(['installQwen','cancelInstallQwen']);release();await pending
})
