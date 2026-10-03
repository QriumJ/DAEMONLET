import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {mkdtemp,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {CharacterVoiceService} from '../electron/main/character-voice/CharacterVoiceService'
import type {QwenInstallation,QwenConnection} from '../electron/main/character-voice/QwenVoiceInstaller'
import type {QwenInstallState,ReferenceVoiceProfile} from '../electron/shared/character-voice-contract'
const clean:Array<()=>Promise<unknown>>=[]
const hostPlatform=Object.getOwnPropertyDescriptor(process,'platform')!
beforeEach(()=>Object.defineProperty(process,'platform',{...hostPlatform,value:'win32'}))
afterEach(async()=>{try{for(const fn of clean.splice(0))await fn()}finally{Object.defineProperty(process,'platform',hostPlatform);vi.restoreAllMocks()}})
function gate<T>(){let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve}}
const reference:ReferenceVoiceProfile={kind:'wav-reference',id:'wav-owned',version:'1',name:'Authorized WAV',fingerprint:'a'.repeat(64),referenceSha256:'b'.repeat(64),reference:{durationMs:4000,sampleRate:24000,channels:1,encoding:'pcm16',samples:96000,bytes:192044}}
async function fixture(ref=true){
 const root=await mkdtemp(join(tmpdir(),'qwen-apply-')),pending=gate<QwenConnection|null>(),runtime=vi.fn(),events:any[]=[],states:any[]=[]
 const installState:QwenInstallState={supported:true,installed:false,repairNeeded:false,phase:'idle',bytes:0,total:100,error:null,model:'test/model',modelBytes:90,runtimeBytes:10,minimumFreeBytes:1000,communityConversion:true,license:'Apache-2.0'}
 const installer:QwenInstallation={snapshot:()=>({...installState}),initialize:vi.fn(async()=>{}),install:vi.fn(()=>{installState.phase='downloading';return pending.promise.then(c=>{installState.phase='idle';installState.installed=!!c;return c})}),cancel:vi.fn(async()=>pending.resolve(null)),applying:vi.fn(value=>installState.phase=value?'applying':'idle')}
 const store={initialize:async()=>{},list:()=>ref?[reference]:[],close:async()=>{}} as any
 const chat={character:{id:'character'},epoch:1} as any
 const service=new CharacterVoiceService(root,'/worker',()=>chat,s=>states.push(s),e=>events.push(e),runtime,undefined,undefined,undefined,store)
 service.attachQwenInstaller(installer);await service.initialize();await service.engine('voxcpm2')
 const owner=service as any;owner.state.enabled=true;owner.state.autoRead=true;owner.state.volume=.25;owner.config={python:'/existing-vox/python',model:'/existing-vox/model'};if(ref)owner.state.bindings.character='wav-owned@1'
 await service.volume(.25);const before=await readFile(join(root,'settings.json'),'utf8')
 clean.push(async()=>{pending.resolve(null);await service.close();await rm(root,{recursive:true,force:true})})
 return {root,service,owner,pending,runtime,events,states,installer,before,installState}
}
it('download-and-apply commits runtime/engine once, preserves authorized reference and Vox config, never prepares or speaks',async()=>{
 const f=await fixture(),prepare=vi.spyOn(f.service,'prepare');const a=f.service.installQwen(),b=f.service.installQwen();expect(a).toBe(b)
 await vi.waitFor(()=>expect(f.installer.install).toHaveBeenCalledTimes(1));f.pending.resolve({python:'/managed/env/bin/python',model:'/managed/model'});await a
 const saved=JSON.parse(await readFile(join(f.root,'settings.json'),'utf8'))
 expect(saved).toMatchObject({engine:'qwen3-tts-06b',qwenRuntime:{python:'/managed/env/bin/python',model:'/managed/model'},runtime:{python:'/existing-vox/python',model:'/existing-vox/model'},enabled:true,autoRead:true,volume:.25,bindings:{character:'wav-owned@1'}})
 expect(prepare).not.toHaveBeenCalled();expect(f.runtime).not.toHaveBeenCalled();expect(f.events.filter(e=>e.type==='audio')).toEqual([])
})
it('missing WAV remains setup-needed without auto-selecting another speaker',async()=>{
 const f=await fixture(false),job=f.service.installQwen();await vi.waitFor(()=>expect(f.installer.install).toHaveBeenCalled());f.pending.resolve({python:'/managed/python',model:'/managed/model'});await job
 expect(f.service.snapshot()).toMatchObject({engine:'qwen3-tts-06b',error:'QWEN_REFERENCE_REQUIRED',bindings:{}});expect(f.runtime).not.toHaveBeenCalled()
})
it('cancellation preserves the exact existing settings, and admission cancellation cannot start installation later',async()=>{
 const f=await fixture(),job=f.service.installQwen();await f.service.cancelInstallQwen();await job
 expect(f.installer.install).not.toHaveBeenCalled();expect(await readFile(join(f.root,'settings.json'),'utf8')).toBe(f.before)
})
it('download failure preserves settings/runtime/reference and never applies',async()=>{
 const f=await fixture();vi.mocked(f.installer.install).mockRejectedValueOnce(Error('VOICE_DOWNLOAD_FAILED'))
 await expect(f.service.installQwen()).rejects.toThrow('VOICE_DOWNLOAD_FAILED');expect(await readFile(join(f.root,'settings.json'),'utf8')).toBe(f.before);expect(f.service.snapshot().engine).toBe('voxcpm2')
})
it('an engine change during download prevents late overwrite even when changed back',async()=>{
 const f=await fixture(),job=f.service.installQwen();await vi.waitFor(()=>expect(f.installer.install).toHaveBeenCalled())
 await f.service.engine('qwen3-tts-06b');await f.service.engine('voxcpm2');const latest=await readFile(join(f.root,'settings.json'),'utf8')
 f.pending.resolve({python:'/managed/python',model:'/managed/model'});await job
 expect(await readFile(join(f.root,'settings.json'),'utf8')).toBe(latest);expect(f.service.snapshot()).toMatchObject({engine:'voxcpm2',qwenInstall:{installed:true,applicationDeferred:true}})
})
it('closed/back/stale settings owner finishes installation but defers registration until explicit apply',async()=>{
 const f=await fixture();let current=true;const job=f.service.installQwen(()=>current);await vi.waitFor(()=>expect(f.installer.install).toHaveBeenCalled());current=false
 f.pending.resolve({python:'/managed/python',model:'/managed/model'});await job
 expect(await readFile(join(f.root,'settings.json'),'utf8')).toBe(f.before);expect(f.service.snapshot().qwenInstall?.applicationDeferred).toBe(true)
 vi.mocked(f.installer.install).mockResolvedValue({python:'/managed/python',model:'/managed/model'});await f.service.installQwen();expect(f.service.snapshot().engine).toBe('qwen3-tts-06b')
})
it('shutdown cancels the owned installer and cannot register a completed obsolete task',async()=>{
 const f=await fixture(),job=f.service.installQwen();await vi.waitFor(()=>expect(f.installer.install).toHaveBeenCalled());await f.service.close();await job
 expect(f.installer.cancel).toHaveBeenCalled();expect(await readFile(join(f.root,'settings.json'),'utf8')).toBe(f.before)
})
it('unsupported Linux rejects installation without changing settings or starting the installer',async()=>{
 const f=await fixture();Object.defineProperty(process,'platform',{...hostPlatform,value:'linux'})
 await expect(f.service.installQwen()).rejects.toThrow('QWEN_INSTALL_UNSUPPORTED')
 expect(f.installer.install).not.toHaveBeenCalled();expect(await readFile(join(f.root,'settings.json'),'utf8')).toBe(f.before)
})
