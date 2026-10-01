import {mkdtemp,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {expect,it,vi} from 'vitest'
import {preparationMetrics} from '../electron/main/character-voice/VoicePreparationMetrics'
it('persists preparation counters without unrestricted audit, input or paths',async()=>{
 const root=await mkdtemp(join(tmpdir(),'voice-preparation-'))
 try{const record=preparationMetrics(root);record({type:'audio-ready',text:'private-input'});record({type:'preparation-ready',audit:{modelCheckMs:1,modelVerification:'installed',modelSkippedWeightBytes:10,transcript:'private-transcript',path:'private-path'}})
 let saved='';await vi.waitFor(async()=>{saved=await readFile(join(root,'preparation-metrics.jsonl'),'utf8');expect(saved).toContain('modelCheckMs')})
 expect(saved).not.toContain('private');expect(saved).not.toContain('audio-ready');expect(JSON.parse(saved)).toMatchObject({modelVerification:'installed',modelSkippedWeightBytes:10})
 }finally{await rm(root,{recursive:true,force:true})}
})
