import {useEffect,useState} from 'react'
import {isStreamingProfile,type VoiceAction,type VoiceApi,type VoiceSnapshot,type ExecutionProfile} from '../../electron/shared/character-voice-contract'
import {AudioPlaybackController} from './AudioPlaybackController'
declare global{interface Window{characterVoice:VoiceApi}}
const statuses={off:'음성 꺼짐',idle:'준비됨',loading:'음성 모델 준비 중',synthesizing:'문장 합성 중',playing:'음성 재생 중',stopped:'음성 중단됨',error:'음성 오류 · 텍스트 대화는 계속 사용할 수 있어요'}
const errors:Record<string,string>={VOICE_RUNTIME_INSTALL:'음성 실행 환경 설치를 완료하지 못했습니다. 다시 시도하면 내려받은 파일을 재사용합니다.',VOICE_BASE_NOT_INSTALLED:'기본 음성 설치 버튼으로 모델을 먼저 받아 주세요.',VOICE_BASE_RUNTIME:'이 앱의 기본 음성 엔진을 확인하지 못했습니다. 기본 음성을 포함한 Mac 배포본이 필요합니다.',VOICE_BASE_CHANGED:'기본 음성 파일 검증에 실패했습니다. 설치 버튼으로 다시 받아 주세요.',VOICE_DOWNLOAD_FAILED:'다운로드하지 못했습니다. 설치 버튼을 다시 누르면 이어받습니다.',VOICE_DOWNLOAD_ACCESS:'모델 제공처의 접근 조건을 확인해 주세요.',VOICE_DOWNLOAD_RANGE:'서버의 이어받기 응답이 올바르지 않습니다. 다시 시도해 주세요.',VOICE_DISK_SPACE:'기본 음성 설치를 위한 여유 공간이 부족합니다.',GGUF_CONVERSION_FAILED:'실행용 음성을 준비하지 못했습니다. 호환되는 LoRA 패키지와 변환 환경을 확인해 주세요.',GGUF_CACHE_CHANGED:'저장된 실행용 음성의 검증에 실패했습니다. 해당 음성을 삭제하고 원본 패키지를 다시 가져와 주세요.',GGUF_DISK_SPACE:'첫 음성 준비에는 임시 여유 공간 30GB가 필요합니다.',RUNTIME_DEPENDENCY:'음성 런타임의 추론 패키지를 찾거나 불러올 수 없습니다. 설치 진단을 실행해 주세요.',MPS_OOM:'Mac GPU 메모리가 부족합니다. 다른 GPU 작업이 끝난 뒤 다시 시도해 주세요.',VOICE_PLATFORM_PROFILE:'다른 플랫폼의 음성 설정입니다. 이 Mac에 맞는 실행 모드와 런타임을 연결한 뒤 음성을 켜 주세요.',RUNTIME_POLICY:'선택한 음성 실행 모드와 환경이 다릅니다.',RUNTIME_VERSION:'선택한 Python이 승인된 음성 런타임 버전과 다릅니다.',RUNTIME_RECEIPT:'Mac 음성 런타임의 설치 영수증을 확인하지 못했습니다.',VOICE_CLEANUP_PENDING:'음성 연결은 해제됐지만 파일 정리가 남아 있습니다. 앱을 다시 시작하면 정리를 재시도합니다.',VOICE_NOT_INSTALLED:'음성 패키지를 가져온 뒤 캐릭터 음성을 선택해 주세요.',VOICE_RUNTIME_MISSING:'독립 TTS Python과 로컬 모델을 연결해 주세요.',VOICE_WORKER_START:'음성 엔진을 시작하지 못했습니다. 설치 상태와 실행 환경을 확인해 주세요.',VOICE_PLAYBACK:'오디오 출력을 시작하지 못했습니다. 시험 재생을 다시 눌러 주세요.',CUDA_OOM:'GPU 메모리가 부족합니다. 음성을 끄거나 다른 GPU 작업이 끝난 뒤 다시 시도해 주세요.',VOICE_SELECTION_MISMATCH:'선택된 6000개 학습 채택본과 패키지 해시가 다릅니다.',UNSUPPORTED_DEVICE:'이 장치에서는 음성을 지원하지 않습니다. Windows CUDA 또는 Apple Silicon Metal 환경이 필요합니다.'}
export function VoiceControls({characterId,menu}:{characterId?:string;menu:boolean}){
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
 if(!state)return null
 const selected=state.bindings[characterId||'']??state.defaultProfile??''
 const builtin=!!state.defaultProfile&&selected===state.defaultProfile,install=state.baseInstall
 return <section className={'voice-controls'+(menu?' expanded':'')} aria-label="캐릭터 음성">
  <div role="status">{statuses[state.status]} {state.enabled&&<button onClick={()=>void act({type:'stop'})}>음성만 중단</button>}</div>
  {state.error&&<p role="alert">{errors[state.error]||'음성을 사용할 수 없습니다. 패키지·런타임·모델 위치를 확인해 다시 연결해 주세요.'} <small>{state.error}</small></p>}
  {(menu||state.enabled&&builtin&&!install?.installed)&&install?.supported&&<div className="voice-install">
   <small>기본 음성 · VoxCPM2 · 다운로드 약 {(install.total/1e9).toFixed(1)}GB · 모델 Apache-2.0<br/>{state.availableProfiles?.includes('cuda-compiled')?'Python·PyTorch 실행 환경과 기본 모델을 함께 설치합니다. 여유 공간 30GB와 BF16 지원 NVIDIA GPU가 필요합니다.':'학습 패키지 없이 사용할 수 있습니다.'} 여성 음색을 기본으로 사용하며, 문장에 따라 조금 달라질 수 있어요.</small>
   {install.phase!=='idle'?<><progress aria-label="기본 음성 설치 진행률" value={install.bytes} max={install.total}/><span role="status">{install.phase==='preparing'?'설치 준비 중':install.phase==='verifying'?'파일 검증 중':install.phase==='installing'?'실행 환경 설치 중':`다운로드 중 ${Math.floor(install.bytes/install.total*100)}%`}</span><button onClick={()=>void act({type:'cancelInstallBase'})}>설치 중단</button></>:<button disabled={install.installed} onClick={()=>void act({type:'installBase'})}>{install.installed?'기본 음성 설치됨':'기본 음성 설치'}</button>}
   {install.error&&<p role="alert">{errors[install.error]||'설치를 완료하지 못했습니다. 다시 시도해 주세요.'}</p>}
  </div>}
  {menu&&<><label><input type="checkbox" checked={state.enabled} onChange={e=>void act({type:'enabled',value:e.target.checked})}/>음성 사용</label>
   <label>캐릭터 음성<select aria-label="캐릭터 음성" value={selected} onChange={e=>void act({type:'bind',profile:e.target.value||null})}>{!state.defaultProfile&&<option value="">없음</option>}{state.profiles.map(p=><option value={p.id+'@'+p.version} key={p.id+'@'+p.version}>{p.name}{p.id+'@'+p.version===state.defaultProfile?'':' · '+p.version}</option>)}</select></label>
   <button onClick={()=>void act({type:'import'})}>음성 패키지 가져오기</button>{!builtin&&<button onClick={()=>void act({type:'configure'})}>TTS 런타임·모델 연결</button>}
   <label>음성 실행 모드<select aria-label="음성 실행 모드" value={state.executionProfile||'baseline'} onChange={e=>void act({type:'executionProfile',value:e.target.value as ExecutionProfile})}>{(state.availableProfiles||[]).map(profile=><option key={profile} value={profile}>{{baseline:'Windows 기준 · 완성 후 재생',cached:'Windows 캐시 · 청크 재생',compiled:'CUDA 가속 (실험)', 'mps-fp32-baseline':'이전 모드','mps-fp32':'이전 모드','gguf-metal-f16':'Metal · 청크 재생','gguf-metal-f16-complete':'Metal · 완성 후 재생','cuda-compiled':'CUDA · 청크 재생','cuda-compiled-complete':'CUDA · 완성 후 재생'}[profile]}</option>)}</select></label>
   {!builtin&&state.executionProfile==='gguf-metal-f16'&&<small>학습한 LoRA 음성 패키지를 가져오세요. 처음 사용할 때 실행용 음성을 준비하며, 다음부터는 저장된 결과를 재사용합니다. 원본 모델과 LoRA는 보존됩니다.</small>}
   {state.executionProfile?.endsWith('-complete')&&<small>각 문장의 합성을 끝낸 뒤 재생합니다.</small>}
   {state.executionProfile==='compiled'&&<small>처음 준비에는 컴파일 시간이 필요하며 발음·음질은 확인 중입니다. 준비 실패 시 기준 모드를 선택할 수 있습니다.</small>}
   <button disabled={!state.enabled||!selected||!state.runtimeConfigured||(!isStreamingProfile(state.executionProfile)&&!state.executionProfile?.endsWith('-complete'))} onClick={()=>void act({type:'prepare'})}>음성 엔진 미리 준비</button>
   {state.error==='COMPILE_UNAVAILABLE'&&<p>CUDA 컴파일을 적용하지 못했습니다. 최적화 런타임을 연결하거나 다른 실행 모드를 선택해 주세요.</p>}
   <button disabled={!state.enabled||!selected||!state.runtimeConfigured} onClick={()=>void act({type:'test'})}>새 문장 시험 재생</button>
   <label><input type="checkbox" checked={state.autoRead} onChange={e=>void act({type:'auto',value:e.target.checked})}/>새 답변 자동 읽기</label>
   <label>음량<input aria-label="음량" type="range" min="0" max="1" step="0.05" value={state.volume} onChange={e=>void act({type:'volume',value:Number(e.target.value)})}/></label>
   <button disabled={!selected||builtin} onClick={()=>void act({type:'remove',profile:selected})}>선택 음성 삭제</button><small>완료 답변을 문장별로 합성합니다. 모델 준비와 합성에 시간이 걸릴 수 있어요.</small>
  </>}
 </section>
}
