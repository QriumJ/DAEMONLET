import {afterEach,expect,it,vi} from 'vitest'
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {CharacterVoiceService} from '../electron/main/character-voice/CharacterVoiceService'
import {checkWindowsModel} from '../electron/main/character-voice/WindowsModelCheck'
vi.mock('../electron/main/character-voice/WindowsModelCheck',()=>({checkWindowsModel:vi.fn(async()=>{})}))
const original=process.platform,roots:string[]=[],services:CharacterVoiceService[]=[]
afterEach(async()=>{for(const s of services.splice(0))await s.close();Object.defineProperty(process,'platform',{value:original});for(const r of roots.splice(0))await rm(r,{recursive:true,force:true});vi.clearAllMocks()})
async function fixture(saved?:'installed'){
 const root=await mkdtemp(join(tmpdir(),'voice-light-policy-'));roots.push(root);Object.defineProperty(process,'platform',{value:'win32'})
 if(saved)await writeFile(join(root,'settings.json'),JSON.stringify({version:1,engine:'voxcpm2',enabled:false,autoRead:false,volume:0,bindings:{},executionProfile:'compiled',modelVerification:saved}))
 const base={native:false,profile:{id:'voxcpm2_default',version:'base',name:'Default',fingerprint:'base',adapterSha256:'none'},executable:'/python',path:'/model',snapshot:()=>({supported:true,installed:true}),initialize:async()=>{},identity:async()=> 'stable',ready:vi.fn(async()=>'/model'),cancelVerification:async()=>{},cancel:async()=>{}}
 const runtime={config:{python:'/python',model:'/model',windowsBase:true},sessionId:'session',running:false,get ready(){return this.running},start:vi.fn(async()=>{runtime.running=true}),stop:vi.fn(async()=>{runtime.running=false}),retireSpeech:vi.fn()}
 const service=new CharacterVoiceService(root,'/worker.py',()=>({character:{id:'test'}}) as any,()=>{},()=>{},()=>runtime as any,()=>{},base as any);services.push(service);await service.initialize()
 return{root,service,runtime,base}
}
it('old settings remain full; explicit lightweight policy persists and reaches managed preparation',async()=>{
 const f=await fixture();expect(f.service.snapshot().modelVerification).toBe('full')
 await f.service.modelVerificationPolicy('installed');expect(JSON.parse(await readFile(join(f.root,'settings.json'),'utf8')).modelVerification).toBe('installed')
 await f.service.enabled(true);f.service.setOutputReady(true);await f.service.prepare();expect(f.base.ready).toHaveBeenCalledWith('installed')
 const reopened=await fixture('installed');expect(reopened.service.snapshot().modelVerification).toBe('installed')
})
it('failed explicit full check blocks the same model until a successful full check',async()=>{
 const f=await fixture();await f.service.enabled(true)
 vi.mocked(checkWindowsModel).mockRejectedValueOnce(Error('private error'))
 await f.service.checkModel();expect(f.service.snapshot().modelCheck?.error).toBe('VOICE_MODEL_CHECK_FAILED')
 f.service.setOutputReady(true);await f.service.prepare();expect(f.runtime.start).not.toHaveBeenCalled()
 await f.service.checkModel();await f.service.prepare();expect(f.runtime.start).toHaveBeenCalledOnce();expect(f.service.snapshot().modelCheck?.error).toBeNull()
})
it('immediate cancellation prevents queued verification from spawning',async()=>{
 const f=await fixture(),pending=f.service.checkModel();await f.service.cancelModelCheck();await pending
 expect(checkWindowsModel).not.toHaveBeenCalled();expect(f.service.snapshot().modelCheck?.busy).not.toBe(true)
})
