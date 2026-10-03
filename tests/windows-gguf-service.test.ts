import {afterEach,beforeEach,describe,expect,it,vi,type Mock} from 'vitest'
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {CharacterVoiceService} from '../electron/main/character-voice/CharacterVoiceService'
import {BASE_VOICE} from '../electron/main/character-voice/VoiceBaseInstaller'
import {checkWindowsModel} from '../electron/main/character-voice/WindowsModelCheck'
import type {TtsConfig} from '../electron/main/character-voice/TtsRuntimeSupervisor'
import type {ManagedVoiceModelRemoval,ReferenceVoiceProfile,VoiceSnapshot} from '../electron/shared/character-voice-contract'
import {GGUF_MODEL_CATALOG,type GgufModelId,type GgufModelInstallState} from '../electron/shared/windows-gguf-model-catalog'

vi.mock('../electron/main/character-voice/WindowsModelCheck',()=>({checkWindowsModel:vi.fn(async()=>{})}))

const platform=Object.getOwnPropertyDescriptor(process,'platform')!,arch=Object.getOwnPropertyDescriptor(process,'arch')!
const services:CharacterVoiceService[]=[],roots:string[]=[],release:Array<()=>void>=[]
const reference:ReferenceVoiceProfile={kind:'wav-reference',id:'wav-owned',version:'1',name:'Authorized fixture WAV',fingerprint:'a'.repeat(64),referenceSha256:'b'.repeat(64),reference:{durationMs:4000,sampleRate:24000,channels:1,encoding:'pcm16',samples:96000,bytes:192044}}
const trained={id:'trained-fixture',version:'1',name:'Fixture LoRA',fingerprint:'c'.repeat(64),adapterSha256:'d'.repeat(64)}
const referenceKey='wav-owned@1',trainedKey='trained-fixture@1'
const turn=()=>new Promise<void>(resolve=>setImmediate(resolve))
type FixtureRuntime={config:TtsConfig;sessionId:string;running:boolean;busy:boolean;audit:{warmed:boolean};readonly ready:boolean;start:Mock<(_package:string,_identity:string,_conditioning?:unknown)=>Promise<void>>;prewarm:Mock<()=>Promise<void>>;stop:Mock<()=>Promise<void>>;retireSpeech:Mock<()=>void>;cancelSpeech:Mock<()=>Promise<{}>>}
function gate(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r});release.push(resolve);return {promise,resolve}}
beforeEach(()=>{Object.defineProperty(process,'platform',{...platform,value:'win32'});Object.defineProperty(process,'arch',{...arch,value:'x64'});vi.mocked(checkWindowsModel).mockReset().mockResolvedValue()})
afterEach(async()=>{release.splice(0).forEach(fn=>fn());await Promise.allSettled(services.splice(0).map(service=>service.close()));for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});Object.defineProperty(process,'platform',platform);Object.defineProperty(process,'arch',arch);vi.restoreAllMocks()})

async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'windows-gguf-service-'));roots.push(root)
 await writeFile(join(root,'settings.json'),JSON.stringify({version:1,engine:'voxcpm2',enabled:false,autoRead:true,volume:.8,bindings:{},executionProfile:'baseline',baseExecutionProfile:'cuda-compiled'}))
 const paths={worker:join(root,'bridge','worker.py'),python:join(root,'env','Scripts','python.exe'),original:join(root,'models','original'),publicModel:join(root,'models','public'),trainedModel:join(root,'models','trained'),cuda:join(root,'native-cuda'),vulkan:join(root,'native-vulkan'),receipt:join(root,'native-cuda','approval.json')}
 for(const path of [join(root,'bridge'),join(root,'env','Scripts'),join(root,'env','Lib','site-packages'),paths.original,paths.publicModel,paths.trainedModel,paths.cuda,paths.vulkan])await mkdir(path,{recursive:true})
 await Promise.all([writeFile(paths.worker,'# Never executed'),writeFile(paths.python,'fixture only'),writeFile(join(root,'env','pyvenv.cfg'),'fixture'),writeFile(join(root,'env','Lib','site-packages','soundfile.py'),'# fixture'),writeFile(paths.receipt,'{}')])
 let installed=true
 const base={native:false,profile:BASE_VOICE,executable:paths.python,path:paths.original,initialize:vi.fn(async()=>{}),identity:vi.fn(async()=> 'stable-fixture-identity'),ready:vi.fn(async()=>paths.original),cancelVerification:vi.fn(async()=>{}),cancel:vi.fn(async()=>{}),install:vi.fn(async()=>{installed=true}),recordModelCheck:vi.fn((valid:boolean)=>{installed=valid}),snapshot:()=>({supported:true,installed,phase:'idle',bytes:0,total:16,error:null}),modelRemoval:vi.fn(async():Promise<ManagedVoiceModelRemoval|null>=>null),removeModel:vi.fn(async(_plan:string,_trash:(path:string)=>Promise<void>)=>{})}
 const qwen={initialize:vi.fn(async()=>{}),install:vi.fn(async()=>({python:paths.python,model:paths.original})),cancel:vi.fn(async()=>{}),applying:vi.fn(),snapshot:()=>({supported:true,installed:false,phase:'idle',bytes:0,total:16,error:null}),modelRemoval:vi.fn(async():Promise<ManagedVoiceModelRemoval|null>=>null),removeModel:vi.fn(async(_plan:string,_trash:(path:string)=>Promise<void>)=>{})}
 const installStates:GgufModelInstallState[]=GGUF_MODEL_CATALOG.models.map(model=>({id:model.id,supported:true,installed:false,verified:false,phase:'idle',bytes:0,total:model.totalBytes,error:null,verification:'sha256',runtimeIncluded:false}))
 const gguf={initialize:vi.fn(async()=>{}),snapshot:()=>structuredClone(installStates),cancel:vi.fn(async()=>{}),install:vi.fn(async(id:GgufModelId)=>{Object.assign(installStates.find(state=>state.id===id)!,{installed:true,verified:true,modelPath:paths.publicModel});return {id,model:paths.publicModel}}),verify:vi.fn(async(_id:GgufModelId)=>paths.publicModel),modelRemoval:vi.fn(async(_id:GgufModelId):Promise<ManagedVoiceModelRemoval|null>=>null),removeModel:vi.fn(async(_id:GgufModelId,_plan:string,_trash:(path:string)=>Promise<void>)=>{})}
 const runtimes:FixtureRuntime[]=[]
 function makeRuntime(config:TtsConfig):FixtureRuntime{const runtime:FixtureRuntime={config,sessionId:'fixture-session-'+runtimes.length,running:false,busy:false,audit:{warmed:true},get ready(){return this.running},start:vi.fn(async(_package:string,_identity:string,_conditioning?:unknown)=>{runtime.running=true}),prewarm:vi.fn(async()=>{}),stop:vi.fn(async()=>{runtime.running=false}),retireSpeech:vi.fn(),cancelSpeech:vi.fn(async()=>({}))};runtimes.push(runtime);return runtime}
 const make=vi.fn(makeRuntime),changed=vi.fn((_snapshot:VoiceSnapshot)=>{}),trash=vi.fn(async(_path:string)=>{})
 const store={initialize:vi.fn(async()=>{}),list:()=>[reference],resolve:vi.fn(async()=>({wav:join(root,'fixture-reference.wav'),sha256:reference.referenceSha256,fingerprint:reference.fingerprint})),close:vi.fn(async()=>{})}
 const service=new CharacterVoiceService(root,paths.worker,()=>({character:{id:'character',revision:1}}) as any,changed,()=>{},make as any,undefined,base as any,undefined,store as any)
 service.attachQwenInstaller(qwen as any);service.attachGgufInstaller(gguf);service.attachModelTrash(trash);services.push(service);await service.initialize()
 // Register a fixture profile without importing or reading any user voice pack.
 const owner=service as any;owner.state.profiles.push(trained)
 const plan=(id:ManagedVoiceModelRemoval['id']='qwen3-tts-06b-gguf'):ManagedVoiceModelRemoval=>({id,engine:id.startsWith('qwen')?id==='qwen3-tts-06b'?'qwen3-tts-06b':'qwen3-tts-06b-gguf':'voxcpm2',modelId:'public-fixture/model',revision:'1'.repeat(40),planId:'fixture-plan',totalBytes:16,directories:[{path:paths.publicModel,bytes:16,files:[{relativePath:'model.gguf',bytes:16}]}]})
 const saved=async()=>JSON.parse(await readFile(join(root,'settings.json'),'utf8'))
 const connectPublic=()=>service.configureVoxPublicGguf(paths.python,paths.publicModel,{runtimeDir:paths.cuda,derivativeDir:paths.publicModel,receipt:paths.receipt})
 const connectTrained=()=>service.configureVoxGguf(paths.python,paths.original,{runtimeDir:paths.vulkan,derivativeDir:paths.trainedModel,receipt:paths.receipt})
 return {root,paths,base,qwen,gguf,installStates,make,runtimes,service,owner,changed,trash,store,plan,saved,connectPublic,connectTrained,setBaseInstalled:(value:boolean)=>{installed=value}}
}

describe('managed model operations own cancellation, unload and confirmation context',()=>{
 it('confirmed removal drains every installer before unloading and rechecks the plan after release',async()=>{
  const f=await fixture();await f.service.enabled(true);await f.service.prepare(true);const runtime=f.runtimes[0],order:string[]=[]
  const baseDone=gate(),qwenDone=gate(),ggufDone=gate(),stopDone=gate()
  f.base.install.mockImplementation(async()=>{await baseDone.promise});f.qwen.install.mockImplementation(async()=>{await qwenDone.promise;return {python:f.paths.python,model:'/late-torch-model'}})
  f.gguf.install.mockImplementation(async id=>{await ggufDone.promise;return {id,model:'/late-gguf-model'}})
  f.base.cancel.mockImplementation(async()=>{order.push('cancel-base');baseDone.resolve()});f.qwen.cancel.mockImplementation(async()=>{order.push('cancel-qwen');qwenDone.resolve()});f.gguf.cancel.mockImplementation(async()=>{order.push('cancel-gguf');ggufDone.resolve()})
  const installing=[f.service.installBase(),f.service.installQwen(),f.service.installGgufModel('qwen3-tts-06b-gguf')]
  await vi.waitFor(()=>expect(f.gguf.install).toHaveBeenCalledOnce())
  runtime.stop.mockImplementation(async()=>{order.push('unload');await stopDone.promise;runtime.running=false})
  f.gguf.modelRemoval.mockImplementation(async()=>{order.push('inspect');expect(runtime.running).toBe(false);return f.plan()})
  const inspecting=f.service.removeManagedModel('qwen3-tts-06b-gguf','fixture-plan')
  await vi.waitFor(()=>expect(runtime.stop).toHaveBeenCalled())
  expect(f.gguf.modelRemoval).not.toHaveBeenCalled();expect(f.service.snapshot().managedModelRemoval?.busy).toBe(true)
  await expect(f.service.prepare(true)).rejects.toThrow('VOICE_MODEL_REMOVAL_BUSY');await f.service.prepare()
  await expect(f.service.installGgufModel('voxcpm2-gguf-f16')).rejects.toThrow('VOICE_MODEL_REMOVAL_BUSY')
  await expect(f.service.refreshManagedModels()).rejects.toThrow('VOICE_MODEL_REMOVAL_BUSY');expect(()=>f.service.configureQwen('/unused','/unused')).toThrow('VOICE_MODEL_REMOVAL_BUSY')
  stopDone.resolve();await inspecting;await Promise.all(installing)
  expect(order.slice(0,3)).toEqual(['cancel-base','cancel-qwen','cancel-gguf']);expect(order.at(-1)).toBe('inspect');expect(order.indexOf('unload')).toBeLessThan(order.indexOf('inspect'));expect(f.gguf.removeModel).toHaveBeenCalledWith('qwen3-tts-06b-gguf','fixture-plan',f.trash);expect(f.service.snapshot()).toMatchObject({engine:'voxcpm2',qwenConfigured:false,managedModelRemoval:{busy:false,error:null}})
  expect(f.trash).not.toHaveBeenCalled();expect(f.runtimes).toHaveLength(1)
 })

 it('waits for a preparation owner to drain before handing an owned model to Trash',async()=>{
  const f=await fixture();await f.connectPublic();await f.service.executionProfile('gguf-cuda-f16');await f.service.enabled(true)
  const startDone=gate(),stopEntered=gate();const nativeStart=vi.fn(async()=>{await startDone.promise})
  f.make.mockImplementation(config=>{let stopped=false;const runtime:FixtureRuntime={config,sessionId:'preparation',running:false,busy:false,audit:{warmed:true},get ready(){return this.running},start:vi.fn(async()=>{await nativeStart();runtime.running=!stopped}),prewarm:vi.fn(async()=>{}),stop:vi.fn(async()=>{stopped=true;stopEntered.resolve();await startDone.promise;runtime.running=false}),retireSpeech:vi.fn(),cancelSpeech:vi.fn(async()=>({}))};f.runtimes.push(runtime);return runtime})
  const preparing=f.service.prepare(true);await vi.waitFor(()=>expect(nativeStart).toHaveBeenCalledOnce())
  f.gguf.modelRemoval.mockResolvedValue(f.plan('voxcpm2-gguf-f16'))
  f.gguf.removeModel.mockImplementation(async(_id,token,trash)=>{expect(token).toBe('fixture-plan');expect(f.runtimes[0].running).toBe(false);await trash(f.paths.publicModel)})
  const removing=f.service.removeManagedModel('voxcpm2-gguf-f16','fixture-plan');await stopEntered.promise
  expect(f.trash).not.toHaveBeenCalled();await expect(f.service.prepare(true)).rejects.toThrow('VOICE_MODEL_REMOVAL_BUSY')
  startDone.resolve();await Promise.all([preparing,removing]);expect(f.trash).toHaveBeenCalledWith(f.paths.publicModel);expect(f.runtimes[0].running).toBe(false)
  expect(f.changed.mock.calls.some(([snapshot])=>snapshot.status==='idle'&&snapshot.managedModelRemoval?.busy)).toBe(false)
 })

 it('rejects an expired confirmation owner before reading a plan or deleting anything',async()=>{
  const f=await fixture();await expect(f.service.inspectManagedModelRemoval('qwen3-tts-06b-gguf',()=>false)).rejects.toThrow('CHAT_SETTINGS_EXPIRED')
  await expect(f.service.removeManagedModel('qwen3-tts-06b-gguf','renderer-token',()=>false)).rejects.toThrow('CHAT_SETTINGS_EXPIRED')
  expect(f.gguf.modelRemoval).not.toHaveBeenCalled();expect(f.gguf.removeModel).not.toHaveBeenCalled();expect(f.trash).not.toHaveBeenCalled()
  expect(f.service.snapshot()).toMatchObject({managedModels:[],managedModelRemoval:{busy:false,error:'CHAT_SETTINGS_EXPIRED'}})
 })

 it('invalidates a plan whose confirmation context expires while metadata is being read',async()=>{
  const f=await fixture(),done=gate();let current=true
  f.gguf.modelRemoval.mockImplementation(async()=>{await done.promise;return f.plan()})
  const inspecting=f.service.inspectManagedModelRemoval('qwen3-tts-06b-gguf',()=>current),result=expect(inspecting).rejects.toThrow('CHAT_SETTINGS_EXPIRED')
  await vi.waitFor(()=>expect(f.gguf.modelRemoval).toHaveBeenCalledOnce());current=false;done.resolve();await result
  expect(f.trash).not.toHaveBeenCalled();expect(f.service.snapshot().managedModels).toEqual([])
 })

 it('preserves the selected profile and settings after Trash fails, refreshes the plan, then permits an explicit retry',async()=>{
  const f=await fixture();await f.service.bind('character',referenceKey);await f.service.configureQwen('/kept-python','/kept-torch');await f.service.enabled(true)
  let present=true;f.gguf.modelRemoval.mockImplementation(async id=>present&&id==='qwen3-tts-06b-gguf'?f.plan():null)
  f.gguf.removeModel.mockImplementation(async(id,token,trash)=>{expect(id).toBe('qwen3-tts-06b-gguf');if(token!=='fixture-plan')throw Error('VOICE_MODEL_REMOVAL_CHANGED');await trash(f.paths.publicModel);present=false;Object.assign(f.installStates[0],{installed:false,verified:false,modelPath:undefined})})
  await f.service.refreshManagedModels();expect(f.service.snapshot().managedModels).toEqual([{...f.plan(),currentVoiceAffected:false,legacy:false}])
  f.trash.mockRejectedValueOnce(Error('private OS details'))
  await expect(f.service.removeManagedModel('qwen3-tts-06b-gguf','fixture-plan')).rejects.toThrow('private OS details')
  expect(f.service.snapshot()).toMatchObject({managedModels:[],managedModelRemoval:{busy:false,error:'VOICE_MODEL_REMOVAL_FAILED'},bindings:{character:referenceKey},qwenConfigured:true})
  await f.service.refreshManagedModels();expect(f.service.snapshot().managedModels).toEqual([{...f.plan(),currentVoiceAffected:false,legacy:false}])
  await expect(f.service.removeManagedModel('qwen3-tts-06b-gguf','obsolete-plan')).rejects.toThrow('VOICE_MODEL_REMOVAL_CHANGED');expect(f.trash).toHaveBeenCalledTimes(1)
  await f.service.removeManagedModel('qwen3-tts-06b-gguf','fixture-plan')
  expect(f.trash).toHaveBeenCalledTimes(2);expect(f.service.snapshot()).toMatchObject({managedModels:[],managedModelRemoval:{busy:false,error:null},status:'idle',qwenConfigured:true,bindings:{character:referenceKey}})
  expect(await f.saved()).toMatchObject({qwenRuntime:{python:'/kept-python',model:'/kept-torch'},bindings:{character:referenceKey}})
 })

 it('close waits for admitted model management and does not resume preparation afterwards',async()=>{
  const f=await fixture(),done=gate();f.gguf.modelRemoval.mockImplementation(async()=>{await done.promise;return f.plan()})
  const inspecting=f.service.inspectManagedModelRemoval('qwen3-tts-06b-gguf');await vi.waitFor(()=>expect(f.gguf.modelRemoval).toHaveBeenCalledOnce())
  let closed=false;const closing=f.service.close().then(()=>{closed=true});await turn();expect(closed).toBe(false)
  done.resolve();await Promise.all([inspecting,closing]);expect(closed).toBe(true);await f.service.prepare();expect(f.make).not.toHaveBeenCalled()
 })

 it('metadata preview blocks while a checker is active and does not cancel it',async()=>{
  const f=await fixture(),done=gate();let aborted=false
  vi.mocked(checkWindowsModel).mockImplementationOnce(async(_python,_model,_worker,_engine,signal)=>{signal.addEventListener('abort',()=>{aborted=true});await done.promise})
  const checking=f.service.checkModel();await vi.waitFor(()=>expect(checkWindowsModel).toHaveBeenCalledOnce())
  await expect(f.service.inspectManagedModelRemoval('qwen3-tts-06b-gguf')).rejects.toThrow('VOICE_MODEL_REMOVAL_BUSY')
  expect(aborted).toBe(false);expect(f.gguf.modelRemoval).not.toHaveBeenCalled()
  const cancelling=f.service.cancelModelCheck();done.resolve();await Promise.all([checking,cancelling]);expect(aborted).toBe(true)
  expect(f.base.recordModelCheck).not.toHaveBeenCalled();expect(f.service.snapshot().modelCheck?.completedAt).toBeUndefined()
 })
 it('inventory and preview keep the existing worker ready until deletion is confirmed',async()=>{
  const f=await fixture();await f.service.enabled(true);await f.service.prepare(true)
  const runtime=f.runtimes[0],stops=runtime.stop.mock.calls.length
  f.gguf.modelRemoval.mockImplementation(async id=>id==='qwen3-tts-06b-gguf'?f.plan():null)
  await f.service.refreshManagedModels();expect(await f.service.inspectManagedModelRemoval('qwen3-tts-06b-gguf')).toMatchObject(f.plan())
  expect(runtime.running).toBe(true);expect(runtime.stop).toHaveBeenCalledTimes(stops)
  for(const installer of [f.base,f.qwen,f.gguf])expect(installer.cancel).not.toHaveBeenCalled()
  expect(f.trash).not.toHaveBeenCalled()
 })
 it('removing the active model disconnects only its connections and persists protected choices',async()=>{
  const f=await fixture();await f.service.configure('/external/python','/external/model');await f.service.configureQwen('/external/qwen-python','/external/qwen-model')
  await f.connectTrained();await f.connectPublic();await f.service.bind('character',referenceKey);await f.service.executionProfile('gguf-cuda-f16');await f.service.enabled(true)
  const plan=f.plan('voxcpm2-gguf-f16');f.gguf.modelRemoval.mockImplementation(async id=>id===plan.id?plan:null)
  expect(f.service.modelRemovalImpact(plan)).toBe(true)
  f.gguf.removeModel.mockImplementation(async(_id,_token,trash)=>{await trash(f.paths.publicModel)})
  await f.service.removeManagedModel(plan.id,plan.planId)
  expect(f.service.snapshot()).toMatchObject({engine:'voxcpm2',executionProfile:'gguf-cuda-f16',bindings:{character:referenceKey},runtimeConfigured:false,voxGgufConfigured:false,status:'unavailable'})
  expect(f.trash.mock.calls).toEqual([[f.paths.publicModel]])
  const saved=await f.saved();expect(saved).toMatchObject({runtime:{model:'/external/model'},qwenRuntime:{model:'/external/qwen-model'},voxGgufRuntime:{model:f.paths.original},bindings:{character:referenceKey}})
  expect(saved.voxPublicGgufRuntime).toBeNull();expect(saved.voxPublicGgufBackends.cuda).toBeUndefined()
  expect(await readFile(f.paths.receipt,'utf8')).toBe('{}');expect(f.store.close).not.toHaveBeenCalled()
 })
 it('removing an unrelated legacy model keeps the current GGUF connection usable',async()=>{
  const f=await fixture();await f.service.configureQwen(f.paths.python,f.paths.original);await f.connectPublic();await f.service.bind('character',referenceKey);await f.service.executionProfile('gguf-cuda-f16');await f.service.enabled(true)
  const plan={...f.plan('qwen3-tts-06b'),directories:[{path:f.paths.original,bytes:16,files:[]}]};f.qwen.modelRemoval.mockResolvedValue(plan)
  expect(f.service.modelRemovalImpact(plan)).toBe(false)
  f.qwen.removeModel.mockImplementation(async(_token,trash)=>{await trash(f.paths.original)})
  await f.service.removeManagedModel(plan.id,plan.planId)
  expect(f.service.snapshot()).toMatchObject({runtimeConfigured:true,voxGgufConfigured:true,qwenConfigured:false,status:'idle',bindings:{character:referenceKey}})
  expect(await f.saved()).toMatchObject({qwenRuntime:null,voxPublicGgufRuntime:{model:f.paths.publicModel,gguf:{runtimeDir:f.paths.cuda}},bindings:{character:referenceKey}})
  expect(f.trash.mock.calls).toEqual([[f.paths.original]])
 })
})

describe('GGUF connections remain separate from legacy engines and each other',()=>{
 it('persists public and trained Vox connections independently and routes checks after engine/profile switches',async()=>{
  const f=await fixture();await f.service.configure('/legacy-python','/legacy-vox');await f.service.configureQwen('/torch-python','/torch-model');await f.connectTrained();await f.connectPublic()
  await f.service.executionProfile('gguf-cuda-f16');await f.service.checkModel();expect(f.make.mock.lastCall?.[0]).toMatchObject({model:f.paths.publicModel,ggufModelKind:'public-base',gguf:{runtimeDir:f.paths.cuda,derivativeDir:f.paths.publicModel},modelVerification:'full'})
  expect(vi.mocked(checkWindowsModel).mock.lastCall?.[5]).toMatchObject({ggufModelKind:'public-base',gguf:{package:'',executionProfile:'gguf-cuda-f16'}})
  await f.service.bind('character',trainedKey);await f.service.executionProfile('gguf-vulkan-f16-complete');await f.service.checkModel()
  expect(f.make.mock.lastCall?.[0]).toMatchObject({model:f.paths.original,gguf:{runtimeDir:f.paths.vulkan,derivativeDir:f.paths.trainedModel}});expect(f.make.mock.lastCall?.[0]).not.toHaveProperty('ggufModelKind')
  expect(vi.mocked(checkWindowsModel).mock.lastCall?.[5]).toMatchObject({gguf:{package:join(f.root,'profiles',trainedKey),executionProfile:'gguf-vulkan-f16-complete'}})
  await f.service.engine('qwen3-tts-06b');await f.service.engine('voxcpm2');await f.service.bind('character',null)
  const saved=await f.saved();expect(saved).toMatchObject({runtime:{python:'/legacy-python',model:'/legacy-vox'},qwenRuntime:{python:'/torch-python',model:'/torch-model'},voxGgufRuntime:{model:f.paths.original,gguf:{derivativeDir:f.paths.trainedModel}},voxPublicGgufRuntime:{model:f.paths.publicModel,gguf:{derivativeDir:f.paths.publicModel}}})
  await f.service.close()
  const reopened=new CharacterVoiceService(f.root,f.paths.worker,()=>({character:{id:'character'}}) as any,()=>{},()=>{},f.make as any,undefined,f.base as any,undefined,f.store as any);services.push(reopened);await reopened.initialize();await reopened.checkModel()
  expect(reopened.snapshot()).toMatchObject({voxGgufConfigured:true,executionProfile:'gguf-cuda-f16',runtimeConfigured:true})
  expect(f.make.mock.lastCall?.[0]).toMatchObject({model:f.paths.publicModel,ggufModelKind:'public-base'})
  ;(reopened as any).state.profiles.push(trained);await reopened.bind('character',trainedKey);await reopened.executionProfile('gguf-vulkan-f16');await reopened.checkModel();expect(f.make.mock.lastCall?.[0]).toMatchObject({model:f.paths.original,gguf:{derivativeDir:f.paths.trainedModel}})
 })

 it('does not reuse a trained connection for a default/reference voice or a public connection for a trained voice',async()=>{
  const f=await fixture();await f.connectTrained();await f.service.executionProfile('gguf-cuda-f16');await f.service.enabled(true)
  expect(f.service.snapshot()).toMatchObject({voxGgufConfigured:false,runtimeConfigured:false,status:'unavailable',error:'VOX_GGUF_RUNTIME_MISSING'});await f.service.prepare();expect(f.make).not.toHaveBeenCalled()
  await f.connectPublic();await f.service.bind('character',referenceKey);expect(f.service.snapshot().voxGgufConfigured).toBe(true)
  const g=await fixture();await g.connectPublic();await g.service.bind('character',trainedKey);await g.service.executionProfile('gguf-cuda-f16');await g.service.enabled(true)
  expect(g.service.snapshot()).toMatchObject({voxGgufConfigured:false,runtimeConfigured:false,status:'unavailable',error:'VOX_GGUF_RUNTIME_MISSING'});expect(g.make).not.toHaveBeenCalled()
 })

 it('rejects mismatched public folders and stale configuration without replacing either connection',async()=>{
  const f=await fixture();await f.connectPublic();await f.connectTrained();const before=await f.saved()
  await f.service.configureVoxPublicGguf('/new-python','/public',{runtimeDir:'/new-dll',derivativeDir:'/different',receipt:'/new-receipt'})
  expect(f.service.snapshot().error).toBe('VOX_GGUF_RUNTIME_CONFIG')
  await f.service.configureVoxPublicGguf('/new-python','/new-model',{runtimeDir:'/new-dll',derivativeDir:'/new-model',receipt:'/new-receipt'},()=>false)
  expect(f.service.snapshot().error).toBe('CHAT_SETTINGS_EXPIRED')
  await f.service.auto(false);const after=await f.saved();expect(after.voxPublicGgufRuntime).toEqual(before.voxPublicGgufRuntime);expect(after.voxGgufRuntime).toEqual(before.voxGgufRuntime)
 })

 it('persists CUDA and Vulkan Qwen DLL folders independently and never falls back across backends',async()=>{
  const f=await fixture();await f.service.bind('character',referenceKey);await f.service.configureQwen('/torch-python','/torch-model');await f.service.engine('qwen3-tts-06b-gguf');await f.service.configureQwenGguf(f.paths.python,f.paths.publicModel,f.paths.cuda)
  await f.service.executionProfile('qwen-gguf-vulkan');expect(f.service.snapshot()).toMatchObject({qwenGgufConfigured:false,runtimeConfigured:false})
  await f.service.configureQwenGguf(f.paths.python,f.paths.publicModel,f.paths.vulkan);await f.service.checkModel();expect(f.make.mock.lastCall?.[0]).toMatchObject({ggufRuntime:f.paths.vulkan,executionProfile:'qwen-gguf-vulkan',modelVerification:'full'})
  await f.service.executionProfile('qwen-gguf-complete');await f.service.checkModel();expect(f.make.mock.lastCall?.[0]).toMatchObject({ggufRuntime:f.paths.cuda,executionProfile:'qwen-gguf-complete'})
  expect(await f.saved()).toMatchObject({qwenGgufRuntime:{ggufRuntime:f.paths.cuda,ggufVulkanRuntime:f.paths.vulkan},qwenRuntime:{python:'/torch-python',model:'/torch-model'}})
  await f.service.close();const reopened=new CharacterVoiceService(f.root,f.paths.worker,()=>({character:{id:'character'}}) as any,()=>{},()=>{},f.make as any,undefined,f.base as any,undefined,f.store as any);services.push(reopened);await reopened.initialize();await reopened.executionProfile('qwen-gguf-vulkan-complete');await reopened.checkModel()
  expect(f.make.mock.lastCall?.[0]).toMatchObject({ggufRuntime:f.paths.vulkan,executionProfile:'qwen-gguf-vulkan-complete'});await reopened.executionProfile('qwen-gguf');await reopened.checkModel();expect(f.make.mock.lastCall?.[0]).toMatchObject({ggufRuntime:f.paths.cuda})
 })
})

describe('full verification does not contaminate the original managed Torch model',()=>{
 it('a successful or failed public Vox GGUF check leaves an original Torch failure blocked until its own successful check',async()=>{
  const f=await fixture();await f.service.enabled(true);vi.mocked(checkWindowsModel).mockRejectedValueOnce(Error('bad original fixture'))
  await f.service.checkModel();expect(f.base.recordModelCheck).toHaveBeenCalledExactlyOnceWith(false);expect(f.owner.blockedModels.has(f.paths.original.toLowerCase())).toBe(true)
  await f.connectPublic();await f.service.executionProfile('gguf-cuda-f16');await f.service.checkModel();expect(f.base.recordModelCheck).toHaveBeenCalledTimes(1);expect(f.owner.blockedModels.has(f.paths.original.toLowerCase())).toBe(true)
  vi.mocked(checkWindowsModel).mockRejectedValueOnce(Error('bad derived fixture'));await f.service.checkModel()
  expect(f.base.recordModelCheck).toHaveBeenCalledTimes(1);expect(f.owner.blockedModels.has(f.paths.publicModel.toLowerCase())).toBe(false);expect(f.owner.blockedModels.has(f.paths.original.toLowerCase())).toBe(true)
  await f.service.executionProfile('cuda-compiled');f.setBaseInstalled(true);await f.service.prepare(true);expect(f.runtimes.every(runtime=>runtime.start.mock.calls.length===0)).toBe(true);expect(f.service.snapshot().error).toBe('VOICE_MODEL_CHECK_FAILED')
  await f.service.checkModel();expect(f.base.recordModelCheck).toHaveBeenLastCalledWith(true);await f.service.prepare(true);expect(f.runtimes.at(-1)?.start).toHaveBeenCalledOnce()
 })

 it('Qwen model checks cannot change the managed Vox receipt, and GGUF full policy preserves the Torch preference',async()=>{
  const f=await fixture();await f.service.modelVerificationPolicy('installed');await f.service.bind('character',referenceKey);await f.service.engine('qwen3-tts-06b-gguf');await f.service.configureQwenGguf(f.paths.python,f.paths.publicModel,f.paths.cuda)
  vi.mocked(checkWindowsModel).mockRejectedValueOnce(Error('bad Qwen fixture'));await f.service.checkModel();expect(f.base.recordModelCheck).not.toHaveBeenCalled();expect(f.owner.blockedModels.has(f.paths.original.toLowerCase())).toBe(false)
  expect(f.service.snapshot().modelVerification).toBe('full');expect(()=>f.service.modelVerificationPolicy('installed')).toThrow('VOICE_ACTION')
  await f.service.engine('voxcpm2');expect(f.service.snapshot().modelVerification).toBe('installed');expect(f.service.snapshot().baseInstall?.installed).toBe(true)
 })
})

describe('model-only installation and verification obey ownership',()=>{
 it('ignores stale completion and immediate expired requests without replacing the selected model',async()=>{
  const f=await fixture();await f.service.engine('qwen3-tts-06b-gguf');await f.service.configureQwenGguf(f.paths.python,f.paths.original,f.paths.cuda)
  const done=gate();let current=true;f.gguf.install.mockImplementation(async id=>{await done.promise;return {id,model:f.paths.publicModel}})
  const installing=f.service.installGgufModel('qwen3-tts-06b-gguf',()=>current);await vi.waitFor(()=>expect(f.gguf.install).toHaveBeenCalledOnce());current=false;done.resolve();await installing
  expect((await f.saved()).qwenGgufRuntime.model).toBe(f.paths.original);expect(f.make).not.toHaveBeenCalled()
  await f.service.installGgufModel('qwen3-tts-06b-gguf',()=>false);expect(f.gguf.install).toHaveBeenCalledOnce()
 })

 it('model download without a manually connected runtime cannot become ready or change an engine/voice',async()=>{
  const f=await fixture();await f.service.bind('character',referenceKey);await f.service.engine('qwen3-tts-06b-gguf');await f.service.enabled(true)
  await f.service.installGgufModel('qwen3-tts-06b-gguf');await f.service.prepare()
  expect(f.service.snapshot()).toMatchObject({engine:'qwen3-tts-06b-gguf',qwenGgufConfigured:false,runtimeConfigured:false,status:'unavailable',error:'QWEN_GGUF_RUNTIME_MISSING',bindings:{character:referenceKey}})
  expect(f.service.snapshot().ggufInstall?.[0]).toMatchObject({installed:true,verified:true,runtimeIncluded:false});expect(f.make).not.toHaveBeenCalled()
  await f.service.engine('voxcpm2');await f.service.executionProfile('gguf-cuda-f16');await f.service.installGgufModel('voxcpm2-gguf-f16')
  expect(f.service.snapshot()).toMatchObject({voxGgufConfigured:false,runtimeConfigured:false,status:'unavailable',error:'VOX_GGUF_RUNTIME_MISSING',bindings:{character:referenceKey}});expect(f.make).not.toHaveBeenCalled()
 })

 it('applies a downloaded public Vox folder only to the public connection, preserving trained and legacy models',async()=>{
  const f=await fixture();await f.connectTrained();await f.connectPublic();await f.service.configure('/legacy-python','/legacy-model');await f.service.bind('character',trainedKey)
  const newModel=join(f.root,'downloaded-model');f.gguf.install.mockResolvedValueOnce({id:'voxcpm2-gguf-f16',model:newModel});await f.service.installGgufModel('voxcpm2-gguf-f16')
  expect(await f.saved()).toMatchObject({engine:'voxcpm2',bindings:{character:trainedKey},runtime:{model:'/legacy-model'},voxGgufRuntime:{model:f.paths.original,gguf:{derivativeDir:f.paths.trainedModel}},voxPublicGgufRuntime:{model:newModel,gguf:{derivativeDir:newModel}}});expect(f.make).not.toHaveBeenCalled()
 })

 it.each(['qwen3-tts-06b-gguf','voxcpm2-gguf-f16'] as const)('a %s download cannot overwrite a connection the user replaces while it runs',async id=>{
  const f=await fixture();await f.connectPublic();await f.connectTrained();await f.service.configureQwenGguf(f.paths.python,f.paths.original,f.paths.cuda)
  const done=gate();f.gguf.install.mockImplementation(async modelId=>{await done.promise;return {id:modelId,model:'/downloaded-after-settings-change'}})
  const installing=f.service.installGgufModel(id);await vi.waitFor(()=>expect(f.gguf.install).toHaveBeenCalledOnce())
  if(id==='qwen3-tts-06b-gguf')await f.service.configureQwenGguf('/replacement-python','/replacement-qwen','/replacement-dll')
  else await f.service.configureVoxPublicGguf('/replacement-python','/replacement-vox',{runtimeDir:'/replacement-dll',derivativeDir:'/replacement-vox',receipt:'/replacement-receipt'})
  done.resolve();await installing;const saved=await f.saved()
  if(id==='qwen3-tts-06b-gguf')expect(saved.qwenGgufRuntime).toMatchObject({python:'/replacement-python',model:'/replacement-qwen',ggufRuntime:'/replacement-dll'})
  else expect(saved.voxPublicGgufRuntime).toMatchObject({python:'/replacement-python',model:'/replacement-vox',gguf:{runtimeDir:'/replacement-dll',derivativeDir:'/replacement-vox'}})
  expect(saved.voxGgufRuntime).toMatchObject({model:f.paths.original,gguf:{derivativeDir:f.paths.trainedModel}});expect(f.make).not.toHaveBeenCalled()
 })

 it('applying Qwen model-only downloads preserves both native backend folders and the current engine/binding',async()=>{
  const f=await fixture();await f.service.bind('character',referenceKey);await f.service.engine('qwen3-tts-06b-gguf');await f.service.configureQwenGguf(f.paths.python,f.paths.original,f.paths.cuda)
  await f.service.executionProfile('qwen-gguf-vulkan');await f.service.configureQwenGguf(f.paths.python,f.paths.original,f.paths.vulkan);await f.service.engine('voxcpm2')
  await f.service.installGgufModel('qwen3-tts-06b-gguf')
  expect(await f.saved()).toMatchObject({engine:'voxcpm2',bindings:{character:referenceKey},qwenGgufRuntime:{python:f.paths.python,model:f.paths.publicModel,ggufRuntime:f.paths.cuda,ggufVulkanRuntime:f.paths.vulkan}});expect(f.make).not.toHaveBeenCalled()
 })

 it('close drains a pending model download and cannot apply its late completion',async()=>{
  const f=await fixture();await f.service.configureQwenGguf(f.paths.python,f.paths.original,f.paths.cuda)
  const done=gate();f.gguf.install.mockImplementation(async id=>{await done.promise;return {id,model:'/late-after-close'}})
  const installing=f.service.installGgufModel('qwen3-tts-06b-gguf');await vi.waitFor(()=>expect(f.gguf.install).toHaveBeenCalledOnce())
  let closed=false;const closing=f.service.close().then(()=>{closed=true});await turn();expect(closed).toBe(false);expect(f.gguf.cancel).toHaveBeenCalled()
  done.resolve();await Promise.all([closing,installing]);expect((await f.saved()).qwenGgufRuntime.model).toBe(f.paths.original);expect(f.make).not.toHaveBeenCalled()
 })

 it('same-model installation shares one owner, cancellation drains it, and the canceled result is not applied',async()=>{
  const f=await fixture();await f.service.engine('qwen3-tts-06b-gguf');await f.service.configureQwenGguf(f.paths.python,f.paths.original,f.paths.cuda)
  const done=gate();f.gguf.install.mockImplementation(async id=>{await done.promise;return {id,model:f.paths.publicModel}});f.gguf.cancel.mockImplementation(async()=>{done.resolve()})
  const first=f.service.installGgufModel('qwen3-tts-06b-gguf'),duplicate=f.service.installGgufModel('qwen3-tts-06b-gguf');expect(duplicate).toBe(first)
  await vi.waitFor(()=>expect(f.gguf.install).toHaveBeenCalledOnce());await f.service.cancelInstallGgufModel();await first;expect((await f.saved()).qwenGgufRuntime.model).toBe(f.paths.original)
  await f.service.installGgufModel('qwen3-tts-06b-gguf');expect(f.gguf.install).toHaveBeenCalledTimes(2);expect((await f.saved()).qwenGgufRuntime.model).toBe(f.paths.publicModel)
 })

 it('a different model request cannot masquerade as the currently admitted download',async()=>{
  const f=await fixture(),done=gate();f.gguf.install.mockImplementation(async id=>{await done.promise;return {id,model:f.paths.publicModel}})
  const first=f.service.installGgufModel('qwen3-tts-06b-gguf');await vi.waitFor(()=>expect(f.gguf.install).toHaveBeenCalledOnce())
  const competing=f.service.installGgufModel('voxcpm2-gguf-f16');done.resolve();await expect(competing).rejects.toThrow('GGUF_MODEL_BUSY');await first
 })

 it('full GGUF verification excludes configuration and preparation until it drains',async()=>{
  const f=await fixture();await f.connectPublic();await f.service.executionProfile('gguf-cuda-f16');await f.service.enabled(true)
  const done=gate();f.gguf.verify.mockImplementation(async()=>{await done.promise;return f.paths.publicModel})
  const checking=f.service.verifyGgufModel('voxcpm2-gguf-f16');await vi.waitFor(()=>expect(f.gguf.verify).toHaveBeenCalledOnce())
  expect(()=>f.service.configureVoxPublicGguf(f.paths.python,f.paths.publicModel,{runtimeDir:f.paths.vulkan,derivativeDir:f.paths.publicModel,receipt:f.paths.receipt})).toThrow('VOICE_MODEL_REMOVAL_BUSY')
  await expect(f.service.prepare(true)).rejects.toThrow('VOICE_MODEL_REMOVAL_BUSY')
  await f.service.prepare();await turn();expect(f.make).not.toHaveBeenCalled();expect((await f.saved()).voxPublicGgufRuntime.gguf.runtimeDir).toBe(f.paths.cuda)
  done.resolve();await checking;await f.service.configureVoxPublicGguf(f.paths.python,f.paths.publicModel,{runtimeDir:f.paths.vulkan,derivativeDir:f.paths.publicModel,receipt:f.paths.receipt});expect((await f.saved()).voxPublicGgufRuntime.gguf.runtimeDir).toBe(f.paths.vulkan)
 })
})
