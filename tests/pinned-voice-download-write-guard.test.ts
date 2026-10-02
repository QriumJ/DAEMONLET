import {afterEach,expect,it,vi} from 'vitest'
import {createHash} from 'node:crypto'
import {link,mkdtemp,readFile,realpath,rm,stat,symlink,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {downloadVoiceFile} from '../electron/main/character-voice/PinnedVoiceDownload'
const roots:string[]=[]
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));vi.restoreAllMocks()})
async function fixture(){const root=await realpath(await mkdtemp(join(tmpdir(),'voice-write-guard-')));roots.push(root);const path=join(root,'cache'),external=join(root,'private-original');await writeFile(external,'PRIVATE ORIGINAL');return {root,path,external}}
const data=Buffer.from('abcdef'),file={url:'https://example.invalid/file',bytes:data.length,sha256:createHash('sha256').update(data).digest('hex')}
it.each(['hardlink','symlink'] as const)('rejects a %s replacing an initially absent cache while fetch is pending',async kind=>{
 const f=await fixture(),fetcher=vi.fn(async()=>{await rm(f.path);if(kind==='hardlink')await link(f.external,f.path);else await symlink(f.external,f.path);return new Response(data)}) as unknown as typeof fetch
 await expect(downloadVoiceFile(f.path,file,new AbortController().signal,()=>{},fetcher)).rejects.toThrow('VOICE_BASE_CHANGED');expect(await readFile(f.external,'utf8')).toBe('PRIVATE ORIGINAL')
})
it('a replaced partial cannot be truncated when a server ignores Range',async()=>{
 const f=await fixture();await writeFile(f.path,'abc');const fetcher=vi.fn(async(_url:string,options:any)=>{expect(options.headers.Range).toBe('bytes=3-');await rm(f.path);await link(f.external,f.path);return new Response(data)}) as unknown as typeof fetch
 await expect(downloadVoiceFile(f.path,file,new AbortController().signal,()=>{},fetcher)).rejects.toThrow('VOICE_BASE_CHANGED');expect(await readFile(f.external,'utf8')).toBe('PRIVATE ORIGINAL')
})
it('a replaced partial cannot be appended through a valid 206 response',async()=>{
 const f=await fixture();await writeFile(f.path,'abc');const fetcher=vi.fn(async()=>{await rm(f.path);await link(f.external,f.path);return new Response('def',{status:206,headers:{'content-range':'bytes 3-5/6'}})}) as unknown as typeof fetch
 await expect(downloadVoiceFile(f.path,file,new AbortController().signal,()=>{},fetcher)).rejects.toThrow('VOICE_BASE_CHANGED');expect(await readFile(f.external,'utf8')).toBe('PRIVATE ORIGINAL')
})
it('the existing oversized ordinary cache resets safely and full corrupt cache still requires a clean retry',async()=>{
 const f=await fixture();await writeFile(f.path,'oversized incomplete download');const fetcher=vi.fn(async()=>new Response(data)) as unknown as typeof fetch
 await downloadVoiceFile(f.path,file,new AbortController().signal,()=>{},fetcher);expect(await readFile(f.path)).toEqual(data)
 await writeFile(f.path,'ABCDEF');await expect(downloadVoiceFile(f.path,file,new AbortController().signal,()=>{},fetcher)).rejects.toThrow('VOICE_BASE_CHANGED');await expect(stat(f.path)).rejects.toThrow();expect(await readFile(f.external,'utf8')).toBe('PRIVATE ORIGINAL')
 await downloadVoiceFile(f.path,file,new AbortController().signal,()=>{},fetcher);expect(await readFile(f.path)).toEqual(data)
})
it('cancellation at the initial progress callback never starts network IO and closes its placeholder handle',async()=>{
 const f=await fixture(),controller=new AbortController(),fetcher=vi.fn()
 await expect(downloadVoiceFile(f.path,file,controller.signal,()=>controller.abort(),fetcher as any)).rejects.toThrow();expect(fetcher).not.toHaveBeenCalled();expect((await stat(f.path)).size).toBe(0);await rm(f.path);expect(await readFile(f.external,'utf8')).toBe('PRIVATE ORIGINAL')
})
