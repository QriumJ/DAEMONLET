/** Offline, sequential, silent A/B. Explicit config and NEW external output folder. */
import {readFile,writeFile,mkdir,readdir,copyFile,rm,realpath} from 'node:fs/promises'
import {resolve,join,isAbsolute,relative,sep} from 'node:path'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {createHash,randomUUID,randomInt} from 'node:crypto'
import {TtsRuntimeSupervisor,verifyWav,type TtsConfig} from '../electron/main/character-voice/TtsRuntimeSupervisor'
import {canonicalReferenceWav} from '../electron/main/character-voice/ReferenceWav'
import {planSpeech,type SpeechBinding} from '../electron/shared/character-voice-contract'
const hash=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex')
const opt=(key:string)=>{const i=process.argv.indexOf('--'+key);if(i<0||!process.argv[i+1])throw Error('Missing --'+key);return process.argv[i+1]}
const cfg=JSON.parse(await readFile(resolve(opt('config')),'utf8'))
const texts=JSON.parse(await readFile(resolve(opt('cases')),'utf8'))
if(!Array.isArray(texts)||texts.length<1||texts.length>6||texts.some(t=>typeof t!=='string'||!t.trim()||t.length>600))throw Error('AB_CASES')
const cases=texts.map(text=>({text,plan:planSpeech(text)}))
if(process.argv.includes('--dry-run')){console.log(JSON.stringify({cases,modes:cfg.transcript?['x-vector','icl']:['x-vector'],noAudioPlayback:true,noGpuLoaded:true}));process.exit(0)}
if(process.platform!=='win32'||cfg.referenceAuthorized!==true)throw Error('AB_REFERENCE_AUTHORIZATION')
const output=resolve(opt('output')),repo=await realpath('.')
const rel=relative(repo,output);if(!rel||!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+sep))throw Error('AB_EXTERNAL_OUTPUT_REQUIRED')
for(const engine of ['vox','qwen'])for(const key of ['python','model','worker'])if(!isAbsolute(cfg[engine]?.[key]||''))throw Error('AB_CONFIG')
if(!isAbsolute(cfg.reference)||!Number.isInteger(cfg.voxSeed)||!Number.isInteger(cfg.qwenSeed))throw Error('AB_CONFIG')
await mkdir(output,{recursive:false});const refRoot=join(output,'reference');await mkdir(refRoot)
const {wav,audio}=canonicalReferenceWav(await readFile(cfg.reference)),reference=join(refRoot,'reference.wav');await writeFile(reference,wav)
const condition={kind:'wav-reference' as const,path:reference,sha256:hash(wav),fingerprint:hash(wav),preprocessingVersion:'mono-pcm16-round-v1',sampleRate:audio.sampleRate,samples:audio.samples}
const report:any={schemaVersion:1,status:'RUNNING',review:'PENDING_BLIND_LISTEN',cases,referenceSha256:condition.sha256,referenceBytes:wav.length,segmentation:'transition-v1',numericSeedsNotComparableBetweenEngines:true,noPostprocessing:'Raw FLOAT WAV retained; app PCM16 conversion/resampling only. No loudness normalization, denoise or trim.',gpuSnapshots:[],runs:[],lifecycle:[],icl:cfg.transcript?'requested':'PENDING_ACCURATE_REFERENCE_TRANSCRIPT'}
const save=()=>writeFile(join(output,'manifest.json'),JSON.stringify(report,null,2))
async function gpu(phase:string){
 const {stdout}=await promisify(execFile)('nvidia-smi',['--query-gpu=name,utilization.gpu,memory.used,memory.free','--format=csv,noheader,nounits'],{windowsHide:true})
 const cells=stdout.trim().split(',').map(x=>x.trim()),row={phase,at:new Date().toISOString(),name:cells[0],utilization:Number(cells[1]),usedMiB:Number(cells[2]),freeMiB:Number(cells[3])}
 report.gpuSnapshots.push(row);await save()
 if(!Number.isFinite(row.utilization)||row.utilization>10||row.freeMiB<10000)throw Error('AB_GPU_BUSY_OR_MEMORY_LOW')
 return row
}
let runtime:TtsRuntimeSupervisor|undefined
try{
 for(const [engine,mode] of [['vox','reference'],['qwen','x-vector'],...(cfg.transcript?[['qwen','icl']]:[])] as string[][]){
  await gpu('before-'+engine+'-'+mode)
  const cache=join(output,'cache-'+engine+'-'+mode);await mkdir(cache)
  const conf:TtsConfig={...cfg[engine],engine:engine==='qwen'?'qwen3-tts-06b':'voxcpm2',executionProfile:engine==='qwen'?'qwen-complete':'cuda-compiled-complete',windowsBase:engine==='vox',cacheRoot:cache,compilerCache:join(output,'compiler-cache'),keepRaw:true,diagnosticPrewarm:true,qwen:{mode:mode==='icl'?'icl':'x-vector',transcript:mode==='icl'?cfg.transcript:''}}
  // Diagnostic Vox worker emits complete audio directly instead of transport chunks.
  if(engine==='vox')conf.executionProfile='compiled'
  runtime=new TtsRuntimeSupervisor(conf,900000)
  const cloneFingerprint=hash(JSON.stringify({engine,mode,revision:engine==='qwen'?'5d83992436eae1d760afd27aff78a71d676296fc':'32279effe8c19989596f05d353d1447f51d9e915',reference:condition.sha256,transcript:mode==='icl'?hash(cfg.transcript):''}))
  const cond={...condition,fingerprint:cloneFingerprint},start=Date.now()
  await runtime.start('',cloneFingerprint,cond)
  const cold:any={engine,mode,initWallMs:Date.now()-start,ready:runtime.audit};report.lifecycle.push(cold);await save()
  const pre=Date.now();await runtime.prewarm();cold.prewarmWallMs=Date.now()-pre;cold.warmed=runtime.audit;await save()
  let epoch=0
  const binding=(seed:number)=>({engine:conf.engine,executionProfile:conf.executionProfile,effectiveSeed:seed,runtimeSessionId:runtime!.sessionId,conditioningFingerprint:cond.fingerprint,speechEpoch:++epoch,characterId:'diagnostic',revision:'1',conversationId:'ab',messageId:'diagnostic',requestId:randomUUID(),generationId:randomUUID(),voiceProfileId:'authorized-reference',voiceProfileVersion:condition.sha256,voiceFingerprint:condition.sha256,epoch:1,modelId:'E4B',personaHash:'diagnostic',semanticHash:'diagnostic'}) as SpeechBinding
  const seed=engine==='vox'?cfg.voxSeed:cfg.qwenSeed
  for(let repeat=0;repeat<2;repeat++)for(const [caseIndex,c] of cases.entries())for(const segment of c.plan.segments){
   const begin=Date.now(),b=binding(seed),a=await runtime.synthesize(segment.text,b,segment.index)
   const firstAudioWallMs=Date.now()-begin
   const name=`${engine}-${mode}-case-${caseIndex}-segment-${segment.index}-repeat-${repeat}`
   await writeFile(join(output,name+'.wav'),a.bytes);verifyWav(Buffer.from(a.bytes))
   const sessions=(await readdir(cache)).filter(n=>n.startsWith('session-'));if(sessions.length!==1)throw Error('AB_CACHE_SESSION')
   const raw=join(cache,sessions[0],a.audioId+'.raw.wav');await copyFile(raw,join(output,name+'.raw.wav'));await rm(raw)
   report.runs.push({engine,mode,caseIndex,segment:segment.index,repeat,seed,session:runtime.sessionId,wallFirstAudioMs:firstAudioWallMs,metrics:{...a,bytes:undefined},pcmSha256:hash(Buffer.from(a.bytes)),file:name+'.wav',rawFile:name+'.raw.wav',rawSha256:hash(await readFile(join(output,name+'.raw.wav')))});await save()
  }
  const old=runtime.sessionId,b=binding(seed),pending=runtime.synthesize(cases[0].plan.segments[0].text,b,0).then(()=> 'COMPLETED_BEFORE_CANCEL',e=>e.message)
  await new Promise(r=>setTimeout(r,150));const cancel=await runtime.cancelSpeech();cold.cancel={...cancel,outcome:await pending,oldSession:old};await save()
  await runtime.start('',cloneFingerprint,cond);cold.afterCancelSession=runtime.sessionId
  const recovered=await runtime.synthesize(cases[0].plan.segments[0].text,binding(seed),0);cold.recoveryDurationMs=recovered.durationMs
  await runtime.stop();cold.ownedWorkerExited=!runtime.running;cold.cacheClean=(await readdir(cache)).length===0;runtime=undefined;await save()
 }
 // Blind samples are byte-for-byte raw outputs with random labels; mapping is separate.
 const blind=join(output,'blind');await mkdir(blind);const rows=report.runs.filter((r:any)=>r.repeat===0),mapping=[]
 for(let i=rows.length-1;i>0;i--){const j=randomInt(0,i+1);[rows[i],rows[j]]=[rows[j],rows[i]]}
 for(const [i,row] of rows.entries()){const label='sample-'+String(i+1).padStart(2,'0')+'.wav';await copyFile(join(output,row.rawFile),join(blind,label));mapping.push({label,engine:row.engine,mode:row.mode,caseIndex:row.caseIndex,segment:row.segment,rawSha256:row.rawSha256})}
 await writeFile(join(output,'blind-key.json'),JSON.stringify(mapping,null,2))
 await writeFile(join(blind,'listening.csv'),'sample,naturalness,speaker_similarity,pronunciation,ending,usable,notes\n'+mapping.map(r=>r.label+',,,,,,PENDING_REVIEW').join('\n')+'\n')
 await writeFile(join(blind,'index.html'),'<!doctype html><html lang="ko"><meta charset="utf-8"><title>음성 비교</title><h1>음성 비교</h1><p>직접 눌러 한 샘플씩 들어주세요. 품질 판정은 아직 없습니다.</p>'+mapping.map(r=>'<p>'+r.label+'</p><audio controls preload="none" src="'+r.label+'"></audio>').join('')+'<script>document.addEventListener("play",e=>{document.querySelectorAll("audio").forEach(a=>{if(a!==e.target)a.pause()})},true)</script></html>')
 report.status='PASS'
}catch(e){report.status='BLOCKED_OR_FAILED';report.error=String(e);throw e}
finally{await runtime?.stop();report.finished=new Date().toISOString();await save()}
