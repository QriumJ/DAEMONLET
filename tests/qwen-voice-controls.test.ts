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
