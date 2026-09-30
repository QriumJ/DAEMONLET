import {expect,it} from 'vitest'
import {ChatDraftStore,chatDraftKey} from '../electron/main/character-chat/ChatDraftStore'
import {ComposerDraft} from '../src/character-chat/ComposerDraft'
import {ConversationViewport} from '../src/character-chat/ConversationViewport'
import {replyPreparationLabel} from '../src/character-chat/CharacterChatApp'
import type {LocalChatSnapshot} from '../electron/shared/character-chat-contract'
const snapshot=(key:string,text='',revision=0,acceptedDraft?:LocalChatSnapshot['acceptedDraft'])=>({draft:{key,text,revision},acceptedDraft} as LocalChatSnapshot)
it('bounds draft input and ignores reordered updates',()=>{
 const store=new ChatDraftStore(),key=chatDraftKey('a','one');store.update(key,'new',2);store.update(key,'old',1)
 expect(store.get(key).text).toBe('new')
 for(const [text,revision] of [['x'.repeat(6001),3],['ok',NaN],['ok',1.5],['ok',0]] as const)expect(()=>store.update(key,text,revision)).toThrow()
 store.clear();expect(store.get(key).text).toBe('')
})
it('only a matching submitted revision clears, while newer typing transfers to the created conversation',()=>{
 const store=new ChatDraftStore();store.update('new','first',1);store.update('new','second',2);store.accepted('new',1,'created');expect(store.get('created').text).toBe('second')
 store.accepted('created',2);expect(store.get('created').text).toBe('')
})
it('late renderer acknowledgments cannot erase newer typing or leak it to another character',()=>{
 const draft=new ComposerDraft();draft.receive(snapshot('a'));draft.edit('first');draft.edit('second')
 expect(draft.receive(snapshot('a','',1,{key:'a',revision:1})).text).toBe('second')
 expect(draft.receive(snapshot('created','first',1,{key:'a',revision:1})).text).toBe('second')
 expect(draft.value.key).toBe('created')
 expect(draft.receive(snapshot('other-character')).text).toBe('')
 expect(draft.receive(snapshot('created','second',2)).text).toBe('second')
 draft.edit('third');expect(draft.receive(snapshot('created','',3,{key:'created',revision:3})).text).toBe('')
})
it('streaming follows at the bottom, but scrolling up holds position and marks new replies until deliberate return',()=>{
 const view=new ConversationViewport();expect(view.content('a','reply1')).toBe(true)
 view.scroll({scrollTop:100,scrollHeight:1000,clientHeight:300});expect(view.content('a','reply2')).toBe(false);expect(view.unread).toBe(true)
 expect(view.content('a','reply3')).toBe(false);view.latest();expect(view.unread).toBe(false);expect(view.content('a','reply4')).toBe(true)
 view.scroll({scrollTop:664,scrollHeight:1000,clientHeight:300});expect(view.following).toBe(true)
 view.scroll({scrollTop:663,scrollHeight:1000,clientHeight:300});expect(view.following).toBe(false)
 expect(view.content('b','reply1')).toBe(true);expect(view.unread).toBe(false)
})
it('unchanged history and keyboard scrolling do not invent an unread reply; reopen starts at the latest',()=>{
 const view=new ConversationViewport();view.content('a','old');view.scroll({scrollTop:0,scrollHeight:6000,clientHeight:300})
 expect(view.content('a','old')).toBe(false);expect(view.unread).toBe(false)
 expect(new ConversationViewport().content('a','old')).toBe(true)
})
it('preparation labels use actual service phases',()=>{expect(replyPreparationLabel('loading')).toBe('대화 모델 준비 중');expect(replyPreparationLabel('generating')).toBe('답변 생성 중')})
