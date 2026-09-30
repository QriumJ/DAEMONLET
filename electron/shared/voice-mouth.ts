export const VOICE_MOUTH_IPC = 'character-voice.mouth'
export type VoiceMouthInput = {epoch:number;level:0|1|2}
export type VoiceMouthFrame = VoiceMouthInput & {characterId:string;revision:string}
export function validVoiceMouth(value:unknown):value is VoiceMouthInput {
 if(!value||typeof value!=='object'||Array.isArray(value))return false
 const frame=value as Record<string,unknown>
 return Object.keys(frame).length===2&&Number.isSafeInteger(frame.epoch)&&(frame.epoch as number)>=0&&(frame.level===0||frame.level===1||frame.level===2)
}
