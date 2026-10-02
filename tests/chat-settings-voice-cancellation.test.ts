import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import type {ReactElement,ReactNode} from 'react'
import type {ChatSettingsAction,ChatSettingsApi,ChatSettingsSnapshot} from '../electron/shared/chat-settings-contract'
import type {VoiceAction} from '../electron/shared/character-voice-contract'

// Exercise the actual full-settings component's action routing with controlled
// hook lifetime and pending preload promises. This is not desktop/DOM QA.
const hooks=vi.hoisted(()=>({states:[] as unknown[],refs:[] as {current:unknown}[],stateIndex:0,refIndex:0,mounting:true,effects:[] as (()=>void|(()=>void))[],cleanups:[] as (()=>void)[]}))
vi.mock('react',async original=>({...await original<typeof import('react')>(),
 useState(initial:unknown){const i=hooks.stateIndex++;if(!(i in hooks.states))hooks.states[i]=typeof initial==='function'?initial():initial;return [hooks.states[i],(next:unknown)=>{hooks.states[i]=typeof next==='function'?next(hooks.states[i]):next}]},
 useRef(initial:unknown){const i=hooks.refIndex++;return hooks.refs[i]??(hooks.refs[i]={current:initial})},
 useEffect(effect:()=>void|(()=>void)){if(hooks.mounting)hooks.effects.push(effect)},
}))
vi.mock('../src/i18n/useLanguage',()=>({useT:()=>Object.assign((s:string)=>s,{language:'ko'})}))
import {ChatVoicePage} from '../src/settings/ChatVoicePage'
import {VoiceSettings} from '../src/character-chat/VoiceControls'

const context={characterId:'gpichan',revision:'builtin',conversationId:null}
const initial={revision:1,context,chat:{model:'E4B',installed:[],phase:'idle',character:{id:'gpichan',name:'Gpichan'},displayName:'Gpichan'},voice:{epoch:1,enabled:false,autoRead:false,volume:.5,profiles:[],bindings:{},status:'off',error:null,runtimeConfigured:false},playbackReady:false} as unknown as ChatSettingsSnapshot
let tree:ReactElement,action:ReturnType<typeof vi.fn<ChatSettingsApi['action']>>,publish:(s:ChatSettingsSnapshot)=>void
const render=()=>{hooks.stateIndex=hooks.refIndex=0;tree=ChatVoicePage({manageCharacters:()=>{}})}
const flush=async()=>{for(let i=0;i<6;i++)await Promise.resolve();render()}
function voiceControls(){
 const find=(node:ReactNode):ReactElement|undefined=>{if(Array.isArray(node))return node.map(find).find(Boolean);if(!node||typeof node!=='object'||!('props'in node))return;const e=node as ReactElement<{children?:ReactNode}>;return e.type===VoiceSettings?e:find(e.props.children)}
 const found=find(tree);if(!found)throw Error('VoiceSettings not mounted');return found.props as {busy:boolean;act:(a:VoiceAction)=>Promise<boolean>|null;state:ChatSettingsSnapshot['voice']}
}
beforeEach(async()=>{
 hooks.states=[];hooks.refs=[];hooks.effects=[];hooks.cleanups=[];hooks.mounting=true
 action=vi.fn<ChatSettingsApi['action']>(async()=>initial)
 vi.stubGlobal('window',{chatSettings:{action,subscribe:(listener:typeof publish)=>{publish=listener;return()=>{}},onOpen:()=>()=>{}}})
 render();hooks.mounting=false;for(const effect of hooks.effects){const cleanup=effect();if(cleanup)hooks.cleanups.push(cleanup)}await flush();action.mockClear()
})
afterEach(()=>{hooks.cleanups.forEach(cleanup=>cleanup());vi.unstubAllGlobals()})

it.each(['installGgufModel','verifyGgufModel'] as const)('dispatches cancel while full-settings %s remains pending, keeping other mutations serialized',async type=>{
 let complete!:(s:ChatSettingsSnapshot)=>void
 const pending=new Promise<ChatSettingsSnapshot>(resolve=>{complete=resolve})
 action.mockImplementation((request:ChatSettingsAction)=>request.type==='voice'&&request.action.type===type?pending:Promise.resolve({...initial,revision:3}))
 const task=voiceControls().act({type,id:'qwen3-tts-06b-gguf'});await flush()
 publish({...initial,revision:2,voice:{...initial.voice,ggufInstall:[{id:'qwen3-tts-06b-gguf',supported:true,installed:false,verified:false,phase:type==='installGgufModel'?'downloading':'verifying',bytes:10,total:100,error:null,verification:'sha256',runtimeIncluded:false}]}});await flush()
 expect(voiceControls().busy).toBe(true)
 expect(await voiceControls().act({type:'cancelInstallGgufModel'})).toBe(true)
 expect(action).toHaveBeenCalledWith({type:'voice',action:{type:'cancelInstallGgufModel'},context})
 await flush();expect(voiceControls().busy).toBe(true)
 expect(await voiceControls().act({type:'engine',value:'voxcpm2'})).toBe(false)
 expect(action.mock.calls.map(([request])=>request.type==='voice'?request.action.type:request.type)).toEqual([type,'cancelInstallGgufModel'])
 // Completion of cancellation must not unlock the original operation or allow
 // its older result to overwrite a newer cancellation snapshot.
 complete({...initial,revision:2});await task;await flush()
 expect(voiceControls().busy).toBe(false)
 expect(await voiceControls().act({type:'engine',value:'voxcpm2'})).toBe(true)
 expect(action).toHaveBeenCalledTimes(3)
})

it('keeps the original operation busy when cancellation IPC fails so a retry can still dispatch',async()=>{
 let complete!:(s:ChatSettingsSnapshot)=>void
 const pending=new Promise<ChatSettingsSnapshot>(resolve=>{complete=resolve})
 let cancels=0
 action.mockImplementation(request=>{if(request.type==='voice'&&request.action.type==='installGgufModel')return pending;if(request.type==='voice'&&request.action.type==='cancelInstallGgufModel'&&++cancels===1)return Promise.reject(Error('fixture cancellation failed'));return Promise.resolve({...initial,revision:2})})
 const task=voiceControls().act({type:'installGgufModel',id:'voxcpm2-gguf-f16'});await flush()
 expect(await voiceControls().act({type:'cancelInstallGgufModel'})).toBe(false);await flush()
 expect(voiceControls().busy).toBe(true)
 expect(await voiceControls().act({type:'cancelInstallGgufModel'})).toBe(true)
 expect(cancels).toBe(2)
 complete({...initial,revision:3});await task;await flush();expect(voiceControls().busy).toBe(false)
})

it.each(['installGgufRuntime','repairGgufRuntime','verifyGgufRuntime'] as const)('dispatches runtime cancellation while full-settings %s is pending, without unlocking other mutations',async type=>{
 let complete!:(s:ChatSettingsSnapshot)=>void
 const pending=new Promise<ChatSettingsSnapshot>(resolve=>complete=resolve)
 action.mockImplementation(request=>request.type==='voice'&&request.action.type===type?pending:Promise.resolve({...initial,revision:3}))
 const task=voiceControls().act({type,id:'qwen-cuda'});await flush()
 publish({...initial,revision:2,voice:{...initial.voice,ggufRuntimeSetup:{busy:true,id:'qwen-cuda',error:null},ggufRuntimeInstall:[{id:'qwen-cuda',supported:true,available:true,installed:false,verified:false,phase:type==='verifyGgufRuntime'?'verifying':'downloading',bytes:10,total:100,error:null}]}});await flush()
 expect(voiceControls().busy).toBe(true);expect(await voiceControls().act({type:'cancelInstallGgufRuntime'})).toBe(true)
 expect(action).toHaveBeenCalledWith({type:'voice',action:{type:'cancelInstallGgufRuntime'},context})
 await flush();expect(voiceControls().busy).toBe(true);expect(await voiceControls().act({type:'engine',value:'voxcpm2'})).toBe(false)
 expect(action.mock.calls.map(([request])=>request.type==='voice'?request.action.type:request.type)).toEqual([type,'cancelInstallGgufRuntime'])
 complete({...initial,revision:2});await task;await flush();expect(voiceControls().busy).toBe(false)
})
