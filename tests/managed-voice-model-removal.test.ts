import {afterEach,expect,it,vi} from 'vitest'
import {createHash} from 'node:crypto'
import {link,lstat,mkdir,mkdtemp,readFile,readdir,realpath,rename,rm,symlink,writeFile} from 'node:fs/promises'
import {dirname,join} from 'node:path'
import {tmpdir} from 'node:os'
import {managedModelRemoval,trashManagedModel,type ManagedModelManifest} from '../electron/main/character-voice/ManagedVoiceModelRemoval'
import {QwenVoiceInstaller} from '../electron/main/character-voice/QwenVoiceInstaller'
import {VoiceBaseInstaller} from '../electron/main/character-voice/VoiceBaseInstaller'
import {WindowsVoiceInstaller} from '../electron/main/character-voice/WindowsVoiceInstaller'
import windowsPolicy from '../electron/voice/runtime-windows-base.json'
const clean:Array<()=>Promise<unknown>>=[]
afterEach(async()=>{for(const fn of clean.splice(0))await fn();vi.restoreAllMocks()})
async function root(){const value=await realpath(await mkdtemp(join(tmpdir(),'managed-model-removal-')));clean.push(()=>rm(value,{recursive:true,force:true}));return value}
async function file(path:string,bytes:string|Buffer){await mkdir(dirname(path),{recursive:true});await writeFile(path,bytes)}
async function fixture(){
 const base=await root(),model=join(base,'models','fixed'),downloads=join(base,'downloads','model')
 await file(join(model,'weights.gguf'),'model');await file(join(model,'receipt.json'),JSON.stringify({id:'fixed'}));await file(join(downloads,'weights.gguf'),'partial')
 for(const name of ['runtime/python.exe','downloads/python.tar.gz','downloads/wheels/tensor.whl','profiles/belle/model.gguf','custom/weights.gguf','models/older/weights.gguf'])await file(join(base,name),'preserve')
 const manifest:ManagedModelManifest={root:base,id:'voxcpm2-base',engine:'voxcpm2',modelId:'official/model',revision:'fixed',directories:[{path:model,files:['weights.gguf','receipt.json'],receipt:{name:'receipt.json',matches:v=>v.id==='fixed'}},{path:downloads,files:['weights.gguf']}]}
 const trashed:string[]=[],trash=vi.fn(async(path:string)=>{const to=join(base,'trash',String(trashed.length));await mkdir(dirname(to),{recursive:true});await rename(path,to);trashed.push(to)})
 return{base,model,downloads,manifest,trash,trashed}
}
it('lists only exact managed model copies and trashes their quarantines while preserving runtimes and private packs',async()=>{
 const f=await fixture(),plan=(await managedModelRemoval(f.manifest))!
 expect(plan).toMatchObject({id:'voxcpm2-base',modelId:'official/model',revision:'fixed'});expect(plan.planId).toMatch(/^[a-f0-9]{64}$/)
 expect(plan.directories.map(d=>d.path)).toEqual([f.model,f.downloads]);expect(plan.totalBytes).toBe(5+JSON.stringify({id:'fixed'}).length+7)
 expect(plan.directories[0].files).toEqual([{relativePath:'receipt.json',bytes:14},{relativePath:'weights.gguf',bytes:5}])
 await trashManagedModel(f.manifest,plan.planId,f.trash);expect(f.trash).toHaveBeenCalledTimes(2)
 expect(f.trash.mock.calls.every(([path])=>path.includes('.remove-model-'))).toBe(true);expect(await managedModelRemoval(f.manifest)).toBeNull()
 for(const name of ['runtime/python.exe','downloads/python.tar.gz','downloads/wheels/tensor.whl','profiles/belle/model.gguf','custom/weights.gguf','models/older/weights.gguf'])expect(await readFile(join(f.base,name),'utf8')).toBe('preserve')
})
it('rejects root/outside/duplicate/nested manifests before any trash operation',async()=>{
 const f=await fixture(),plan=(await managedModelRemoval(f.manifest))!
 for(const directories of [[{path:f.base,files:[]}],[{path:join(f.base,'..','outside'),files:[]}],[f.manifest.directories[0],f.manifest.directories[0]],[{path:join(f.base,'models'),files:['fixed/weights.gguf','fixed/receipt.json']},f.manifest.directories[0]]]){
  await expect(trashManagedModel({...f.manifest,directories},plan.planId,f.trash)).rejects.toThrow('VOICE_MODEL_REMOVAL_CHANGED')
 }
 expect(f.trash).not.toHaveBeenCalled();expect(await readFile(join(f.model,'weights.gguf'),'utf8')).toBe('model')
})
it.each(['extra-file','empty-unknown-directory','wrong-receipt','file-link','directory-link','hard-link'] as const)('fails closed for %s without moving any model',async kind=>{
 const f=await fixture(),plan=(await managedModelRemoval(f.manifest))!,outside=join(f.base,'external')
 if(kind==='extra-file')await file(join(f.model,'user.wav'),'private')
 if(kind==='empty-unknown-directory')await mkdir(join(f.model,'private'))
 if(kind==='wrong-receipt')await file(join(f.model,'receipt.json'),JSON.stringify({id:'another-owner'}))
 if(kind==='file-link'){await rm(join(f.model,'weights.gguf'));await symlink(join(f.base,'custom','weights.gguf'),join(f.model,'weights.gguf'))}
 if(kind==='directory-link'){await rename(f.downloads,outside);await symlink(outside,f.downloads,'dir')}
 if(kind==='hard-link'){await rm(join(f.model,'weights.gguf'));await link(join(f.base,'custom','weights.gguf'),join(f.model,'weights.gguf'))}
 await expect(trashManagedModel(f.manifest,plan.planId,f.trash)).rejects.toThrow('VOICE_MODEL_REMOVAL_CHANGED');expect(f.trash).not.toHaveBeenCalled();expect((await lstat(f.model)).isDirectory()).toBe(true)
})
it('a same-size file replacement and added partial-cache files revoke the exact confirmation token',async()=>{
 const f=await fixture(),old=(await managedModelRemoval(f.manifest))!
 await rename(join(f.model,'weights.gguf'),join(f.base,'old-weights'));await file(join(f.model,'weights.gguf'),'model')
 await expect(trashManagedModel(f.manifest,old.planId,f.trash)).rejects.toThrow('VOICE_MODEL_REMOVAL_CHANGED');expect(f.trash).not.toHaveBeenCalled()
 const current=(await managedModelRemoval(f.manifest))!;await file(join(f.downloads,'owner.wav'),'private')
 await expect(trashManagedModel(f.manifest,current.planId,f.trash)).rejects.toThrow();expect(f.trash).not.toHaveBeenCalled()
})
it('trash failure restores remaining model paths and reports partial success honestly',async()=>{
 const f=await fixture(),plan=(await managedModelRemoval(f.manifest))!;f.trash.mockRejectedValueOnce(Error('OS trash unavailable'))
 await expect(trashManagedModel(f.manifest,plan.planId,f.trash)).rejects.toThrow('VOICE_MODEL_REMOVAL_FAILED')
 expect(await readFile(join(f.model,'weights.gguf'),'utf8')).toBe('model');expect(await readFile(join(f.downloads,'weights.gguf'),'utf8')).toBe('partial')
 const retry=(await managedModelRemoval(f.manifest))!;f.trash.mockImplementationOnce(async path=>{const to=join(f.base,'trash','first');await mkdir(dirname(to),{recursive:true});await rename(path,to)}).mockRejectedValueOnce(Error('second copy busy'))
 await expect(trashManagedModel(f.manifest,retry.planId,f.trash)).rejects.toThrow('VOICE_MODEL_REMOVAL_FAILED');expect(await managedModelRemoval(f.manifest)).toMatchObject({directories:[{path:f.downloads}]})
 expect(await readFile(join(f.downloads,'weights.gguf'),'utf8')).toBe('partial')
})
it('missing model roots are read-only and no renderer-like path can create an owned target',async()=>{
 const base=await root(),missing=join(base,'not-installed'),manifest:ManagedModelManifest={root:missing,id:'qwen3-tts-06b',engine:'qwen3-tts-06b',modelId:'official/base',revision:'fixed',directories:[{path:join(missing,'model'),files:['model.safetensors']}]}
 expect(await managedModelRemoval(manifest)).toBeNull();expect(await readdir(base)).toEqual([])
 await expect(trashManagedModel(manifest,'x'.repeat(64),async()=>{})).rejects.toThrow('VOICE_MODEL_REMOVAL_CHANGED')
})
it('GGUF public catalog IDs reuse the helper without admitting external character derivatives',async()=>{
 const f=await fixture()
 for(const id of ['qwen3-tts-06b-gguf','voxcpm2-gguf-f16'] as const)expect(await managedModelRemoval({...f.manifest,id,engine:id==='qwen3-tts-06b-gguf'?'qwen3-tts-06b-gguf':'voxcpm2'})).toMatchObject({id})
 expect((await managedModelRemoval(f.manifest))!.directories.some(d=>d.path.includes('belle'))).toBe(false)
})

async function qwen(){
 const base=await root(),model=Buffer.from('managed model'),hash=createHash('sha256').update(model).digest('hex')
 const policy={engine:'qwen3-tts-06b',model:'official/qwen',revision:'fixed',license:'Apache-2.0',totalBytes:model.length,files:{'model.safetensors':{bytes:model.length,sha256:hash}}}
 const lock:any={schemaVersion:1,platform:'win32-x64',minimumFreeBytes:1,python:{url:'https://vendor/python',bytes:1,sha256:'a'.repeat(64),filename:'python.tar.gz',version:'3.11.15',license:'PSF'},wheels:[],modelSha256:{'model.safetensors':hash}}
 const installer=new QwenVoiceInstaller(join(base,'qwen-managed'),'/resources',()=>{},{platform:'win32-x64',policy,lock}),owner=installer as any
 await file(join(owner.target,'model','model.safetensors'),model);await file(join(owner.target,'install-receipt.json'),JSON.stringify({schemaVersion:1,fingerprint:owner.fingerprint,model:policy.model,revision:policy.revision}))
 await file(join(owner.target,'env','Scripts','python.exe'),'python');await file(join(owner.target,'env','qwen-runtime.json'),'{}');await file(join(owner.rootPath,'downloads',owner.fingerprint,'model','model.safetensors'),model)
 await file(join(owner.rootPath,'downloads',owner.fingerprint,'python.tar.gz'),'archive');await installer.initialize()
 return{base,installer,owner,model}
}
it('Qwen removal preserves managed Python, blocks concurrent install, updates state, and never executes a helper',async()=>{
 const f=await qwen(),plan=(await f.installer.modelRemoval())!,run=vi.spyOn(f.owner,'run'),trash=vi.fn(async(path:string)=>{await rm(path,{recursive:true})})
 const removing=f.installer.removeModel(plan.planId,trash);await expect(f.installer.install()).rejects.toThrow('VOICE_MODEL_REMOVAL_BUSY');await removing
 expect(run).not.toHaveBeenCalled();expect(f.installer.snapshot()).toMatchObject({installed:false,repairNeeded:false,phase:'idle',error:null})
 expect(await readFile(join(f.owner.target,'env','Scripts','python.exe'),'utf8')).toBe('python');expect(await readFile(join(f.owner.rootPath,'downloads',f.owner.fingerprint,'python.tar.gz'),'utf8')).toBe('archive')
 expect(await f.installer.modelRemoval()).toBeNull()
})
it('Qwen removal waits for a cancelled writer to drain and rejects its newly changed preview before trash',async()=>{
 const f=await qwen(),plan=(await f.installer.modelRemoval())!;let done!:()=>void
 const writer=new Promise<null>(r=>done=()=>r(null)),controller=new AbortController();f.owner.operation=writer;f.owner.controller=controller
 const trash=vi.fn(),removing=f.installer.removeModel(plan.planId,trash).catch(e=>e.message);await vi.waitFor(()=>expect(controller.signal.aborted).toBe(true));expect(trash).not.toHaveBeenCalled()
 await file(join(f.owner.rootPath,'downloads',f.owner.fingerprint,'model','model.safetensors'),'changed copy');done();expect(await removing).toBe('VOICE_MODEL_REMOVAL_CHANGED');expect(trash).not.toHaveBeenCalled();expect(f.installer.snapshot().installed).toBe(true)
 f.owner.operation=null;f.owner.controller=null
})
it('Qwen changed ownership receipt or OS trash failure never deletes an external model and restores installed state',async()=>{
 const f=await qwen(),plan=(await f.installer.modelRemoval())!,trash=vi.fn().mockRejectedValue(Error('OS denied'))
 await expect(f.installer.removeModel(plan.planId,trash)).rejects.toThrow('VOICE_MODEL_REMOVAL_FAILED');expect(f.installer.snapshot()).toMatchObject({installed:true,error:'VOICE_MODEL_REMOVAL_FAILED'})
 const fresh=(await f.installer.modelRemoval())!;await file(join(f.owner.target,'install-receipt.json'),JSON.stringify({schemaVersion:1,fingerprint:'not-managed',model:'other',revision:'fixed'}))
 await expect(f.installer.removeModel(fresh.planId,trash)).rejects.toThrow('VOICE_MODEL_REMOVAL_CHANGED');expect(trash).toHaveBeenCalledTimes(1);expect(await readFile(join(f.owner.target,'model','model.safetensors'))).toEqual(f.model)
})
it('Mac Base removal includes only its exact model receipt/files and preserves bundled runtime',async()=>{
 const base=await root(),catalog={repo:'catalog/vox',revision:'fixed',license:'Apache-2.0',files:{'base.gguf':{bytes:4,sha256:createHash('sha256').update('base').digest('hex')}}} as any
 const installer=new VoiceBaseInstaller(join(base,'base-model'),join(base,'app-runtime'),()=>{},{catalog,verifyRuntime:async()=>{}}),owner=installer as any
 await file(join(installer.path,'base.gguf'),'base');await file(join(installer.path,'model-receipt.json'),JSON.stringify(catalog));await file(join(installer.executable),'executable');await file(join(installer.path+'.download','base.gguf'),'part');owner.status.installed=true
 const plan=(await installer.modelRemoval())!;await installer.removeModel(plan.planId,async path=>rm(path,{recursive:true}));expect(installer.snapshot().installed).toBe(false);expect(await readFile(installer.executable,'utf8')).toBe('executable')
})
it('Windows Base targets official revision model/download paths while leaving runtime and custom model trees alone',async()=>{
 const base=await root(),installer=new WindowsVoiceInstaller(join(base,'windows-base'),'/resources',()=>{}),owner=installer as any
 for(const name of Object.keys(windowsPolicy.model.files))await file(join(installer.path,name),'fixture')
 await file(join(installer.path,'snapshot-provenance.json'),JSON.stringify({model_id:windowsPolicy.model.repo,revision:windowsPolicy.model.revision,files:Object.fromEntries(Object.entries(windowsPolicy.model.files).map(([name,value])=>[name,value.sha256]))}))
 await file(join(owner.root,'downloads','model','model.safetensors'),'partial');await file(installer.executable,'python');await file(join(base,'custom','model.safetensors'),'private');owner.status.installed=true
 const plan=(await installer.modelRemoval())!;expect(plan.modelId).toBe('openbmb/VoxCPM2');await installer.removeModel(plan.planId,async path=>rm(path,{recursive:true}));expect(installer.snapshot().installed).toBe(false);expect(await readFile(installer.executable,'utf8')).toBe('python');expect(await readFile(join(base,'custom','model.safetensors'),'utf8')).toBe('private')
})
