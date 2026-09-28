import {expect,it,vi} from 'vitest'
import {createElement} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
import {ChatQuickSwitch} from '../src/character-chat/CharacterChatApp'
import {VoiceSettings} from '../src/character-chat/VoiceControls'
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
