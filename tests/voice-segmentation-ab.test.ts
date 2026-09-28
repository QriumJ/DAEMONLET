import {expect,it} from 'vitest'
import {concatenateWavs,defaultCases,segmentationAb} from '../scripts/voice-segmentation-ab'
import {verifyWav} from '../electron/main/character-voice/TtsRuntimeSupervisor'
import {planSpeech} from '../electron/shared/character-voice-contract'
import {vi} from 'vitest'
function wav(){const h=Buffer.alloc(48);h.write('RIFF');h.writeUInt32LE(40,4);h.write('WAVEfmt ',8);h.writeUInt32LE(16,16);h.writeUInt16LE(1,20);h.writeUInt16LE(1,22);h.writeUInt32LE(48000,24);h.writeUInt32LE(96000,28);h.writeUInt16LE(2,32);h.writeUInt16LE(16,34);h.write('data',36);h.writeUInt32LE(4,40);h.writeInt16LE(123,44);h.writeInt16LE(-456,46);return h}
it('concatenates PCM with one header, without silence or sample changes',()=>{const a=wav(),out=concatenateWavs([a,a]);expect(out.length).toBe(52);expect(out.subarray(44)).toEqual(Buffer.concat([a.subarray(44),a.subarray(44)]));expect(verifyWav(out)).toBe(4/48)})
it('rejects malformed audio instead of masking an arm failure',()=>expect(()=>concatenateWavs([Buffer.from('RIFF')])).toThrow())
it('help and dry-run require no voice/model/runtime arguments',async()=>{const log=vi.spyOn(console,'log').mockImplementation(()=>{});try{await segmentationAb(['--help']);expect(log.mock.calls[0][0]).toContain('--dry-run');await segmentationAb(['--dry-run']);const report=JSON.parse(log.mock.calls[1][0]);expect(report.scope).toBe('planner-only');expect(report.plans[0].arms.map((a:any)=>a.segments.length)).toEqual([5,3]);expect(report.plans[1].arms.map((a:any)=>a.segments.length)).toEqual([3,1])}finally{log.mockRestore()}})
it('all default diagnostic cases obey the shared bounded planner',()=>{for(const c of defaultCases)expect(planSpeech(c.text).segments.map(s=>s.text).join('')).toBe(c.text)})
