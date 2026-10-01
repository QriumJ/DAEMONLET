import {useEffect,useRef,useState} from 'react'
import {BelleConnectionWizard} from './BelleConnectionWizard'
import {useT} from '../i18n/useLanguage'
import type {BelleConnectionApi,BelleConnectionSnapshot} from '../../electron/shared/belle-connection'
const labels={unconfigured:'설정 필요',disconnected:'연결 해제됨',checking:'설치·보안 저장소 확인 중',connecting:'터널 연결 중',ready:'터널 준비됨',reconnecting:'다시 연결하는 중',error:'연결 확인 필요',external:'외부 터미널 세션 사용 중'}
export function belleError(code:string){return ({STORE_UNAVAILABLE:'안전한 키 저장소를 사용할 수 없습니다. macOS Keychain 또는 Windows 자격 증명 관리자와 앱 구성 요소를 확인한 뒤 상태를 다시 확인해 주세요. 평문 저장은 하지 않습니다.',STORE_LOCKED:'OS 보안 저장소에 접근할 수 있는 로그인 세션에서 다시 시도해 주세요.',STORE_DENIED:'OS 보안 저장소 요청이 취소되었거나 허용되지 않았습니다.',KEY_MISSING:'저장한 키가 없습니다. 전용 키를 직접 입력해 주세요.',CLIENT_MISSING:'OpenAI 공식 tunnel-client가 필요합니다. 공식 연결 안내에서 설치한 뒤 앱을 다시 열어 주세요.',CLIENT_VERSION:'tunnel-client 버전이나 필요한 기능을 확인하지 못했습니다. 공식 클라이언트를 확인해 주세요.',NODE_MISSING:'Node.js 22.13 이상이 필요합니다. 설치는 자동으로 진행하지 않습니다.',NODE_VERSION:'Node.js 22.13 이상을 사용해 주세요.',ADAPTER_MISSING:'앱의 연결 구성 요소가 없습니다. 앱 빌드를 확인해 주세요.',EXTERNAL_SESSION:'외부 터미널에서 실행한 연결은 여기서 종료하지 않습니다. 그 창에서 직접 종료한 뒤 앱을 일반 실행해 주세요.',LOCAL_NOT_READY:'캐릭터 화면이 준비되지 않았습니다. 캐릭터를 표시하고 다시 연결해 주세요.',SAVE_FAILED:'연결 설정을 저장하지 못했습니다. 키와 연결 상태를 확인해 주세요.',INVALID_CONFIG:'터널 ID와 Platform 조직 ID를 확인해 주세요.',INVALID_KEY:'전용 키 형식을 확인해 주세요.',CONNECTION_FAILED:'터널 준비 상태를 확인하지 못했습니다. 네트워크·키 권한·터널 ID를 확인하고 다시 시도해 주세요.',SHUTTING_DOWN:'앱 종료 중에는 연결할 수 없습니다.'} as Record<string,string>)[code]??'연결 설정을 처리하지 못했습니다. 현재 상태를 확인해 주세요.'}
export function BelleConnectionPage({api,initial}:{api?:BelleConnectionApi;initial?:BelleConnectionSnapshot}){
 const [wizard,setWizard]=useState(false)
 const t=useT(),[state,setState]=useState(initial??null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[tunnelId,setTunnelId]=useState(initial?.config?.tunnelId??''),[organizationId,setOrganizationId]=useState(initial?.config?.organizationId??'')
 const key=useRef<HTMLInputElement>(null),operation=useRef(false),stopping=useRef(false)
 useEffect(()=>{if(!api)return;let active=true;const accept=(v:BelleConnectionSnapshot)=>{if(active){setState(v);if(v.config){setTunnelId(v.config.tunnelId);setOrganizationId(v.config.organizationId)}}};const off=api.subscribe(accept);void api.snapshot().then(accept).catch(()=>{if(active)setError('연결 상태를 불러오지 못했습니다.')});return()=>{active=false;off();if(key.current)key.current.value=''}},[api])
 const run=async(task:()=>Promise<BelleConnectionSnapshot>,interrupt=false)=>{if((operation.current&&!interrupt)||(interrupt&&stopping.current))return;if(interrupt)stopping.current=true;setError('');if(!interrupt){operation.current=true;setBusy(true)};try{setState(await task())}catch(e){setError(belleError(e instanceof Error?e.message:''))}finally{if(interrupt)stopping.current=false;if(!interrupt){operation.current=false;setBusy(false)}}}
 if(!state||!api)return <div className="empty-state" role="status">{t('연결 상태를 불러오는 중…')}</div>
 const active=['checking','connecting','ready','reconnecting'].includes(state.state),external=state.state==='external',secure=state.secureStore!=='unavailable'
 const connection=<section className="section-card"><h2>{t('연결 상태')}</h2><p role="status" aria-live="polite"><span className={'status-dot '+(state.state==='ready'?'positive':'')}/>{t(labels[state.state])}</p>
   <p>{t('터널 준비됨은 연결 통로의 상태입니다. 실제 표시와 음성은 플러그인에서 시험해 주세요. 연결할 때 음성은 기본 음소거입니다.')}</p>
   {state.clientVersion&&<p>tunnel-client {state.clientVersion} · Node {state.nodeVersion}</p>}
   {(error||state.error)&&<div className="notice error" role="alert">{t(error||belleError(state.error!))}</div>}
   {external&&<p>{t(belleError('EXTERNAL_SESSION'))}</p>}
   <div className="button-row"><button className="button secondary" disabled={busy||active} onClick={()=>void run(()=>api.refresh())}>{t('상태 다시 확인')}</button><button className="button primary" disabled={busy||active||external||!secure||!state.config||!state.credentialStored} onClick={()=>void run(()=>api.connect())}>{t(state.state==='error'?'다시 연결':'연결')}</button><button className="button secondary" disabled={external||!active} onClick={()=>void run(()=>api.disconnect(),true)}>{t('연결 해제·자동 연결 끄기')}</button></div>
  </section>
 const credentials=<section className="section-card"><h2>{t('개인 터널과 키')}</h2><p>{t('본인 개인 Platform 조직과 연결된 터널을 입력하세요. Restricted Tunnels Read+Use 전용 키만 사용하세요. 앱에서 키의 권한을 검증할 수는 없습니다.')}</p>
   <form onSubmit={event=>{event.preventDefault();if(operation.current)return;const entered=key.current?.value??'';if(key.current)key.current.value='';void run(()=>api.configure({tunnelId:tunnelId.trim(),organizationId:organizationId.trim(),key:entered}))}}>
    <label className="chat-settings-field">{t('터널 ID')}<input aria-label={t('터널 ID')} value={tunnelId} maxLength={39} disabled={busy||external} autoComplete="off" spellCheck={false} onChange={event=>setTunnelId(event.target.value)}/></label>
    <label className="chat-settings-field">{t('Platform 조직 ID')}<input aria-label={t('Platform 조직 ID')} value={organizationId} maxLength={68} disabled={busy||external} autoComplete="off" spellCheck={false} onChange={event=>setOrganizationId(event.target.value)}/></label>
    <label className="chat-settings-field">{t(state.credentialStored?'교체할 전용 키':'전용 키')}<input ref={key} type="password" aria-label={t('전용 키')} maxLength={1024} disabled={busy||external||!secure} autoComplete="off" spellCheck={false} autoCapitalize="none" aria-describedby="belle-key-help"/></label>
    <p id="belle-key-help">{t(secure?'키는 macOS Keychain 또는 Windows 자격 증명 관리자에만 보관하며 다시 표시하지 않습니다. 저장 전에 대상과 보관 기간을 확인합니다.':'안전한 저장소를 사용할 수 없어 키 저장이 차단됐습니다. 평문·파일 저장으로 대체하지 않습니다.')}</p>
    <div className="button-row"><button className="button secondary" type="submit" disabled={busy||active||external||!secure||!tunnelId.trim()||!organizationId.trim()}>{t('키 저장·대상 확인')}</button><button type="button" className="button quiet" disabled={busy||external||!state.credentialStored} onClick={()=>void run(()=>api.forget())}>{t('저장한 키·설정 삭제')}</button></div>
   </form>
   <p>{t('저장만으로 연결하지 않습니다. 로컬 키 삭제는 Platform 키나 터널 권한을 취소하지 않습니다.')}</p>
  </section>
 return <div className="belle-connection-page">
  <header className="page-header"><div><h1>{t('Dots 연결')}</h1><p>{t('앱을 열고 Dots에 연결하면 선택한 캐릭터가 문장·포즈·상태를 표시해요.')}</p></div></header>
  <div className="button-row belle-wizard-launch"><button className="button secondary" disabled={busy} onClick={()=>{if(key.current)key.current.value='';setWizard(v=>!v);void run(()=>api.refresh())}}>{t(wizard?'기존 설정 보기':'Dots 연결 마법사 열기')}</button></div>
  {wizard?<BelleConnectionWizard state={state} api={api} busy={busy} error={error||(state.error?belleError(state.error):'')} credentials={credentials} connection={connection} onExit={()=>{if(key.current)key.current.value='';setWizard(false)}} onRefresh={()=>void run(()=>api.refresh())}/>:<>
  {connection}
  {credentials}
  <section className="section-card"><h2>{t('앱을 시작할 때')}</h2><label className="toggle-row"><input type="checkbox" checked={state.config?.autoConnect??false} disabled={busy||external||!secure||!state.credentialStored} onChange={event=>void run(()=>api.setAutoConnect(event.target.checked))}/>{t('앱 시작 시 자동 연결')}</label><p>{t('기본은 꺼짐입니다. 켜기 전에 정확한 대상과 지속 접근을 다시 확인합니다. OS 로그인 서비스는 만들지 않으며 앱 종료 시 소유한 연결을 끝냅니다.')}</p></section>
  <section className="section-card"><h2>{t('필요한 구성 요소')}</h2><p>{t('OpenAI 공식 tunnel-client와 Node.js 22.13 이상이 필요합니다. 앱은 설치·다운로드하거나 새 터널·권한을 만들지 않습니다.')}</p><p>https://developers.openai.com/api/docs/guides/secure-mcp-tunnels</p><p>{t('공개 수신 포트를 열지 않습니다. 파일 읽기·명령 실행·대화 내역 제공은 연결 도구에 없습니다.')}</p></section>
  </>}
 </div>
}
