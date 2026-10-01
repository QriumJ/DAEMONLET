import {EventEmitter} from 'node:events'
import {expect,it,vi} from 'vitest'
const state=vi.hoisted(()=>({child:null as EventEmitter|null,callback:null as ((error:Error|null,stdout:string)=>void)|null}))
vi.mock('node:child_process',()=>({execFile:vi.fn((_python,_args,_options,callback)=>{state.callback=callback;return state.child=new EventEmitter()})}))
import {checkWindowsModel} from '../electron/main/character-voice/WindowsModelCheck'
it('an abort callback cannot report completion until the owned process closes',async()=>{
 const controller=new AbortController();let settled=false
 const task=checkWindowsModel('/python','/model','/worker.py','voxcpm2',controller.signal).catch(e=>e.message).finally(()=>{settled=true})
 controller.abort();state.callback!(Error('aborted'),'');await Promise.resolve();expect(settled).toBe(false)
 state.child!.emit('close');expect(await task).toBe('VOICE_MODEL_CHECK_CANCELLED')
})
it('failed checks return private codes instead of upstream paths or text',async()=>{
 const task=checkWindowsModel('/python','/model','/worker.py','qwen3-tts-06b',new AbortController().signal).catch(e=>e.message)
 state.callback!(Error('private upstream data'),'private output');state.child!.emit('close')
 expect(await task).toBe('VOICE_MODEL_CHECK_FAILED')
})
