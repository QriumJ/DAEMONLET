export const MAX_VOICE_SEED=0x7fffffff
export type VoiceSeedSettings={mode:'random-per-reply'|'fixed';fixedSeed:number}
export type SeedPolicy=VoiceSeedSettings['mode']|'reroll'|'reproduce'
export const DEFAULT_VOICE_SEED:VoiceSeedSettings={mode:'random-per-reply',fixedSeed:42}
export function validVoiceSeed(value:unknown):value is number{return typeof value==='number'&&Number.isSafeInteger(value)&&value>=1&&value<=MAX_VOICE_SEED}
export function validSeedSettings(value:unknown):value is VoiceSeedSettings{const v=value as VoiceSeedSettings;return !!v&&typeof v==='object'&&!Array.isArray(v)&&['random-per-reply','fixed'].includes(v.mode)&&validVoiceSeed(v.fixedSeed)&&Object.keys(v).every(k=>k==='mode'||k==='fixedSeed')}
export type VoiceGenerationPlan=Readonly<{generationId:string;effectiveSeed:number;seedPolicy:SeedPolicy;messageId:string;voiceFingerprint:string;speechPlanFingerprint:string}>
export type VoiceResultInfo=VoiceGenerationPlan & {cached:boolean;latestUnstored:boolean}
