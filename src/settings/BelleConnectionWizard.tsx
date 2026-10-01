import {useEffect,useRef,useState,type ReactNode} from 'react'
import {useT} from '../i18n/useLanguage'
import type {BelleConnectionApi,BelleConnectionSnapshot,BelleGuide} from '../../electron/shared/belle-connection'
import {BELLE_WIZARD_PROGRESS,restoredWizardStep,wizardNextAllowed,wizardRuntimeReady} from './belle-wizard-progress'
const steps=['준비 확인','Platform 터널·workspace','전용 키 저장','터널 연결','ChatGPT 플러그인 연결','연결 진단']
export function BelleConnectionWizard({state,api,busy,error,credentials,connection,onExit,onRefresh}:{state:BelleConnectionSnapshot;api:BelleConnectionApi;busy:boolean;error:string;credentials:ReactNode;connection:ReactNode;onExit:()=>void;onRefresh:()=>void}){
 const t=useT(),[step,setStep]=useState(()=>{try{return restoredWizardStep(localStorage.getItem(BELLE_WIZARD_PROGRESS))}catch{return 0}}),[installed,setInstalled]=useState(false),[linkError,setLinkError]=useState(false),[opening,setOpening]=useState(false),linkLock=useRef(false),heading=useRef<HTMLHeadingElement>(null),mounted=useRef(true)
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false}},[])
 useEffect(()=>{try{localStorage.setItem(BELLE_WIZARD_PROGRESS,String(step))}catch{};heading.current?.focus()},[step])
 // This acknowledgement is scoped to the current ready target and current wizard visit.
 useEffect(()=>{setInstalled(false)},[state.config?.tunnelId,state.config?.organizationId,state.credentialStored,state.state,state.secureStore,state.error])
 const open=async(guide:BelleGuide)=>{if(linkLock.current)return;linkLock.current=true;setOpening(true);setLinkError(false);try{await api.openGuide(guide)}catch{if(mounted.current)setLinkError(true)}finally{linkLock.current=false;if(mounted.current)setOpening(false)}}
 const link=(guide:BelleGuide,label:string)=><button className="button secondary" disabled={opening} onClick={()=>void open(guide)}>{t(label)}</button>
 const ready=wizardRuntimeReady(state),saved=Boolean(state.config&&state.credentialStored)
 return <div className="belle-wizard" aria-label={t('Dots 연결 마법사')}>
  <section className="section-card">
   <p>{t('Dots 연결 마법사')} · {step+1} / 6</p>
   <ol className="belle-wizard-steps" aria-label={t('연결 단계')}>{steps.map((label,index)=><li key={label} aria-current={step===index?'step':undefined}>{t(label)}</li>)}</ol>
   <h2 ref={heading} tabIndex={-1}>{t(steps[step])}</h2>
   <p>{t('단계만 이 기기에 저장합니다. 연결·설치 완료 여부는 저장하지 않고 다시 확인합니다. 언제든 기존 설정으로 돌아갈 수 있습니다.')}</p>
   {error&&<p className="notice error" role="alert">{t(error)}</p>}
   {linkError&&<p className="notice error" role="alert">{t('공식 페이지를 열지 못했습니다. 잠시 후 다시 시도해 주세요.')}</p>}
   {step===0&&<>
    <p>{t('본인 Platform 조직과 사용할 ChatGPT workspace를 준비하세요. 로그인과 권한 설정은 공식 페이지에서 직접 진행합니다.')}</p>
    <ul><li>{t('OpenAI 공식 tunnel-client와 Node.js 22.13 이상이 필요합니다. 설치는 사용자가 직접 진행합니다.')}</li><li>{t('캐릭터 화면을 표시하고 OpenAI로 나가는 HTTPS 연결이 가능한지 확인하세요.')}</li><li>{t('ChatGPT 개발자 모드 접근은 별도 workspace 권한입니다. 사용할 계정·workspace의 정책을 확인하세요.')}</li></ul>
    <p>{t('공식 클라이언트가 이미 있다면 tunnel-client help quickstart로 준비 사항을 확인할 수 있습니다. 이 마법사는 터미널을 실행하지 않습니다.')}</p>
    <div className="button-row">{link('tunnelDocs','공식 터널 안내 열기')}{link('pluginDocs','공식 플러그인 안내 열기')}</div>
   </>}
   {step===1&&<>
    <ol><li>{t('Platform 터널 설정에서 로그인한 뒤 사용할 조직을 확인하세요. 기존 터널이 있으면 그대로 사용합니다.')}</li><li>{t('터널을 만들거나 편집할 때만 Tunnels Read + Manage가 필요합니다. 권한이 없으면 조직 관리자에게 요청하세요.')}</li><li>{t('터널에 소유 Platform 조직과 사용할 ChatGPT workspace를 연결하세요. 개인 조직에만 연결된 터널은 다른 workspace에 자동으로 나타나지 않습니다.')}</li><li>{t('터널 ID와 Platform 조직 ID를 확인해 다음 단계에 입력하세요. 같은 stdio 터널을 다른 실행 중인 클라이언트와 공유하지 마세요.')}</li></ol>
    <div className="button-row">{link('tunnels','Platform 터널 설정 열기')}</div>
   </>}
   {step===2&&<>
    <p>{t('Runtime API keys에서 Restricted 키의 Tunnels Read + Use만 허용하세요. 키 소유자도 대상 터널의 Read + Use 권한이 필요합니다. All 또는 Admin 키는 사용하지 마세요.')}</p>
    <p>{t('키를 아래에 직접 입력하고 저장 대상을 확인하세요. 이미 저장된 키가 있으면 교체 없이 다음으로 갈 수 있습니다.')}</p>
    <div className="button-row">{link('keys','Runtime 키 설정 열기')}</div>
   </>}
   {step===3&&<>
    <p>{t('저장한 대상과 키로 연결하려면 아래 연결 버튼을 누르고 확인 창에서 승인하세요. 저장·다음 단계·마법사 재시작만으로 연결하거나 자동 연결을 켜지 않습니다.')}</p>
    {ready&&<p>{t('이미 터널이 준비되어 있습니다. 기존 연결을 유지하고 다음 단계로 이동할 수 있습니다.')}</p>}
   </>}
   {step===4&&<>
    <p>{t('터널 준비 상태를 유지한 채 ChatGPT에서 직접 진행하세요. 이 앱은 개발자 모드를 켜거나 플러그인을 설치하지 않습니다.')}</p>
    <ol><li>{t('ChatGPT 설정 → Security and login에서 Developer mode를 직접 켜세요. Enterprise/Edu에서는 workspace 관리자의 접근 허용이 필요할 수 있습니다.')}</li><li>{t('ChatGPT Plugins의 + 버튼에서 이름과 설명을 입력하세요. Connection에서 Tunnel을 선택하고 이 앱에 저장한 터널 ID를 선택하거나 입력하세요.')}</li><li>{t('연결을 생성하고 발견된 도구·메타데이터를 확인하세요. 기존 플러그인이 있으면 대상 터널이 같은지 확인하세요.')}</li></ol>
    {state.config&&<p className="belle-wizard-target">{t('대상 터널')}: <code>{state.config.tunnelId}</code></p>}
    {!ready&&<p role="status">{t('터널이 아직 준비되지 않았습니다. 뒤로 이동해 연결하거나 진단을 확인하세요.')}</p>}
    <div className="button-row">{link('plugins','ChatGPT Plugins 열기')}{link('pluginDocs','공식 플러그인 안내 열기')}</div>
    <label className="toggle-row"><input type="checkbox" checked={installed} disabled={!ready||busy} onChange={event=>setInstalled(event.target.checked)}/>{t('ChatGPT에서 이 터널의 플러그인 연결·도구 목록을 직접 확인했습니다.')}</label>
    <p>{t('이 선택은 사용자의 확인입니다. 앱이 설치나 실제 도구 호출을 검증한 것은 아닙니다.')}</p>
   </>}
   {step===5&&<>
    <dl className="belle-wizard-diagnostics" aria-live="polite"><div><dt>{t('안전한 키 저장')}</dt><dd>{t(saved?'저장됨':'저장 필요')}</dd></div><div><dt>{t('터널 runtime')}</dt><dd>{t(ready?'터널 준비됨':'준비 상태 확인 필요')}</dd></div><div><dt>{t('플러그인 설치 확인')}</dt><dd>{t(installed?'사용자가 확인함':'사용자 재확인 필요')}</dd></div><div><dt>{t('실제 도구 호출')}</dt><dd>{t('미확인 · 앱에 지원되는 실호출 증거 없음')}</dd></div></dl>
    <p>{t('ChatGPT 새 대화에서 연결한 플러그인을 선택하고 현재 선택한 캐릭터에게 짧은 문장 표시를 요청하세요. 도구 호출 결과와 캐릭터 화면을 직접 확인하세요. 음성은 기본 음소거입니다.')}</p>
    <p>{t('터널이 보이지 않으면 workspace 연결과 Tunnels Read + Use를 확인하세요. 권한 변경 반영은 최대 30분 걸릴 수 있습니다. 발견·호출 실패 시 터널 준비 상태와 공식 안내를 확인하세요.')}</p>
    <div className="button-row"><button className="button secondary" disabled={busy} onClick={onRefresh}>{t('진단 다시 확인')}</button>{link('tunnelDocs','공식 터널 안내 열기')}</div>
   </>}
  </section>
  {step===2&&credentials}
  {(step===0||step===3||step===4||step===5)&&connection}
  <section className="section-card"><div className="button-row">
   <button className="button secondary" disabled={busy||step===0} onClick={()=>setStep(s=>Math.max(0,s-1))}>{t('뒤로')}</button>
   {step<5&&<button className="button primary" disabled={busy||!wizardNextAllowed(step,state,installed)} onClick={()=>setStep(s=>Math.min(5,s+1))}>{t('다음')}</button>}
   {step<5&&<button className="button quiet" disabled={busy} onClick={()=>setStep(5)}>{t('건너뛰고 진단 보기')}</button>}
   <button className="button quiet" disabled={busy} onClick={()=>{setInstalled(false);setStep(0);onRefresh()}}>{t('안내 처음부터')}</button>
   <button className="button secondary" onClick={onExit}>{t('중단·기존 설정으로')}</button>
  </div><p>{t('안내 중단·재시작은 저장한 키나 기존 연결을 바꾸지 않습니다. 연결 중단은 연결 해제 버튼으로 진행하세요.')}</p></section>
 </div>
}
