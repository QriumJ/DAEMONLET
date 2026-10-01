import type {CharacterChatDefinition} from './character-chat-semantics'
export const DOT_IPC={get:'dot-presentation.get',changed:'dot-presentation.changed',ready:'dot-presentation.ready',voiceAction:'dot-presentation.voice-action',audio:'dot-presentation.audio',voiceEvent:'dot-presentation.voice-event',volume:'dot-presentation.volume',volumeChanged:'dot-presentation.volume-changed'} as const
export const DOT_VOICE_PREPARATION_TIMEOUT_MS=900_000
export const DOT_STATES=['idle','thinking','speaking','done','error'] as const
export const DOT_POSES=['neutral','listening','thinking','happy','sad','error'] as const
export type DotCommand={type:'present';text?:string;pose:typeof DOT_POSES[number];state:typeof DOT_STATES[number];speak:boolean;durationMs:number;fallback:boolean}|{type:'cancel'}
export type DotFrame={sequence:number;active:boolean;characterId:string|null;revision:string|null;text:string;pose:typeof DOT_POSES[number];state:typeof DOT_STATES[number];definition:CharacterChatDefinition;expiresAt:number;muted:boolean;voicePhase?:'preparing'|'playing'|'error';voiceError?:'preparation-timeout'|'failed'}
export interface DotPresentationApi{get():Promise<DotFrame|null>;subscribe(listener:(frame:DotFrame|null)=>void):()=>void;ready(value:boolean):Promise<void>}
export function parseDotCommand(value:unknown):DotCommand{
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('DOT_ARGUMENTS')
 const v=value as Record<string,unknown>
 if(v.type==='cancel'&&Object.keys(v).length===1)return {type:'cancel'}
 if(v.type!=='present'||Object.keys(v).some(k=>!['type','text','pose','state','speak','durationMs'].includes(k)))throw Error('DOT_ARGUMENTS')
 if(v.text!==undefined&&(typeof v.text!=='string'||!v.text.trim()||[...v.text].length>600||/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\ud800-\udfff]/u.test(v.text)))throw Error('DOT_TEXT')
 if(v.pose!==undefined&&(typeof v.pose!=='string'||!/^[a-zA-Z0-9_-]{1,48}$/.test(v.pose)))throw Error('DOT_POSE')
 if(v.state!==undefined&&!DOT_STATES.includes(v.state as any)||v.speak!==undefined&&typeof v.speak!=='boolean')throw Error('DOT_ARGUMENTS')
 if(v.durationMs!==undefined&&(!Number.isInteger(v.durationMs)||(v.durationMs as number)<1000||(v.durationMs as number)>30000))throw Error('DOT_DURATION')
 if(v.text===undefined&&v.pose===undefined&&v.state===undefined||v.speak===true&&v.text===undefined)throw Error('DOT_ARGUMENTS')
 const fallback=v.pose!==undefined&&!DOT_POSES.includes(v.pose as any)
 return {type:'present',...(v.text===undefined?{}:{text:(v.text as string).normalize('NFC').trim()}),pose:fallback?'neutral':(v.pose??'neutral') as any,state:(v.state??'idle') as any,speak:v.speak===true,durationMs:(v.durationMs??12000) as number,fallback}
}
