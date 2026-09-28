import type {GenerationBinding} from './character-chat-contract'

export const VOICE_IPC = {action:'character-voice.action', changed:'character-voice.changed', audio:'character-voice.audio', event:'character-voice.event'} as const
export type VoiceProfile = {id:string;version:string;name:string;fingerprint:string;adapterSha256:string}
export type ExecutionProfile='baseline'|'cached'|'compiled'|'mps-fp32-baseline'|'mps-fp32'|'gguf-metal-f16'|'gguf-metal-f16-complete'|'cuda-compiled'|'cuda-compiled-complete'
export function isStreamingProfile(profile:ExecutionProfile|undefined){return !!profile&&profile!=='baseline'&&profile!=='mps-fp32-baseline'&&profile!=='gguf-metal-f16-complete'&&profile!=='cuda-compiled-complete'}
export function voiceCapabilities(platform:string,arch:string):ExecutionProfile[]{return platform==='win32'?['baseline','cached','compiled','cuda-compiled','cuda-compiled-complete']:platform==='darwin'&&arch==='arm64'?['gguf-metal-f16','gguf-metal-f16-complete']:[]}
export type SpeechBinding = GenerationBinding & {messageId:string;speechEpoch:number;voiceProfileId:string;voiceProfileVersion:string;voiceFingerprint:string;runtimeSessionId:string;executionProfile?:ExecutionProfile}
export type VoiceInstallState={supported:boolean;installed:boolean;phase:'idle'|'preparing'|'downloading'|'verifying'|'installing';bytes:number;total:number;error:string|null}
export type VoiceSnapshot = {epoch:number;enabled:boolean;autoRead:boolean;volume:number;profiles:VoiceProfile[];bindings:Record<string,string>;status:'off'|'idle'|'loading'|'synthesizing'|'playing'|'stopped'|'error';error:string|null;runtimeConfigured:boolean;baseInstall?:VoiceInstallState;defaultProfile?:string;availableProfiles?:ExecutionProfile[];executionProfile?:ExecutionProfile}
export type VoiceAction = {type:'ready'|'snapshot'|'import'|'configure'|'test'|'stop'|'prepare'|'installBase'|'cancelInstallBase'}|{type:'executionProfile';value:ExecutionProfile}|{type:'enabled'|'auto';value:boolean}|{type:'volume';value:number}|{type:'bind';profile:string|null}|{type:'remove';profile:string}|{type:'read';messageId:string}|{type:'played';audioId:string;epoch:number;error?:boolean}|{type:'scheduled';audioId:string;epoch:number;delayMs:number;gapMs:number}|{type:'outputStopped';epoch:number;elapsedMs:number}
export type VoiceEvent = {type:'stop';epoch:number;requestedAt?:number}|{type:'audio';epoch:number;audioId:string;binding:SpeechBinding;segmentIndex:number;stream?:{synthesisId:string;chunkIndex:number;sampleOffset:number;sampleCount:number}}
export interface VoiceApi {action(value:VoiceAction):Promise<VoiceSnapshot>;audio(id:string,epoch:number):Promise<Uint8Array>;subscribe(listener:(state:VoiceSnapshot)=>void):()=>void;onEvent(listener:(event:VoiceEvent)=>void):()=>void}

export {DEFAULT_SPEECH_POLICY,planSpeech, speechSegments, legacySpeechSegments, type SpeechPolicy} from './voice-utterance-plan'
