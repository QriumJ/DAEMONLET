import {afterEach,expect,it} from 'vitest'
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createElement} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
import {CharacterVoiceService} from '../electron/main/character-voice/CharacterVoiceService'
import {VoiceSettings} from '../src/character-chat/VoiceControls'
import {currentVoiceSetupPath,defaultVoiceSetup,isLegacyVoiceModel,voiceSetupPaths} from '../electron/shared/voice-setup-paths'
import type {VoiceSnapshot} from '../electron/shared/character-voice-contract'

const platform=Object.getOwnPropertyDescriptor(process,'platform')!,arch=Object.getOwnPropertyDescriptor(process,'arch')!
const services:CharacterVoiceService[]=[],roots:string[]=[]
// A saved, unavailable WAV binding remains recoverable without inventing a
// trained pack that initialize() would correctly remove from the registry.
const savedVoiceKey='wav-00000000-0000-0000-0000-000000000000@'+'a'.repeat(64)
afterEach(async()=>{for(const s of services.splice(0))await s.close();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});Object.defineProperty(process,'platform',platform);Object.defineProperty(process,'arch',arch)})
async function fixture(saved?:Record<string,unknown>){
 Object.defineProperty(process,'platform',{...platform,value:'win32'});Object.defineProperty(process,'arch',{...arch,value:'x64'})
 const root=await mkdtemp(join(tmpdir(),'voice-setup-path-'));roots.push(root)
 if(saved)await writeFile(join(root,'settings.json'),JSON.stringify({version:1,enabled:false,autoRead:true,volume:.5,bindings:{character:savedVoiceKey},...saved}))
 const s=new CharacterVoiceService(root,'/never-run-worker',()=>({character:{id:'character'}}) as any,()=>{},()=>{});services.push(s);await s.initialize();return {s,root}
}
it('new Windows x64 defaults to Qwen Base GGUF without enabling or downloading anything',async()=>{
 const f=await fixture();expect(f.s.snapshot()).toMatchObject({engine:'qwen3-tts-06b-gguf',executionProfile:'qwen-gguf',enabled:false,runtimeConfigured:false,platform:'win32',arch:'x64',engineReady:false})
 expect(defaultVoiceSetup('win32','x64')).toEqual({engine:'qwen3-tts-06b-gguf',profile:'qwen-gguf'})
 expect(voiceSetupPaths('linux','x64')).toEqual([])
})
it.each([
 {executionProfile:'cached'},
 {engine:'voxcpm2',executionProfile:'compiled',baseExecutionProfile:'cuda-compiled-complete'},
 {engine:'qwen3-tts-06b',executionProfile:'baseline',qwenRuntime:{python:'/kept/python',model:'/kept/model'}},
 {engine:'qwen3-tts-06b-gguf',executionProfile:'baseline',qwenGgufExecutionProfile:'qwen-gguf-vulkan-complete'},
])('restores existing choices including older settings with no engine: %j',async saved=>{
 const f=await fixture(saved);expect(f.s.snapshot().engine).toBe(saved.engine??'voxcpm2');expect(f.s.snapshot().bindings).toEqual({character:savedVoiceKey})
 expect(f.s.snapshot().executionProfile).toBe(saved.engine==='qwen3-tts-06b'?'qwen-complete':saved.engine==='qwen3-tts-06b-gguf'?'qwen-gguf-vulkan-complete':saved.executionProfile)
})
it('one explicit route change persists engine/profile together and keeps bindings and alternate connections',async()=>{
 const f=await fixture({engine:'voxcpm2',executionProfile:'cached',runtime:{python:'/legacy/python',model:'/legacy/model'},qwenRuntime:{python:'/old/qwen',model:'/old/model'}})
 await f.s.selectVoicePath('qwen-gguf');const saved=JSON.parse(await readFile(join(f.root,'settings.json'),'utf8'))
 expect(saved).toMatchObject({engine:'qwen3-tts-06b-gguf',qwenGgufExecutionProfile:'qwen-gguf',enabled:false,bindings:{character:savedVoiceKey},runtime:{model:'/legacy/model'},qwenRuntime:{model:'/old/model'}})
 await f.s.selectVoicePath('vox-legacy');expect(f.s.snapshot()).toMatchObject({engine:'voxcpm2',executionProfile:'compiled',runtimeConfigured:true})
 expect(()=>f.s.selectVoicePath('vox-metal')).toThrow('VOICE_ACTION')
})
it('Mac Metal and MLX are current paths and their managed models are not legacy',()=>{
 expect(voiceSetupPaths('darwin','arm64').map(path=>[path.id,path.legacy])).toEqual([['vox-metal',false],['qwen-mlx',false]])
 expect(defaultVoiceSetup('darwin','arm64')).toEqual({engine:'voxcpm2',profile:'gguf-metal-f16'})
 expect(isLegacyVoiceModel('qwen3-tts-06b','darwin')).toBe(false);expect(isLegacyVoiceModel('voxcpm2-base','darwin')).toBe(false)
 expect(isLegacyVoiceModel('qwen3-tts-06b','win32')).toBe(true);expect(isLegacyVoiceModel('qwen3-tts-06b-gguf','win32')).toBe(false)
 expect(currentVoiceSetupPath({engine:'qwen3-tts-06b',executionProfile:'qwen-mlx-complete',platform:'darwin'} as VoiceSnapshot)).toBe('qwen-mlx')
})
it('new-user steps expose unavailable runtime honestly and keep legacy/technical options folded',()=>{
 const state:VoiceSnapshot={epoch:0,platform:'win32',arch:'x64',engine:'qwen3-tts-06b-gguf',executionProfile:'qwen-gguf',availableProfiles:['qwen-gguf'],enabled:false,autoRead:true,volume:.5,profiles:[],bindings:{},status:'off',error:null,runtimeConfigured:false,ggufRuntimeInstall:[{id:'qwen-cuda',supported:true,available:false,installed:false,verified:false,phase:'idle',bytes:0,total:12,error:null,blockedReason:'GGUF_RUNTIME_ARTIFACT_PENDING'}]}
 const html=renderToStaticMarkup(createElement(VoiceSettings,{state,act:()=>{},playbackReady:false,characterId:'character'}))
 for(const text of ['음성 엔진 선택','필요한 파일 받기·연결','목소리 선택·추가','시험 재생·적용'])expect(html).toContain(text)
 expect(html).toMatch(/<button[^>]*disabled[^>]*>필요한 파일 받기·연결<\/button>/)
 expect(html).toContain('모델만 받아도 음성이 연결되지 않습니다.');expect(html).toContain('<details class="voice-legacy">');expect(html).toContain('<details class="voice-advanced">')
 expect(html).not.toContain('<details class="voice-legacy" open');expect(html).not.toContain('<details class="voice-advanced" open')
})
