import {afterEach,expect,it,vi} from 'vitest'
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {EventEmitter} from 'node:events'
import {ipcMain} from 'electron'
import {VOICE_IPC} from '../electron/shared/character-voice-contract'
import {randomUUID} from 'node:crypto'
import {ConversationStore} from '../electron/main/character-chat/ConversationStore'
const environment=vi.hoisted(()=>({root:'',windows:vi.fn(),confirm:vi.fn()}))
vi.mock('electron',async()=>({app:{getPath:()=>environment.root,isPackaged:false},BrowserWindow:environment.windows,ipcMain:{handle:vi.fn(),removeHandler:vi.fn()},screen:new (await import('node:events')).EventEmitter(),dialog:{showMessageBox:environment.confirm}}))
vi.mock('../electron/main/SecurityPolicy',()=>({secureWebContents:vi.fn(),expectedRendererUrl:()=> 'pet://app/character-chat.html',isTrustedSender:()=>true}))
import {CharacterChatWindow} from '../electron/main/character-chat/CharacterChatWindow'
const roots:string[]=[]
it.each(['LLM_STOP_FAILED','CHAT_STORAGE_FAILED'])('Voice F3: %s cannot skip voice cleanup',async code=>{
 const {window}=await fixture();const destroy=vi.fn();window.window={destroy} as any
 vi.spyOn(window.service,'close').mockRejectedValue(Error(code));const close=vi.spyOn(window.voice,'close').mockResolvedValue()
 await expect(window.dispose()).rejects.toThrow();expect(close).toHaveBeenCalledTimes(1);expect(destroy).toHaveBeenCalledTimes(1)
})
it.each([false,true])('Voice F2: hide then show=%s denies late completed reply',async show=>{
 const {window}=await savedFixture();mockWindows();await window.open()
 const win=window.window as any;win.isVisible=()=>true;win.webContents.isDestroyed=()=>false
 const voice=window.voice.service as any,runtime={running:false,sessionId:'mock',retireSpeech:vi.fn(),start:vi.fn(async()=>{}),stop:vi.fn(async()=>{}),synthesize:vi.fn(async()=>({audioId:'mock',bytes:new Uint8Array(1),durationMs:1}))}
 Object.assign(runtime,{cancelSpeech:vi.fn(async()=>{await runtime.stop();return {keptWarm:false,elapsedMs:0}})})
 voice.runtime=runtime;voice.config={python:'mock',model:'mock'};voice.state.enabled=true;voice.state.profiles=[{id:'voice',version:'1'}];voice.state.bindings={gpichan:'voice@1'}
 const chat=window.service.snapshot(),message={id:'pending',role:'assistant',status:'streaming',text:'응.',binding:{characterId:'gpichan',revision:chat.character!.revision,conversationId:chat.conversation!.id,requestId:'pending',epoch:chat.epoch,modelId:'E4B'}}
 chat.conversation!.messages.push(message as any);vi.spyOn(window.service,'snapshot').mockReturnValue(chat)
 await (window.voice as any).action({type:'ready'});win.emit('show');(window.service as any).notifyVoiceStart('pending');(window.service as any).emit();win.emit('hide');if(show)win.emit('show')
 message.status='complete';(window.service as any).notifyVoice(message)
 await new Promise(r=>setTimeout(r,30));expect(runtime.start).not.toHaveBeenCalled();expect(runtime.synthesize).not.toHaveBeenCalled();await window.dispose()
})
afterEach(async()=>{vi.restoreAllMocks();environment.windows.mockReset();environment.confirm.mockReset();for(const r of roots.splice(0))await rm(r,{recursive:true,force:true})})
async function fixture(){
 environment.root=await mkdtemp(join(tmpdir(),'chat-window-lifecycle-'));roots.push(environment.root)
 await mkdir(join(environment.root,'character-chat'))
 const hooks={pet:()=>null,reveal:vi.fn(),active:vi.fn(),select:vi.fn(async()=>{}),selected:vi.fn(()=> 'gpichan')}
 const entries=['gpichan','synthetic-b'].map(id=>({id,name:id,revision:'revision-'+id,status:'ready'}))
 const registry={snapshot:()=>({entries}),get:(id:string)=>entries.find(e=>e.id===id),ensureReady:async(e:unknown)=>e,readPersonaAsset:async(e:{id:string})=>Buffer.from(JSON.stringify({schemaVersion:1,id:e.id,label:e.id,base:{source:'source.png',psd:'model.psd'},poses:[]}))}
 const window=new CharacterChatWindow('/unused',registry as any,undefined,hooks)
 vi.spyOn(window.service.runtime,'stop').mockResolvedValue();vi.spyOn(window.service.models,'cancel').mockResolvedValue()
 vi.spyOn(window.service.models,'installed').mockResolvedValue(['E4B']);vi.spyOn(window.service.runtime,'available').mockResolvedValue(true)
 return {window,root:join(environment.root,'character-chat'),registry,hooks}
}
it('F1: unopened repeated dispose shares cleanup and leaves stored chat/layout untouched',async()=>{
 const {window,root}=await fixture();for(const name of ['conversations.json','window-layout.json'])await writeFile(join(root,name),'preserve exact bytes')
 const a=window.dispose(),b=window.dispose();expect(a).toBe(b);await a
 for(const name of ['conversations.json','window-layout.json'])expect(await readFile(join(root,name),'utf8')).toBe('preserve exact bytes')
 expect(window.service.runtime.stop).toHaveBeenCalledTimes(1)
})
it('F1: dispose overlapping open waits and never creates a window after shutdown',async()=>{
 const {window,root}=await fixture();await writeFile(join(root,'window-layout.json'),'keep original')
 let release!:()=>void;const gate=new Promise<void>(r=>{release=r})
 vi.spyOn(window.service,'initialize').mockImplementation(()=>gate)
 const opened=window.open(),closed=window.dispose();release();await Promise.all([opened,closed])
 expect(environment.windows).not.toHaveBeenCalled();expect(await readFile(join(root,'window-layout.json'),'utf8')).toBe('keep original')
})

it.each([0,1])('conversation deletion uses native confirmation and honors answer %s',async response=>{
 const {window}=await fixture();const win={isDestroyed:()=>false};window.window=win as any
 const snapshot=window.service.snapshot();snapshot.character={id:'test'} as any;snapshot.conversations=[{id:'target',characterId:'test',title:'새 대화'}]
 vi.spyOn(window.service,'snapshot').mockReturnValue(snapshot)
 const remove=vi.spyOn(window.service,'deleteConversation').mockResolvedValue()
 environment.confirm.mockResolvedValue({response})
 await (window as any).action({type:'delete',id:'target'})
 expect(environment.confirm).toHaveBeenLastCalledWith(win,expect.objectContaining({buttons:['취소','삭제'],defaultId:0,cancelId:0}))
 expect(remove).toHaveBeenCalledTimes(response===1?1:0)
})
it('a closed window cannot apply a delayed deletion confirmation',async()=>{
 const {window}=await fixture();window.window={isDestroyed:()=>false} as any
 const snapshot=window.service.snapshot();snapshot.character={id:'test'} as any;snapshot.conversations=[{id:'target',characterId:'test',title:'새 대화'}]
 vi.spyOn(window.service,'snapshot').mockReturnValue(snapshot);const remove=vi.spyOn(window.service,'deleteConversation').mockResolvedValue()
 let resolve!:(v:{response:number})=>void;environment.confirm.mockImplementation(()=>new Promise(r=>{resolve=r}))
 const pending=(window as any).action({type:'delete',id:'target'});window.window=null;resolve({response:1});await pending;expect(remove).not.toHaveBeenCalled()
})

function mockWindows(){
 environment.windows.mockImplementation(function(){
  const win=new EventEmitter() as any
  let dead=false
  win.webContents=new EventEmitter();win.webContents.send=vi.fn();win.webContents.isDestroyed=()=>dead;win.isVisible=()=>true
  win.isDestroyed=()=>dead;win.show=vi.fn();win.focus=vi.fn();win.loadURL=vi.fn(async()=>{})
  win.destroy=()=>{dead=true;win.emit('closed')};win.close=win.destroy
  return win
 })
}
async function savedFixture(){
 const f=await fixture(),id=randomUUID();const data={version:2 as const,model:'E4B' as const,characterId:'gpichan',current:id,conversations:[{id,characterId:'gpichan',title:'kept',messages:[],updatedAt:new Date().toISOString()}],memories:{gpichan:[{id:randomUUID(),text:'kept memory'}]}}
 const store=new ConversationStore(f.root);await store.save(data);return {...f,store,data}
}
it('R1: transient persona failure recovers through the same window open with latest selected character',async()=>{
 const {window,registry,hooks,store}=await savedFixture();mockWindows();const before=await readFile(store.file)
 vi.spyOn(registry,'readPersonaAsset').mockRejectedValueOnce(Error('temporary persona'))
 await expect(window.open()).rejects.toThrow('temporary persona');expect(environment.windows).not.toHaveBeenCalled()
 hooks.selected.mockReturnValue('synthetic-b');registry.get('synthetic-b')!.revision='latest'
 await window.open();expect(environment.windows).toHaveBeenCalledTimes(1);expect(window.service.snapshot().character?.id).toBe('synthetic-b');expect(window.service.snapshot().character?.revision).toBe('latest');expect((await readFile(store.file)).equals(before)).toBe(true)
 await window.dispose()
})
it('R1: layout-only failure retries layout but never reloads or resets a loaded service',async()=>{
 const {window,store,data}=await savedFixture();mockWindows()
 const serviceStore=(window.service as any).store as ConversationStore,load=vi.spyOn(serviceStore,'load')
 const layout=vi.spyOn((window as any).layout,'load').mockRejectedValueOnce(Error('temporary layout'))
 await expect(window.open()).rejects.toThrow('temporary layout');expect(window.service.snapshot().memories).toEqual(data.memories.gpichan)
 await window.open();expect(layout).toHaveBeenCalledTimes(2);expect(load).toHaveBeenCalledTimes(1);expect((await store.load()).value).toEqual(data);await window.dispose()
})
it('R1: overlapping opens share preparation and create only one window',async()=>{
 const {window}=await savedFixture();mockWindows();const store=(window.service as any).store as ConversationStore,read=store.load.bind(store)
 let release!:()=>void;const gate=new Promise<void>(r=>{release=r})
 const load=vi.spyOn(store,'load').mockImplementation(async()=>{await gate;return read()});const layout=vi.spyOn((window as any).layout,'load')
 const a=window.open(),b=window.open();release();await Promise.all([a,b]);expect(load).toHaveBeenCalledTimes(1);expect(layout).toHaveBeenCalledTimes(1);expect(environment.windows).toHaveBeenCalledTimes(1);await window.dispose()
})
it('R1: failed service waits for pending layout before another attempt; dispose forbids late opens',async()=>{
 const {window,registry,store}=await savedFixture();mockWindows();const before=await readFile(store.file)
 let release!:()=>void;const gate=new Promise<void>(r=>{release=r})
 const read=vi.spyOn(registry,'readPersonaAsset').mockRejectedValueOnce(Error('temporary'))
 const layout=vi.spyOn((window as any).layout,'load').mockImplementationOnce(()=>gate)
 const a=window.open(),b=window.open();const results=Promise.allSettled([a,b]);await vi.waitFor(()=>expect(read).toHaveBeenCalledTimes(1));expect(layout).toHaveBeenCalledTimes(1)
 const disposed=window.dispose();release();await disposed;expect((await results).every(r=>r.status==='rejected')).toBe(true)
 await window.open();await expect(window.service.initialize()).rejects.toThrow('종료');expect(environment.windows).not.toHaveBeenCalled();expect((await readFile(store.file)).equals(before)).toBe(true)
})
it('R2: closing the bubble cancels an accepted queued send before runtime startup',async()=>{
 const {window}=await savedFixture();mockWindows();await window.open()
 const start=vi.spyOn(window.service.runtime,'start'),verify=vi.spyOn(window.service.models,'verify'),generate=vi.spyOn(window.service.runtime,'generate')
 const send=window.service.send('queued');window.window!.close();await send;await (window.service as any).serial
 expect(verify).not.toHaveBeenCalled();expect(start).not.toHaveBeenCalled();expect(generate).not.toHaveBeenCalled();expect(window.service.snapshot().phase).toBe('idle');await window.dispose()
})

it('Voice F2: pending initial save crosses hide/show without automatic speech',async()=>{
 const {window}=await savedFixture();mockWindows();await window.open();await (window.voice as any).action({type:'ready'})
 let release!:()=>void;const gate=new Promise<void>(r=>{release=r});const original=(window.service as any).save.bind(window.service)
 vi.spyOn(window.service as any,'save').mockImplementationOnce(async(...args:any[])=>{await gate;return original(...args)})
 const start=vi.spyOn(window.service.runtime,'start').mockResolvedValue();vi.spyOn(window.service.models,'verify').mockResolvedValue('/synthetic');vi.spyOn(window.service.runtime,'count').mockResolvedValue(1)
 vi.spyOn(window.service.runtime,'generate').mockResolvedValue({text:'응.',meaning:null} as any)
 const voice=window.voice.service as any;voice.state.enabled=true
 const read=vi.spyOn(voice,'read');const sending=window.service.send('새 질문');window.window!.emit('hide');window.window!.emit('show');release();await sending
 await vi.waitFor(()=>expect(start).toHaveBeenCalled());await (window.service as any).job
 expect(window.service.snapshot().conversation!.messages.at(-1)?.status).toBe('complete');expect(read).not.toHaveBeenCalled();await window.dispose()
})
it('Voice F3: throwing detach does not skip worker close or window destroy',async()=>{
 const {window}=await fixture();const destroy=vi.fn();window.window={destroy} as any;(window as any).detach=()=>{throw Error('destroyed')}
 const close=vi.spyOn(window.voice.service,'close').mockResolvedValue();(window.voice as any).detach.push(()=>{throw Error('detached')})
 await expect(window.dispose()).rejects.toThrow('CHAT_CLOSE_FAILED');expect(close).toHaveBeenCalledTimes(1);expect(destroy).toHaveBeenCalledTimes(1)
})

it('Voice F2: renderer readiness and replacement are main-owned',async()=>{
 const {window}=await savedFixture();mockWindows();await window.open()
 const voice=window.voice.service as any,chat=window.service.snapshot();voice.state.enabled=true
 const read=vi.spyOn(voice,'read').mockResolvedValue(undefined)
 const message={id:'unready',role:'assistant',status:'complete',text:'응.',binding:{requestId:'unready',characterId:'gpichan'}}
 ;(window.service as any).notifyVoiceStart('unready');(window.service as any).notifyVoice(message);expect(read).not.toHaveBeenCalled()
 await (window.voice as any).action({type:'ready'});message.id='old';message.binding.requestId='old';(window.service as any).notifyVoiceStart('old')
 window.window!.webContents.emit('did-start-loading');await (window.voice as any).action({type:'ready'});(window.service as any).notifyVoice(message);expect(read).not.toHaveBeenCalled()
 message.id='fresh';message.binding.requestId='fresh';(window.service as any).notifyVoiceStart('fresh');(window.service as any).notifyVoice(message);expect(read).toHaveBeenCalledTimes(1)
 expect(window.service.snapshot().conversation?.id).toBe(chat.conversation?.id);await window.dispose()
})

it('Voice F2: renderer reload rejects readiness IPC suspended in initialization',async()=>{
 const {window}=await savedFixture();mockWindows();await window.open()
 const calls=vi.mocked(ipcMain.handle).mock.calls;const handle=calls.filter(c=>c[0]===VOICE_IPC.action).at(-1)![1]
 let release!:()=>void;vi.spyOn(window.voice,'initialize').mockImplementation(()=>new Promise<void>(r=>{release=r}))
 const pending=handle({} as any,{type:'ready'});const check=expect(pending).rejects.toThrow('VOICE_OUTPUT_EXPIRED')
 window.window!.webContents.emit('did-start-loading');release();await check
 expect((window.voice.service as any).outputReady).toBe(false);await window.dispose()
})
