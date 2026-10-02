import {afterEach,expect,it,vi} from 'vitest'
import {createHash} from 'node:crypto'
import {link,mkdir,mkdtemp,readFile,readdir,realpath,rename,rm,stat,symlink,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {WindowsGgufModelInstaller} from '../electron/main/character-voice/WindowsGgufModelInstaller'
import {GGUF_MODEL_CATALOG,type GgufModelCatalog} from '../electron/shared/windows-gguf-model-catalog'
import voxPolicy from '../electron/voice/base-model.json'
import qwenGgufPolicy from '../electron/voice/runtime-qwen-gguf-windows.json'
import voxGgufPolicy from '../electron/voice/runtime-gguf-windows-voxcpm2.json'
const id='qwen3-tts-06b-gguf' as const
const bytes=Buffer.from('GGUFfixture-weight-data'),sha256=createHash('sha256').update(bytes).digest('hex')
const cleanup:Array<()=>Promise<unknown>>=[]
afterEach(async()=>{for(const close of cleanup.splice(0))await close();vi.restoreAllMocks()})
const turn=()=>new Promise<void>(r=>setImmediate(r))
async function fixture(fetcher?:typeof fetch,observer?:()=>void,free=1024**3){
 const root=await realpath(await mkdtemp(join(tmpdir(),'gguf-model-')))
 const entry=structuredClone(GGUF_MODEL_CATALOG.models[0]);entry.files=[{...entry.files[0],bytes:bytes.length,sha256}];entry.totalBytes=bytes.length;entry.minimumFreeBytes=bytes.length+1024
 const catalog:GgufModelCatalog={sourcePolicy:'explicitly-approved-community-conversions',models:[entry]}
 const states:any[]=[],fetcherDefault=vi.fn(async()=>new Response(bytes)) as unknown as typeof fetch
 const installer=new WindowsGgufModelInstaller(root,()=>{states.push(installer.snapshot());observer?.()},{platform:'win32-x64',catalog,fetch:fetcher??fetcherDefault,freeBytes:async()=>free})
 cleanup.push(async()=>{await installer.cancel();await rm(root,{recursive:true,force:true})})
 return {root,entry,installer,states,fetcher:fetcher??fetcherDefault}
}
it('catalog pins public Base variants, identifies community publishers and matches admitted Vox F16 files',()=>{
 expect(GGUF_MODEL_CATALOG.sourcePolicy).toBe('explicitly-approved-community-conversions')
 expect(GGUF_MODEL_CATALOG.models.map(m=>m.id)).toEqual(['qwen3-tts-06b-gguf','voxcpm2-gguf-f16'])
 const vox=GGUF_MODEL_CATALOG.models[1];expect(vox.repository).toBe(voxPolicy.repo);expect(vox.revision).toBe(voxPolicy.revision)
 for(const file of vox.files)expect({bytes:file.bytes,sha256:file.sha256}).toEqual(voxPolicy.files[file.name as keyof typeof voxPolicy.files])
 for(const model of GGUF_MODEL_CATALOG.models){expect(model.communityConversion).toBe(true);expect(model.publisher).toContain('community');expect(model.files.reduce((n,f)=>n+f.bytes,0)).toBe(model.totalBytes);for(const file of model.files)expect(file.url).toBe(`https://huggingface.co/${model.repository}/resolve/${model.revision}/${file.name}`)}
 expect(GGUF_MODEL_CATALOG.models[0].files[0].name).toContain('-base-Q8_0')
})
it.each([
 {id:'qwen3-tts-06b-gguf',receipt:qwenGgufPolicy.managedModelReceipt,repository:qwenGgufPolicy.modelRepository,revision:qwenGgufPolicy.modelRevision,files:qwenGgufPolicy.models,runtimeCommit:qwenGgufPolicy.sourceCommit},
 {id:'voxcpm2-gguf-f16',receipt:voxGgufPolicy.managedModelReceipt,repository:voxGgufPolicy.publicModel.repo,revision:voxGgufPolicy.publicModel.revision,files:voxGgufPolicy.publicModel.files,runtimeCommit:voxGgufPolicy.sourceCommit},
])('$id catalog fingerprint and file pins match Python worker admission',policy=>{
 const model=GGUF_MODEL_CATALOG.models.find(entry=>entry.id===policy.id)!
 expect(model).toBeDefined()
 const files=model.files.map(({name,bytes,sha256})=>({name,bytes,sha256}))
 expect(policy.receipt).toEqual({
  schemaVersion:1,owner:'daemonlet-managed-public-gguf-model',scope:'public-base',id:model.id,
  fingerprint:createHash('sha256').update(JSON.stringify({schemaVersion:1,model})).digest('hex'),
  repository:model.repository,revision:model.revision,files,
 })
 expect(policy.repository).toBe(model.repository)
 expect(policy.revision).toBe(model.revision)
 expect(policy.runtimeCommit).toBe(model.runtimeCommit)
 expect(policy.files).toEqual(Object.fromEntries(files.map(({name,bytes,sha256})=>[name,{bytes,sha256}])))
})
it('downloads only model files and atomically publishes an owned, fully hashed bundle without runtime setup',async()=>{
 const f=await fixture();await f.installer.initialize();expect(f.fetcher).not.toHaveBeenCalled()
 const run=f.installer.install(id);expect(f.installer.install(id)).toBe(run)
 const result=await run;expect(result?.id).toBe(id);expect(await readFile(join(result!.model,f.entry.files[0].name))).toEqual(bytes)
 expect((await readdir(result!.model)).sort()).toEqual([f.entry.files[0].name,'model-receipt.json'].sort())
 expect(f.installer.snapshot()[0]).toMatchObject({installed:true,verified:true,phase:'idle',bytes:bytes.length,runtimeIncluded:false,error:null})
 expect(f.states.some(s=>s[0].phase==='publishing')).toBe(true)
 const initialized=new WindowsGgufModelInstaller(f.root,()=>{},{platform:'win32-x64',catalog:{sourcePolicy:'explicitly-approved-community-conversions',models:[f.entry]},fetch:vi.fn() as any})
 await initialized.initialize();expect(initialized.snapshot()[0]).toMatchObject({installed:true,verified:false});await initialized.verify(id);expect(initialized.snapshot()[0].verified).toBe(true)
 await f.installer.install(id);expect(f.fetcher).toHaveBeenCalledTimes(1)
})
it('immediate cancellation owns admission and prevents download, later explicit retry succeeds',async()=>{
 const f=await fixture();const a=f.installer.install(id),cancel=f.installer.cancel();expect(await a).toBeNull();await cancel;expect(f.fetcher).not.toHaveBeenCalled()
 expect(f.installer.snapshot()[0]).toMatchObject({installed:false,phase:'idle',error:null});expect(await f.installer.install(id)).not.toBeNull()
})
it('preparing observer can reenter cancellation without losing the owned task',async()=>{
 let f:Awaited<ReturnType<typeof fixture>>,duplicate:Promise<unknown>|undefined,cancel:Promise<unknown>|undefined
 f=await fixture(undefined,()=>{if(f.installer.snapshot()[0].phase==='preparing'){duplicate=f.installer.install(id);cancel=f.installer.cancel()}})
 const accepted=f.installer.install(id);await turn();expect(duplicate).toBe(accepted);await Promise.all([accepted,cancel]);expect(f.fetcher).not.toHaveBeenCalled()
})
it('retains interrupted bytes and resumes the exact pinned range on explicit retry',async()=>{
 let request=0,closed=false
 const fetcher=vi.fn(async(_url:string,options:any)=>{
  if(++request===1){return new Response(new ReadableStream({start(controller){controller.enqueue(bytes.subarray(0,7));options.signal.addEventListener('abort',()=>{closed=true;controller.error(new DOMException('cancelled','AbortError'))},{once:true})}}))}
  expect(options.headers.Range).toBe('bytes=7-')
  return new Response(bytes.subarray(7),{status:206,headers:{'content-range':`bytes 7-${bytes.length-1}/${bytes.length}`}})
 }) as unknown as typeof fetch
 const f=await fixture(fetcher),pending=f.installer.install(id)
 await vi.waitFor(()=>expect(f.installer.snapshot()[0].bytes).toBe(7));await f.installer.cancel();expect(await pending).toBeNull();expect(closed).toBe(true)
 const removal=await f.installer.modelRemoval(id);expect(removal?.directories).toHaveLength(1);expect(removal!.directories[0].files.some(file=>file.relativePath===f.entry.files[0].name&&file.bytes===7)).toBe(true)
 const result=await f.installer.install(id);expect(await readFile(join(result!.model,f.entry.files[0].name))).toEqual(bytes);expect(request).toBe(2)
})
it('a server that ignores Range restarts the file rather than appending duplicate bytes',async()=>{
 const f=await fixture();const owner=f.installer as any;await owner.ensureBundle(f.entry);const stage=owner.stage(f.entry);await mkdir(stage);await writeFile(join(stage,'model-receipt.json'),JSON.stringify(owner.receipt(f.entry))+'\n');await writeFile(join(stage,f.entry.files[0].name),bytes.subarray(0,7))
 const result=await f.installer.install(id);expect(await readFile(join(result!.model,f.entry.files[0].name))).toEqual(bytes)
})
it.each(['wrong-range','wrong-hash','oversized-response'] as const)('rejects %s and never publishes a model',async kind=>{
 const fetcher=vi.fn(async()=>kind==='wrong-range'?new Response(bytes,{status:206,headers:{'content-range':`bytes 1-${bytes.length}/${bytes.length+1}`}}):new Response(kind==='wrong-hash'?Buffer.alloc(bytes.length):Buffer.concat([bytes,Buffer.from('overflow')]))) as unknown as typeof fetch
 const f=await fixture(fetcher);await expect(f.installer.install(id)).rejects.toThrow();expect(f.installer.snapshot()[0]).toMatchObject({installed:false,verified:false,phase:'idle'});await expect(stat((f.installer as any).target(f.entry))).rejects.toThrow()
})
it('a hash failure retains ownership and an explicit retry downloads clean pinned bytes',async()=>{
 let requests=0;const fetcher=vi.fn(async()=>new Response(++requests===1?Buffer.alloc(bytes.length):bytes)) as unknown as typeof fetch
 const f=await fixture(fetcher);await expect(f.installer.install(id)).rejects.toThrow('VOICE_BASE_CHANGED')
 const retry=await f.installer.install(id);expect(await readFile(join(retry!.model,f.entry.files[0].name))).toEqual(bytes);expect(requests).toBe(2);expect(f.installer.snapshot()[0].error).toBeNull()
})
it('a forged ownership receipt cannot authorize download, verification or managed deletion',async()=>{
 const f=await fixture();const owner=f.installer as any;await owner.ensureBundle(f.entry)
 await writeFile(join(owner.bundle(f.entry),'ownership.json'),JSON.stringify({...owner.receipt(f.entry),scope:'private-trained-character'}))
 await expect(f.installer.install(id)).rejects.toThrow('GGUF_MODEL_CHANGED');await expect(f.installer.verify(id)).rejects.toThrow('GGUF_MODEL_CHANGED');await expect(f.installer.modelRemoval(id)).rejects.toThrow('VOICE_MODEL_REMOVAL_CHANGED');expect(f.fetcher).not.toHaveBeenCalled()
})
it('insufficient remaining disk space rejects before any network request',async()=>{
 const f=await fixture(undefined,undefined,0);await expect(f.installer.install(id)).rejects.toThrow('VOICE_DISK_SPACE');expect(f.fetcher).not.toHaveBeenCalled()
})
it('cancellation at publication retains verified staged bytes without a late completed installation',async()=>{
 let f:Awaited<ReturnType<typeof fixture>>,cancel:Promise<void>|undefined
 f=await fixture(undefined,()=>{if(f.installer.snapshot()[0].phase==='publishing')cancel=f.installer.cancel()});expect(await f.installer.install(id)).toBeNull();await cancel
 const owner=f.installer as any;await expect(stat(owner.target(f.entry))).rejects.toThrow();expect(await readFile(join(owner.stage(f.entry),f.entry.files[0].name))).toEqual(bytes);expect(f.installer.snapshot()[0].installed).toBe(false)
})
it('unknown installed files and content changes fail closed and preserve all original bytes',async()=>{
 const f=await fixture(),result=await f.installer.install(id);const target=result!.model
 await writeFile(join(target,'user-private-file'),'preserve');await expect(f.installer.install(id)).rejects.toThrow('GGUF_MODEL_CHANGED');await expect(f.installer.modelRemoval(id)).rejects.toThrow('VOICE_MODEL_REMOVAL_CHANGED')
 expect(await readFile(join(target,'user-private-file'),'utf8')).toBe('preserve');await rm(join(target,'user-private-file'));await writeFile(join(target,f.entry.files[0].name),Buffer.alloc(bytes.length))
 await expect(f.installer.verify(id)).rejects.toThrow('GGUF_MODEL_CHANGED');expect(f.installer.snapshot()[0]).toMatchObject({installed:false,verified:false})
 expect((await readFile(join(target,f.entry.files[0].name))).equals(Buffer.alloc(bytes.length))).toBe(true)
})
it.each(['symlink','hardlink'] as const)('rejects %s download paths without modifying an external file',async kind=>{
 const f=await fixture();const owner=f.installer as any;await owner.ensureBundle(f.entry);const stage=owner.stage(f.entry);await mkdir(stage);await writeFile(join(stage,'model-receipt.json'),JSON.stringify(owner.receipt(f.entry))+'\n')
 const external=join(f.root,'external');await writeFile(external,bytes);if(kind==='symlink')await symlink(external,join(stage,f.entry.files[0].name));else await link(external,join(stage,f.entry.files[0].name))
 await expect(f.installer.install(id)).rejects.toThrow('GGUF_MODEL_CHANGED');expect(f.fetcher).not.toHaveBeenCalled();expect(await readFile(external)).toEqual(bytes)
})
it.each([false,true])('a hardlink replacing the cache during fetch cannot truncate or overwrite an external original (resume=%s)',async resume=>{
 let f:Awaited<ReturnType<typeof fixture>>;const original=Buffer.from('PRIVATE ORIGINAL MUST SURVIVE')
 const fetcher=vi.fn(async(_url:string,options:any)=>{
  const path=join((f.installer as any).stage(f.entry),f.entry.files[0].name)
  // The downloader has already admitted the ordinary cache. Replace the named
  // path while the network is pending; its held handle must never follow this.
  await rm(path);await link(join(f.root,'private-original'),path)
  if(resume)expect(options.headers.Range).toBe('bytes=7-')
  return resume?new Response(bytes.subarray(7),{status:206,headers:{'content-range':`bytes 7-${bytes.length-1}/${bytes.length}`}}):new Response(bytes)
 }) as unknown as typeof fetch
 f=await fixture(fetcher);await writeFile(join(f.root,'private-original'),original)
 if(resume){const owner=f.installer as any;await owner.ensureBundle(f.entry);const stage=owner.stage(f.entry);await mkdir(stage);await writeFile(join(stage,'model-receipt.json'),JSON.stringify(owner.receipt(f.entry))+'\n');await writeFile(join(stage,f.entry.files[0].name),bytes.subarray(0,7))}
 await expect(f.installer.install(id)).rejects.toThrow('VOICE_BASE_CHANGED');expect(fetcher).toHaveBeenCalledOnce();expect(await readFile(join(f.root,'private-original'))).toEqual(original);expect(f.installer.snapshot()[0]).toMatchObject({installed:false,verified:false})
})
it('managed deletion accepts only an unchanged preview and exposes only owned model files',async()=>{
 const f=await fixture(),result=await f.installer.install(id),plan=await f.installer.modelRemoval(id)
 expect(plan?.id).toBe(id);expect(plan!.directories.map(d=>d.path)).toEqual([result!.model]);expect(plan!.directories[0].files.map(file=>file.relativePath).sort()).toEqual([f.entry.files[0].name,'model-receipt.json'].sort())
 const trash=vi.fn(async path=>rm(path,{recursive:true,force:true}));await writeFile(join(result!.model,f.entry.files[0].name),bytes)
 await expect(f.installer.removeModel(id,plan!.planId,trash)).rejects.toThrow('VOICE_MODEL_REMOVAL_CHANGED');expect(trash).not.toHaveBeenCalled()
 const fresh=await f.installer.modelRemoval(id);await f.installer.removeModel(id,fresh!.planId,trash);expect(trash).toHaveBeenCalledTimes(1);expect(f.installer.snapshot()[0]).toMatchObject({installed:false,verified:false});await expect(stat(result!.model)).rejects.toThrow()
})
it('removal admission blocks new downloads and verifiers while owned directories are quarantined',async()=>{
 const f=await fixture();await f.installer.install(id);const plan=await f.installer.modelRemoval(id);let release!:()=>void,entered!:()=>void
 const begun=new Promise<void>(r=>entered=r),hold=new Promise<void>(r=>release=r)
 const removal=f.installer.removeModel(id,plan!.planId,async path=>{entered();await hold;await rm(path,{recursive:true,force:true})});await begun
 try{await expect(f.installer.install(id)).rejects.toThrow('VOICE_MODEL_REMOVAL_BUSY');await expect(f.installer.verify(id)).rejects.toThrow('VOICE_MODEL_REMOVAL_BUSY')}finally{release();await removal}
})
it('a second trash failure clears vanished installation state, preserves the remaining copy and supports explicit recovery',async()=>{
 const f=await fixture(),installed=(await f.installer.install(id))!,owner=f.installer as any,stage=owner.stage(f.entry)
 await mkdir(stage);await writeFile(join(stage,'model-receipt.json'),JSON.stringify(owner.receipt(f.entry))+'\n');await writeFile(join(stage,f.entry.files[0].name),bytes.subarray(0,7))
 const plan=(await f.installer.modelRemoval(id))!;let calls=0
 await expect(f.installer.removeModel(id,plan.planId,async path=>{if(++calls===1)await rename(path,join(f.root,'fixture-trash'));else throw Error('OS trash denied second copy')})).rejects.toThrow('VOICE_MODEL_REMOVAL_FAILED')
 await expect(stat(installed.model)).rejects.toThrow();expect(await readFile(join(stage,f.entry.files[0].name))).toEqual(bytes.subarray(0,7));expect(f.installer.snapshot()[0]).toMatchObject({installed:false,verified:false,modelPath:undefined,phase:'idle',error:'VOICE_MODEL_REMOVAL_FAILED'})
 const remaining=(await f.installer.modelRemoval(id))!;expect(remaining.directories.map(d=>d.path)).toEqual([stage])
 await f.installer.removeModel(id,remaining.planId,async path=>rm(path,{recursive:true,force:true}));expect(f.installer.snapshot()[0].error).toBeNull()
 const retry=await f.installer.install(id);expect(await readFile(join(retry!.model,f.entry.files[0].name))).toEqual(bytes);expect(f.installer.snapshot()[0]).toMatchObject({installed:true,verified:true,error:null})
})
