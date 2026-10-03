import {afterEach,expect,it} from 'vitest'
import {createHash} from 'node:crypto'
import {link,mkdir,mkdtemp,readFile,readdir,realpath,rm,symlink,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {managedRuntimeArchivePins,managedRuntimeArchivesName,managedRuntimeCatalogName,stageManagedRuntimeArchives,verifyManagedRuntimeArchives,verifyManagedRuntimeBuildReport,verifyPackagedManagedRuntime} from '../scripts/release/managed-runtime-assets.mjs'

const roots:string[]=[]
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true})})
const ids=['qwen-cuda','qwen-vulkan','vox-cuda','vox-vulkan']
const digest=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex')
async function fixture(archives=true){
 const root=await realpath(await mkdtemp(join(tmpdir(),'managed-runtime-assets-')));roots.push(root)
 const source=join(root,'.generated/voice-gguf-runtime/win32-x64/archives'),voice=join(root,'dist-electron/voice')
 const payload:Record<string,Buffer>={},catalog:any={schemaVersion:1,platform:'win32-x64',components:{},runtimes:{}}
 for(const id of ['shared','cuda-redist',...ids]){
  const name=id+'-win32-x64.zip',bytes=Buffer.from('PK-SYNTHETIC-ARCHIVE-DATA-ONLY-'+id)
  payload[name]=bytes
  catalog.components[id]={id,archive:{name,bundledPath:name,format:'zip',bytes:bytes.length,sha256:digest(bytes)},files:{'licenses/test.txt':{bytes:1,sha256:'1'.repeat(64)}},provenance:{kind:'synthetic-test-only'}}
 }
 for(const id of ids)catalog.runtimes[id]={id,available:true,components:['shared',...(id.endsWith('cuda')?['cuda-redist']:[]),id]}
 await mkdir(join(root,'electron/voice'),{recursive:true});await mkdir(voice,{recursive:true})
 const catalogBytes=Buffer.from(JSON.stringify(catalog)+'\n')
 await writeFile(join(root,'electron/voice',managedRuntimeCatalogName),catalogBytes);await writeFile(join(voice,managedRuntimeCatalogName),catalogBytes)
 const policy=JSON.stringify({managedRuntimeCatalog:{filename:managedRuntimeCatalogName,bytes:catalogBytes.length,sha256:digest(catalogBytes)}})+'\n'
 for(const name of ['runtime-qwen-gguf-windows.json','runtime-gguf-windows-voxcpm2.json'])for(const directory of [join(root,'electron/voice'),voice])await writeFile(join(directory,name),policy)
 if(archives){await mkdir(source,{recursive:true});for(const [name,bytes] of Object.entries(payload))await writeFile(join(source,name),bytes)}
 return {root,source,voice,catalog,payload,pins:managedRuntimeArchivePins(catalog),stage:(production=true,target='win32-x64')=>stageManagedRuntimeArchives(root,voice,{production,target})}
}
it('copies all fixed archives outside ASAR and verifies both source and destination without executing payloads',async()=>{
 const f=await fixture(),result=await f.stage()
 expect(result).toMatchObject({schemaVersion:1,target:'win32-x64',status:'bundled',archives:6,cleanHostVerified:false,publicReleaseApproved:false})
 expect(result.bytes).toBe(Object.values(f.payload).reduce((n,b)=>n+b.length,0))
 expect((await readdir(join(f.voice,managedRuntimeArchivesName))).sort()).toEqual(Object.keys(f.payload).sort())
 for(const [name,bytes] of Object.entries(f.payload)){expect(await readFile(join(f.source,name))).toEqual(bytes);expect(await readFile(join(f.voice,managedRuntimeArchivesName,name))).toEqual(bytes)}
 expect(await verifyPackagedManagedRuntime(f.voice,'win32-x64',{trustedCatalogPath:join(f.root,'electron/voice',managedRuntimeCatalogName)})).toMatchObject({status:'bundled',archives:6})
})
it('permits a clearly marked source-only Windows build while production requires every archive',async()=>{
 const f=await fixture(false)
 expect(await f.stage(false)).toMatchObject({status:'source-only-runtime-unavailable',archives:0,bytes:0,cleanHostVerified:false})
 await expect(f.stage()).rejects.toThrow('GGUF_RUNTIME_PACKAGE_NOT_READY: missing archive')
 await expect(readdir(join(f.voice,managedRuntimeArchivesName))).rejects.toThrow()
})
it('permits explicit production source CI without letting its ASAR or voice output become a package candidate',async()=>{
 const f=await fixture(false)
 const result=await stageManagedRuntimeArchives(f.root,f.voice,{target:'win32-x64',production:true,sourceOnlyRuntime:true})
 const bytes=await readFile(join(f.voice,managedRuntimeCatalogName))
 expect(result).toMatchObject({status:'source-only-runtime-unavailable',sourceOnlyRuntime:true,archives:0,bytes:0,cleanHostVerified:false})
 expect(()=>verifyManagedRuntimeBuildReport(result,bytes,{sourceOnlyRuntime:true})).not.toThrow()
 expect(()=>verifyManagedRuntimeBuildReport(result,bytes)).toThrow('cannot become a Windows installer candidate')
 await expect(verifyPackagedManagedRuntime(f.voice,'win32-x64')).rejects.toThrow('missing archive')
 for(const patch of [{sourceOnlyRuntime:false},{archives:1},{bytes:1},{catalogSha256:'0'.repeat(64)},{status:'bundled'}]){
  expect(()=>verifyManagedRuntimeBuildReport({...result,...patch},bytes,{sourceOnlyRuntime:true})).toThrow('GGUF_RUNTIME_PACKAGE_NOT_READY')
 }
})
it.each(['missing','same-size-tamper','unlisted','hardlink','directory-alias'] as const)('production source CI still rejects an existing %s archive set',async kind=>{
 const f=await fixture(),pin=f.pins[0],path=join(f.source,pin.name)
 if(kind==='missing')await rm(path)
 if(kind==='same-size-tamper')await writeFile(path,Buffer.alloc(pin.bytes))
 if(kind==='unlisted')await writeFile(join(f.source,'extra.zip'),'unlisted')
 if(kind==='hardlink'){const outside=join(f.root,'outside');await writeFile(outside,f.payload[pin.name]);await rm(path);await link(outside,path)}
 if(kind==='directory-alias'){const actual=join(f.root,'actual-archives');await mkdir(actual);for(const [name,bytes] of Object.entries(f.payload))await writeFile(join(actual,name),bytes);await rm(f.source,{recursive:true});await symlink(actual,f.source,'junction')}
 await expect(stageManagedRuntimeArchives(f.root,f.voice,{target:'win32-x64',production:true,sourceOnlyRuntime:true})).rejects.toThrow('GGUF_RUNTIME_PACKAGE_NOT_READY')
 await expect(readdir(join(f.voice,managedRuntimeArchivesName))).rejects.toThrow()
})
it('does not treat absent archives under a linked parent as an unavailable source CI input',async()=>{
 const f=await fixture(false),outside=join(f.root,'outside-generated')
 await mkdir(outside);await symlink(outside,join(f.root,'.generated'),'junction')
 await expect(stageManagedRuntimeArchives(f.root,f.voice,{target:'win32-x64',production:true,sourceOnlyRuntime:true})).rejects.toThrow('archive directory is linked')
})
it('does not require or bundle Windows native archives for a Mac build',async()=>{
 const f=await fixture(false);await rm(join(f.root,'electron/voice',managedRuntimeCatalogName))
 expect(await f.stage(true,'darwin-arm64')).toMatchObject({target:'darwin-arm64',status:'not-required',archives:0})
 expect(await verifyPackagedManagedRuntime(f.voice,'darwin-arm64')).toMatchObject({status:'not-required'})
 await expect(readdir(join(f.voice,managedRuntimeArchivesName))).rejects.toThrow()
})
it.each(['missing','same-size-tamper','wrong-size','unlisted'] as const)('rejects %s archive sets before publishing any output',async kind=>{
 const f=await fixture(),pin=f.pins[0],path=join(f.source,pin.name)
 if(kind==='missing')await rm(path)
 if(kind==='same-size-tamper')await writeFile(path,Buffer.alloc(pin.bytes))
 if(kind==='wrong-size')await writeFile(path,'short')
 if(kind==='unlisted')await writeFile(join(f.source,'model.gguf'),'never bundle weights')
 await expect(f.stage()).rejects.toThrow('GGUF_RUNTIME_PACKAGE_NOT_READY')
 await expect(readdir(join(f.voice,managedRuntimeArchivesName))).rejects.toThrow()
 expect((await readdir(f.voice)).some(name=>name.startsWith('.managed-gguf-archives-'))).toBe(false)
})
it.each(['symlink','hardlink'] as const)('rejects a %s substituted archive and preserves outside bytes',async kind=>{
 const f=await fixture(),pin=f.pins[0],path=join(f.source,pin.name),external=join(f.root,'outside')
 await writeFile(external,f.payload[pin.name]);await rm(path)
 if(kind==='symlink')await symlink(external,path);else await link(external,path)
 await expect(f.stage()).rejects.toThrow('GGUF_RUNTIME_PACKAGE_NOT_READY')
 expect(await readFile(external)).toEqual(f.payload[pin.name])
})
it('rejects an archive directory alias',async()=>{
 const f=await fixture(),actual=join(f.root,'actual-archives')
 await mkdir(actual);for(const [name,bytes] of Object.entries(f.payload))await writeFile(join(actual,name),bytes)
 await rm(f.source,{recursive:true});await symlink(actual,f.source,'junction')
 await expect(f.stage()).rejects.toThrow('archive directory is linked')
})
it('preserves an existing archive output rather than overwriting it',async()=>{
 const f=await fixture(),target=join(f.voice,managedRuntimeArchivesName);await mkdir(target);await writeFile(join(target,'user-owned'),'preserve')
 await expect(f.stage()).rejects.toThrow('archive output already exists');expect(await readFile(join(target,'user-owned'),'utf8')).toBe('preserve')
})
it.each(['unavailable','traversal','different-bundled-path','unpinned','unreferenced'] as const)('rejects %s catalog metadata',async kind=>{
 const f=await fixture(),catalog=structuredClone(f.catalog),component=catalog.components.shared
 if(kind==='unavailable')catalog.runtimes['qwen-cuda'].available=false
 if(kind==='traversal')component.archive.name='../outside.zip'
 if(kind==='different-bundled-path')component.archive.bundledPath='other-win32-x64.zip'
 if(kind==='unpinned')component.archive.sha256='0'
 if(kind==='unreferenced')catalog.components.extra=structuredClone(component)
 expect(()=>managedRuntimeArchivePins(catalog)).toThrow('GGUF_RUNTIME_PACKAGE_NOT_READY')
})
it('detects a packaged catalog differing from the source lock',async()=>{
 const f=await fixture();await f.stage();await writeFile(join(f.voice,managedRuntimeCatalogName),JSON.stringify({...f.catalog,note:'different'}))
 await expect(verifyPackagedManagedRuntime(f.voice,'win32-x64',{trustedCatalogPath:join(f.root,'electron/voice',managedRuntimeCatalogName)})).rejects.toThrow('catalog differs from source')
})
it('rejects checkout newline conversion before staging any runtime archives',async()=>{
 const f=await fixture(),path=join(f.root,'electron/voice',managedRuntimeCatalogName)
 await writeFile(path,(await readFile(path,'utf8')).replaceAll('\n','\r\n'))
 await expect(f.stage()).rejects.toThrow('worker catalog pin differs')
 await expect(readdir(join(f.voice,managedRuntimeArchivesName))).rejects.toThrow()
})
it('rejects a packaged worker policy with a different catalog pin',async()=>{
 const f=await fixture();await f.stage()
 await writeFile(join(f.voice,'runtime-gguf-windows-voxcpm2.json'),JSON.stringify({managedRuntimeCatalog:{}}))
 await expect(verifyPackagedManagedRuntime(f.voice,'win32-x64')).rejects.toThrow('worker catalog pin differs')
})
it('checks every packaged archive again and rejects an unsupported Windows target',async()=>{
 const f=await fixture();await f.stage();await writeFile(join(f.voice,managedRuntimeArchivesName,f.pins[0].name),Buffer.alloc(f.pins[0].bytes))
 await expect(verifyManagedRuntimeArchives(join(f.voice,managedRuntimeArchivesName),f.catalog)).rejects.toThrow('archive SHA')
 await expect(f.stage(true,'win32-arm64')).rejects.toThrow('unsupported Windows target')
 await expect(verifyPackagedManagedRuntime(f.voice,'win32-arm64')).rejects.toThrow('unsupported Windows target')
})
