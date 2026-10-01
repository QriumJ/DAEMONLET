import {afterEach,expect,it,vi} from 'vitest'
import {createHash} from 'node:crypto'
import {gzipSync} from 'node:zlib'
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,symlink} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,dirname} from 'node:path'
import {QwenVoiceInstaller} from '../electron/main/character-voice/QwenVoiceInstaller'
import {extractQwenPython} from '../electron/main/character-voice/QwenArchive'
const clean:Array<()=>Promise<unknown>>=[]
afterEach(async()=>{for(const fn of clean.splice(0))await fn();vi.restoreAllMocks()})
const hash=(body:Buffer)=>createHash('sha256').update(body).digest('hex')
function tar(items:Array<{name:string;body?:string;type?:string;link?:string;size?:number}>){
 const parts:Buffer[]=[]
 for(const item of items){const b=Buffer.from(item.body??''),h=Buffer.alloc(512);h.write(item.name);h.write('0000755\0',100);h.write((item.size??b.length).toString(8).padStart(11,'0')+'\0',124);h.write('        ',148);h.write(item.type??'0',156);if(item.link)h.write(item.link,157);h.write('ustar\0',257);h.write([...h].reduce((a,b)=>a+b,0).toString(8).padStart(6,'0')+'\0 ',148);parts.push(h,b,Buffer.alloc((512-b.length%512)%512))}
 parts.push(Buffer.alloc(1024));return gzipSync(Buffer.concat(parts))
}
async function fixture(windows=false,extra:{run?:Function;fetch?:typeof fetch;free?:number}={}){
 const root=await mkdtemp(join(tmpdir(),'qwen-managed-'));clean.push(()=>rm(root,{recursive:true,force:true}))
 const archive=tar([{name:windows?'python/python.exe':'python/bin/python3.12',body:'pinned fake executable'},...(windows?[{name:'python/Lib/venv/scripts/nt/python.exe',body:'pinned fake executable'}]:[])]),model=Buffer.from('pinned model'),wheel=Buffer.from('pinned wheel')
 const files=new Map([['https://vendor/python',archive],['https://vendor/wheel',wheel],['https://huggingface.co/test/model/resolve/fixed/model.safetensors',model]])
 const asset=(url:string,body:Buffer)=>({url,bytes:body.length,sha256:hash(body)})
 const lock={schemaVersion:1,platform:windows?'win32-x64':'darwin-arm64',minimumFreeBytes:1024,python:{...asset('https://vendor/python',archive),filename:'python.tar.gz',version:windows?'3.11.15':'3.12.13',license:'PSF'},wheels:[{...asset('https://vendor/wheel',wheel),filename:'one.whl',name:'one',version:'1',license:'MIT'}],modelSha256:{'model.safetensors':hash(model)}}
 const policy={engine:'qwen3-tts-06b',model:'test/model',revision:'fixed',license:'Apache-2.0',totalBytes:model.length,files:{'model.safetensors':{bytes:model.length,sha256:hash(model)}}}
 const calls:Array<{command:string;args:string[]}>=[],states:any[]=[]
 const run=async(command:string,args:string[],signal:AbortSignal)=>{
  calls.push({command,args});if(extra.run)await extra.run(command,args,signal)
  if(args.includes('venv')){const env=args.at(-1)!;await mkdir(join(env,windows?'Scripts':'bin'),{recursive:true});await writeFile(join(env,windows?'Scripts/python.exe':'bin/python'),'pinned fake executable')}
  if(args.includes('--downloads')&&!args.includes('--audit-env')){const env=dirname(dirname(command));await writeFile(join(env,'qwen-runtime.json'),'{}');const final=args[args.indexOf('--final-python')+1];await writeFile(join(env,'pyvenv.cfg'),'home = '+dirname(final)+'\ninclude-system-site-packages = false\nversion = '+lock.python.version+'\nexecutable = '+final+'\ncommand = managed Qwen offline installation\n')}
  return 'PASS'
 }
 const fetcher=vi.fn(extra.fetch??(async(url:any)=>new Response(files.get(String(url))!)))
 const installer=new QwenVoiceInstaller(join(root,'managed'),'/resources',()=>states.push(installer.snapshot()),{platform:lock.platform,policy,lock,run,fetch:fetcher,freeBytes:async()=>extra.free??10**9})
 const owner=installer as any
 return {root,installer,owner,files,calls,states,fetcher,model}
}
for(const windows of [false,true]){
 const platform=windows?'Windows':'Mac'
 it(`${platform}: complete staged install, offline helper, restart recognition and existing apply use no inference`,async()=>{
  const f=await fixture(windows);const a=f.installer.install(),b=f.installer.install();expect(a).toBe(b)
  const connection=await a;expect(connection?.python).toContain(windows?join('Scripts','python.exe'):join('bin','python'));expect(await readFile(join(connection!.model,'model.safetensors'))).toEqual(f.model)
  expect(f.installer.snapshot()).toMatchObject({installed:true,phase:'idle',error:null});expect(f.calls.some(c=>c.args.includes('--verify'))).toBe(true)
  expect(f.calls.flatMap(c=>c.args)).not.toEqual(expect.arrayContaining(['prewarm','synthesis','generate','pip']))
  const count=f.fetcher.mock.calls.length;await f.installer.initialize();await f.installer.install();expect(f.fetcher).toHaveBeenCalledTimes(count)
  expect(f.states.map(s=>s.phase)).toEqual(expect.arrayContaining(['downloading','installing','verifying']))
  expect((await readdir(f.installer.root)).filter(n=>n.startsWith('.install-'))).toEqual([])
 })
 it(`${platform}: wrong download hashes never execute Python and retry reuses verified assets`,async()=>{
  const f=await fixture(windows);f.fetcher.mockImplementationOnce(async()=>new Response(Buffer.alloc(f.files.get('https://vendor/python')!.length)))
  await expect(f.installer.install()).rejects.toThrow();expect(f.calls).toEqual([]);expect(f.installer.snapshot().installed).toBe(false)
  await f.installer.install();expect(f.installer.snapshot().installed).toBe(true)
 })
 it(`${platform}: disk admission precedes downloads and execution`,async()=>{
  const f=await fixture(windows,{free:0});await expect(f.installer.install()).rejects.toThrow('VOICE_DISK_SPACE');expect(f.fetcher).not.toHaveBeenCalled();expect(f.calls).toEqual([])
 })
 it(`${platform}: immediate cancel prevents all IO and allows one explicit retry`,async()=>{
  const f=await fixture(windows),pending=f.installer.install();await f.installer.cancel();expect(await pending).toBeNull();expect(f.fetcher).not.toHaveBeenCalled();await f.installer.install();expect(f.installer.snapshot().installed).toBe(true)
 })
 it(`${platform}: cancel waits for owned installer child cleanup before deleting stage`,async()=>{
  let entered!:()=>void,release!:()=>void;const started=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r)
  const f=await fixture(windows,{run:async(_c:string,args:string[],signal:AbortSignal)=>{if(!args.includes('--downloads'))return;entered();await gate;signal.throwIfAborted()}})
  const job=f.installer.install();await started;let returned=false;const cancelled=f.installer.cancel().then(()=>returned=true);await new Promise(r=>setImmediate(r));expect(returned).toBe(false)
  expect((await readdir(f.installer.root)).some(n=>n.startsWith('.install-'))).toBe(true);release();await cancelled;expect(await job).toBeNull();expect((await readdir(f.installer.root)).some(n=>n.startsWith('.install-'))).toBe(false)
 })
 it(`${platform}: commit verification failure restores previous bundle and retains its bytes`,async()=>{
  const f=await fixture(windows);await f.installer.install();const target=f.owner.target;await writeFile(join(target,'owner-marker'),'previous')
  f.owner.state.installed=false
  const check=vi.spyOn(f.owner,'check').mockRejectedValueOnce(Error('QWEN_RUNTIME_CHANGED'))
  await expect(f.installer.install()).rejects.toThrow('QWEN_RUNTIME_CHANGED');expect(check).toHaveBeenCalled();expect(await readFile(join(target,'owner-marker'),'utf8')).toBe('previous')
 })
 it(`${platform}: root/model/cache links are rejected without writing through them`,async()=>{
  const f=await fixture(windows),outside=join(f.root,'outside');await mkdir(outside);await symlink(outside,f.installer.root,'dir')
  await expect(f.installer.install()).rejects.toThrow('QWEN_INSTALL_CHANGED');expect(await readdir(outside)).toEqual([]);expect(f.fetcher).not.toHaveBeenCalled()
 })
 it(`${platform}: reusing a regular verified model preserves source and avoids its network request`,async()=>{
  const f=await fixture(windows),source=join(f.root,'external-model');await mkdir(source);await writeFile(join(source,'model.safetensors'),f.model);await f.installer.install(source)
  expect(f.fetcher.mock.calls.map(c=>String(c[0]))).not.toContain('https://huggingface.co/test/model/resolve/fixed/model.safetensors');expect(await readFile(join(source,'model.safetensors'))).toEqual(f.model)
 })
}

it.each([
 [{name:'python/../../outside',body:'bad'}],
 [{name:'python/link',type:'2',link:'../../outside'}],
 [{name:'python/escape',type:'2',link:'dir'},{name:'python/escape/payload',body:'bad'}],
 [{name:'python/FILE',body:'first'},{name:'python/file',body:'second'}],
 [{name:'python/huge',size:513*1024**2}],
 [{name:'python/fifo',type:'6'}],
].map(items=>({items})))('portable Python archive rejects traversal, links-as-parents, duplicates and bombs: %j',async({items})=>{
 const root=await mkdtemp(join(tmpdir(),'qwen-archive-'));clean.push(()=>rm(root,{recursive:true,force:true}));const archive=join(root,'python.tar.gz'),target=join(root,'stage');await writeFile(archive,tar(items as any));await mkdir(target)
 await expect(extractQwenPython(archive,target,new AbortController().signal)).rejects.toThrow()
})
