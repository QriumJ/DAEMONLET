import {readFile,writeFile,mkdir,realpath} from 'node:fs/promises'
import {resolve,join,isAbsolute,relative,sep} from 'node:path'
import {createHash,randomUUID} from 'node:crypto'
import {TtsRuntimeSupervisor,verifyWav} from '../electron/main/character-voice/TtsRuntimeSupervisor'
import {verifyVoicePackage} from '../electron/main/character-voice/VoicePackage'
import {VoiceBaseInstaller} from '../electron/main/character-voice/VoiceBaseInstaller'
import {WindowsVoiceInstaller} from '../electron/main/character-voice/WindowsVoiceInstaller'
import {ReferenceProfileStore,workerReferenceConverter} from '../electron/main/character-voice/ReferenceProfileStore'
import {planSpeech,type ExecutionProfile,type SpeechBinding} from '../electron/shared/character-voice-contract'
import {validVoiceSeed} from '../electron/shared/voice-seed'
export const seedAbHelp='seed-ab --config FILE --cases FILE --seeds 42,17,42 --output NEW_DIRECTORY [--dry-run] [--cancel] [--compare-complete]'
export async function seedAb(args:string[]){
 if(args.includes('--help')){console.log(seedAbHelp+'\nOne voice/backend per run. No downloads, installation or training. Cases: JSON string array. Config: kind (trained/default/wav), executionProfile, python/model/worker/cacheRoot, package (trained), baseRoot/resources (managed), reference (wav).');return}
 const option=(name:string)=>{const i=args.indexOf('--'+name);if(i<0||!args[i+1])throw Error('Missing --'+name);return args[i+1]}
 const seeds=option('seeds').split(',').map(s=>/^[0-9]+$/.test(s)?Number(s):NaN);if(!seeds.length||seeds.length>16||!seeds.every(validVoiceSeed))throw Error('VOICE_SEED_INVALID')
 const texts=JSON.parse(await readFile(resolve(option('cases')),'utf8'));if(!Array.isArray(texts)||!texts.length||texts.length>12||texts.some(s=>typeof s!=='string'||!s.trim()||s.length>6000)||texts.length*seeds.length>64)throw Error('SEED_CASES')
 const config=JSON.parse(await readFile(resolve(option('config')),'utf8'));if(!['trained','default','wav'].includes(config.kind))throw Error('SEED_KIND')
 const cases=texts.map(text=>({text,plan:planSpeech(text)}))
 if(args.includes('--dry-run')){console.log(JSON.stringify({dryRun:true,kind:config.kind,executionProfile:config.executionProfile,seeds,cases,modelLoaded:false,outputWritten:false},null,2));return}
 const output=resolve(option('output')),repo=await realpath('.'),within=(root:string)=>{const rel=relative(root,output);return !rel||!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+sep)};if(within(repo)||config.cacheRoot&&within(resolve(config.cacheRoot))||process.env.DAEMONLET_DATA_HOME&&within(resolve(process.env.DAEMONLET_DATA_HOME))||/(?:Application Support|AppData[\\/]Roaming)[\\/]Daemonlet/i.test(output))throw Error('PRIVATE_OUTPUT_REQUIRED')
 for(const key of ['python','model','worker','cacheRoot'])if(!isAbsolute(config[key]||''))throw Error('SEED_CONFIG')
 await mkdir(output,{recursive:false})
 const report:any={schemaVersion:1,kind:config.kind,executionProfile:config.executionProfile,seeds,cases,review:'PENDING_REVIEW',runs:[],status:'RUNNING',started:new Date().toISOString()}
 const save=()=>writeFile(join(output,'manifest.json'),JSON.stringify(report,null,2))
 let runtime:TtsRuntimeSupervisor|undefined
 try{
  let condition,profile,packagePath='';const managed=config.kind!=='trained'
  if(managed){const base=process.platform==='darwin'?new VoiceBaseInstaller(config.baseRoot,config.resources,()=>{}):new WindowsVoiceInstaller(config.baseRoot,config.resources,()=>{});await base.initialize();await base.ready();config.python=base.executable;config.model=base.path;profile=base.profile;report.baseIdentity=await base.identity();if(config.kind==='wav'){const store=new ReferenceProfileStore(join(output,'reference-store'),workerReferenceConverter(join(config.worker,'..','reference-import-worker.cjs')));await store.initialize();const ref=await store.import(config.reference,'Seed diagnostic',new AbortController().signal);condition=await store.resolve(ref.id+'@'+ref.version);profile=ref;condition.fingerprint=createHash('sha256').update(JSON.stringify({reference:ref.fingerprint,assets:report.baseIdentity})).digest('hex')}}
  else {packagePath=config.package;profile=(await verifyVoicePackage(packagePath)).profile}
  report.voice=profile
  runtime=new TtsRuntimeSupervisor({...config,nativeBase:managed&&process.platform==='darwin',windowsBase:managed&&process.platform==='win32'},900000);await runtime.start(packagePath,condition?.fingerprint||profile.fingerprint,condition);report.ready=runtime.audit;report.session=runtime.sessionId;await save()
  let epoch=0
  const jobs=seeds.map(seed=>({seed,cancel:false,complete:false}));if(args.includes('--cancel'))jobs.push({seed:seeds[0],cancel:true,complete:false},{seed:seeds[0],cancel:false,complete:false});if(args.includes('--compare-complete'))jobs.push({seed:seeds[0],cancel:false,complete:true})
  for(const [jobIndex,job] of jobs.entries())for(const [caseIndex,c] of cases.entries()){
   const generationId=randomUUID(),row:any={job:jobIndex,case:caseIndex,effectiveSeed:job.seed,generationId,review:'PENDING_REVIEW',status:'RUNNING',delivery:job.complete?'complete':'stream',groups:[],session:runtime.sessionId};report.runs.push(row);await save();let cancelTask:Promise<unknown>|undefined
   try{
    for(const segment of c.plan.segments){
     const binding={effectiveSeed:job.seed,generationId,runtimeSessionId:runtime.sessionId,conditioningFingerprint:condition?.fingerprint,speechEpoch:++epoch,characterId:'diagnostic',revision:'1',conversationId:'seed-ab',messageId:'case-'+caseIndex,requestId:generationId,voiceProfileId:profile.id,voiceProfileVersion:profile.version,voiceFingerprint:profile.fingerprint,epoch:1,modelId:'E4B',personaHash:'diagnostic',semanticHash:'diagnostic'} as SpeechBinding
     const parts:Buffer[]=[];let result:any,chunks=0,firstMs=0;const begin=Date.now()
     if(job.complete){runtime.config.executionProfile=process.platform==='darwin'?'gguf-metal-f16-complete':'cuda-compiled-complete';const a=await runtime.synthesize(segment.text,binding,segment.index);parts.push(Buffer.from(a.bytes));result=a;delete result.bytes}
     else if(['baseline','mps-fp32-baseline'].includes(config.executionProfile)){const a=await runtime.synthesize(segment.text,binding,segment.index);parts.push(Buffer.from(a.bytes));result={...a,bytes:undefined}}
     else result=await runtime.stream(segment.text,binding,segment.index,async a=>{firstMs ||= Date.now()-begin;parts.push(Buffer.from(a.bytes));if(job.cancel&&++chunks===3){cancelTask=runtime!.cancelSpeech();await new Promise(()=>{})}})
     if(!parts.length)throw Error('EMPTY_AUDIO');const pcm=Buffer.concat(parts.map(p=>p.subarray(44))),head=Buffer.from(parts[0].subarray(0,44));head.writeUInt32LE(36+pcm.length,4);head.writeUInt32LE(pcm.length,40);const bytes=Buffer.concat([head,pcm]);verifyWav(bytes)
     const file=`case-${caseIndex}-run-${jobIndex}-seed-${job.seed}-group-${segment.index}.wav`;await writeFile(join(output,file),bytes)
     row.groups.push({file,segmentIndex:segment.index,text:segment.text,pcmSha256:createHash('sha256').update(pcm).digest('hex'),samples:pcm.length/2,firstMs,metrics:result});await save()
    }
    if(job.cancel)throw Error('CANCEL_NOT_REACHED');row.status='PASS'
   }catch(e){row.error=String(e);row.cancel=await cancelTask;row.status=job.cancel&&String(e).includes('VOICE_CANCELLED')?'CANCELLED':'FAIL';if(row.status==='FAIL')throw e}
   finally{await save()}
  }
  report.status='PASS'
 }catch(e){report.status='FAIL';report.error=String(e);throw e}
 finally{
  await runtime?.stop();report.ownedWorkerExited=!runtime?.running;report.finished=new Date().toISOString();await save()
  const quote=(s:unknown)=>'"'+String(s).replaceAll('"','""')+'"';await writeFile(join(output,'listening.csv'),'case,run,seed,naturalness,speaker_similarity,pronunciation_or_omission,ending,consistency,usable,notes\n'+report.runs.map((r:any)=>[r.case,r.job,r.effectiveSeed,'','','','','','','PENDING_REVIEW'].map(quote).join(',')).join('\n')+'\n')
  const esc=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));await writeFile(join(output,'index.html'),'<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>시드별 음성 비교</title><style>body{font:16px/1.6 system-ui;max-width:900px;margin:40px auto;padding:20px;background:#f5f6f1;color:#203f36}article{background:white;padding:24px;margin:16px 0;border-radius:16px}audio{width:100%}small{color:#637067}</style><h1>시드별 음성 비교</h1><p>같은 음성과 생성 조건에서 시드만 변경한 실제 출력입니다. 품질 순위가 아닙니다. 청취 전 판정은 PENDING_REVIEW입니다.</p>'+report.runs.map((r:any)=>'<article><h2>Case '+r.case+' · seed '+r.effectiveSeed+'</h2><small>'+esc(r.status)+' · '+esc(r.delivery)+'</small>'+r.groups.map((g:any)=>'<p>'+esc(g.text)+'</p><audio controls preload="metadata" src="'+esc(g.file)+'"></audio>').join('')+'</article>').join('')+'<script>document.addEventListener("play",e=>{if(e.target.tagName==="AUDIO")document.querySelectorAll("audio").forEach(a=>{if(a!==e.target)a.pause()})},true)</script></html>')
 }
}
