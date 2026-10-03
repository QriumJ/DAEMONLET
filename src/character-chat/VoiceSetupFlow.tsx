import type {ReactNode} from 'react'
import type {VoiceAction,VoiceSnapshot} from '../../electron/shared/character-voice-contract'
import {currentVoiceSetupPath,voiceSetupPaths,voiceSetupPlatform} from '../../electron/shared/voice-setup-paths'
import {useT} from '../i18n/useLanguage'

export function VoiceEngineStep({state,busy,act,legacyModels}:{state:VoiceSnapshot;busy:boolean;act:(action:VoiceAction)=>unknown;legacyModels:ReactNode}){
 const t=useT(),{platform,arch}=voiceSetupPlatform(state),paths=voiceSetupPaths(platform,arch),current=currentVoiceSetupPath(state),legacy=paths.filter(path=>path.legacy),selected=paths.find(path=>path.id===current)
 const choose=(id:typeof current)=>{if(id!==current)void act({type:'selectVoicePath',id})}
 const card=(path:typeof paths[number],recommended=false)=><label className="voice-engine-card" key={path.id}><input type="radio" name="voice-engine-path" value={path.id} checked={current===path.id} disabled={busy} onChange={()=>choose(path.id)}/><span><strong>{t(path.title)} {recommended&&<span className="voice-recommended">{t('권장')}</span>}</strong><small>{t(path.description)}</small></span></label>
 return <section className="voice-setup-step" aria-labelledby="voice-engine-step"><h3 id="voice-engine-step"><span>1</span>{t('음성 엔진 선택')}</h3><p>{t('새 엔진으로 바꿔도 기존 모델과 목소리는 보존됩니다. 파일은 다음 단계에서 직접 준비합니다.')}</p>
  <div className="voice-engine-options">{paths.filter(path=>!path.legacy).map((path,index)=>card(path,index===0))}</div>
  {selected?.legacy&&<div className="notice" role="status"><strong>{t('현재 레거시 방식 사용 중')}</strong><p>{t('기존 선택을 유지했습니다. 권장 엔진을 선택한 뒤 필요한 파일과 목소리를 확인해 전환하세요.')}</p></div>}
  {!!legacy.length&&<details className="voice-legacy"><summary>{t('레거시 엔진·모델 관리')}</summary><p>{t('기존 Windows PyTorch 경로입니다. 자동 전환하거나 삭제하지 않습니다.')}</p>{legacy.map(path=>card(path))}{legacyModels}</details>}
 </section>
}

export function VoiceSetupStep({number,title,children}:{number:number;title:string;children:ReactNode}){
 const t=useT()
 return <section className="voice-setup-step" aria-label={t(title)}><h3><span>{number}</span>{t(title)}</h3>{children}</section>
}
