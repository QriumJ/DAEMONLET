import {verifyRuntimeTermsDocuments} from '../scripts/release/runtime-terms.mjs'
import {afterEach,expect,it} from 'vitest'
import {mkdtemp,readFile,rm,cp,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {ManagedRuntimeTerms} from '../electron/main/character-voice/ManagedRuntimeTerms'
import catalogJson from '../electron/voice/managed-gguf-runtime-catalog.json'
import policy from '../electron/voice/managed-runtime-terms.json'
import type {GgufRuntimeCatalog} from '../electron/shared/windows-gguf-runtime-catalog'
const roots:string[]=[]
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})))})
async function fixture(){const root=await mkdtemp(join(tmpdir(),'runtime-terms-'));roots.push(root);const docs=join(root,'docs');await cp(resolve('electron/voice/runtime-terms'),docs,{recursive:true});const catalog=structuredClone(catalogJson) as GgufRuntimeCatalog;const create=()=>new ManagedRuntimeTerms(root,docs,catalog);const terms=create();await terms.initialize();return{root,docs,catalog,terms,create}}
it('loads the exact Microsoft DLL scope and original document pins without creating acceptance',async()=>{
 const f=await fixture(),snapshot=f.terms.snapshot('qwen-cuda')
 expect(snapshot).toMatchObject({accepted:false,error:null,documents:[{version:'14.51.36247.0'},{version:'14.40.33810.0 (NumPy)',koreanAvailable:true}],cudaNotice:{id:'cuda-13'}})
 expect(snapshot.documents.flatMap(d=>d.files)).toHaveLength(7)
 expect(()=>f.terms.assertAccepted()).toThrow('GGUF_RUNTIME_TERMS_REQUIRED')
 await expect(readFile(join(f.root,'managed-runtime-terms.json'))).rejects.toMatchObject({code:'ENOENT'})
 expect(f.terms.snapshot('vox-vulkan').cudaNotice).toBeUndefined()
})
it('saves only an explicit exact-scope acceptance and reuses it after restart',async()=>{
 const f=await fixture();await f.terms.accept(f.terms.fingerprint,()=>true)
 expect(()=>f.terms.assertAccepted()).not.toThrow()
 const saved=JSON.parse(await readFile(join(f.root,'managed-runtime-terms.json'),'utf8'));expect(saved).toEqual({version:1,fingerprint:f.terms.fingerprint,acceptedAt:expect.any(String)})
 const reopened=f.create();await reopened.initialize();expect(reopened.snapshot('vox-cuda').accepted).toBe(true)
})
it.each(['stale','expired'])('does not store %s acceptance',async mode=>{
 const f=await fixture();await expect(f.terms.accept(mode==='stale'?'0'.repeat(64):f.terms.fingerprint,()=>mode!=='expired')).rejects.toThrow(mode==='stale'?'GGUF_RUNTIME_TERMS_CHANGED':'CHAT_SETTINGS_EXPIRED')
 await expect(readFile(join(f.root,'managed-runtime-terms.json'))).rejects.toMatchObject({code:'ENOENT'})
 const reopened=f.create();await reopened.initialize();expect(reopened.snapshot('qwen-cuda').accepted).toBe(false)
})
it('rechecks context at the receipt commit point instead of accepting a closed settings page',async()=>{
 const f=await fixture();let calls=0;await expect(f.terms.accept(f.terms.fingerprint,()=>++calls===1)).rejects.toThrow('CHAT_SETTINGS_EXPIRED')
 await expect(readFile(join(f.root,'managed-runtime-terms.json'))).rejects.toMatchObject({code:'ENOENT'})
})
it.each(['wrong-hash','new-file','other-component'])('fails closed on %s Microsoft scope changes despite an old acceptance',async mode=>{
 const f=await fixture();await f.terms.accept(f.terms.fingerprint,()=>true)
 if(mode==='wrong-hash')f.catalog.components.shared.files['vc/vcomp140.dll'].sha256='0'.repeat(64)
 else if(mode==='new-file')f.catalog.components.shared.files['python/extra/vcruntime140.dll']={bytes:1,sha256:'0'.repeat(64)}
 else f.catalog.components['qwen-cuda'].files['native/vcruntime140.dll']={bytes:1,sha256:'0'.repeat(64)}
 const changed=f.create();await changed.initialize();expect(changed.snapshot('qwen-cuda')).toMatchObject({accepted:false,error:'GGUF_RUNTIME_TERMS_CHANGED'});expect(()=>changed.assertAccepted()).toThrow('GGUF_RUNTIME_TERMS_CHANGED')
})
it('rejects changed original bytes and malformed receipts without accepting automatically',async()=>{
 const f=await fixture();await f.terms.accept(f.terms.fingerprint,()=>true)
 await writeFile(join(f.docs,policy.groups[0].original.file),'changed')
 const changed=f.create();await changed.initialize();expect(changed.snapshot('qwen-cuda')).toMatchObject({accepted:false,error:'GGUF_RUNTIME_TERMS_CHANGED'})
 await expect(f.terms.accept(f.terms.fingerprint,()=>true)).rejects.toThrow('GGUF_RUNTIME_TERMS_CHANGED')
 const other=await fixture();await writeFile(join(other.root,'managed-runtime-terms.json'),JSON.stringify({version:1,fingerprint:other.terms.fingerprint,acceptedAt:false}));const malformed=other.create();await malformed.initialize();expect(malformed.snapshot('qwen-cuda').accepted).toBe(false)
})
it('opens only the selected pinned documents as data, including offline originals before acceptance',async()=>{
 const f=await fixture();expect(await f.terms.document('vc-v14-1451','original','qwen-cuda')).toBe(join(f.docs,policy.groups[0].original.file))
 expect(await f.terms.document('vc-2015-2022-1440','korean-original','vox-vulkan')).toBe(join(f.docs,policy.groups[1].koreanOriginal!.file))
 await expect(f.terms.document('../../settings.json','original','qwen-cuda')).rejects.toThrow('VOICE_ACTION')
 await expect(f.terms.document('cuda-13','original','qwen-vulkan')).rejects.toThrow('VOICE_ACTION')
 expect(f.terms.snapshot('qwen-cuda').accepted).toBe(false)
})

it('checks all delivered original documents, including CUDA, during packaging without executable payloads',async()=>{
 expect(await verifyRuntimeTermsDocuments(resolve('electron/voice'))).toMatchObject({documents:7,bytes:expect.any(Number)})
})
