import {resolve,join} from 'node:path'
import {mkdir,writeFile} from 'node:fs/promises'
import {randomUUID} from 'node:crypto'
import {verifyVoicePackage,importVoicePackage,SELECTED_VOICE,profileKey} from '../electron/main/character-voice/VoicePackage'
import {TtsRuntimeSupervisor} from '../electron/main/character-voice/TtsRuntimeSupervisor'
import type {SpeechBinding} from '../electron/shared/character-voice-contract'

const [command,...args]=process.argv.slice(2)
function option(name:string){const index=args.indexOf('--'+name);if(index<0||!args[index+1])throw Error('Missing --'+name);return resolve(args[index+1])}
function value(name:string,fallback:string){const index=args.indexOf('--'+name);return index<0?fallback:args[index+1]}
const source=option('package')
const verified=await verifyVoicePackage(source,SELECTED_VOICE)
if(command==='doctor')console.log(JSON.stringify({status:'PASS',scope:'package-only',profile:verified.profile},null,2))
else if(command==='import'){
 const result=await importVoicePackage(source,join(option('data'),'voice','profiles'),SELECTED_VOICE)
 console.log(JSON.stringify({status:'PASS',profile:result.profile},null,2))
}else if(command==='smoke'){
 const data=option('data'),result=await importVoicePackage(source,join(data,'voice','profiles'),SELECTED_VOICE)
 const worker=new TtsRuntimeSupervisor({python:option('python'),model:option('model'),worker:resolve('electron/voice/worker.py'),cacheRoot:join(data,'voice','cache')},300_000)
 try{
  await worker.start(join(data,'voice','profiles',profileKey(result.profile)),result.profile.fingerprint)
  const binding:SpeechBinding={characterId:'diagnostic',revision:'diagnostic',conversationId:randomUUID(),messageId:randomUUID(),requestId:randomUUID(),epoch:1,speechEpoch:1,personaHash:'diagnostic',semanticHash:'diagnostic',modelId:'E4B',voiceProfileId:result.profile.id,voiceProfileVersion:result.profile.version,voiceFingerprint:result.profile.fingerprint,runtimeSessionId:worker.sessionId}
  const measurements=[]
  for(let i=0;i<2;i++){
   const audio=await worker.synthesize('응, 듣고 있어. 지금은 어떤 이야기를 할까?',binding,i)
   const {bytes,...metrics}=audio;measurements.push(metrics)
   // Explicit diagnostic export only. App playback never retains completed WAVs.
   await mkdir(join(data,'diagnostics'),{recursive:true});await writeFile(join(data,'diagnostics',`new-sentence-${i}.wav`),bytes)
  }
  const load=worker.audit
  let cancellation:Record<string,unknown>|undefined
  if(args.includes('--cancel')){
   const pending=worker.synthesize('이 문장은 합성 중에 중단하고 다음 요청에서 다시 복구합니다.',binding,2).then(()=>({error:null}),e=>({error:e.message}))
   await new Promise(r=>setTimeout(r,1000))
   const start=performance.now();await worker.stop();const stopped=await pending
   if(stopped.error!=='VOICE_CANCELLED'||worker.running)throw Error('CANCELLATION_FAILED')
   cancellation={status:'PASS',stopMs:performance.now()-start,ownedWorkerExited:true}
   await worker.start(join(data,'voice','profiles',profileKey(result.profile)),result.profile.fingerprint)
   binding.runtimeSessionId=worker.sessionId
   const recovered=await worker.synthesize('다시 이야기할 준비가 됐어.',binding,0)
   cancellation.recoveryDurationMs=recovered.durationMs
  }
  const report={status:'PASS',scope:'worker-synthesis-only',appPlayback:'NOT_TESTED',listening:'NOT_TESTED',profile:result.profile,load,measurements,cancellation}
  await writeFile(join(data,'diagnostics','worker-result.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2))
 }finally{await worker.stop()}
}else if(command==='stream'){
 const profile=value('profile','cached');if(profile!=='cached'&&profile!=='compiled')throw Error('EXECUTION_PROFILE')
 const data=option('data');await mkdir(data,{recursive:true})
 const worker=new TtsRuntimeSupervisor({python:option('python'),model:option('model'),worker:resolve('electron/voice/worker.py'),cacheRoot:join(data,'cache'),compilerCache:args.includes('--compiler-cache')?option('compiler-cache'):join(data,'compiler-cache'),executionProfile:profile},300_000)
 const report:any={profile,scope:'worker-stream-with-immediate-credit',appPlayback:'NOT_TESTED',physicalListening:'NOT_TESTED',measurements:[]}
 try{
  await worker.start(source,verified.profile.fingerprint+':'+profile);report.audit=worker.audit
  const binding:SpeechBinding={characterId:'diagnostic',revision:'diagnostic',conversationId:randomUUID(),messageId:randomUUID(),requestId:randomUUID(),epoch:1,speechEpoch:1,personaHash:'diagnostic',semanticHash:'diagnostic',modelId:'E4B',voiceProfileId:verified.profile.id,voiceProfileVersion:verified.profile.version,voiceFingerprint:verified.profile.fingerprint,runtimeSessionId:worker.sessionId,executionProfile:profile}
  const texts=['응.','오빠, 오늘은 어떤 이야기를 할까?','응, 듣고 있어. 지금은 어떤 이야기를 할까?','내일 오후 세 시에 다시 확인해 줘.','RTX 4090으로 음성을 만들고 있어.','먼저 파일을 확인할게. 문제가 없으면 다음 작업으로 넘어가자.']
  for(let repeat=0;repeat<2;repeat++)for(let index=0;index<texts.length;index++){
   const start=performance.now();let first:number|undefined,chunks=0,samples=0
   const result=await worker.stream(texts[index],binding,index,async chunk=>{first??=performance.now()-start;chunks++;samples+=chunk.sampleCount})
   report.measurements.push({repeat,index,...result,firstChunkReceivedMs:first,observedChunks:chunks,observedSamples:samples})
   await writeFile(join(data,'stream-result.json'),JSON.stringify(report,null,2)+'\n')
  }
  if(args.includes('--cancel')){
   const pending=worker.stream(texts[5],binding,0,()=>new Promise(()=>{})).then(()=>null,e=>e.message)
   await new Promise(r=>setTimeout(r,700));const started=performance.now();await worker.stop();const error=await pending
   if(error!=='VOICE_CANCELLED'||worker.running)throw Error('CANCELLATION_FAILED')
   report.cancel={workerStopMs:performance.now()-started,ownedWorkerExited:true}
   await worker.start(source,verified.profile.fingerprint+':'+profile);binding.runtimeSessionId=worker.sessionId
   report.recovery=await worker.stream(texts[2],binding,0,async()=>{})
  }
  report.status='PASS'
 }catch(e){report.status='FAIL';report.error=e instanceof Error?e.message:'ERROR';throw e}
 finally{await worker.stop();await writeFile(join(data,'stream-result.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2))}
}else throw Error('Use doctor, import, smoke or stream')
