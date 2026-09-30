import {VoiceControls,MessageVoiceControls} from './VoiceControls'
import {ModifierDragController} from '../pet/ModifierDragController'
import {useEffect,useLayoutEffect,useRef,useState} from 'react'
import {useT} from '../i18n/useLanguage'
import {ComposerDraft} from './ComposerDraft'
import {ConversationViewport} from './ConversationViewport'
import type {LocalChatApi,LocalChatAction,LocalChatSnapshot} from '../../electron/shared/character-chat-contract'
declare global{interface Window{characterChat:LocalChatApi}}
export function replyPreparationLabel(phase:LocalChatSnapshot['phase']){return phase==='loading'?'대화 모델 준비 중':'답변 생성 중'}
export function CharacterChatApp(){
 const t=useT(),[state,setState]=useState<LocalChatSnapshot|null>(null),[text,setText]=useState(''),[error,setError]=useState(''),[menu,setMenu]=useState(false),[unread,setUnread]=useState(false),[submitting,setSubmitting]=useState(false)
 const draft=useRef(new ComposerDraft()),viewport=useRef(new ConversationViewport()),stateRef=useRef<LocalChatSnapshot|null>(null),menuButton=useRef<HTMLButtonElement>(null),list=useRef<HTMLDivElement>(null),content=useRef<HTMLDivElement>(null),header=useRef<HTMLElement>(null),resize=useRef<HTMLButtonElement>(null),sendPending=useRef(false)
 const receive=(next:LocalChatSnapshot)=>{
  if(stateRef.current&&next.epoch<stateRef.current.epoch)return
  stateRef.current=next;setState(next);setText(draft.current.receive(next).text)
 }
 const act=async(a:LocalChatAction)=>{try{const next=await window.characterChat.action(a);receive(next);return next}catch{setError(t('작업을 완료하지 못했습니다. 다시 시도해 주세요.'))}}
 useEffect(()=>{const controllers:ModifierDragController[]=[];for(const [element,kind] of [[header.current,'move'],[resize.current,'resize']] as const){if(element)controllers.push(new ModifierDragController(element,{platform:'native',allowed:()=>true,hit:()=>true,request:r=>window.characterChat.gesture(kind,r),lock:active=>element.classList.toggle('dragging',active),gesture:e=>e.button===0&&!(kind==='move'&&(e.target as Element).closest('button'))}))}return()=>controllers.forEach(c=>c.dispose())},[])
 useEffect(()=>{const off=window.characterChat.subscribe(receive);void act({type:'snapshot'});return off},[])
 const key=state?.draft?.key||state?.conversation?.id||state?.character?.id||'',last=state?.conversation?.messages.filter(m=>m.role==='assistant').at(-1),reply=last?JSON.stringify([last.id,last.text,last.status]):''
 useLayoutEffect(()=>{const element=list.current;if(!element)return;if(viewport.current.content(key,reply))element.scrollTop=element.scrollHeight;setUnread(viewport.current.unread)},[key,reply])
 useEffect(()=>{const observer=new ResizeObserver(()=>{const element=list.current;if(element&&viewport.current.following)element.scrollTop=element.scrollHeight});if(content.current)observer.observe(content.current);if(list.current)observer.observe(list.current);return()=>observer.disconnect()},[])
 const latest=()=>{viewport.current.latest();if(list.current)list.current.scrollTop=list.current.scrollHeight;setUnread(false)}
 const busy=state?['loading','generating','replying'].includes(state.phase):false,installed=state?.installed.includes(state.model)
 const send=async()=>{
  if(!draft.current.value.text.trim()||busy||sendPending.current||!installed)return
  const value={...draft.current.value};sendPending.current=true;setSubmitting(true);setError('')
  try{await window.characterChat.saveDraft(value);const next=await act({type:'send',text:value.text,draftKey:value.key,draftRevision:value.revision});if(next?.acceptedDraft?.key===value.key&&next.acceptedDraft.revision===value.revision)latest()}
  catch{setError(t('초안을 보관하지 못했습니다. 내용을 복사하고 다시 시도해 주세요.'))}
  finally{sendPending.current=false;setSubmitting(false)}
 }
 return <main className="chat-bubble" onKeyDown={e=>{if(e.key==='Escape'&&menu){setMenu(false);menuButton.current?.focus()}}} onPointerDown={e=>{if(menu&&!(e.target as Element).closest('.bubble-menu, .chat-menu-button'))setMenu(false)}}>
  <header ref={header} title={t('끌어서 말풍선 이동')}><div className="drag-space"><span className="chat-name">{state?.displayName||state?.character?.name}</span></div><button className="chat-menu-button" ref={menuButton} aria-label={t('대화 메뉴')} aria-controls="chat-quick-switch" aria-expanded={menu} onClick={()=>setMenu(!menu)}>···</button><button aria-label={t('말풍선 닫기')} onClick={()=>void act({type:'codex-mode'})}>×</button></header>
  <VoiceControls showStatus={!menu}/>{menu&&<ChatQuickSwitch state={state} act={act} close={()=>setMenu(false)}/>}
  <div className="messages-region"><div className="messages" ref={list} tabIndex={0} aria-label={t('대화 내용')} onScroll={()=>{if(list.current){viewport.current.scroll(list.current);setUnread(viewport.current.unread)}}}><div ref={content}>
   {state&&!installed&&<div className="setup"><button onClick={()=>void act({type:'open-settings'})}>{t('설정에서 모델 준비하기')}</button></div>}
   {state?.conversation?.messages.map(m=><article className={'message '+m.role} key={m.id} aria-label={t(m.role==='user'?'보낸 메시지':'받은 메시지')}><p>{m.text||(m.status==='streaming'?<span className="reply-preparation" role="status"><span className="typing" aria-hidden="true"><i/><i/><i/></span>{t(replyPreparationLabel(state.phase))}</span>:'…')}</p>{m.role==='assistant'&&m.status==='complete'&&<MessageVoiceControls messageId={m.id}/>}{m.status==='stopped'&&<small>{t('중단됨')}</small>}{m.status==='error'&&<small>{t('응답을 받지 못했어요')}</small>}</article>)}
  </div></div><span className="chat-sr-only" role="status">{unread?t('새 답변이 있습니다.'):''}</span>{unread&&<button className="new-reply" onMouseDown={e=>e.preventDefault()} onClick={()=>{const keyboard=document.activeElement?.classList.contains('new-reply');latest();if(keyboard)list.current?.focus({preventScroll:true})}}>{t('새 답변 보기')} ↓</button>}</div>
  {(state?.error||error)&&<div className="error" role="alert">{t(state?.error||error)}</div>}
  <div className="composer"><textarea aria-label={t('메시지')} disabled={!state?.draft} onFocus={()=>void act({type:'attention',active:true})} onBlur={()=>void act({type:'attention',active:false})} placeholder={t('메시지')} value={text} maxLength={6000} onChange={e=>{const value=draft.current.edit(e.target.value);setText(value.text);void window.characterChat.saveDraft(value).catch(()=>setError(t('초안을 보관하지 못했습니다. 내용을 복사하고 다시 시도해 주세요.')))}} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();void send()}}}/>{busy?<button className="send-button" aria-label={t('응답 중단')} title={t('중단')} onClick={()=>void act({type:'stop'})}><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/></svg></button>:<button className="send-button" aria-label={t('보내기')} title={t('보내기')} disabled={!installed||!text.trim()||submitting} onClick={()=>void send()}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5m-6 6 6-6 6 6" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/></svg></button>}</div>
  <div className="tail"/><button ref={resize} className="resize-handle" aria-label={t('끌어서 말풍선 크기 조절')} title={t('끌어서 크기 조절')}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m5 12 7-7m-2 7 2-2" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg></button>
 </main>
}

export function ChatQuickSwitch({state,act,close}:{state:LocalChatSnapshot|null;act:(value:LocalChatAction)=>unknown;close:()=>void}){const t=useT();return <section id="chat-quick-switch" className="bubble-menu" aria-label={t('대화 선택')}><label>{t('캐릭터')}<select aria-label={t('캐릭터')} value={state?.character?.id||''} onChange={e=>void act({type:'character',id:e.target.value})}>{state?.characters.map(c=><option value={c.id} key={c.id}>{c.name}</option>)}</select></label><label>{t('저장된 대화')}<select aria-label={t('저장된 대화')} value={state?.conversation?.id||''} onChange={e=>{void act({type:'conversation',id:e.target.value});close()}}><option value="" disabled>{t('대화 선택')}</option>{state?.conversations.filter(c=>c.characterId===state.character?.id).map(c=><option value={c.id} key={c.id}>{c.title}</option>)}</select></label></section>}
