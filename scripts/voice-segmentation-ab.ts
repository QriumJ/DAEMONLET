import {readFile,mkdir,writeFile} from 'node:fs/promises'
import {resolve,join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {planSpeech,type ExecutionProfile,type SpeechBinding} from '../electron/shared/character-voice-contract'
import {verifyVoicePackage,SELECTED_VOICE,sha256} from '../electron/main/character-voice/VoicePackage'
import {TtsRuntimeSupervisor,verifyWav} from '../electron/main/character-voice/TtsRuntimeSupervisor'

export const segmentationHelp=`segmentation-ab --dry-run [--cases cases.json] [--data NEW_DIRECTORY]
segmentation-ab --package PATH --python PATH --model PATH --data NEW_DIRECTORY
  [--profile gguf-metal-f16|compiled|cuda-compiled|cached|baseline|gguf-metal-f16-complete|cuda-compiled-complete]
  [--cases cases.json] [--repeats 3] [--policies legacy-sentence-v1,transition-v1] [--compiler-cache PATH] [--cache-root PATH]
Cases: JSON array of {id,text}. Output must not exist. No downloads.
--cache-root reuses an approved runtime cache (including adjacent gguf-cache), never app settings.
Worker timing uses immediate credit; app playback and listening require separate validation.`
export const defaultCases=[
 {id:'required-a',text:'비 소리 들으니까 밖은 진짜 축축하겠다. 우리 오늘은 그냥 가게 문 닫고 좀 쉴까? 아, 그래도 손님 오실 수도 있으니까 가게는 열어두고 안에서 쉬자. 그럼 내가 따뜻한 차라도 좀 더 끓여올게. 오빠도 옆에 앉아서 좀 쉬어, 오늘 고생 많았잖아.'},
 {id:'required-b',text:'아... 하, 안 돼... 그만...'},
 {id:'ellipsis-unicode',text:'아… 하, 안 돼… 그만…'},
 ...['응.','왜?','알았어.'].map((text,i)=>({id:`short-${i}`,text})),
 {id:'test',text:'응, 듣고 있어. 지금은 어떤 이야기를 할까?'},
 {id:'mixed',text:'오후 3.14초쯤 멈췄어? 응, v0.8.1에서 Dr. Kim의 file.wav를 확인했어. 아... 잠깐만.'},
 {id:'long',text:'오늘은 비가 내리니까 따뜻한 차를 마시면서 천천히 이야기하자. 창밖을 바라보니 길을 걷는 사람들이 우산을 들고 있어. '.repeat(4)+'그만...'},
]
export function concatenateWavs(wavs:Buffer[]){
 const parts:Buffer[]=[]
 for(const wav of wavs){verifyWav(wav);for(let i=12;i+8<=wav.length;){const size=wav.readUInt32LE(i+4);if(wav.toString('ascii',i,i+4)==='data')parts.push(wav.subarray(i+8,i+8+size));i+=8+size+(size%2)}}
 const pcm=Buffer.concat(parts);if(!pcm.length)throw Error('VOICE_INVALID_WAV')
 const h=Buffer.alloc(44);h.write('RIFF');h.writeUInt32LE(36+pcm.length,4);h.write('WAVEfmt ',8);h.writeUInt32LE(16,16);h.writeUInt16LE(1,20);h.writeUInt16LE(1,22);h.writeUInt32LE(48000,24);h.writeUInt32LE(96000,28);h.writeUInt16LE(2,32);h.writeUInt16LE(16,34);h.write('data',36);h.writeUInt32LE(pcm.length,40)
 return Buffer.concat([h,pcm]) // Diagnostic concatenation may span multiple bounded synthesis inputs.
}
export async function segmentationAb(args:string[]){
 if(args.includes('--help')){console.log(segmentationHelp);return}
 const value=(name:string,fallback?:string)=>{const i=args.indexOf('--'+name);if(i<0){if(fallback!==undefined)return fallback;throw Error('Missing --'+name)}if(!args[i+1]||args[i+1].startsWith('--'))throw Error('Missing --'+name);return args[i+1]}
 const cases=args.includes('--cases')?JSON.parse(await readFile(resolve(value('cases')),'utf8')):defaultCases
 if(!Array.isArray(cases)||!cases.length||cases.length>100||cases.some(c=>!c||typeof c.text!=='string'||typeof c.id!=='string'||!/^[a-zA-Z0-9_-]{1,80}$/.test(c.id))||new Set(cases.map(c=>c.id)).size!==cases.length)throw Error('VOICE_AB_CASES')
 const policies=value('policies','legacy-sentence-v1,transition-v1').split(',');if(policies.length!==2||new Set(policies).size!==2||policies.some(p=>!['legacy-sentence-v1','utterance-v1','transition-v1'].includes(p)))throw Error('VOICE_AB_POLICIES')
 const plans=cases.map(c=>({...c,arms:policies.map(policy=>planSpeech(c.text,policy as any))}))
 const report:any={runId:randomUUID(),baseCommit:'08cc14a77776f4a0a626cc907841856815fc93e6',os:process.platform,arch:process.arch,plans,scope:'worker-immediate-credit',appPlayback:'NOT_TESTED',listening:'PENDING_REVIEW',measurements:[]}
 const data=args.includes('--data')?resolve(value('data')):undefined
 if(data)await mkdir(data) // exclusive: do not overwrite earlier reports, packages or app data
 if(args.includes('--dry-run')){report.scope='planner-only';if(data)await writeFile(join(data,'plan.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));return}
 if(!data)throw Error('Missing --data')
 report.implementationCommit=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();report.dirty=!!execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim()
 const repeats=Number(value('repeats','3'));if(!Number.isSafeInteger(repeats)||repeats<1||repeats>10)throw Error('VOICE_AB_REPEATS')
 const profile=value('profile',process.platform==='darwin'?'gguf-metal-f16':'compiled') as ExecutionProfile
 if(!['gguf-metal-f16','compiled','cuda-compiled','cached','baseline','gguf-metal-f16-complete','cuda-compiled-complete'].includes(profile))throw Error('EXECUTION_PROFILE')
 const source=resolve(value('package')),verified=await verifyVoicePackage(source,SELECTED_VOICE)
 report.voice=verified.profile;report.manifest=verified.manifest;report.referenceSha256=await sha256(join(source,verified.manifest.reference));report.executionProfile=profile
 report.effectiveGeneration=profile.startsWith('gguf-')?{seed:42,cfg:2,steps:10,temperature:1,maxSteps:'min(600,token_count*6+10)',seedSource:'fixed native binary; not changed by CLI'}:{source:'verified package inference settings; see manifest and worker audit'}
 const worker=new TtsRuntimeSupervisor({python:resolve(value('python')),model:resolve(value('model')),worker:resolve('electron/voice/worker.py'),cacheRoot:resolve(value('cache-root',join(data,'cache'))),compilerCache:resolve(value('compiler-cache',join(data,'compiler-cache'))),executionProfile:profile},300_000)
 const csv=[`case_id,backend,voice,repeat,${policies[0]}_path,${policies[1]}_path,text_complete,short_phrase_naturalness,within_reply_voice_consistency,boundary_naturalness,ending_ok,preferred,reviewer,notes`]
 const save=async()=>{await writeFile(join(data,'report.json'),JSON.stringify(report,null,2)+'\n');await writeFile(join(data,'listening.csv'),csv.join('\n')+'\n')}
 try{
  const load=performance.now();await worker.start(source,verified.profile.fingerprint+':'+profile);report.loadMs=performance.now()-load;report.audit=worker.audit
  const binding:SpeechBinding={characterId:'diagnostic',revision:'diagnostic',conversationId:randomUUID(),messageId:randomUUID(),requestId:randomUUID(),epoch:1,speechEpoch:1,personaHash:'diagnostic',semanticHash:'diagnostic',modelId:'E4B',voiceProfileId:verified.profile.id,voiceProfileVersion:verified.profile.version,voiceFingerprint:verified.profile.fingerprint,runtimeSessionId:worker.sessionId,executionProfile:profile}
  for(let repeat=0;repeat<repeats;repeat++)for(const c of plans){
   const files:Record<string,string>={}
   for(const arm of c.arms){
    const measurement:any={caseId:c.id,repeat,policy:arm.policy,order:report.measurements.length,session:worker.sessionId,workerState:'ready after initial load or preceding arm',tinyCount:arm.segments.filter((s:any)=>s.tinyReason).length,actualCalls:0,segments:[],status:'RUNNING'};report.measurements.push(measurement)
    const wavs:Buffer[]=[]
    for(const s of arm.segments){
     const chunks:Buffer[]=[],start=performance.now();let first:number|undefined;measurement.actualCalls++
     const metric:any=profile==='baseline'||profile.endsWith('-complete')?await worker.synthesize(s.text,binding,s.index):await worker.stream(s.text,binding,s.index,async chunk=>{first??=performance.now()-start;chunks.push(Buffer.from(chunk.bytes))})
     const wav=metric.bytes?Buffer.from(metric.bytes):concatenateWavs(chunks);verifyWav(wav);wavs.push(wav)
     const file=`${c.id}-${repeat}-${arm.policy}-${s.index}.wav`;await writeFile(join(data,file),wav)
     const {bytes,...metrics}=metric;measurement.segments.push({...s,utf16:s.text.length,utf8:Buffer.byteLength(s.text),file,firstChunkReceivedMs:first??null,wallMs:performance.now()-start,...metrics});await save()
    }
    const file=`${c.id}-${repeat}-${arm.policy}.wav`;await writeFile(join(data,file),concatenateWavs(wavs));files[arm.policy]=file;measurement.wav=file;measurement.status='PASS';await save()
   }
   csv.push([c.id,profile,verified.profile.id,repeat,files[policies[0]],files[policies[1]],...Array(7).fill(''),'PENDING_REVIEW'].join(','));await save()
  }
  report.status='PASS'
 }catch(error){report.status='FAIL';report.error=error instanceof Error?error.message:'ERROR';const last=report.measurements.at(-1);if(last?.status==='RUNNING'){last.status='FAIL';last.error=report.error}throw error}
 finally{try{await worker.stop()}finally{await save();console.log(JSON.stringify({status:report.status,data,measurements:report.measurements.length,listening:report.listening}))}}
}
