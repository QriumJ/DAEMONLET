import {afterEach,expect,it,vi} from 'vitest'
import {createHash} from 'node:crypto'
import {mkdtemp,realpath,mkdir,writeFile,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,dirname,basename} from 'node:path'
import {WindowsGgufRuntimeInstaller,type GgufRuntimeCatalog,type GgufRuntimeId} from '../electron/main/character-voice/WindowsGgufRuntimeInstaller'

const io=vi.hoisted(()=>({enabled:false,active:new Set<string>(),started:[] as string[],maximum:0,
 waiters:new Map<string,()=>void>(),firstRead:new Set<string>(),failure:'' as ''|'open'|'read'|'close'|'stat'}))
vi.mock('node:fs/promises',async original=>{
 const actual=await original<typeof import('node:fs/promises')>()
 return {...actual,open:async(...args:any[])=>{
  const name=basename(String(args[0])),watched=io.enabled&&/^f\d{2}\.bin$/.test(name)
  if(watched){io.started.push(name);if(io.failure==='open'&&name==='f03.bin')throw Error('OPEN_FAILURE')}
  const handle=await (actual.open as any)(...args)
  if(!watched)return handle
  io.active.add(name);io.maximum=Math.max(io.maximum,io.active.size)
  return new Proxy(handle,{get(target,key){
   if(key==='stat'&&io.failure==='stat'&&name==='f03.bin')return async()=>{throw Error('STAT_FAILURE')}
   if(key==='read')return async(...values:any[])=>{
    if(!io.firstRead.has(name)){io.firstRead.add(name);await new Promise<void>(done=>io.waiters.set(name,done))}
    if(io.failure==='read'&&name==='f00.bin')throw Error('READ_FAILURE')
    return target.read(...values)
   }
   if(key==='close')return async()=>{try{await target.close();if(io.failure==='close'&&name==='f00.bin')throw Error('CLOSE_FAILURE')}finally{io.active.delete(name)}}
   const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value
  }})
 }}
})
const clean:Array<()=>Promise<void>>=[]
function release(name?:string){for(const [key,done] of io.waiters)if(!name||key===name){io.waiters.delete(key);done()}}
afterEach(async()=>{release();io.enabled=false;for(const run of clean.splice(0))await run();io.active.clear();io.started=[];io.maximum=0;io.firstRead.clear();io.failure=''})
const sha=(raw:Buffer|string)=>createHash('sha256').update(raw).digest('hex')
const ids:GgufRuntimeId[]=['qwen-cuda','qwen-vulkan','vox-cuda','vox-vulkan']
async function fixture(){
 const base=await realpath(await mkdtemp(join(tmpdir(),'runtime-hash-drain-'))),root=join(base,'rt'),catalog:GgufRuntimeCatalog={schemaVersion:1,components:{},runtimes:{} as any}
 for(const id of ['shared','cuda-redist',...ids]){
  const data:Record<string,Buffer>=id==='shared'?Object.fromEntries(Array.from({length:12},(_,i)=>['python/f'+String(i).padStart(2,'0')+'.bin',Buffer.from('FIXTURE BYTES '+i)]))
   :id==='cuda-redist'?{'cuda/fixture.dll':Buffer.from('NOT CUDA')}:{'native/fixture.dll':Buffer.from('NOT NATIVE'),'meta/native-build.json':Buffer.from('{}')}
  if(id==='shared')data['vc/fixture.dll']=Buffer.from('NOT VC')
  const fingerprint=sha(id),path=join(root,'c',id,fingerprint.slice(0,12))
  catalog.components[id]={id,archive:{name:id+'.zip',format:'zip',bytes:123,sha256:fingerprint},files:Object.fromEntries(Object.entries(data).map(([name,raw])=>[name,{bytes:raw.length,sha256:sha(raw)}])),provenance:{fixture:true}}
  for(const [name,raw] of Object.entries(data)){await mkdir(dirname(join(path,name)),{recursive:true});await writeFile(join(path,name),raw)}
  await mkdir(join(root,'component-receipts'),{recursive:true})
  await writeFile(join(root,'component-receipts',id+'-'+fingerprint+'.json'),JSON.stringify({schemaVersion:1,owner:'daemonlet-managed-gguf-runtime-component',id,fingerprint,provenance:{fixture:true}}))
 }
 for(const id of ids)catalog.runtimes[id]={id,engine:id.startsWith('qwen')?'qwen3-tts-06b-gguf':'voxcpm2',backend:id.endsWith('cuda')?'CUDA0':'Vulkan0',available:true,components:['shared',...(id.endsWith('cuda')?['cuda-redist']:[]),id],python:{component:'shared',path:'python/f00.bin'},native:{component:id,path:'native'},...(id.startsWith('vox')?{receipt:{component:id,path:'meta/native-build.json'}}:{}),dependencyDirs:[{component:'shared',path:'vc'},...(id.endsWith('cuda')?[{component:'cuda-redist',path:'cuda'}]:[])],pythonVersion:'3.11.15'}
 const catalogSha256=sha(JSON.stringify(catalog));await mkdir(join(root,'active'))
 await writeFile(join(root,'.catalog.json'),JSON.stringify({schemaVersion:1,owner:'daemonlet-managed-gguf-runtime-catalog',catalogSha256,layout:'compact-v1'}))
 const active=join(root,'active/qwen-cuda.json')
 await writeFile(active,JSON.stringify({schemaVersion:2,owner:'daemonlet-managed-gguf-runtime',id:'qwen-cuda',catalogSha256,layout:'compact-v1',components:catalog.runtimes['qwen-cuda'].components.map(id=>({id,fingerprint:catalog.components[id].archive.sha256}))}))
 const before=await readFile(active),installer=new WindowsGgufRuntimeInstaller(root,()=>{},{catalog,catalogSha256,layout:'compact-v1',platform:'win32-x64'})
 clean.push(async()=>{await installer.cancel();await rm(base,{recursive:true,force:true})})
 return {installer,active,before,first:join(root,'c/shared',sha('shared').slice(0,12),'python/f00.bin')}
}
function pending(f:Awaited<ReturnType<typeof fixture>>){
 io.enabled=true;let settled=false
 const outcome=f.installer.verify('qwen-cuda').then(value=>({value,error:null as unknown}),error=>({value:null,error})).finally(()=>{settled=true})
 return {outcome,settled:()=>settled}
}
it('bounds full file hashes at four and leaves no open handles before admitting',async()=>{
 const f=await fixture(),p=pending(f)
 await vi.waitFor(()=>expect(io.waiters.size).toBe(4));expect(io.maximum).toBe(4);expect(io.started).toHaveLength(4);expect(p.settled()).toBe(false)
 const drain=setInterval(()=>release(),1)
 try{expect((await p.outcome).value?.id).toBe('qwen-cuda')}finally{clearInterval(drain)}
 expect(io.maximum).toBe(4);expect(io.active.size).toBe(0);expect(io.started).toHaveLength(12);expect(await readFile(f.active)).toEqual(f.before)
})
it.each(['hash','open','read','close','stat','stamp'] as const)('drains in-flight handles after %s failure before rejecting or retrying',async mode=>{
 const f=await fixture();if(mode==='hash'){const raw=await readFile(f.first);raw[0]^=1;await writeFile(f.first,raw)}else if(mode!=='stamp')io.failure=mode
 const p=pending(f),expected=mode==='open'||mode==='stat'?3:4
 await vi.waitFor(()=>expect(io.waiters.size).toBe(expected))
 if(mode==='stamp')await writeFile(f.first,await readFile(f.first))
 if(mode!=='open'&&mode!=='stat'){release('f00.bin');await vi.waitFor(()=>expect(io.active.size).toBe(3))}
 expect(p.settled()).toBe(false);expect(io.started).toHaveLength(4)
 release();expect((await p.outcome).error).toBeTruthy();expect(io.active.size).toBe(0);expect(io.started).toHaveLength(4)
 expect(f.installer.snapshot().find(row=>row.id==='qwen-cuda')?.verified).toBe(false);expect(await readFile(f.active)).toEqual(f.before)
 io.enabled=false;io.failure='';if(mode==='hash')await writeFile(f.first,'FIXTURE BYTES 0')
 expect((await f.installer.verify('qwen-cuda')).id).toBe('qwen-cuda')
})
it('awaits every in-flight handle on cancellation before a subsequent full verify',async()=>{
 const f=await fixture(),p=pending(f);await vi.waitFor(()=>expect(io.waiters.size).toBe(4))
 let cancelled=false;const cancellation=f.installer.cancel('qwen-cuda').then(()=>{cancelled=true})
 release('f00.bin');await vi.waitFor(()=>expect(io.active.size).toBe(3));expect(cancelled).toBe(false);expect(p.settled()).toBe(false)
 release();expect((await p.outcome).error).toBeTruthy();await cancellation
 expect(io.active.size).toBe(0);expect(io.started).toHaveLength(4);expect(await readFile(f.active)).toEqual(f.before)
 io.enabled=false;expect((await f.installer.verify('qwen-cuda')).id).toBe('qwen-cuda')
})
