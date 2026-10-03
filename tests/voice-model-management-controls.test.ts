import {expect,it} from 'vitest'
import {createElement} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
import {VoiceSettings} from '../src/character-chat/VoiceControls'
import {GGUF_MODEL_CATALOG,type VoiceSnapshot,type ManagedVoiceModelRemoval} from '../electron/shared/character-voice-contract'
const state:VoiceSnapshot={epoch:1,enabled:false,autoRead:false,volume:.5,profiles:[],bindings:{},status:'off',error:null,runtimeConfigured:false,engine:'qwen3-tts-06b-gguf',availableProfiles:['qwen-gguf-vulkan','qwen-gguf-vulkan-complete'],executionProfile:'qwen-gguf-vulkan',modelVerification:'full',ggufInstall:GGUF_MODEL_CATALOG.models.map(model=>({id:model.id,supported:true,installed:false,verified:false,phase:'idle',bytes:0,total:model.totalBytes,error:null,verification:'sha256',runtimeIncluded:false}))}
const render=(value:VoiceSnapshot=state)=>renderToStaticMarkup(createElement(VoiceSettings,{state:value,act:()=>{},playbackReady:false,characterId:'test'}))
const removal:ManagedVoiceModelRemoval={id:'qwen3-tts-06b-gguf',engine:'qwen3-tts-06b-gguf',modelId:'Serveurperso/Qwen3-TTS-GGUF',revision:'pinned-revision',planId:'fresh-plan',totalBytes:1234,directories:[{path:'/sample/app-managed/model',bytes:1000,files:[{relativePath:'model.gguf',bytes:1000}]},{path:'/sample/app-managed/download',bytes:234,files:[{relativePath:'model.gguf',bytes:234}]}]}
it('catalog identifies two public community conversions with hashes, size and separate runtime requirements',()=>{
 const html=render();expect(GGUF_MODEL_CATALOG.sourcePolicy).toBe('explicitly-approved-community-conversions');expect(GGUF_MODEL_CATALOG.models).toHaveLength(2)
 for(const model of GGUF_MODEL_CATALOG.models){expect(html).toContain(model.repository);expect(html).toContain(model.revision);expect(html).toContain(model.license);expect(html).toContain(model.runtimeCommit);for(const file of model.files){expect(html).toContain(file.name);expect(html).toContain(file.sha256)}}
 expect(html).toContain('커뮤니티 변환 모델');expect(html).toContain('직접 배포한 공식 GGUF가 아닙니다.');expect(html).toContain('모델 파일만 내려받습니다.');expect(html).toContain('다운로드만으로 엔진이나 캐릭터 음성을 바꾸지 않습니다.');expect(html).toContain('GGUF 모델 다운로드·설치');expect(html).not.toContain('belle_candidates_6000')
 expect(html).toContain('Qwen GGUF Vulkan · 청크 재생');expect(html).toContain('Qwen GGUF Vulkan · 완성 후 재생');expect(html).toContain('보유한 GGUF 실행 환경 수동 연결');expect(html).toContain('Vulkan 경로는 RTX 4090에서 검증했습니다.')
})
it.each(['preparing','downloading','verifying','publishing'] as const)('GGUF %s shows cancellation and locks competing installation actions',phase=>{
 const html=render({...state,ggufInstall:state.ggufInstall!.map((model,index)=>index?model:{...model,phase,bytes:model.total/2})});expect(html).toContain('<button>GGUF 모델 작업 중단</button>');expect(html).toContain('disabled="">GGUF 모델 다운로드·설치');expect(html).toContain('GGUF 모델 다운로드 진행률')
})
it('receipt detection and full SHA verification have distinct states',()=>{
 const installed=state.ggufInstall!.map(model=>({...model,installed:true,modelPath:'/sample/app-managed/model'}))
 const detected=render({...state,ggufInstall:installed});expect(detected).toContain('GGUF 모델 설치됨');expect(detected).not.toContain('GGUF 모델 SHA-256 검사 완료');expect(detected).toContain('>GGUF 모델 SHA-256 검사</button>')
 const checked=render({...state,ggufInstall:installed.map(model=>({...model,verified:true}))});expect(checked).toContain('GGUF 모델 SHA-256 검사 완료')
})
it('managed model listing exposes exact roots and byte counts while excluding external and private files',()=>{
 const html=render({...state,managedModels:[removal],managedModelRemoval:{busy:false,error:null}});expect(html).toContain(removal.modelId);expect(html).toContain('1,234 bytes');for(const directory of removal.directories)expect(html).toContain(directory.path)
 expect(html).toContain('모델 삭제 대상 확인');expect(html).toContain('외부 모델, 개인 학습 GGUF, 학습팩과 기준 WAV는 목록에 포함하지 않습니다.');expect(html).not.toContain('fresh-plan')
 const busy=render({...state,managedModels:[removal],managedModelRemoval:{busy:true,error:null}});expect(busy).toContain('앱 관리 모델 정리 중');expect(busy).toContain('disabled="">모델 삭제 대상 확인')
})
