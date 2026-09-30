import {expect,it,vi} from 'vitest'
import {createElement} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
import {ChatQuickSwitch} from '../src/character-chat/CharacterChatApp'
import {VoiceSettings,MessageVoiceControls} from '../src/character-chat/VoiceControls'
vi.mock('../src/i18n/useLanguage',()=>({useT:()=>Object.assign((s:string)=>s,{language:'ko'})}))
const voice:any={epoch:1,status:'loading',enabled:true,autoRead:true,volume:.5,profiles:[{id:'belle',version:'1',name:'Belle'}],bindings:{belle:'belle@1'},runtimeConfigured:true,executionProfile:'gguf-metal-f16',availableProfiles:['gguf-metal-f16','gguf-metal-f16-complete'],baseInstall:{supported:true,installed:false,phase:'preparing',bytes:0,total:100,error:null}}
it('bubble menu contains exactly character and current-character saved conversation selectors',()=>{
 const state:any={character:{id:'belle'},characters:[{id:'belle',name:'Belle'}],conversation:null,conversations:[{id:'one',characterId:'belle',title:'keep'},{id:'two',characterId:'other',title:'do not show'}]}
 const html=renderToStaticMarkup(createElement(ChatQuickSwitch,{state,act:()=>{},close:()=>{}}));expect(html.match(/<select/g)).toHaveLength(2);expect(html).toContain('캐릭터');expect(html).toContain('저장된 대화');expect(html).not.toContain('do not show');for(const text of ['<button','음성','모델','기억','설치','삭제'])expect(html).not.toContain(text)
})
it('settings form keeps cancellation available while preparing and never owns a player',()=>{
 const html=renderToStaticMarkup(createElement(VoiceSettings,{state:voice,characterId:'belle',act:()=>{},playbackReady:false,busy:true}));expect(html).toMatch(/<button>설치 중단<\/button>/);expect(html).toMatch(/<button>음성만 중단<\/button>/);expect(html).toMatch(/<button disabled="">시험 재생<\/button>/);expect(html).toContain('음성 설치·고급 설정')
})
it('base installation and two Metal modes remain available in the management form',()=>{
 const html=renderToStaticMarkup(createElement(VoiceSettings,{state:{...voice,baseInstall:{...voice.baseInstall,phase:'idle'}},characterId:'belle',act:()=>{},playbackReady:true}));expect(html).toContain('기본 음성 설치');expect(html).toContain('Metal · 청크 재생');expect(html).toContain('Metal · 완성 후 재생');expect(html).not.toContain('MPS')
})
it('seed form distinguishes random policy and fixed numeric editing without promising quality',()=>{const html=renderToStaticMarkup(createElement(VoiceSettings,{state:{...voice,seedSettings:{mode:'fixed',fixedSeed:777}},characterId:'belle',act:()=>{},playbackReady:true}));expect(html).toContain('답변마다 무작위');expect(html).toContain('고정 시드');expect(html).toContain('value="777"');expect(html).toContain('다음 합성부터 적용');expect(html).not.toContain('더 고품질')})

it.each([false,true])('unsupported voice settings explain the platform and preserve turning off (enabled=%s)',enabled=>{
 const html=renderToStaticMarkup(createElement(VoiceSettings,{state:{...voice,status:'off',availableProfiles:[],enabled},characterId:'belle',act:()=>{},playbackReady:false}))
 const checkbox=html.match(/<input[^>]*aria-describedby="voice-platform-support"[^>]*>/)![0]
 expect(checkbox.includes('disabled=""')).toBe(!enabled);expect(html).toContain('이 장치에서는 음성을 지원하지 않습니다.');expect(html).toContain('id="voice-platform-support"')
})
it('supported idle voice settings keep activation available without an unsupported warning',()=>{
 const html=renderToStaticMarkup(createElement(VoiceSettings,{state:{...voice,status:'off',enabled:false},characterId:'belle',act:()=>{},playbackReady:false}))
 expect(html).toContain('<input type="checkbox"/>음성 사용');expect(html).not.toContain('voice-platform-support')
})

it('everyday voice controls precede collapsed WAV import and synthesis options',()=>{
 const html=renderToStaticMarkup(createElement(VoiceSettings,{state:{...voice,baseInstall:{...voice.baseInstall,installed:true,phase:'idle'}},characterId:'belle',act:()=>{},playbackReady:true}))
 const index=(text:string)=>html.indexOf(text)
 expect(index('aria-label="캐릭터 음성"')).toBeLessThan(index('WAV로 새 음성 추가'))
 expect(index('aria-label="음량"')).toBeLessThan(index('WAV로 새 음성 추가'))
 expect(index('>시험 재생</button>')).toBeLessThan(index('WAV로 새 음성 추가'))
 expect(html).toContain('<details class="voice-reference-import"><summary>WAV로 새 음성 추가</summary>')
 expect(index('WAV로 새 음성 추가')).toBeLessThan(index('새 음성의 시드'))
})
it('WAV import cancellation and errors remain visible outside collapsed import',()=>{
 const html=renderToStaticMarkup(createElement(VoiceSettings,{state:{...voice,referenceImport:{busy:true,error:'VOICE_REFERENCE_FORMAT'}},characterId:'belle',act:()=>{},playbackReady:true,busy:true}))
 const before=html.slice(0,html.indexOf('<details class="voice-reference-import"'))
 expect(before).toContain('<button>WAV 가져오기 중단</button>');expect(before).toContain('올바른 RIFF/WAVE')
})

it('a reply exposes one primary play button before its collapsed advanced voice controls',()=>{
 const html=renderToStaticMarkup(createElement(MessageVoiceControls,{messageId:'synthetic'})),before=html.slice(0,html.indexOf('<details>'))
 expect(before.match(/<button/g)).toHaveLength(1);expect(before).toContain('재생');expect(before).not.toContain('시드');expect(html).toContain('<details><summary>음성 옵션</summary>');expect(html).toContain('다른 시드로 다시 읽기')
})
