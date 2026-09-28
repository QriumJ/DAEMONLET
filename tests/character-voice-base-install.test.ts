import {afterEach,it,expect,vi} from 'vitest'
import {mkdtemp,rm,mkdir,writeFile,readFile,stat} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {VoiceBaseInstaller} from '../electron/main/character-voice/VoiceBaseInstaller'
import catalog from '../electron/voice/base-model.json'
const roots:string[]=[]
afterEach(async()=>{for(const p of roots.splice(0))await rm(p,{recursive:true,force:true})})
async function setup(fetcher:typeof fetch){
 const root=await mkdtemp(join(tmpdir(),'voice-install-'));roots.push(root)
 const model=structuredClone(catalog);for(const file of Object.values(model.files)){file.bytes=6;file.sha256=createHash('sha256').update('abcdef').digest('hex')}
 const installer=new VoiceBaseInstaller(root,'/unused',()=>{}, {catalog:model,fetch:fetcher,verifyRuntime:async()=>{},freeBytes:async()=>1e10})
 return {root,model,installer}
}
const run=it.skipIf(process.platform!=='darwin'||process.arch!=='arm64')
run('opening voice settings never downloads; install validates both files before publishing',async()=>{
 const fetcher=vi.fn(async()=>new Response('abcdef')) as any;const {installer}=await setup(fetcher)
 await installer.initialize();expect(fetcher).not.toHaveBeenCalled();expect(installer.snapshot().installed).toBe(false)
 await installer.install();expect(fetcher).toHaveBeenCalledTimes(2);expect(installer.snapshot()).toMatchObject({installed:true,phase:'idle',bytes:12,total:12})
 await expect(installer.verify()).resolves.toBe(installer.path)
})
run('resumes an interrupted file and checks the exact range',async()=>{
 const fetcher=vi.fn(async(_url:string,options:any)=>options.headers.Range?new Response('def',{status:206,headers:{'content-range':'bytes 3-5/6'}}):new Response('abcdef')) as any
 const {installer}=await setup(fetcher);await mkdir(installer.path+'.download');await writeFile(join(installer.path+'.download','VoxCPM2-BaseLM-F16.gguf'),'abc')
 await installer.install();expect(fetcher.mock.calls[0][1].headers.Range).toBe('bytes=3-')
 expect(await readFile(join(installer.path,'VoxCPM2-BaseLM-F16.gguf'),'utf8')).toBe('abcdef')
})
run('rejects bad hashes without making a partial model installed',async()=>{
 const {installer}=await setup(vi.fn(async()=>new Response('badbad')) as any)
 await expect(installer.install()).rejects.toThrow('VOICE_BASE_CHANGED');expect(installer.snapshot().installed).toBe(false);await expect(stat(installer.path)).rejects.toThrow()
})
run('rejects a mismatched range and never appends incorrect bytes',async()=>{
 const {installer}=await setup(vi.fn(async()=>new Response('def',{status:206,headers:{'content-range':'bytes 2-4/6'}})) as any)
 await mkdir(installer.path+'.download');const file=join(installer.path+'.download','VoxCPM2-BaseLM-F16.gguf');await writeFile(file,'abc')
 await expect(installer.install()).rejects.toThrow('VOICE_DOWNLOAD_RANGE');expect(await readFile(file,'utf8')).toBe('abc')
})
run('cancels network IO, keeps resumable bytes and permits retry',async()=>{
 let started!:()=>void;const ready=new Promise<void>(r=>{started=r})
 const fetcher=vi.fn((_url:any,{signal}:any)=>new Promise<Response>((_,reject)=>{started();signal.addEventListener('abort',()=>reject(signal.reason),{once:true})})) as any
 const {installer}=await setup(fetcher);const pending=installer.install();await ready;await installer.cancel();await pending
 expect(installer.snapshot()).toMatchObject({phase:'idle',installed:false,error:null});await expect(stat(installer.path)).rejects.toThrow()
 fetcher.mockImplementation(async()=>new Response('abcdef'));await installer.install();expect(installer.snapshot().installed).toBe(true)
})
run('fails closed when an installed model is later modified',async()=>{
 const {installer}=await setup(vi.fn(async()=>new Response('abcdef')) as any);await installer.install()
 await writeFile(join(installer.path,'VoxCPM2-Acoustic-F16.gguf'),'ABCDEF');await expect(installer.ready()).rejects.toThrow('VOICE_BASE_CHANGED')
})

it('pinned downloader materializes verified empty source files without network IO',async()=>{
 const {downloadVoiceFile}=await import('../electron/main/character-voice/PinnedVoiceDownload')
 const root=await mkdtemp(join(tmpdir(),'voice-empty-'));roots.push(root);const path=join(root,'empty.py'),fetcher=vi.fn()
 await downloadVoiceFile(path,{url:'https://example.invalid/empty.py',bytes:0,sha256:createHash('sha256').update('').digest('hex')},new AbortController().signal,()=>{},fetcher as any)
 expect((await stat(path)).size).toBe(0);expect(fetcher).not.toHaveBeenCalled()
})
it('Windows pinned downloads resume verified ranges and reject corrupt bytes',async()=>{
 const {downloadVoiceFile}=await import('../electron/main/character-voice/PinnedVoiceDownload')
 const root=await mkdtemp(join(tmpdir(),'voice-pinned-'));roots.push(root);const path=join(root,'wheel'),signal=new AbortController().signal
 const file={url:'https://example.invalid/wheel',bytes:6,sha256:createHash('sha256').update('abcdef').digest('hex')}
 await writeFile(path,'abc');const fetcher=vi.fn(async()=>new Response('def',{status:206,headers:{'content-range':'bytes 3-5/6'}})) as any
 await downloadVoiceFile(path,file,signal,()=>{},fetcher);expect(fetcher.mock.calls[0][1].headers.Range).toBe('bytes=3-');expect(await readFile(path,'utf8')).toBe('abcdef')
 await writeFile(path,'ABCDEF');await expect(downloadVoiceFile(path,file,signal,()=>{},fetcher)).rejects.toThrow('VOICE_BASE_CHANGED');await expect(stat(path)).rejects.toThrow()
})

run('installed-state discovery never runs native hash verification; loading still does',async()=>{
 const {installer,root,model}=await setup(vi.fn(async()=>new Response('abcdef')) as any);await installer.install()
 const runtime=vi.fn(async()=>{}),fresh=new VoiceBaseInstaller(root,'/unused',()=>{}, {catalog:model,verifyRuntime:runtime})
 const hashes=vi.spyOn(fresh,'verify');await fresh.initialize();expect(fresh.snapshot().installed).toBe(true);expect(runtime).not.toHaveBeenCalled();expect(hashes).not.toHaveBeenCalled()
 await fresh.ready();expect(runtime).toHaveBeenCalledOnce();expect(hashes).toHaveBeenCalledOnce()
 await fresh.cancel()
})
run('Mac verification abort is drained before cancellation returns',async()=>{
 const {root,model}=await setup(vi.fn(async()=>new Response('abcdef')) as any);let entered!:()=>void;const begun=new Promise<void>(r=>entered=r)
 const installer=new VoiceBaseInstaller(root,'/unused',()=>{}, {catalog:model,verifyRuntime:signal=>new Promise((_,reject)=>{entered();signal!.addEventListener('abort',()=>reject(Error('aborted')),{once:true})})})
 const verification=installer.ready().catch(e=>e.message);await begun;await installer.cancelVerification();expect(await verification).toBe('aborted');expect((installer as any).verifying).toBeNull()
})
