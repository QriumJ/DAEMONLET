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
