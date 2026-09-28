import {afterAll,beforeAll,describe,expect,it} from 'vitest'
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createHash} from 'node:crypto'
import {build} from 'esbuild'
import {createPackage} from '@electron/asar'
import {checkInstallerPayload,voiceRuntimeFiles} from '../scripts/release/installer-payload.mjs'

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
  await createPackage(join(root,'stage'),asar)
 })
 afterAll(async()=>{await rm(root,{recursive:true,force:true})})
 it('accepts the complete production workers with exact ASAR bytes',()=>expect(()=>checkInstallerPayload(files,asar)).not.toThrow())
 it('rejects altered workers even at an allowed path',()=>expect(()=>checkInstallerPayload(files.map((f,i)=>i===0?{...f,sha256:'0'.repeat(64)}:f),asar)).toThrow('differs'))
 it('rejects missing runtime files',()=>expect(()=>checkInstallerPayload(files.slice(1),asar)).toThrow('Missing'))
 it('rejects duplicate runtime files',()=>expect(()=>checkInstallerPayload([...files,files[0]],asar)).toThrow('Duplicate'))
 it.each(['resources/voice/extra.py','resources/voice/subdir/worker.py','resources/voice/runtime-unknown.json','resources/tools/worker.py','scripts/author.py','resources/voice/__pycache__/worker.pyc','resources/models/model.gguf','resources/voice/belle.petchar'])(
  'still rejects %s',path=>expect(()=>checkInstallerPayload([...files,{path,bytes:1,sha256:'0'.repeat(64)}],asar)).toThrow('Authoring'))
})
