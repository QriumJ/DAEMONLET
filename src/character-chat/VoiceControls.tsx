import {useT} from '../i18n/useLanguage'
import {useEffect,useState} from 'react'
import {isReferenceProfile,isStreamingProfile,type VoiceAction,type VoiceApi,type VoiceSnapshot,type ExecutionProfile} from '../../electron/shared/character-voice-contract'
import {AudioPlaybackController} from './AudioPlaybackController'
declare global{interface Window{characterVoice:VoiceApi}}
const statuses={unavailable:'음성 준비 필요',off:'음성 꺼짐',idle:'준비됨',loading:'음성 모델 준비 중',synthesizing:'발화 합성 중',playing:'음성 재생 중',stopped:'음성 중단됨',error:'음성 오류 · 텍스트 대화는 계속 사용할 수 있어요'}
const errors:Record<string,string>={VOICE_REFERENCE_NAME:'음성 이름을 1~80자로 입력하고 사용 권한을 확인해 주세요.',VOICE_REFERENCE_FORMAT:'올바른 RIFF/WAVE 파일을 선택해 주세요.',VOICE_REFERENCE_UNSUPPORTED:'PCM 16·24비트 또는 float32, 모노·스테레오 WAV를 지원합니다.',VOICE_REFERENCE_SIZE:'WAV 파일은 20MiB 이하여야 합니다.',VOICE_REFERENCE_DURATION:'기준 음성은 2~20초여야 합니다.',VOICE_REFERENCE_SAMPLES:'WAV에 올바르지 않은 샘플 값이 있습니다.',VOICE_REFERENCE_SILENT:'음성이 너무 작거나 무음입니다. 또렷한 발화를 선택해 주세요.',VOICE_REFERENCE_COUNT:'WAV 음성은 최대 32개까지 저장할 수 있습니다.',VOICE_REFERENCE_STORAGE_LIMIT:'WAV 음성 저장 공간 한도를 초과했습니다.',VOICE_REFERENCE_FILE:'링크가 아닌 일반 WAV 파일을 선택해 주세요.',VOICE_REFERENCE_IMPORT:'WAV를 가져오지 못했습니다. 파일을 확인하고 다시 시도해 주세요.',VOICE_REFERENCE_TIMEOUT:'WAV 처리 시간이 초과됐습니다.',VOICE_REFERENCE_STORAGE:'WAV 음성 저장소를 확인할 수 없습니다. 다른 음성은 계속 사용할 수 있습니다.',VOICE_REFERENCE_CHANGED:'저장된 기준 음성 검증에 실패했습니다. 원본 WAV를 새 프로필로 가져와 주세요.',VOICE_REFERENCE_UNAVAILABLE:'선택한 WAV 음성이 없거나 손상됐습니다. 다른 음성을 직접 선택하거나 원본을 다시 가져와 주세요.',VOICE_REFERENCE_RUNTIME:'이 음성 엔진은 WAV 클로닝 계약을 지원하지 않습니다.',VOICE_REFERENCE_BINDING:'음성 조건이 바뀌었습니다. 다시 재생해 주세요.',VOICE_RUNTIME_INSTALL:'음성 실행 환경 설치를 완료하지 못했습니다. 다시 시도하면 내려받은 파일을 재사용합니다.',VOICE_BASE_NOT_INSTALLED:'기본 음성 설치 버튼으로 모델을 먼저 받아 주세요.',VOICE_BASE_RUNTIME:'이 앱의 기본 음성 엔진을 확인하지 못했습니다. 기본 음성을 포함한 Mac 배포본이 필요합니다.',VOICE_BASE_CHANGED:'기본 음성 파일 검증에 실패했습니다. 설치 버튼으로 다시 받아 주세요.',VOICE_DOWNLOAD_FAILED:'다운로드하지 못했습니다. 설치 버튼을 다시 누르면 이어받습니다.',VOICE_DOWNLOAD_ACCESS:'모델 제공처의 접근 조건을 확인해 주세요.',VOICE_DOWNLOAD_RANGE:'서버의 이어받기 응답이 올바르지 않습니다. 다시 시도해 주세요.',VOICE_DISK_SPACE:'기본 음성 설치를 위한 여유 공간이 부족합니다.',GGUF_CONVERSION_FAILED:'실행용 음성을 준비하지 못했습니다. 호환되는 LoRA 패키지와 변환 환경을 확인해 주세요.',GGUF_CACHE_CHANGED:'저장된 실행용 음성의 검증에 실패했습니다. 해당 음성을 삭제하고 원본 패키지를 다시 가져와 주세요.',GGUF_DISK_SPACE:'첫 음성 준비에는 임시 여유 공간 30GB가 필요합니다.',RUNTIME_DEPENDENCY:'음성 런타임의 추론 패키지를 찾거나 불러올 수 없습니다. 설치 진단을 실행해 주세요.',MPS_OOM:'Mac GPU 메모리가 부족합니다. 다른 GPU 작업이 끝난 뒤 다시 시도해 주세요.',VOICE_PLATFORM_PROFILE:'다른 플랫폼의 음성 설정입니다. 이 Mac에 맞는 실행 모드와 런타임을 연결한 뒤 음성을 켜 주세요.',RUNTIME_POLICY:'선택한 음성 실행 모드와 환경이 다릅니다.',RUNTIME_VERSION:'선택한 Python이 승인된 음성 런타임 버전과 다릅니다.',RUNTIME_RECEIPT:'Mac 음성 런타임의 설치 영수증을 확인하지 못했습니다.',VOICE_CLEANUP_PENDING:'음성 연결은 해제됐지만 파일 정리가 남아 있습니다. 앱을 다시 시작하면 정리를 재시도합니다.',VOICE_NOT_INSTALLED:'음성 패키지를 가져온 뒤 캐릭터 음성을 선택해 주세요.',VOICE_RUNTIME_MISSING:'독립 TTS Python과 로컬 모델을 연결해 주세요.',VOICE_WORKER_START:'음성 엔진을 시작하지 못했습니다. 설치 상태와 실행 환경을 확인해 주세요.',VOICE_PLAYBACK:'오디오 출력을 시작하지 못했습니다. 시험 재생을 다시 눌러 주세요.',CUDA_OOM:'GPU 메모리가 부족합니다. 음성을 끄거나 다른 GPU 작업이 끝난 뒤 다시 시도해 주세요.',VOICE_SELECTION_MISMATCH:'선택된 6000개 학습 채택본과 패키지 해시가 다릅니다.',UNSUPPORTED_DEVICE:'이 장치에서는 음성을 지원하지 않습니다. Windows CUDA 또는 Apple Silicon Metal 환경이 필요합니다.'}
export function VoiceControls({showStatus=true}:{showStatus?:boolean}){
 const [state,setState]=useState<VoiceSnapshot|null>(null)
 const act=(v:VoiceAction)=>window.characterVoice.action(v).then(s=>setState(old=>old&&old.epoch>s.epoch?old:s)).catch(()=>{})
 useEffect(()=>{
  if(!window.characterVoice)return
  const player=new AudioPlaybackController(window.characterVoice)
  const off=window.characterVoice.subscribe(s=>{player.setVolume(s.volume);setState(old=>old&&old.epoch>s.epoch?old:s)})
  const events=window.characterVoice.onEvent(e=>void player.receive(e))
  const hide=()=>{player.setVisible(!document.hidden);void act({type:document.hidden?'stop':'ready'})}
  player.setVisible(!document.hidden)
  document.addEventListener('visibilitychange',hide)
  void window.characterVoice.action({type:'ready'}).then(s=>{player.setVolume(s.volume);setState(old=>old&&old.epoch>s.epoch?old:s)}).catch(()=>{})
  return()=>{events();off();document.removeEventListener('visibilitychange',hide);player.dispose();void window.characterVoice.action({type:'stop'}).catch(()=>{})}
 },[])
 if(!state||!showStatus)return null
 return <section className="voice-controls" aria-label="캐릭터 음성"><div role="status">{statuses[state.status]} {state.enabled&&<button onClick={()=>void act({type:'stop'})}>음성만 중단</button>}</div>{state.error&&<p role="alert">{errors[state.error]||'음성 설정을 확인해 주세요.'}</p>}</section>
}
export function VoiceSettings({state,characterId,act,playbackReady,busy=false}:{state:VoiceSnapshot;characterId?:string;act:(value:VoiceAction)=>unknown;playbackReady:boolean;busy?:boolean}){
 const t=useT(),selected=state.bindings[characterId||'']??state.defaultProfile??''
 const builtin=!!state.defaultProfile&&selected===state.defaultProfile,install=state.baseInstall,profile=state.profiles.find(p=>p.id+'@'+p.version===selected),reference=isReferenceProfile(profile)?profile:null,managed=builtin||!!reference||selected.startsWith('wav-')
 const [name,setName]=useState(''),[acknowledged,setAcknowledged]=useState(false),[rename,setRename]=useState('')
 useEffect(()=>setRename(reference?.name||''),[reference?.id,reference?.name])
 return <section className="voice-settings" aria-label={t('캐릭터 음성')}>
  <div role="status">{t(statuses[state.status])}{state.enabled&&<button onClick={()=>void act({type:'stop'})}>{t('음성만 중단')}</button>}</div>
  {state.error&&<p className="notice error" role="alert">{t(errors[state.error]||'음성을 사용할 수 없습니다. 패키지·런타임·모델 위치를 확인해 다시 연결해 주세요.')}</p>}
  <div className="voice-reference-import">
   <strong>{t('WAV 기준 클로닝 · 학습 없음')}</strong><p>{t('사용 권한이 있는 한 명의 또렷한 발화를 선택하세요. 결과는 AI 합성 음성입니다.')}</p>
   <small>{t('2~20초 · 최대 20MiB · PCM 16/24비트 또는 float32 · 모노/스테레오')}</small>
   <label>{t('새 음성 이름')}<input aria-label={t('새 음성 이름')} value={name} maxLength={80} disabled={busy} onChange={e=>setName(e.target.value)}/></label>
   <label><input type="checkbox" checked={acknowledged} disabled={busy} onChange={e=>setAcknowledged(e.target.checked)}/>{t('이 음성을 사용할 권한이 있습니다.')}</label>
   <button disabled={busy||state.referenceImport?.busy||!name.trim()||!acknowledged} onClick={()=>void act({type:'importReference',name,acknowledged})}>{t(state.referenceImport?.busy?'WAV 가져오는 중':'WAV로 음성 추가')}</button>
   {state.referenceImport?.busy&&<button onClick={()=>void act({type:'cancelReferenceImport'})}>{t('WAV 가져오기 중단')}</button>}
   {state.referenceImport?.error&&<p role="alert">{t(errors[state.referenceImport.error]||'WAV를 가져오지 못했습니다. 파일을 확인하고 다시 시도해 주세요.')}</p>}
   <small>{t('저장 후 캐릭터 음성 목록에서 직접 선택하면 적용됩니다. 가져오기만으로 현재 음성을 바꾸거나 모델을 다운로드하지 않습니다.')}</small>
  </div>
  <label><input disabled={busy} type="checkbox" checked={state.enabled} onChange={e=>void act({type:'enabled',value:e.target.checked})}/>{t('음성 사용')}</label>
  <label>{t('캐릭터 음성')}<select disabled={busy||!characterId} aria-label={t('캐릭터 음성')} value={selected} onChange={e=>void act({type:'bind',profile:e.target.value||null})}>{selected&&!profile&&<option value={selected}>{t('선택한 WAV 음성을 찾을 수 없습니다')}</option>}{!state.defaultProfile&&<option value="">{t('없음')}</option>}{state.profiles.map(p=><option value={p.id+'@'+p.version} key={p.id+'@'+p.version}>{p.id+'@'+p.version===state.defaultProfile?t('기본 음성 · VoxCPM2'):p.name}{p.id+'@'+p.version===state.defaultProfile?'':isReferenceProfile(p)?' · WAV':' · '+p.version}</option>)}</select></label>
  {reference&&<div className="voice-reference-info"><strong>{t('WAV 기준 클로닝 · 학습 없음')}</strong>{!reference.error&&<small>{t('기준 음성')}: {(reference.reference.durationMs/1000).toFixed(1)}s · {reference.reference.sampleRate}Hz · {t('모노')}</small>}<label>{t('음성 이름')}<input aria-label={t('음성 이름')} value={rename} maxLength={80} disabled={busy} onChange={e=>setRename(e.target.value)}/></label><button disabled={busy||!rename.trim()||rename.trim()===reference.name} onClick={()=>void act({type:'renameReference',profile:selected,name:rename})}>{t('이름 변경')}</button></div>}
  <label>{t('재생 방식')}<select disabled={busy} aria-label={t('음성 실행 모드')} value={state.executionProfile||'baseline'} onChange={e=>void act({type:'executionProfile',value:e.target.value as ExecutionProfile})}>{(state.availableProfiles||[]).map(profile=><option key={profile} value={profile}>{{baseline:t('Windows 기준 · 완성 후 재생'),cached:t('Windows 캐시 · 청크 재생'),compiled:t('CUDA · 청크 재생'),'mps-fp32-baseline':t('이전 모드'),'mps-fp32':t('이전 모드'),'gguf-metal-f16':t('Metal · 청크 재생'),'gguf-metal-f16-complete':t('Metal · 완성 후 재생'),'cuda-compiled':t('CUDA · 청크 재생'),'cuda-compiled-complete':t('CUDA · 완성 후 재생')}[profile]}</option>)}</select></label>
  <small>{state.executionProfile?.endsWith('-complete')||state.executionProfile==='baseline'?t('각 발화 구간의 합성을 끝낸 뒤 재생합니다. 구간 사이에 대기 시간이 있을 수 있어요.'):t('음성이 만들어지는 동안 순서대로 재생합니다.')}</small>
  <label><input disabled={busy} type="checkbox" checked={state.autoRead} onChange={e=>void act({type:'auto',value:e.target.checked})}/>{t('새 답변 자동 읽기')}</label>
  <label>{t('음량')}<input disabled={busy} aria-label={t('음량')} type="range" min="0" max="1" step="0.05" value={state.volume} onChange={e=>void act({type:'volume',value:Number(e.target.value)})}/></label>
  <button disabled={busy||!playbackReady||!state.enabled||!selected||!state.runtimeConfigured} onClick={()=>void act({type:'test'})}>{t('시험 재생')}</button>
  {!playbackReady&&<small>{t('시험 재생은 캐릭터챗을 연 뒤 사용할 수 있어요.')}</small>}
  <details className="voice-advanced" open={managed&&!install?.installed||install?.phase!==undefined&&install.phase!=='idle'}><summary>{t('음성 설치·고급 설정')}</summary>
   {install?.supported&&<div className="voice-install"><strong>{t('기본 음성 · VoxCPM2')}</strong><small>{t('학습 패키지 없이 사용할 수 있습니다.')} {t('여성 음색을 기본으로 사용하며, 문장에 따라 조금 달라질 수 있어요.')}</small><small>{t('다운로드 약')} {(install.total/1e9).toFixed(1)} GB · Apache-2.0</small>{state.availableProfiles?.includes('cuda-compiled')&&<small>{t('Python·PyTorch 실행 환경과 기본 모델을 함께 설치합니다. 여유 공간 30GB와 BF16 지원 NVIDIA GPU가 필요합니다.')}</small>}
    {install.phase!=='idle'?<><progress aria-label={t('기본 음성 설치 진행률')} value={install.bytes} max={install.total}/><span role="status">{t(install.phase==='preparing'?'설치 준비 중':install.phase==='verifying'?'파일 검증 중':install.phase==='installing'?'실행 환경 설치 중':'다운로드 중')} {install.total>0?Math.floor(install.bytes/install.total*100):0}%</span><button onClick={()=>void act({type:'cancelInstallBase'})}>{t('설치 중단')}</button></>:<button disabled={busy||install.installed} onClick={()=>void act({type:'installBase'})}>{t(install.installed?'기본 음성 설치됨':'기본 음성 설치')}</button>}
    {install.error&&<p role="alert">{t(errors[install.error]||'설치를 완료하지 못했습니다. 다시 시도해 주세요.')}</p>}
   </div>}
   <div className="button-row"><button disabled={busy} onClick={()=>void act({type:'import'})}>{t('음성 패키지 가져오기')}</button>{!managed&&<button disabled={busy} onClick={()=>void act({type:'configure'})}>{t('TTS 런타임·모델 연결')}</button>}
   <button disabled={busy||!playbackReady||!state.enabled||!selected||!state.runtimeConfigured||(!isStreamingProfile(state.executionProfile)&&!state.executionProfile?.endsWith('-complete'))} onClick={()=>void act({type:'prepare'})}>{t('음성 엔진 미리 준비')}</button><button className="destructive-text" disabled={busy||!selected||builtin} onClick={()=>void act({type:'remove',profile:selected})}>{t('선택 음성 삭제')}</button></div>
   {!managed&&state.executionProfile?.startsWith('gguf-')&&<small>{t('처음 사용할 때 실행용 음성을 준비하고 다음부터는 저장된 결과를 재사용합니다. 원본 모델과 LoRA는 보존됩니다.')}</small>}
   {state.executionProfile==='compiled'&&<small>{t('처음 준비에는 컴파일 시간이 필요합니다. 준비 실패 시 기준 모드를 선택할 수 있습니다.')}</small>}
   {state.error==='COMPILE_UNAVAILABLE'&&<p>{t('CUDA 컴파일을 적용하지 못했습니다. 최적화 런타임을 연결하거나 다른 실행 모드를 선택해 주세요.')}</p>}
  </details>
 </section>
}
