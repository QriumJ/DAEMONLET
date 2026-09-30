import {expect,it,vi} from 'vitest'
import {createElement} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
import {BelleConnectionPage,belleError} from '../src/settings/BelleConnectionPage'
import type {BelleConnectionSnapshot} from '../electron/shared/belle-connection'
vi.mock('../src/i18n/useLanguage',()=>({useT:()=>Object.assign((s:string)=>s,{language:'ko'})}))
const state:BelleConnectionSnapshot={state:'disconnected',config:{tunnelId:'tunnel_'+'a'.repeat(32),organizationId:'org-example123',autoConnect:false,consentVersion:1},credentialStored:true,secureStore:'macos-keychain',clientVersion:'0.0.14',nodeVersion:'v22.23.0',error:null,retry:0,muted:true}
const html=(s=state)=>renderToStaticMarkup(createElement(BelleConnectionPage,{api:{} as any,initial:s}))
it('key entry is password/uncontrolled/blank with no retrieval display or reveal control',()=>{const h=html(),input=h.match(/<input[^>]*type="password"[^>]*>/)![0];expect(input).not.toContain('value=');expect(input).toContain('autoComplete="off"');for(const text of ['키 표시','키 가져오기','localStorage','textarea'])expect(h).not.toContain(text);expect(h).toContain('다시 표시하지 않습니다')})
it('auto is off by default with action-time disclosure and no login service',()=>{const h=html();expect(h.match(/<input[^>]*type="checkbox"[^>]*>/)![0]).not.toContain('checked');expect(h).toContain('정확한 대상과 지속 접근');expect(h).toContain('OS 로그인 서비스는 만들지')})
it('transport readiness never claims actual tool output or sound',()=>{const h=html({...state,state:'ready'});expect(h).toContain('터널 준비됨');expect(h).toContain('실제 표시와 음성은 플러그인에서 시험');expect(h).toContain('기본 음소거')})
it('external helper cannot be stopped or adopted in this view',()=>{const h=html({...state,state:'external'});expect(h).toContain('그 창에서 직접 종료');expect(h).toMatch(/<button[^>]*disabled=""[^>]*>연결 해제·자동 연결 끄기/);expect(h).toMatch(/type="password"[^>]*disabled=""/)})
it('unsupported platform cannot save/connect/auto-enable or use plaintext fallback',()=>{const h=html({...state,secureStore:'unavailable',credentialStored:false});expect(h).toContain('평문·파일 저장으로 대체하지');expect(h).toMatch(/type="password"[^>]*disabled=""/);expect(h).toMatch(/type="checkbox"[^>]*disabled=""/)})
it('errors use fixed helpful guidance and dependencies are never auto-installed',()=>{expect(belleError('CLIENT_MISSING')).toContain('공식');expect(belleError('NODE_MISSING')).toContain('자동');expect(belleError('PRIVATE_RAW_KEY')).not.toContain('PRIVATE_RAW_KEY');expect(html()).toContain('설치·다운로드하거나 새 터널·권한을 만들지')})
