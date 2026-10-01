/** Separate Mac measurements: silent, matched WAV reference, native streaming. */
import {readFile,writeFile,mkdir,readdir,copyFile,rm,realpath} from 'node:fs/promises'
import {resolve,join,isAbsolute,relative,sep} from 'node:path'
import {createHash,randomUUID,randomInt} from 'node:crypto'
import {TtsRuntimeSupervisor,verifyWav,type TtsConfig} from '../electron/main/character-voice/TtsRuntimeSupervisor'
import {canonicalReferenceWav} from '../electron/main/character-voice/ReferenceWav'
import {planSpeech,type SpeechBinding} from '../electron/shared/character-voice-contract'
import {VoiceBaseInstaller} from '../electron/main/character-voice/VoiceBaseInstaller'
const hash=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex')
const opt=(key:string)=>{const i=process.argv.indexOf('--'+key);if(i<0||!process.argv[i+1])throw Error('Missing --'+key);return process.argv[i+1]}
const cfg=JSON.parse(await readFile(resolve(opt('config')),'utf8')),texts=JSON.parse(await readFile(resolve(opt('cases')),'utf8'))
if(!Array.isArray(texts)||texts.length<1||texts.length>6||texts.some(t=>typeof t!=='string'||!t.trim()||t.length>600))throw Error('AB_CASES')
const cases=texts.map(text=>({text,plan:planSpeech(text)}))
if(process.argv.includes('--dry-run')){console.log(JSON.stringify({cases,platform:'darwin-arm64',noAudioPlayback:true,noGpuLoaded:true}));process.exit(0)}
if(process.platform!=='darwin'||process.arch!=='arm64'||cfg.referenceAuthorized!==true)throw Error('AB_REFERENCE_AUTHORIZATION')
const output=resolve(opt('output')),repo=await realpath('.'),rel=relative(repo,output)
if(!rel||!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+sep))throw Error('AB_EXTERNAL_OUTPUT_REQUIRED')
for(const p of [cfg.reference,cfg.vox.runtimeRoot,cfg.vox.modelRoot,cfg.qwen.python,cfg.qwen.model,cfg.qwen.worker])if(!isAbsolute(p||''))throw Error('AB_CONFIG')
if(!Number.isInteger(cfg.voxSeed)||!Number.isInteger(cfg.qwenSeed))throw Error('AB_CONFIG')
const vox=new VoiceBaseInstaller(cfg.vox.modelRoot,cfg.vox.runtimeRoot,()=>{});await vox.initialize();await vox.ready()
await mkdir(output,{recursive:false});await mkdir(join(output,'reference'))
const {wav,audio}=canonicalReferenceWav(await readFile(cfg.reference)),reference=join(output,'reference/reference.wav');await writeFile(reference,wav)
const condition={kind:'wav-reference' as const,path:reference,sha256:hash(wav),fingerprint:hash(wav),preprocessingVersion:'mono-pcm16-round-v1',sampleRate:audio.sampleRate,samples:audio.samples}
const report:any={schemaVersion:1,platform:'darwin-arm64',status:'RUNNING',review:'PENDING_BLIND_LISTEN',cases,referenceSha256:condition.sha256,numericSeedsNotComparableBetweenEngines:true,segmentation:'transition-v1',noAudioPlayback:true,noPostprocessing:'Same app PCM48 mono16 conversion only. Qwen native float WAV additionally retained. Vox native PCM16 is the earliest exported waveform; float/VRAM unavailable, not estimated.',timingDefinition:'Warm wallFirstAudioMs: immediately before runtime.stream to first binding/sequence/WAV-validated PCM accept callback. Separate cold init and prewarm excluded. Not speaker output or perceived first-word onset. firstSignalWallMs tracks first chunk containing nonzero PCM; firstNonzeroSample reports leading exact-zero samples.',memoryUnits:'MLX allocator peak is unified-memory allocation, not dedicated VRAM. Native engine memory metrics are reported as provided.',runs:[],lifecycle:[]}
const save=()=>writeFile(join(output,'manifest.json'),JSON.stringify(report,null,2)+'\n')
let runtime:TtsRuntimeSupervisor|undefined
try{
 for(const [engine,mode] of [['vox','reference'],['qwen','x-vector'],...(cfg.transcript?[['qwen','icl']]:[])] as string[][]){
  const cache=join(output,'cache-'+engine+'-'+mode);await mkdir(cache)
  const conf:TtsConfig=engine==='vox'?{engine:'voxcpm2',python:vox.executable,model:vox.path,worker:cfg.qwen.worker,nativeBase:true,cacheRoot:cache,executionProfile:'gguf-metal-f16'}:{...cfg.qwen,engine:'qwen3-tts-06b',cacheRoot:cache,executionProfile:'qwen-mlx',keepRaw:true,qwen:{mode:mode==='icl'?'icl':'x-vector',transcript:mode==='icl'?cfg.transcript:''}}
  runtime=new TtsRuntimeSupervisor(conf,300000)
  const fingerprint=hash(JSON.stringify({engine,mode,backend:engine==='qwen'?'mlx':'gguf-metal',reference:condition.sha256,transcript:mode==='icl'?hash(cfg.transcript):''})),cond={...condition,fingerprint},begin=performance.now()
  await runtime.start('',fingerprint,cond)
  const cold:any={engine,mode,initWallMs:performance.now()-begin,ready:runtime.audit};report.lifecycle.push(cold);await save()
  let epoch=0
  const binding=()=>({engine:conf.engine,executionProfile:conf.executionProfile,effectiveSeed:engine==='vox'?cfg.voxSeed:cfg.qwenSeed,runtimeSessionId:runtime!.sessionId,conditioningFingerprint:cond.fingerprint,speechEpoch:++epoch,characterId:'diagnostic',revision:'1',conversationId:'ab',messageId:'diagnostic',requestId:randomUUID(),generationId:randomUUID(),voiceProfileId:'authorized-reference',voiceProfileVersion:condition.sha256,voiceFingerprint:condition.sha256,epoch:1,modelId:'E4B',personaHash:'diagnostic',semanticHash:'diagnostic'}) as SpeechBinding
  async function synth(text:string,index:number,name?:string){
   const start=performance.now(),parts:Buffer[]=[],chunkTrace:any[]=[];let header:Buffer|undefined,first:number|undefined,firstSignalWallMs:number|undefined,firstNonzeroSample:number|undefined,samples=0
   const metrics=await runtime!.stream(text,binding(),index,async a=>{const arrival=performance.now()-start;first??=arrival;header??=Buffer.from(a.bytes.subarray(0,44));const pcm=Buffer.from(a.bytes.subarray(44));let nonzero:number|undefined,peak=0;for(let i=0;i<a.sampleCount;i++){const sample=pcm.readInt16LE(i*2);peak=Math.max(peak,Math.abs(sample));if(sample!==0)nonzero??=i}if(nonzero!==undefined){firstSignalWallMs??=arrival;firstNonzeroSample??=a.sampleOffset+nonzero}chunkTrace.push({chunkIndex:a.chunkIndex,sampleOffset:a.sampleOffset,sampleCount:a.sampleCount,wallArrivalMs:arrival,peakInt16:peak,firstNonzeroLocalSample:nonzero});parts.push(pcm);samples+=a.sampleCount})
   if(!header||!samples)throw Error('AB_EMPTY');header.writeUInt32LE(36+samples*2,4);header.writeUInt32LE(samples*2,40);const bytes=Buffer.concat([header,...parts]);verifyWav(bytes)
   let rawFile:string|undefined
   if(name){await writeFile(join(output,name+'.wav'),bytes)
    if(engine==='qwen'){const sessions=(await readdir(cache)).filter(n=>n.startsWith('session-'));if(sessions.length!==1)throw Error('AB_CACHE_SESSION');const raw=join(cache,sessions[0],metrics.synthesisId+'.raw.wav');rawFile=name+'.raw.wav';await copyFile(raw,join(output,rawFile));await rm(raw)}
   }
   return{wallFirstAudioMs:first,firstSignalWallMs,firstNonzeroSample,chunkTrace,wallTotalMs:performance.now()-start,metrics,rawAudioDurationMs:samples/48,measuredRtf:metrics.generationMs/(samples/48),pcmSha256:hash(bytes),file:name?name+'.wav':undefined,rawFile}
  }
  const pre=performance.now();cold.prewarm=await synth('응, 듣고 있어.',0);cold.prewarmWallMs=performance.now()-pre;cold.prewarmMethod='matched streaming sentence; complete generator drain';await save()
  for(let repeat=0;repeat<2;repeat++)for(const [caseIndex,c] of cases.entries())for(const segment of c.plan.segments){
   const name=`${engine}-${mode}-case-${caseIndex}-segment-${segment.index}-repeat-${repeat}`
   report.runs.push({engine,mode,repeat,caseIndex,segment:segment.index,seed:engine==='vox'?cfg.voxSeed:cfg.qwenSeed,session:runtime.sessionId,...await synth(segment.text,segment.index,name)});await save()
  }
  const old=runtime.sessionId,pending=runtime.stream(cases[0].plan.segments[0].text,binding(),0,async()=>{}).then(()=> 'COMPLETED_BEFORE_CANCEL',e=>e.message)
  await new Promise(r=>setTimeout(r,50));cold.cancel={...await runtime.cancelSpeech(),outcome:await pending,oldSession:old};await save()
  await runtime.start('',fingerprint,cond);cold.recoverySession=runtime.sessionId;cold.recovery=await synth(cases[0].plan.segments[0].text,0)
  await runtime.stop();cold.cacheClean=(await readdir(cache)).length===0;cold.ownedWorkerExited=!runtime.running;runtime=undefined;await save()
 }
 const blind=join(output,'blind');await mkdir(blind);const rows=report.runs.filter((r:any)=>r.repeat===0),mapping=[]
 for(let i=rows.length-1;i>0;i--){const j=randomInt(0,i+1);[rows[i],rows[j]]=[rows[j],rows[i]]}
 for(const [i,row] of rows.entries()){const label='sample-'+String(i+1).padStart(2,'0')+'.wav';await copyFile(join(output,row.file),join(blind,label));mapping.push({label,engine:row.engine,mode:row.mode,caseIndex:row.caseIndex,segment:row.segment,pcmSha256:row.pcmSha256})}
 await writeFile(join(output,'blind-key.json'),JSON.stringify(mapping,null,2)+'\n')
 await writeFile(join(blind,'listening.csv'),'sample,naturalness,speaker_similarity,pronunciation,ending,usable,notes\n'+mapping.map(r=>r.label+',,,,,,PENDING_REVIEW').join('\n')+'\n')
 await writeFile(join(blind,'index.html'),'<!doctype html><html lang="ko"><meta charset="utf-8"><title>음성 비교</title><h1>음성 비교</h1><p>직접 눌러 한 샘플씩 들어주세요. 품질 판정은 아직 없습니다.</p>'+mapping.map(r=>'<p>'+r.label+'</p><audio controls preload="none" src="'+r.label+'"></audio>').join('')+'<script>document.addEventListener("play",e=>{document.querySelectorAll("audio").forEach(a=>{if(a!==e.target)a.pause()})},true)</script></html>')
 report.status='PASS'
}catch(e){report.status='BLOCKED_OR_FAILED';report.error=String(e);throw e}
finally{await runtime?.stop();report.finished=new Date().toISOString();await save()}
