import {useEffect,useState} from 'react'
import type {VoiceAction,VoiceApi,VoiceSnapshot} from '../../electron/shared/character-voice-contract'
import {AudioPlaybackController} from './AudioPlaybackController'
declare global{interface Window{characterVoice:VoiceApi}}
const statuses={off:'음성 꺼짐',idle:'준비됨',loading:'음성 모델 준비 중',synthesizing:'문장 합성 중',playing:'음성 재생 중',stopped:'음성 중단됨',error:'음성 오류 · 텍스트 대화는 계속 사용할 수 있어요'}
const errors:Record<string,string>={VOICE_CLEANUP_PENDING:'음성 연결은 해제됐지만 파일 정리가 남아 있습니다. 앱을 다시 시작하면 정리를 재시도합니다.',VOICE_NOT_INSTALLED:'채택 음성 패키지를 가져온 뒤 캐릭터 음성을 선택해 주세요.',VOICE_RUNTIME_MISSING:'독립 TTS Python과 로컬 모델을 연결해 주세요.',VOICE_WORKER_START:'Python을 시작하지 못했습니다. 런타임 위치를 다시 연결해 주세요.',VOICE_PLAYBACK:'오디오 출력을 시작하지 못했습니다. 시험 재생을 다시 눌러 주세요.',CUDA_OOM:'GPU 메모리가 부족합니다. 음성을 끄거나 다른 GPU 작업이 끝난 뒤 다시 시도해 주세요.',VOICE_SELECTION_MISMATCH:'선택된 6000개 학습 채택본과 패키지 해시가 다릅니다.',UNSUPPORTED_DEVICE:'이 장치에서는 음성을 지원하지 않습니다. 현재 Windows CUDA 환경이 필요합니다.'}
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
 const selected=state.bindings[characterId||'']||''
 return <section className={'voice-controls'+(menu?' expanded':'')} aria-label="캐릭터 음성">
  <div role="status">{statuses[state.status]} {state.enabled&&<button onClick={()=>void act({type:'stop'})}>음성만 중단</button>}</div>
  {state.error&&<p role="alert">{errors[state.error]||'음성을 사용할 수 없습니다. 패키지·런타임·모델 위치를 확인해 다시 연결해 주세요.'} <small>{state.error}</small></p>}
  {menu&&<><label><input type="checkbox" checked={state.enabled} onChange={e=>void act({type:'enabled',value:e.target.checked})}/>음성 사용</label>
   <label>캐릭터 음성<select aria-label="캐릭터 음성" value={selected} onChange={e=>void act({type:'bind',profile:e.target.value||null})}><option value="">없음</option>{state.profiles.map(p=><option value={p.id+'@'+p.version} key={p.id+'@'+p.version}>{p.name} · {p.version}</option>)}</select></label>
   <button onClick={()=>void act({type:'import'})}>음성 패키지 가져오기</button><button onClick={()=>void act({type:'configure'})}>TTS 런타임·모델 연결</button>
   <button disabled={!state.enabled||!selected||!state.runtimeConfigured} onClick={()=>void act({type:'test'})}>새 문장 시험 재생</button>
   <label><input type="checkbox" checked={state.autoRead} onChange={e=>void act({type:'auto',value:e.target.checked})}/>새 답변 자동 읽기</label>
   <label>음량<input aria-label="음량" type="range" min="0" max="1" step="0.05" value={state.volume} onChange={e=>void act({type:'volume',value:Number(e.target.value)})}/></label>
   <button disabled={!selected} onClick={()=>void act({type:'remove',profile:selected})}>선택 음성 삭제</button><small>완료 답변을 문장별로 합성합니다. 모델 준비와 합성에 시간이 걸릴 수 있어요.</small>
  </>}
 </section>
}
