import {afterEach,expect,it,vi} from 'vitest'
import {mkdtemp,writeFile,rm,access} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {seedAb} from '../scripts/voice-seed-ab'
const roots:string[]=[]
afterEach(async()=>{vi.restoreAllMocks();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true})})
it('help and dry-run need no model/runtime or output directory',async()=>{const log=vi.spyOn(console,'log').mockImplementation(()=>{});await seedAb(['--help']);expect(log).toHaveBeenCalled();const root=await mkdtemp(join(tmpdir(),'seed-ab-'));roots.push(root);const cfg=join(root,'config.json'),cases=join(root,'cases.json'),out=join(root,'absent');await writeFile(cfg,JSON.stringify({kind:'wav',executionProfile:'gguf-metal-f16'}));await writeFile(cases,JSON.stringify(['응.','오늘은 조금 쉬어도 괜찮아.']));await seedAb(['--config',cfg,'--cases',cases,'--output',out,'--seeds','42,17,42','--dry-run']);const value=JSON.parse(String(log.mock.calls.at(-1)![0]));expect(value).toMatchObject({seeds:[42,17,42],modelLoaded:false,outputWritten:false});await expect(access(out)).rejects.toThrow()})
it.each(['0','-1','1.5','true','2147483648','42,'])('rejects invalid explicit seed list %s before reading models',async seeds=>{await expect(seedAb(['--seeds',seeds])).rejects.toThrow('VOICE_SEED_INVALID')})
