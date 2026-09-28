import {it,expect,afterEach,vi} from 'vitest'
import {mkdtemp,mkdir,writeFile,readFile,rename,rm} from 'node:fs/promises'
import {join,dirname} from 'node:path'
import {tmpdir} from 'node:os'
import {VoiceAssetIdentity} from '../electron/main/character-voice/VoiceAssetIdentity'
import {WindowsVoiceInstaller} from '../electron/main/character-voice/WindowsVoiceInstaller'
const roots:string[]=[],identities:VoiceAssetIdentity[]=[]
afterEach(async()=>{for(const i of identities.splice(0))i.close();for(const r of roots.splice(0))await rm(r,{recursive:true,force:true});vi.restoreAllMocks()})
async function fixture(){const root=await mkdtemp(join(tmpdir(),'voice-identity-'));roots.push(root);const model=join(root,'model');await mkdir(model);await writeFile(join(model,'weights'),'test');return{root,model}}
it('binds reuse to policy, canonical roots, file metadata and installation replacement',async()=>{
 const {root,model}=await fixture(),file=join(model,'weights'),identity=new VoiceAssetIdentity('manifest-1',[model],[{path:file,bytes:4}]);identities.push(identity)
 const first=await identity.snapshot();expect(first).not.toBeNull();expect(await identity.snapshot()).toBe(first)
 await writeFile(file,'edit');expect(await identity.snapshot()).not.toBe(first)
 const beforeReplace=await identity.snapshot();await rename(model,join(root,'old'));await mkdir(model);await writeFile(file,'test');expect(await identity.snapshot()).not.toBe(beforeReplace)
 const other=new VoiceAssetIdentity('manifest-2',[model],[{path:file,bytes:4}]);identities.push(other);expect(await other.snapshot()).not.toBe(await identity.snapshot())
 await rm(file);await expect(identity.snapshot()).rejects.toThrow()
})
it('observes runtime changes beyond the per-request metadata list',async()=>{
 const {model}=await fixture();await writeFile(join(model,'library'),'original')
 const identity=new VoiceAssetIdentity('policy',[model],[{path:join(model,'weights')}]);identities.push(identity);const first=await identity.snapshot()
 await writeFile(join(model,'library'),'changed');await vi.waitFor(async()=>expect(await identity.snapshot()).not.toBe(first))
})
it('Windows installed-state discovery performs no hash scan or Python import process',async()=>{
 const {root}=await fixture(),installer=new WindowsVoiceInstaller(root,'/resources',()=>{}),runtime=dirname(dirname(installer.executable))
 await mkdir(runtime,{recursive:true});await writeFile(join(runtime,'install-receipt.json'),JSON.stringify({fingerprint:runtime.split(/[\\/]/).at(-1)}))
 ;(installer as any).status.supported=true
 const metadata=vi.fn(async()=> 'metadata');vi.spyOn(installer as any,'assetIdentity').mockReturnValue({snapshot:metadata,close:()=>{}})
 const run=vi.spyOn(installer as any,'run').mockResolvedValue('{}'),hash=vi.spyOn(installer as any,'checkFile').mockResolvedValue(undefined)
 await installer.initialize();expect(installer.snapshot().installed).toBe(true);expect(metadata).toHaveBeenCalledWith(false);expect(run).not.toHaveBeenCalled();expect(hash).not.toHaveBeenCalled()
 await installer.ready();expect(run).toHaveBeenCalledTimes(1);expect(hash.mock.calls.length).toBeGreaterThan(0)
 await installer.cancel()
})
it('Windows verification cancellation waits for the actual child close event',async()=>{
 const {root}=await fixture(),installer=new WindowsVoiceInstaller(root,'/resources',()=>{}),controller=new AbortController()
 const task=(installer as any).run(process.execPath,['-e','setTimeout(()=>{},30000)'],controller.signal).catch((e:Error)=>e.message)
 controller.abort();expect(await task).toBe('VOICE_INSTALL_CANCELLED')
})
