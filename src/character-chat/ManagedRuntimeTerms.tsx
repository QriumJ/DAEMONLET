import {useEffect,useState} from 'react'
import {useT} from '../i18n/useLanguage'
import type {ManagedRuntimeTermsState} from '../../electron/shared/managed-runtime-terms'
import type {VoiceAction} from '../../electron/shared/character-voice-contract'

export function ManagedRuntimeTerms({state,busy,act}:{state:ManagedRuntimeTermsState;busy:boolean;act:(action:VoiceAction)=>unknown}){
 const t=useT(),[review,setReview]=useState(true),[checked,setChecked]=useState(false)
 useEffect(()=>{setChecked(false);setReview(true)},[state.fingerprint,state.accepted])
 return <section className="voice-runtime-terms" aria-label={t('Microsoft 음성 실행 파일 이용 조건')}>
  <strong>{t('Microsoft 음성 실행 파일 이용 조건')}</strong>
  <p>{t('아래 조건은 관리형 Windows 음성에 포함된 Microsoft Visual C++ 파일의 설치·사용에만 적용됩니다.')}</p>
  <p>{t('DAEMONLET의 MIT 라이선스와 LGPL 등 각 오픈소스 구성요소의 별도 권리는 유지됩니다.')}</p>
  {review||state.accepted?<>
   {state.documents.map(doc=><details key={doc.id}><summary>{doc.title} · {doc.version}</summary>
    <div className="button-row"><button disabled={busy} onClick={()=>void act({type:'viewGgufRuntimeTerms',id:doc.id,view:'original'})}>{t('Microsoft 원문 보기')}</button><button disabled={busy} onClick={()=>void act({type:'viewGgufRuntimeTerms',id:doc.id,view:'text'})}>{t('원문 텍스트 보기')}</button>{doc.koreanAvailable&&<button disabled={busy} onClick={()=>void act({type:'viewGgufRuntimeTerms',id:doc.id,view:'korean-original'})}>{t('Microsoft 한국어 원문 보기')}</button>}</div>
    <small>{t('적용되는 파일')}</small><ul>{doc.files.map(file=><li key={file}><code>{file}</code></li>)}</ul><small>{t('원문 SHA-256')}: {doc.originalSha256}</small>
   </details>)}
   {state.accepted?<p role="status">{t('이 버전의 Microsoft 음성 실행 파일 이용 조건을 수락했습니다.')}</p>:<>
    <p>{t('조건을 수락하면 파일 준비와 음성 실행을 계속할 수 있습니다. 수락 버튼을 누르지 않고 취소하거나 창을 닫으면 수락이 저장되지 않습니다.')}</p>
    <label><input type="checkbox" checked={checked} disabled={busy||!!state.error} onChange={event=>setChecked(event.target.checked)}/>{t('위 Microsoft 런타임 이용 조건을 확인했으며 해당 파일의 설치·사용 조건을 수락합니다.')}</label>
    <div className="button-row"><button disabled={busy||!checked||!!state.error} onClick={()=>void act({type:'acceptGgufRuntimeTerms',fingerprint:state.fingerprint})}>{t('Microsoft 조건 수락')}</button><button disabled={busy} onClick={()=>{setChecked(false);setReview(false)}}>{t('취소')}</button></div>
   </>}
  </>:<button disabled={busy} onClick={()=>setReview(true)}>{t('Microsoft 이용 조건 확인')}</button>}
  {state.error&&<p role="alert">{t('이용 조건 문서 또는 적용 파일이 변경되어 수락할 수 없습니다. 배포본을 확인해 주세요.')}</p>}
  {state.cudaNotice&&<details><summary>{t('NVIDIA CUDA 구성요소 안내')}</summary><p>{t('CUDA 경로에는 NVIDIA 재배포 구성요소가 포함됩니다. 해당 구성요소의 이용·배포 조건은 별도 원문에 있습니다.')}</p><button disabled={busy} onClick={()=>void act({type:'viewGgufRuntimeTerms',id:state.cudaNotice!.id,view:'original'})}>{t('NVIDIA CUDA 원문 보기')}</button></details>}
 </section>
}
