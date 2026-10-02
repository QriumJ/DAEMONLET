import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {mkdtemp,readFile,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {CharacterVoiceService} from '../electron/main/character-voice/CharacterVoiceService'
import {isStreamingProfile,type ReferenceVoiceProfile} from '../electron/shared/character-voice-contract'
const platform=Object.getOwnPropertyDescriptor(process,'platform')!,arch=Object.getOwnPropertyDescriptor(process,'arch')!
const cleanup:Array<()=>Promise<unknown>>=[]
beforeEach(()=>{Object.defineProperty(process,'platform',{...platform,value:'win32'});Object.defineProperty(process,'arch',{...arch,value:'x64'})})
afterEach(async()=>{for(const fn of cleanup.splice(0))await fn();Object.defineProperty(process,'platform',platform);Object.defineProperty(process,'arch',arch);vi.restoreAllMocks()})
const reference:ReferenceVoiceProfile={kind:'wav-reference',id:'wav-owned',version:'1',name:'Authorized WAV',fingerprint:'a'.repeat(64),referenceSha256:'b'.repeat(64),reference:{durationMs:4000,sampleRate:24000,channels:1,encoding:'pcm16',samples:96000,bytes:192044}}
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'qwen-gguf-service-')),make=vi.fn(),store={initialize:async()=>{},list:()=>[reference],close:async()=>{}} as any
 const service=new CharacterVoiceService(root,'/worker.py',()=>({character:{id:'character'}}) as any,()=>{},()=>{},make,undefined,undefined,undefined,store)
 await service.initialize();const owner=service as any;owner.state.bindings.character='wav-owned@1';owner.config={python:'/vox/python',model:'/vox/model'};owner.qwenConfig={python:'/torch/python',model:'/torch/model'}
 cleanup.push(async()=>{await service.close();await rm(root,{recursive:true,force:true})})
 return{root,service,owner,make}
}
it('GGUF connection and execution persist separately while preserving existing engines and WAV binding',async()=>{
 const f=await fixture();await f.service.configureQwenGguf('/gguf/python','/gguf/model','/gguf/dll');await f.service.engine('qwen3-tts-06b-gguf');await f.service.executionProfile('qwen-gguf-complete')
 const saved=JSON.parse(await readFile(join(f.root,'settings.json'),'utf8'))
 expect(saved).toMatchObject({engine:'qwen3-tts-06b-gguf',qwenGgufRuntime:{python:'/gguf/python',model:'/gguf/model',ggufRuntime:'/gguf/dll'},runtime:{python:'/vox/python',model:'/vox/model'},qwenRuntime:{python:'/torch/python',model:'/torch/model'},bindings:{character:'wav-owned@1'},qwenGgufExecutionProfile:'qwen-gguf-complete'})
 expect(f.make).not.toHaveBeenCalled();expect(f.service.snapshot()).toMatchObject({qwenConfigured:true,qwenGgufConfigured:true,modelVerification:'full',availableProfiles:['qwen-gguf','qwen-gguf-complete','qwen-gguf-vulkan','qwen-gguf-vulkan-complete']})
 const reopened=new CharacterVoiceService(f.root,'/worker.py',()=>({character:{id:'character'}}) as any,()=>{},()=>{},f.make,undefined,undefined,undefined,{initialize:async()=>{},list:()=>[reference],close:async()=>{}} as any)
 await reopened.initialize();expect(reopened.snapshot()).toMatchObject({engine:'qwen3-tts-06b-gguf',executionProfile:'qwen-gguf-complete',runtimeConfigured:true});await reopened.close()
})
it('GGUF always hashes model weights without changing the PyTorch installed preference',async()=>{
 const f=await fixture();await f.service.modelVerificationPolicy('installed');await f.service.engine('qwen3-tts-06b-gguf');expect(f.service.snapshot().modelVerification).toBe('full')
 expect(()=>f.service.modelVerificationPolicy('installed')).toThrow('VOICE_ACTION');await f.service.engine('qwen3-tts-06b');expect(f.service.snapshot().modelVerification).toBe('installed')
})
it('GGUF rejects a trained LoRA profile as a Qwen reference and never starts a worker',async()=>{
 const f=await fixture();f.owner.state.profiles.push({id:'trained',version:'1',name:'Trained voice',adapterSha256:'c'.repeat(64),fingerprint:'d'.repeat(64)})
 f.owner.state.bindings.character='trained@1';await f.service.configureQwenGguf('/python','/model','/dll');await f.service.engine('qwen3-tts-06b-gguf');await f.service.enabled(true)
 expect(f.service.snapshot()).toMatchObject({runtimeConfigured:false,status:'unavailable',error:'QWEN_REFERENCE_REQUIRED'});await f.service.prepare();expect(f.make).not.toHaveBeenCalled()
})
it('expired configuration owners preserve old connections and report expiration',async()=>{
 const f=await fixture();await f.service.configureQwenGguf('/old/python','/old/model','/old/dll');await f.service.configureQwenGguf('/new/python','/new/model','/new/dll',()=>false)
 expect(f.owner.qwenGgufConfig).toEqual({python:'/old/python',model:'/old/model',ggufRuntime:'/old/dll'});expect(f.service.snapshot().error).toBe('CHAT_SETTINGS_EXPIRED')
})
it('GGUF stays unavailable on Mac and Windows ARM64 while existing Qwen remains selectable',async()=>{
 const f=await fixture();Object.defineProperty(process,'arch',{...arch,value:'arm64'});expect(f.service.snapshot().availableEngines).toEqual(['voxcpm2','qwen3-tts-06b'])
 await f.service.engine('qwen3-tts-06b-gguf');expect(f.service.snapshot().engine).toBe('voxcpm2');expect(f.service.snapshot().error).toBe('VOICE_ACTION')
 Object.defineProperty(process,'platform',{...platform,value:'darwin'});expect(f.service.snapshot().availableEngines).toEqual(['voxcpm2','qwen3-tts-06b'])
})
it('streaming and complete GGUF profiles have explicit playback semantics',()=>{expect(isStreamingProfile('qwen-gguf')).toBe(true);expect(isStreamingProfile('qwen-gguf-complete')).toBe(false)})
