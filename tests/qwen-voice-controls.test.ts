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
