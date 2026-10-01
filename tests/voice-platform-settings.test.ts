import {expect,it,vi} from 'vitest'
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {CharacterVoiceService} from '../electron/main/character-voice/CharacterVoiceService'
import type {LocalChatSnapshot} from '../electron/shared/character-chat-contract'
import type {ExecutionProfile} from '../electron/shared/character-voice-contract'

const supported:Array<[string,string,ExecutionProfile]>=[
 ...(['baseline','cached','compiled','cuda-compiled','cuda-compiled-complete'] as const).map(profile=>['win32','x64',profile] as [string,string,ExecutionProfile]),
 ...(['gguf-metal-f16','gguf-metal-f16-complete'] as const).map(profile=>['darwin','arm64',profile] as [string,string,ExecutionProfile]),
]
const unsupported:Array<[string,string,ExecutionProfile]>=[['linux','x64','baseline'],['darwin','x64','gguf-metal-f16'],['darwin','arm64','compiled'],['win32','x64','gguf-metal-f16']]
async function withSettings(host:string,arch:string,profile:ExecutionProfile,seed:'missing'|'invalid'|'valid',run:(service:CharacterVoiceService,path:string,runtime:ReturnType<typeof vi.fn>)=>Promise<void>){
 const platform=Object.getOwnPropertyDescriptor(process,'platform')!,architecture=Object.getOwnPropertyDescriptor(process,'arch')!,root=await mkdtemp(join(tmpdir(),'voice-platform-settings-'))
 let service:CharacterVoiceService|undefined
 try{
  Object.defineProperty(process,'platform',{value:host,configurable:true});Object.defineProperty(process,'arch',{value:arch,configurable:true})
  const path=join(root,'settings.json'),settings={version:1,enabled:true,autoRead:false,volume:.35,bindings:{},executionProfile:profile,...(seed==='missing'?{}:{seedSettings:{mode:'fixed',fixedSeed:seed==='invalid'?true:17}})}
  await writeFile(path,JSON.stringify(settings));const runtime=vi.fn()
  service=new CharacterVoiceService(root,'/worker',()=>({} as LocalChatSnapshot),()=>{},()=>{},runtime)
  await service.initialize();await run(service,path,runtime)
 }finally{await service?.close();Object.defineProperty(process,'platform',platform);Object.defineProperty(process,'arch',architecture);await rm(root,{recursive:true,force:true})}
}
for(const [host,arch,profile] of supported)for(const seed of ['missing','invalid','valid'] as const)it(`${host}/${arch}/${profile}: restores supported settings with ${seed} seed fields`,async()=>{
 await withSettings(host,arch,profile,seed,async(service,path,runtime)=>{
  expect(service.snapshot()).toMatchObject({enabled:true,autoRead:false,volume:.35,seedError:seed==='invalid'})
  if(seed==='missing')expect(service.snapshot().seedSettings).toEqual({mode:'random-per-reply',fixedSeed:42})
  if(seed==='valid')expect(service.snapshot().seedSettings).toEqual({mode:'fixed',fixedSeed:17})
  if(seed==='invalid'){expect(service.snapshot().error).toBe('VOICE_SEED_SETTINGS');await service.seedSettings({mode:'fixed',fixedSeed:42});expect(service.snapshot()).toMatchObject({enabled:true,seedError:false,seedSettings:{mode:'fixed',fixedSeed:42}})}
  await service.enabled(false);expect(service.snapshot().enabled).toBe(false);await service.enabled(true);expect(service.snapshot().enabled).toBe(true)
  expect(JSON.parse(await readFile(path,'utf8'))).toMatchObject({enabled:true,autoRead:false,volume:.35});expect(runtime).not.toHaveBeenCalled()
 })
})
for(const [host,arch,profile] of unsupported)for(const seed of ['missing','invalid','valid'] as const)it(`${host}/${arch}/${profile}: safely disables incompatible settings with ${seed} seed fields`,async()=>{
 await withSettings(host,arch,profile,seed,async(service,_path,runtime)=>{
  expect(service.snapshot()).toMatchObject({enabled:false,autoRead:false,volume:.35,seedError:seed==='invalid',error:seed==='invalid'?'VOICE_SEED_SETTINGS':'VOICE_PLATFORM_PROFILE'})
  if(seed==='missing')expect(service.snapshot().seedSettings).toEqual({mode:'random-per-reply',fixedSeed:42})
  if(seed==='invalid'){await service.seedSettings({mode:'fixed',fixedSeed:42});expect(service.snapshot()).toMatchObject({enabled:false,seedError:false,error:'VOICE_PLATFORM_PROFILE'})}
  expect(runtime).not.toHaveBeenCalled()
 })
})
it.each([['linux','x64'],['darwin','x64']])('%s/%s: activation cannot persist an enabled state without supported profiles',async(host,arch)=>{
 await withSettings(host,arch,'baseline','valid',async(service,path,runtime)=>{
  const saved=await readFile(path,'utf8');await service.enabled(true)
  expect(service.snapshot()).toMatchObject({enabled:false,error:'UNSUPPORTED_DEVICE'});expect(await readFile(path,'utf8')).toBe(saved);expect(runtime).not.toHaveBeenCalled()
  await service.enabled(false);expect(service.snapshot()).toMatchObject({enabled:false,error:null});expect(JSON.parse(await readFile(path,'utf8')).enabled).toBe(false)
 })
})
