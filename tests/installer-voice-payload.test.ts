import {afterAll,beforeAll,describe,expect,it} from 'vitest'
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createHash} from 'node:crypto'
import {build} from 'esbuild'
import {createPackage} from '@electron/asar'
import {checkInstallerPayload,voiceRuntimeFiles} from '../scripts/release/installer-payload.mjs'
import {managedRuntimeArchivePins} from '../scripts/release/managed-runtime-assets.mjs'

describe('Windows installer TTS payload',()=>{
 let root:string,asar:string,files:Array<{path:string;bytes:number;sha256:string}>
 beforeAll(async()=>{
  root=await mkdtemp(join(tmpdir(),'installer-voice-'));asar=join(root,'app.asar');files=[]
  await mkdir(join(root,'stage/dist-electron/voice'),{recursive:true})
  for(const name of voiceRuntimeFiles){
   const bytes=name==='reference-import-worker.cjs'?Buffer.from((await build({entryPoints:['electron/utility/reference-import-worker.ts'],bundle:true,platform:'node',format:'cjs',write:false})).outputFiles[0].contents):await readFile(join('electron/voice',name))
   await writeFile(join(root,'stage/dist-electron/voice',name),bytes)
   files.push({path:'resources/voice/'+name,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')})
  }
  const catalog=JSON.parse(await readFile(join('electron/voice','managed-gguf-runtime-catalog.json'),'utf8'))
  for(const pin of managedRuntimeArchivePins(catalog))files.push({path:'resources/voice/managed-gguf-runtime-archives/'+pin.name,bytes:pin.bytes,sha256:pin.sha256})
  await createPackage(join(root,'stage'),asar)
 })
 afterAll(async()=>{await rm(root,{recursive:true,force:true})})
 it('ships the CPU full-check worker as an ASAR-bound runtime resource',()=>{expect(voiceRuntimeFiles).toContain('windows_model_check.py');expect(files.some(f=>f.path==='resources/voice/windows_model_check.py'&&f.bytes>0)).toBe(true);expect(()=>checkInstallerPayload(files.filter(f=>f.path!=='resources/voice/windows_model_check.py'),asar)).toThrow('Missing')})
 it('ships the GGUF worker, ABI and fixed policy with matching packaged bytes',()=>{for(const name of ['qwen_gguf_worker.py','qwen_gguf_abi.py','runtime-qwen-gguf-windows.json','voxcpm_windows_gguf_worker.py','voxcpm_windows_gguf_runtime.py','runtime-gguf-windows-voxcpm2.json']){expect(voiceRuntimeFiles).toContain(name);expect(files.find(f=>f.path==='resources/voice/'+name)?.bytes).toBeGreaterThan(0)}})
 it('ships managed admission and its fixed catalog as ASAR-bound resources',()=>{for(const name of ['managed_gguf_runtime.py','managed-gguf-runtime-catalog.json'])expect(voiceRuntimeFiles).toContain(name)})
 it('accepts the complete production workers with exact ASAR bytes',()=>expect(()=>checkInstallerPayload(files,asar)).not.toThrow())
 it('rejects altered workers even at an allowed path',()=>expect(()=>checkInstallerPayload(files.map((f,i)=>i===0?{...f,sha256:'0'.repeat(64)}:f),asar)).toThrow('differs'))
 it('rejects missing runtime files',()=>expect(()=>checkInstallerPayload(files.slice(1),asar)).toThrow('Missing'))
 it('rejects duplicate runtime files',()=>expect(()=>checkInstallerPayload([...files,files[0]],asar)).toThrow('Duplicate'))
 it('requires every fixed archive in the installer inventory',()=>expect(()=>checkInstallerPayload(files.filter(f=>!f.path.includes('/managed-gguf-runtime-archives/shared-')),asar)).toThrow('GGUF_RUNTIME_PACKAGE_NOT_READY: Missing'))
 it.each(['sha256','bytes'] as const)('rejects a runtime archive with different %s',field=>{
  expect(()=>checkInstallerPayload(files.map(f=>f.path.includes('/managed-gguf-runtime-archives/shared-')?{...f,[field]:field==='bytes'?f.bytes+1:'0'.repeat(64)}:f),asar)).toThrow('differs from packaged catalog')
 })
 it('rejects a duplicated runtime archive',()=>expect(()=>checkInstallerPayload([...files,files.find(f=>f.path.includes('/managed-gguf-runtime-archives/shared-'))!],asar)).toThrow('Duplicate managed'))
 it.each(['resources/voice/ab_vox_worker.py','resources/voice/extra.py','resources/voice/subdir/worker.py','resources/voice/runtime-unknown.json','resources/tools/worker.py','scripts/author.py','resources/voice/__pycache__/worker.pyc','resources/models/model.gguf','resources/voice/belle.petchar','resources/voice/managed-gguf-runtime-archives/unlisted.zip','resources/voice/managed-gguf-runtime-archives/python.exe'])(
  'still rejects %s',path=>expect(()=>checkInstallerPayload([...files,{path,bytes:1,sha256:'0'.repeat(64)}],asar)).toThrow('Authoring'))
})
