import {afterEach,expect,it,vi} from 'vitest'
import {mkdtemp,mkdir,writeFile,rm,symlink,realpath} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {voiceCapabilities,isStreamingProfile} from '../electron/shared/character-voice-contract'
import {verifyMacInterpreter} from '../electron/main/character-voice/VoiceRuntimeProfile'
import {regularTree,sha256} from '../electron/main/character-voice/VoicePackage'
import {CharacterVoiceService} from '../electron/main/character-voice/CharacterVoiceService'
const roots:string[]=[]
afterEach(async()=>{vi.restoreAllMocks();for(const p of roots.splice(0))await rm(p,{recursive:true,force:true})})
it('exposes only the platform profiles and retains baseline/stream semantics',()=>{
 expect(voiceCapabilities('darwin','arm64')).toEqual(['gguf-metal-f16','gguf-metal-f16-complete'])
 expect(voiceCapabilities('darwin','x64')).toEqual([])
 expect(voiceCapabilities('linux','arm64')).toEqual([])
 expect(voiceCapabilities('win32','x64')).toEqual(['baseline','cached','compiled','cuda-compiled','cuda-compiled-complete'])
 expect(isStreamingProfile('gguf-metal-f16-complete')).toBe(false)
 expect(isStreamingProfile('gguf-metal-f16')).toBe(true)
})
it.skipIf(process.platform!=='darwin')('allows a receipted venv interpreter link but rejects target changes',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'voice-macos-')));roots.push(root)
 await mkdir(join(root,'bin'));await writeFile(join(root,'python-base'),'test-executable');await symlink('../python-base',join(root,'bin/python'))
 const receipt={schemaVersion:2,profile:'macos-arm64-mps-fp32-v1',prefix:root,interpreter:join(root,'python-base'),interpreter_sha256:await sha256(join(root,'python-base'))}
 await writeFile(join(root,'voice-runtime.json'),JSON.stringify(receipt))
 await expect(verifyMacInterpreter(join(root,'bin/python'))).resolves.toEqual({prefix:root,target:join(root,'python-base')})
 await writeFile(join(root,'python-base'),'modified');await expect(verifyMacInterpreter(join(root,'bin/python'))).rejects.toThrow('RUNTIME_RECEIPT')
})
it.skipIf(process.platform!=='darwin')('canonicalizes macOS temporary ancestors but still rejects package links',async()=>{
 const root=await mkdtemp('/tmp/voice-parent-');roots.push(root)
 await writeFile(join(root,'한글 공백.txt'),'test');expect((await regularTree(root)).has('한글 공백.txt')).toBe(true)
 await symlink('/etc',join(root,'escape'));await expect(regularTree(root)).rejects.toThrow('LINK')
})
it.skipIf(process.platform!=='darwin')('disables imported Windows profile and asks for native reconfiguration',async()=>{
 const root=await mkdtemp(join(tmpdir(),'voice-settings-'));roots.push(root)
 await writeFile(join(root,'settings.json'),JSON.stringify({version:1,enabled:true,autoRead:true,volume:0.8,bindings:{},executionProfile:'compiled'}))
 const service=new CharacterVoiceService(root,'/worker',()=>({}) as any,()=>{},()=>{})
 await service.initialize();expect(service.snapshot()).toMatchObject({enabled:false,executionProfile:'gguf-metal-f16',error:'VOICE_PLATFORM_PROFILE'})
 await service.close()
})
