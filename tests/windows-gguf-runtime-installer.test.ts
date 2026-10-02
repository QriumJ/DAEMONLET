import {afterEach,expect,it,vi} from 'vitest'
import {createHash} from 'node:crypto'
import {mkdtemp,realpath,rm,mkdir,writeFile,readFile,lstat,readdir,link,symlink} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,dirname} from 'node:path'
import {ZipFile} from 'yazl'
import {WindowsGgufRuntimeInstaller,type GgufRuntimeCatalog,type GgufRuntimeId} from '../electron/main/character-voice/WindowsGgufRuntimeInstaller'
const clean:Array<()=>Promise<unknown>>=[]
afterEach(async()=>{for(const fn of clean.splice(0))await fn();vi.restoreAllMocks()})
const sha=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex')
const ids:GgufRuntimeId[]=['qwen-cuda','qwen-vulkan','vox-cuda','vox-vulkan']
async function zip(files:Record<string,Buffer>,mode?:number){const archive=new ZipFile();for(const [name,b] of Object.entries(files))archive.addBuffer(b,name,{mode:mode??0o100600});archive.end();const parts:Buffer[]=[];for await(const b of archive.outputStream)parts.push(Buffer.from(b));return Buffer.concat(parts)}
async function fixture(options:{observer?:()=>void;bundled?:boolean;fetch?:typeof fetch;badZip?:'extra'|'link'|'missing';pending?:GgufRuntimeId;free?:number}={}){
 const base=await realpath(await mkdtemp(join(tmpdir(),'runtime-installer-'))),root=join(base,'managed'),bundles=join(base,'bundled'),archives=new Map<string,Buffer>(),catalog:GgufRuntimeCatalog={schemaVersion:1,components:{},runtimes:{} as any}
 await mkdir(bundles)
 for(const component of ['shared','cuda-redist',...ids]){
  const files:Record<string,Buffer>=component==='shared'?{'python/python.exe':Buffer.from('FAKE PYTHON NEVER EXECUTED'),'vc/vcruntime140.dll':Buffer.from('FAKE VC')}:component==='cuda-redist'?{'cuda/cublas64_13.dll':Buffer.from('FAKE CUDA')}:component.startsWith('vox')?{'native/daemonlet-voice.exe':Buffer.from('FAKE NATIVE NEVER EXECUTED'),'meta/native-build.json':Buffer.from('{}')}:{'native/qwen.dll':Buffer.from('FAKE DLL NEVER LOADED')}
  let payload={...files};if(component==='qwen-cuda'&&options.badZip==='extra')payload['unknown-user-file']=Buffer.from('not allowed');if(component==='qwen-cuda'&&options.badZip==='missing')payload={}
  const archive=await zip(payload,component==='qwen-cuda'&&options.badZip==='link'?0o120777:undefined),name=component+'.zip',hash=sha(archive);archives.set('https://fixed.example/'+name,archive)
  catalog.components[component]={id:component,archive:{name,bytes:archive.length,sha256:hash,format:'zip',url:options.bundled?undefined:'https://fixed.example/'+name},files:Object.fromEntries(Object.entries(files).map(([n,b])=>[n,{bytes:b.length,sha256:sha(b)}])),provenance:{sourceCommit:'a'.repeat(40),license:'MIT'}}
  await writeFile(join(bundles,name),archive)
 }
 for(const id of ids)catalog.runtimes[id]={id,engine:id.startsWith('qwen')?'qwen3-tts-06b-gguf':'voxcpm2',backend:id.endsWith('cuda')?'CUDA0':'Vulkan0',available:id!==options.pending,components:id===options.pending?[]:['shared',...(id.endsWith('cuda')?['cuda-redist']:[]),id],python:{component:'shared',path:'python/python.exe'},native:{component:id,path:'native'},...(id.startsWith('vox')?{receipt:{component:id,path:'meta/native-build.json'}}:{}),dependencyDirs:[{component:'shared',path:'vc'},...(id.endsWith('cuda')?[{component:'cuda-redist',path:'cuda'}]:[])],pythonVersion:'3.11.15'}
 const fetcher=options.fetch??vi.fn(async(url)=>new Response(new Uint8Array(archives.get(String(url))!))) as typeof fetch
 const installer=new WindowsGgufRuntimeInstaller(root,()=>options.observer?.(),{catalog,catalogSha256:sha(JSON.stringify(catalog)),platform:'win32-x64',bundledRoot:options.bundled?bundles:undefined,fetch:fetcher,freeBytes:async()=>options.free??1024**3})
 clean.push(async()=>{await installer.cancel();await rm(base,{recursive:true,force:true})})
 const target=(c:string)=>join(root,'components',c,catalog.components[c].archive.sha256)
 return{base,root,bundles,catalog,archives,fetcher,installer,target}
}
it.each(ids)('atomically admits all %s dependencies with exact paths and provenance but no native execution',async id=>{
 const f=await fixture();await f.installer.initialize();expect(await readdir(f.base)).toEqual(['bundled']);const a=f.installer.install(id);expect(f.installer.install(id)).toBe(a);const c=(await a)!
 expect(c.python).toBe(join(f.target('shared'),'python/python.exe'));expect(c.runtimeDir).toBe(join(f.target(id),'native'));expect(c.managedRuntime).toMatchObject({root:f.root,runtimeId:id});expect(c.receipt!==undefined).toBe(id.startsWith('vox'))
 const active=JSON.parse(await readFile(c.managedRuntime.receipt,'utf8'));expect(active.components).toEqual(f.catalog.runtimes[id].components.map(component=>({id:component,fingerprint:f.catalog.components[component].archive.sha256})))
 expect(f.installer.snapshot().find(s=>s.id===id)).toMatchObject({installed:true,verified:true,phase:'idle'});expect(await f.installer.verify(id)).toEqual(c)
 const count=(f.fetcher as any).mock.calls.length;await f.installer.install(id);expect((f.fetcher as any).mock.calls).toHaveLength(count)
})
it('uses only pinned bundled archives and shares Python/VC/CUDA physically across backends',async()=>{
 const fetcher=vi.fn().mockRejectedValue(Error('network forbidden')),f=await fixture({bundled:true,fetch:fetcher});const q=(await f.installer.install('qwen-cuda'))!,v=(await f.installer.install('vox-cuda'))!
 expect(q.python).toBe(v.python);expect(q.dependencyDirs).toEqual(v.dependencyDirs);expect(fetcher).not.toHaveBeenCalled();expect(await readFile(q.python,'utf8')).toBe('FAKE PYTHON NEVER EXECUTED')
})
it('initialize claims metadata installation but fresh verify detects changed Python before returning a spawn connection',async()=>{
 const f=await fixture(),c=(await f.installer.install('qwen-cuda'))!;await writeFile(c.python,'CORRUPTED PYTHON')
 await expect(f.installer.verify('qwen-cuda')).rejects.toThrow('GGUF_RUNTIME_CHANGED');expect(f.installer.snapshot().find(s=>s.id==='qwen-cuda')?.verified).toBe(false)
})
it('repair replaces owned damaged payload, retires the guarded previous copy and does not download healthy shared groups',async()=>{
 const f=await fixture(),c=(await f.installer.install('qwen-cuda'))!,count=(f.fetcher as any).mock.calls.length;await writeFile(join(c.runtimeDir,'qwen.dll'),'damaged')
 await expect(f.installer.install('qwen-cuda')).rejects.toThrow('GGUF_RUNTIME_CHANGED');const repaired=(await f.installer.repair('qwen-cuda'))!
 expect(await readFile(join(repaired.runtimeDir,'qwen.dll'),'utf8')).toBe('FAKE DLL NEVER LOADED');expect((f.fetcher as any).mock.calls).toHaveLength(count)
 expect((await readdir(dirname(f.target('qwen-cuda')))).some(n=>n.startsWith('.previous-'))).toBe(false)
})
it.each(['extra','link','missing'] as const)('rejects %s ZIP payload and rolls back every dependency without an active receipt',async badZip=>{
 const f=await fixture({badZip});await expect(f.installer.install('qwen-cuda')).rejects.toThrow();expect(f.installer.snapshot().find(s=>s.id==='qwen-cuda')?.installed).toBe(false)
 await expect(lstat(f.target('shared'))).rejects.toThrow();await expect(lstat(join(f.root,'active','qwen-cuda.json'))).rejects.toThrow()
})
it('cancellation before admission is immediate and later explicit retry is healthy',async()=>{
 const f=await fixture(),pending=f.installer.install('qwen-cuda');await f.installer.cancel();expect(await pending).toBeNull();expect(f.fetcher).not.toHaveBeenCalled();expect((await f.installer.install('qwen-cuda'))?.id).toBe('qwen-cuda')
})
it('cancel after publishing the first component rolls back and preserves another backend’s shared dependencies',async()=>{
 let f:Awaited<ReturnType<typeof fixture>>,armed=false,cancel:Promise<void>|undefined
 f=await fixture({observer:()=>{if(armed&&f.installer.snapshot().find(s=>s.id==='qwen-cuda')?.phase==='publishing')cancel=f.installer.cancel('qwen-cuda')}})
 const other=(await f.installer.install('vox-vulkan'))!;armed=true;expect(await f.installer.install('qwen-cuda')).toBeNull();await cancel
 expect(await f.installer.verify('vox-vulkan')).toEqual(other);await expect(lstat(f.target('cuda-redist'))).rejects.toThrow();expect(await readFile(other.python,'utf8')).toContain('FAKE PYTHON')
})
it('cancel at completion restores the previous active receipt and immutable runtime bytes',async()=>{
 const f=await fixture(),old=(await f.installer.install('qwen-cuda'))!,receipt=await readFile(old.managedRuntime.receipt),owner=f.installer as any,original=owner.atomicJson.bind(owner);let cancel:Promise<void>|undefined
 const hook=vi.spyOn(owner,'atomicJson').mockImplementation(async(path,value)=>{await original(path,value);if(path===old.managedRuntime.receipt)cancel=f.installer.cancel('qwen-cuda')})
 expect(await f.installer.install('qwen-cuda')).toBeNull();await cancel;hook.mockRestore()
 expect(await readFile(old.managedRuntime.receipt)).toEqual(receipt);expect(await f.installer.verify('qwen-cuda')).toEqual(old)
})
it('retains an interrupted pinned archive and resumes Range on retry',async()=>{
 let f:Awaited<ReturnType<typeof fixture>>,first=true
 const fetcher=vi.fn(async(url:any,options:any)=>{const bytes=f.archives.get(String(url))!;if(first){first=false;return new Response(new ReadableStream({start(controller){controller.enqueue(bytes.subarray(0,7));options.signal.addEventListener('abort',()=>controller.error(Error('cancelled')),{once:true})}}))}const range=options.headers.Range;if(range){expect(range).toBe('bytes=7-');return new Response(new Uint8Array(bytes.subarray(7)),{status:206,headers:{'content-range':`bytes 7-${bytes.length-1}/${bytes.length}`}})}return new Response(new Uint8Array(bytes))}) as typeof fetch
 f=await fixture({fetch:fetcher});const task=f.installer.install('qwen-cuda');await vi.waitFor(()=>expect(f.installer.snapshot().find(s=>s.id==='qwen-cuda')?.bytes).toBe(7));await f.installer.cancel();expect(await task).toBeNull();expect((await f.installer.install('qwen-cuda'))?.id).toBe('qwen-cuda')
})
it('unknown files or hardlinks revoke repair ownership without touching user files',async()=>{
 const f=await fixture(),c=(await f.installer.install('qwen-cuda'))!,external=join(f.base,'private');await writeFile(external,'PRIVATE')
 await writeFile(join(c.runtimeDir,'user.wav'),'PRIVATE WAV');await expect(f.installer.repair('qwen-cuda')).rejects.toThrow('GGUF_RUNTIME_CHANGED');expect(await readFile(join(c.runtimeDir,'user.wav'),'utf8')).toBe('PRIVATE WAV')
 await rm(join(c.runtimeDir,'user.wav'));await rm(join(c.runtimeDir,'qwen.dll'));await link(external,join(c.runtimeDir,'qwen.dll'));await expect(f.installer.repair('qwen-cuda')).rejects.toThrow('GGUF_RUNTIME_CHANGED');expect(await readFile(external,'utf8')).toBe('PRIVATE')
})
it('rejects symlink root aliases and forged active receipts, preserving the referenced external folder',async()=>{
 const f=await fixture(),external=join(f.base,'external');await mkdir(external);await symlink(external,f.root,'dir');await expect(f.installer.install('qwen-cuda')).rejects.toThrow('GGUF_RUNTIME_CHANGED');expect(await readdir(external)).toEqual([])
 await rm(f.root);const c=(await f.installer.install('qwen-cuda'))!;await writeFile(c.managedRuntime.receipt,JSON.stringify({owner:'external'}));await expect(f.installer.repair('qwen-cuda')).rejects.toThrow('GGUF_RUNTIME_CHANGED')
})
it('deactivation removes only the selected active receipt and preserves all cached/shared dependencies',async()=>{
 const f=await fixture(),q=(await f.installer.install('qwen-cuda'))!,v=(await f.installer.install('vox-cuda'))!;await f.installer.remove('qwen-cuda',path=>rm(path))
 expect(f.installer.snapshot().find(s=>s.id==='qwen-cuda')?.installed).toBe(false);expect(await f.installer.verify('vox-cuda')).toEqual(v);expect(await readFile(q.python,'utf8')).toContain('FAKE PYTHON');expect(await lstat(q.runtimeDir)).toBeTruthy()
 const count=(f.fetcher as any).mock.calls.length;await f.installer.install('qwen-cuda');expect((f.fetcher as any).mock.calls).toHaveLength(count)
})
it('trash rejection restores the selected active receipt',async()=>{
 const f=await fixture(),c=(await f.installer.install('qwen-cuda'))!;await expect(f.installer.remove('qwen-cuda',async()=>{throw Error('OS denied')})).rejects.toThrow('OS denied');expect(await f.installer.verify('qwen-cuda')).toEqual(c)
})
it('pending artifacts and insufficient disk fail closed before fetch or native execution',async()=>{
 const pending=await fixture({pending:'vox-vulkan'});expect(pending.installer.snapshot().find(s=>s.id==='vox-vulkan')).toMatchObject({available:false,blockedReason:'GGUF_RUNTIME_ARTIFACT_PENDING'});await expect(pending.installer.install('vox-vulkan')).rejects.toThrow('GGUF_RUNTIME_ARTIFACT_PENDING');expect(pending.fetcher).not.toHaveBeenCalled()
 const small=await fixture({free:0});await expect(small.installer.install('qwen-cuda')).rejects.toThrow('GGUF_RUNTIME_DISK_SPACE');expect(small.fetcher).not.toHaveBeenCalled()
})
it('source-only catalogs do not claim artifact availability, while intact cached installations still verify',async()=>{
 const f=await fixture({bundled:true});await rm(f.bundles,{recursive:true});await f.installer.initialize();expect(f.installer.snapshot().every(s=>!s.available&&!s.repairAvailable)).toBe(true)
 await expect(f.installer.install('qwen-cuda')).rejects.toThrow('GGUF_RUNTIME_ARTIFACT_PENDING');expect(f.fetcher).not.toHaveBeenCalled()
 const ready=await fixture({bundled:true});const c=(await ready.installer.install('qwen-cuda'))!;await rm(ready.bundles,{recursive:true});await rm(join(ready.root,'downloads'),{recursive:true});await ready.installer.initialize()
 expect(ready.installer.snapshot().find(s=>s.id==='qwen-cuda')).toMatchObject({available:true,repairAvailable:false,installed:true,verified:false});expect(await ready.installer.verify('qwen-cuda')).toEqual(c)
})
it('partial-stage or unknown component receipts are never silently overwritten by an install',async()=>{
 const f=await fixture(),c=f.catalog.components.shared;const receipt=join(f.root,'component-receipts','shared-'+c.archive.sha256+'.json');await mkdir(dirname(receipt),{recursive:true});await writeFile(receipt,'PRIVATE RECEIPT')
 await expect(f.installer.install('qwen-cuda')).rejects.toThrow();expect(await readFile(receipt,'utf8')).toBe('PRIVATE RECEIPT');await expect(lstat(f.target('shared'))).rejects.toThrow()
})
it('throttles progress notifications while always publishing exact final bytes and phase',async()=>{
 let f:Awaited<ReturnType<typeof fixture>>,chunks=0;const observer=vi.fn();vi.spyOn(Date,'now').mockReturnValue(1000)
 const fetcher=vi.fn(async(url:any)=>{const bytes=f.archives.get(String(url))!;return new Response(new ReadableStream({start(controller){for(let offset=0;offset<bytes.length;offset+=8){controller.enqueue(bytes.subarray(offset,offset+8));chunks++}controller.close()}}))}) as typeof fetch
 f=await fixture({fetch:fetcher,observer});await f.installer.install('qwen-cuda');expect(chunks).toBeGreaterThan(40);expect(observer.mock.calls.length).toBeLessThan(20)
 const state=f.installer.snapshot().find(s=>s.id==='qwen-cuda')!;expect(state.bytes).toBe(state.total);expect(state).toMatchObject({phase:'idle',installed:true,verified:true})
})
it.each(['fetch','body'] as const)('normalizes %s socket failures without exposing private messages and retains retryable bytes',async phase=>{
 let f:Awaited<ReturnType<typeof fixture>>,first=true;const socket=Object.assign(Error('PRIVATE SOCKET PATH'),{code:'UND_ERR_SOCKET'})
 const fetcher=vi.fn(async(url:any,options:any)=>{const bytes=f.archives.get(String(url))!;if(first){first=false;if(phase==='fetch')throw TypeError('fetch failed',{cause:socket});return new Response(new ReadableStream({start(controller){controller.enqueue(bytes.subarray(0,7))},pull(controller){controller.error(TypeError('terminated',{cause:socket}))}}))}const range=options.headers.Range,offset=range?Number(/^bytes=(\d+)-$/.exec(range)![1]):0;return new Response(new Uint8Array(bytes.subarray(offset)),{status:range?206:200,headers:range?{'content-range':`bytes ${offset}-${bytes.length-1}/${bytes.length}`}:{}})}) as typeof fetch
 f=await fixture({fetch:fetcher});await expect(f.installer.install('qwen-cuda')).rejects.toThrow('GGUF_RUNTIME_DOWNLOAD_FAILED');expect(f.installer.snapshot().find(s=>s.id==='qwen-cuda')?.error).toBe('GGUF_RUNTIME_DOWNLOAD_FAILED')
 expect((await readFile(join(f.root,'downloads',f.catalog.components.shared.archive.sha256+'.zip'))).length).toBe(phase==='body'?7:0)
 expect((await f.installer.install('qwen-cuda'))?.id).toBe('qwen-cuda')
})
it.each(['access','range','size','hash'] as const)('keeps %s admission failures distinct from socket errors',async failure=>{
 let f:Awaited<ReturnType<typeof fixture>>;const expected={access:'GGUF_RUNTIME_DOWNLOAD_ACCESS',range:'GGUF_RUNTIME_DOWNLOAD_RANGE',size:'GGUF_RUNTIME_DOWNLOAD_SIZE',hash:'GGUF_RUNTIME_CHANGED'}[failure]
 const fetcher=vi.fn(async(url:any)=>{const bytes=f.archives.get(String(url))!;if(failure==='access')return new Response(null,{status:403});if(failure==='range')return new Response(new Uint8Array(bytes),{status:206,headers:{'content-range':`bytes 1-${bytes.length-1}/${bytes.length}`}});return new Response(new Uint8Array(failure==='size'?Buffer.concat([bytes,Buffer.from('extra')]):Buffer.alloc(bytes.length)))}) as typeof fetch
 f=await fixture({fetch:fetcher});await expect(f.installer.install('qwen-cuda')).rejects.toThrow(expected);expect(f.installer.snapshot().find(s=>s.id==='qwen-cuda')?.error).toBe(expected);expect(f.installer.snapshot().find(s=>s.id==='qwen-cuda')?.installed).toBe(false)
})
it('keeps filesystem failures separate and exposes no raw path in the public error',async()=>{
 const f=await fixture();vi.spyOn(f.installer as any,'archive').mockRejectedValue(Object.assign(Error('permission denied PRIVATE PATH'),{code:'EACCES'}))
 await expect(f.installer.install('qwen-cuda')).rejects.toThrow('GGUF_RUNTIME_FILESYSTEM_FAILED');expect(f.installer.snapshot().find(s=>s.id==='qwen-cuda')?.error).toBe('GGUF_RUNTIME_FILESYSTEM_FAILED')
})
it.each([false,true])('preserves unknown stage files and reports cleanup recovery even when cancelled=%s',async cancel=>{
 const f=await fixture();let privateFile='',cancelled:Promise<void>|undefined;vi.spyOn(f.installer as any,'extract').mockImplementation(async(_id,_archive,stage)=>{await mkdir(String(stage),{recursive:true});privateFile=join(String(stage),'user-private.wav');await writeFile(privateFile,'PRIVATE WAV');if(cancel)cancelled=f.installer.cancel('qwen-cuda');throw Error('VOICE_DOWNLOAD_FAILED')})
 await expect(f.installer.install('qwen-cuda')).rejects.toThrow('GGUF_RUNTIME_RECOVERY');await cancelled;expect(f.installer.snapshot().find(s=>s.id==='qwen-cuda')).toMatchObject({installed:false,verified:false,error:'GGUF_RUNTIME_RECOVERY'});expect(await readFile(privateFile,'utf8')).toBe('PRIVATE WAV');await expect(lstat(f.target('shared'))).rejects.toThrow()
})
