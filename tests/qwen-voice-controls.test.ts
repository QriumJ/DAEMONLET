import {expect,it} from 'vitest'
import {createElement} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
import {VoiceSettings} from '../src/character-chat/VoiceControls'
import type {VoiceSnapshot} from '../electron/shared/character-voice-contract'
const state:VoiceSnapshot={epoch:1,enabled:true,autoRead:true,volume:.5,profiles:[],bindings:{},status:'idle',error:null,runtimeConfigured:true,engine:'qwen3-tts-06b',availableEngines:['voxcpm2','qwen3-tts-06b'],qwenConfigured:true,qwenClone:{mode:'x-vector',transcript:''},availableProfiles:['qwen-mlx','qwen-mlx-complete'],executionProfile:'qwen-mlx'}
it('Mac settings label real incremental Qwen and offer complete decoding separately',()=>{
 const html=renderToStaticMarkup(createElement(VoiceSettings,{state,act:()=>{},playbackReady:true,characterId:'test'}))
 expect(html).toContain('음성 엔진');expect(html).toContain('Qwen MLX · 청크 재생');expect(html).toContain('Qwen MLX · 완성 후 재생');expect(html).toContain('합성 중 생성되는 음성');expect(html).not.toContain('각 구간의 합성이 끝난 뒤 재생합니다.')
})
it('Windows labels only complete waveform and requires exact transcript for ICL',()=>{
 const html=renderToStaticMarkup(createElement(VoiceSettings,{state:{...state,availableProfiles:['qwen-complete'],executionProfile:'qwen-complete',qwenClone:{mode:'icl',transcript:''}},act:()=>{},playbackReady:true,characterId:'test'}))
 expect(html).toContain('Qwen · 완성 후 재생');expect(html).toContain('각 구간의 합성이 끝난 뒤 재생');expect(html).toContain('기준 WAV의 정확한 문장');expect(html).not.toContain('Qwen MLX · 청크 재생')
})

it('Windows preparation policy explains skipped weights and offers an explicit full check',()=>{
 const html=renderToStaticMarkup(createElement(VoiceSettings,{state:{...state,modelVerification:'installed',availableProfiles:['qwen-complete'],executionProfile:'qwen-complete'},act:()=>{},playbackReady:true}))
 expect(html).toContain('설치 때 검사 · 빠른 준비');expect(html).toContain('설치 후 손상을 모두 발견하지 못합니다.');expect(html).toContain('모델 전체 검사')
 const mac=renderToStaticMarkup(createElement(VoiceSettings,{state,act:()=>{},playbackReady:true}));expect(mac).not.toContain('모델 준비 검사')
})
it('a running full check shows cancellation and disables engine controls',()=>{
 const html=renderToStaticMarkup(createElement(VoiceSettings,{state:{...state,modelVerification:'full',modelCheck:{busy:true,error:null}},act:()=>{},playbackReady:true}))
 expect(html).toContain('모델 전체 검사 중');expect(html).toContain('검사 중단');expect(html).toContain('aria-label="음성 엔진" disabled')
})

it('a damaged managed Vox model offers user-initiated repair rather than a disabled installed button',()=>{
 const html=renderToStaticMarkup(createElement(VoiceSettings,{state:{...state,engine:'voxcpm2',modelVerification:'installed',baseInstall:{supported:true,installed:false,phase:'idle',bytes:0,total:1,error:'VOICE_BASE_CHANGED'},modelCheck:{busy:false,error:'VOICE_MODEL_CHECK_FAILED'}},act:()=>{},playbackReady:true}))
 expect(html).toContain('기본 음성 복구 설치');expect(html).not.toContain('>기본 음성 설치됨</button>')
})

const managed={supported:true,installed:false,repairNeeded:false,phase:'idle' as const,bytes:0,total:1862240384,error:null,model:'mlx-community/Qwen3-TTS-12Hz-0.6B-Base-4bit',modelBytes:1711328624,runtimeBytes:150911760,minimumFreeBytes:8*1024**3,communityConversion:true,license:'Apache-2.0'}
it('Qwen install clearly includes runtime/conversion/space and hides all Vox installation and connection controls',()=>{
 const html=renderToStaticMarkup(createElement(VoiceSettings,{state:{...state,qwenConfigured:false,qwenInstall:managed,baseInstall:{supported:true,installed:false,phase:'idle',bytes:0,total:1,error:null}},act:()=>{},playbackReady:false}))
 for(const text of ['Qwen 다운로드·설치 후 적용','mlx-community MLX 4bit','1.71 GB','0.15 GB','1.86 GB','8 GiB','Python·MLX','말하거나 대화를 열지 않습니다.','WAV 기준 음성'])expect(html).toContain(text)
 expect(html).not.toContain('>TTS 런타임·모델 연결</button>');expect(html).not.toContain('>기본 음성 설치</button>')
})
it.each(['preparing','downloading','installing','verifying','applying'] as const)('Qwen phase %s shows a live status and interruptible cancellation even during a pending page action',phase=>{
 const html=renderToStaticMarkup(createElement(VoiceSettings,{state:{...state,qwenInstall:{...managed,phase,bytes:managed.total/2}},act:()=>{},playbackReady:false,busy:true}))
 expect(html).toContain('aria-live="polite"');expect(html).toContain('<button>Qwen 설치 중단</button>');expect(html).toContain('aria-label="음성 엔진" disabled');expect(html).not.toContain('>Qwen 다운로드·설치 후 적용</button>')
 if(phase==='downloading')expect(html).toContain('50%');else expect(html).not.toContain('50%')
})
it('installed, repair, retry and deferred registration offer the correct explicit operation',()=>{
 for(const [install,label] of [[{...managed,installed:true},'설치된 Qwen 적용'],[{...managed,repairNeeded:true,error:'QWEN_INSTALL_CHANGED'},'Qwen 복구 설치 후 적용'],[{...managed,error:'VOICE_DOWNLOAD_FAILED'},'Qwen 설치 다시 시도'],[{...managed,installed:true,applicationDeferred:true},'현재 설정을 유지했습니다.']] as const){
  const html=renderToStaticMarkup(createElement(VoiceSettings,{state:{...state,qwenInstall:install},act:()=>{},playbackReady:false}));expect(html).toContain(label)
 }
 const windows=renderToStaticMarkup(createElement(VoiceSettings,{state:{...state,qwenInstall:{...managed,communityConversion:false,model:'Qwen/Qwen3-TTS-12Hz-0.6B-Base',modelBytes:2516106051,runtimeBytes:3695031909,total:6211137960,minimumFreeBytes:30*1024**3}},act:()=>{},playbackReady:false}));expect(windows).toContain('Qwen 공식 원본');expect(windows).toContain('6.21 GB');expect(windows).toContain('30 GiB');expect(windows).toContain('PyTorch CUDA')
})

it('Vox default can install Qwen without changing engine, and keeps failure/cancel/deferred actions visible',()=>{
 for(const install of [managed,{...managed,error:'VOICE_DOWNLOAD_FAILED'},{...managed,installed:true,applicationDeferred:true},{...managed,phase:'downloading' as const}]){
  const html=renderToStaticMarkup(createElement(VoiceSettings,{state:{...state,engine:'voxcpm2',qwenConfigured:false,qwenInstall:install},act:()=>{},playbackReady:false}))
  expect(html).toContain('value="voxcpm2" selected');expect(html).toContain('Qwen 다운로드 및 설치')
  if(install.phase==='downloading')expect(html).toContain('Qwen 설치 중단')
  else expect(html).toContain(install.installed?'설치된 Qwen 적용':install.error?'Qwen 설치 다시 시도':'Qwen 다운로드·설치 후 적용')
 }
})
