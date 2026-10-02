import {validVoiceSeed} from '../../shared/voice-seed'
import {spawn,type ChildProcessWithoutNullStreams,type SpawnOptionsWithoutStdio} from 'node:child_process'
import {randomUUID} from 'node:crypto'
import {join,isAbsolute,dirname} from 'node:path'
import {mkdir,mkdtemp,readFile,lstat,rm} from 'node:fs/promises'
import type {SpeechBinding,ExecutionProfile} from '../../shared/character-voice-contract'

import type {ReferenceCondition} from './ReferenceProfileStore'
import {verifyMacInterpreter} from './VoiceRuntimeProfile'
import {ENGINE} from './VoicePackage'
import voxWindowsPolicy from '../../voice/runtime-gguf-windows-voxcpm2.json'
import defaultVoice from '../../voice/base-voice-defaults.json'

export type VoxGgufConfig={runtimeDir:string;derivativeDir:string;receipt:string}
const voxWindowsProfiles=new Set(['gguf-cuda-f16','gguf-cuda-f16-complete','gguf-vulkan-f16','gguf-vulkan-f16-complete'])
const voxWindowsProfile=(profile:ExecutionProfile|undefined)=>voxWindowsProfiles.has(profile||'')
export type TtsConfig={modelVerification?:'full'|'installed';diagnosticPrewarm?:boolean;keepRaw?:boolean;engine?:import('../../shared/character-voice-contract').VoiceEngine;qwen?:import('../../shared/character-voice-contract').QwenCloneSettings;ggufRuntime?:string;gguf?:VoxGgufConfig;ggufModelKind?:'public-base';python:string;model:string;worker:string;cacheRoot:string;executionProfile?:ExecutionProfile;compilerCache?:string;nativeBase?:boolean;windowsBase?:boolean}
export type SpawnWorker=(command:string,args:string[],options:SpawnOptionsWithoutStdio)=>ChildProcessWithoutNullStreams
export type AudioResult={audioId:string;bytes:Uint8Array;durationMs:number;generationMs:number;rtf:number;peakAllocatedBytes?:number;peakReservedBytes?:number;rawSampleRate?:number;rawDurationMs?:number;firstAudioReadyMs?:number;ramWorkingSetBytes?:number;ramPeakWorkingSetBytes?:number;ramCommitBytes?:number}
export type AudioChunk=AudioResult & {synthesisId:string;chunkIndex:number;sampleOffset:number;sampleCount:number;firstChunkReadyMs:number}
type CancelTarget={requestId:string;synthesisId:string;runtimeSessionId:string;speechEpoch:number}
type CancelResult={keptWarm:boolean;elapsedMs:number;fallback?:string;boundary?:string;reuseAudit?:Record<string,any>}
export function verifyWav(bytes:Buffer) {
 if(bytes.length<44||bytes.length>5_800_000||bytes.toString('ascii',0,4)!=='RIFF'||bytes.toString('ascii',8,12)!=='WAVE'||bytes.readUInt32LE(4)+8!==bytes.length)throw Error('VOICE_INVALID_WAV')
 let format=false,samples=0
 for(let i=12;i+8<=bytes.length;){const size=bytes.readUInt32LE(i+4),end=i+8+size;if(end>bytes.length)throw Error('VOICE_INVALID_WAV');const id=bytes.toString('ascii',i,i+4)
  if(id==='fmt '){if(size<16||bytes.readUInt16LE(i+8)!==1||bytes.readUInt16LE(i+10)!==1||bytes.readUInt32LE(i+12)!==48000||bytes.readUInt32LE(i+16)!==96000||bytes.readUInt16LE(i+20)!==2||bytes.readUInt16LE(i+22)!==16)throw Error('VOICE_INVALID_WAV');format=true}
  if(id==='data'){if(samples||size%2)throw Error('VOICE_INVALID_WAV');samples=size/2}
  i=end+(size%2)
 }
 if(!format||!samples||samples>48000*60)throw Error('VOICE_INVALID_WAV')
 return samples/48
}
export class TtsRuntimeSupervisor {
 sessionId=randomUUID()
 private child:ChildProcessWithoutNullStreams|null=null
 private exit:Promise<void>=Promise.resolve()
 private ending:Promise<void>|null=null
 private cache:string|null=null
 private key=''
 private conditioning:ReferenceCondition|undefined
 private pending:{id:string;expected:string;target?:CancelTarget;resolve:(v:any)=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>;chunk?:(v:any)=>void}|null=null
 private cancellation:{id:string;target:CancelTarget;resolve:()=>void;reject:(e:Error)=>void;task:Promise<CancelResult>;boundary?:string;reuseAudit?:Record<string,any>}|null=null
 private starting:Promise<void>|null=null
 private revision=0
 private streams=new Set<{retire:()=>void}>()
 private deliveries=0
 // A protocol failure may reject and clear the request before stop runs. Keep
 // native activity marked until a validated terminal response or cleanup ack.
 private ggufActive=false
 audit:Record<string,unknown>|null=null
 constructor(readonly config:TtsConfig,private timeoutMs=180_000,private spawnProcess:SpawnWorker=spawn){}
 get running(){return !!this.child}
 get ready(){return !!this.child&&!!this.key&&!this.starting&&!this.ending&&!this.pending&&!this.cancellation}
 // Protocol/GPU activity ends at the terminal response, before file delivery and
 // playback necessarily finish. An idle model can still have retiring callbacks.
 get busy(){return !!this.pending||!!this.starting||!!this.cancellation}
 get cancellationPending(){return !!this.cancellation}
 get deliveryPending(){return this.deliveries>0}
 private get windowsGguf(){return this.config.engine==='qwen3-tts-06b-gguf'||voxWindowsProfile(this.config.executionProfile)}
 retireSpeech(){for(const stream of this.streams)stream.retire()}
 private call(type:string,expected:string,data:object={},chunk?:(v:any)=>void) {
  if(!this.child||this.pending||this.cancellation)return Promise.reject(Error('VOICE_WORKER_BUSY'))
  return new Promise<any>((resolve,reject)=>{
   const id=randomUUID(),timer=setTimeout(()=>{this.fail(Error('VOICE_TIMEOUT'));void this.stop().catch(()=>{})},type==='init'&&['compiled','gguf-metal-f16','gguf-metal-f16-complete','cuda-compiled','cuda-compiled-complete'].includes(this.config.executionProfile||'')?900_000:this.timeoutMs)
   const stream=data as {synthesisId:string;binding:SpeechBinding}
   const target=type==='stream'?{requestId:id,synthesisId:stream.synthesisId,runtimeSessionId:stream.binding.runtimeSessionId,speechEpoch:stream.binding.speechEpoch}:undefined
   this.pending={id,expected,target,resolve,reject,timer,chunk}
   if(this.windowsGguf&&['synthesize','stream','prewarm'].includes(type))this.ggufActive=true
   this.child!.stdin.write(JSON.stringify({protocolVersion:1,type,requestId:id,...data})+'\n',error=>{if(error)this.fail(Error('VOICE_WORKER_IO'))})
  })
 }
 private fail(error:Error){const p=this.pending;this.pending=null;if(p){clearTimeout(p.timer);p.reject(error)}}
 cancelSpeech(timeoutMs=2000):Promise<CancelResult> {
  this.retireSpeech()
  if(this.cancellation)return this.cancellation.task
  const started=Date.now(),p=this.pending,child=this.child
  if(this.config.engine==='qwen3-tts-06b'&&(this.starting||p))return this.stop().then(()=>({keptWarm:false,elapsedMs:Date.now()-started,fallback:'qwen-owned-process-termination'}))
  if(this.starting||p&&!p.target)return this.stop().then(()=>({keptWarm:false,elapsedMs:Date.now()-started,fallback:'non-streaming'}))
  if(!p?.target||!child)return Promise.resolve({keptWarm:!!child,elapsedMs:0})
  let resolve!:()=>void,reject!:(e:Error)=>void
  const acknowledgement=new Promise<void>((yes,no)=>{resolve=yes;reject=no})
  const timer=setTimeout(()=>reject(Error('VOICE_CANCEL_TIMEOUT')),timeoutMs)
  const cancellation:{id:string;target:CancelTarget;resolve:()=>void;reject:(e:Error)=>void;task:Promise<CancelResult>;boundary?:string;reuseAudit?:Record<string,any>}={id:randomUUID(),target:p.target,resolve,reject,task:Promise.resolve({keptWarm:false,elapsedMs:0})}
  this.cancellation=cancellation
  cancellation.task=acknowledgement.then(()=>{if(this.child!==child||this.ending)throw Error('VOICE_CANCEL_ABORTED');return {keptWarm:true,elapsedMs:Date.now()-started,boundary:cancellation.boundary,reuseAudit:cancellation.reuseAudit}}).catch(async error=>{
   await this.stop();return {keptWarm:false,elapsedMs:Date.now()-started,fallback:error instanceof Error?error.message:'VOICE_CANCEL_FAILED'}
  }).finally(()=>{clearTimeout(timer);if(this.cancellation===cancellation)this.cancellation=null})
  child.stdin.write(JSON.stringify({protocolVersion:1,type:'cancel-stream',requestId:cancellation.id,target:cancellation.target})+'\n',error=>{if(error)reject(Error('VOICE_WORKER_IO'))})
  return cancellation.task
 }
 async start(packagePath:string,fingerprint:string,conditioning?:ReferenceCondition) {
  if(this.cancellation)await this.cancellation.task
  if(this.ending)await this.ending
  if(this.starting){await this.starting.catch(()=>{});if(this.key===fingerprint)return;if(this.ending)await this.ending}
  if(this.child&&this.key===fingerprint)return
  if(this.child)await this.stop()
  const task=this.launch(packagePath,fingerprint,this.revision,conditioning);this.starting=task
  try{await task}finally{if(this.starting===task)this.starting=null}
 }
 private async launch(packagePath:string,fingerprint:string,revision:number,conditioning?:ReferenceCondition) {
  const qwenGguf=this.config.engine==='qwen3-tts-06b-gguf'
  const voxGguf=voxWindowsProfile(this.config.executionProfile)
  const publicVox=voxGguf&&this.config.ggufModelKind==='public-base'
  if(qwenGguf&&(process.platform!=='win32'||process.arch!=='x64'||!this.config.ggufRuntime||!isAbsolute(this.config.ggufRuntime)||!['qwen-gguf','qwen-gguf-complete','qwen-gguf-vulkan','qwen-gguf-vulkan-complete'].includes(this.config.executionProfile||'')||this.config.nativeBase||this.config.windowsBase))throw Error('QWEN_GGUF_RUNTIME_CONFIG')
  if(this.config.ggufModelKind!==undefined&&(!voxGguf||this.config.ggufModelKind!=='public-base'))throw Error('VOX_GGUF_RUNTIME_CONFIG')
  if(voxGguf&&(process.platform!=='win32'||process.arch!=='x64'||this.config.engine!=='voxcpm2'||!this.config.gguf||![this.config.gguf.runtimeDir,this.config.gguf.derivativeDir,this.config.gguf.receipt].every(p=>typeof p==='string'&&isAbsolute(p))||(publicVox?packagePath!=='':!isAbsolute(packagePath))||this.config.nativeBase||this.config.windowsBase))throw Error('VOX_GGUF_RUNTIME_CONFIG')
  if(publicVox&&this.config.model!==this.config.gguf!.derivativeDir)throw Error('VOX_GGUF_RUNTIME_CONFIG')
  if(voxGguf&&!publicVox&&conditioning)throw Error('VOICE_REFERENCE_RUNTIME')
  if(qwenGguf&&!conditioning)throw Error('VOICE_REFERENCE_RUNTIME')
  if(conditioning&&(!this.config.nativeBase&&!this.config.windowsBase&&this.config.engine!=='qwen3-tts-06b'&&!qwenGguf&&!publicVox||conditioning.kind!=='wav-reference'||!isAbsolute(conditioning.path)))throw Error('VOICE_REFERENCE_RUNTIME')
  this.conditioning=conditioning
  for(const p of [this.config.python,this.config.model,this.config.worker,this.config.cacheRoot])if(!isAbsolute(p))throw Error('VOICE_RUNTIME_CONFIG')
  if(!this.config.nativeBase&&(this.config.executionProfile?.startsWith('mps-')||this.config.executionProfile?.startsWith('gguf-metal-')))await verifyMacInterpreter(this.config.python,this.config.executionProfile)
  await mkdir(this.config.cacheRoot,{recursive:true});const cache=await mkdtemp(join(this.config.cacheRoot,'session-'))
  if(revision!==this.revision){await rm(cache,{recursive:true,force:true});throw Error('VOICE_CANCELLED')}
  this.cache=cache;this.sessionId=randomUUID()
  const child=this.child=this.spawnProcess(this.config.python,this.config.nativeBase?[]:['-B','-u',this.config.worker],{cwd:this.config.nativeBase?dirname(this.config.python):this.cache,windowsHide:true,shell:false,stdio:['pipe','pipe','pipe'],env:{...process.env,PYTHONPATH:'',PYTHONNOUSERSITE:'1',PYTHONDONTWRITEBYTECODE:'1',PYTHONUTF8:'1',HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1',HF_HOME:join(this.cache,'hf'),TORCH_HOME:join(this.cache,'torch'),NUMBA_CACHE_DIR:join(this.cache,'numba'),TEMP:this.cache,TMP:this.cache,TMPDIR:this.cache,MLX_AUDIO_CACHE_DIR:join(this.cache,'mlx')}})
  this.exit=new Promise(resolve=>{child.once('close',()=>{if(this.child===child){this.child=null;this.key='';this.ggufActive=false;this.fail(Error('VOICE_WORKER_EXIT'))}resolve()});child.once('error',()=>{this.fail(Error('VOICE_WORKER_START'))})})
  child.stdin.on('error',()=>this.fail(Error('VOICE_WORKER_IO')))
  let buffer=''
  child.stdout.setEncoding('utf8');child.stdout.on('data',(chunk:string)=>{
   if(this.child!==child)return
   buffer+=chunk
   if(buffer.length>65536){this.fail(Error('VOICE_PROTOCOL_LIMIT'));void this.stop().catch(()=>{});return}
   while(buffer.includes('\n')){const index=buffer.indexOf('\n'),line=buffer.slice(0,index);buffer=buffer.slice(index+1)
    try {const v=JSON.parse(line),p=this.pending,c=this.cancellation
     if(c&&v.requestId===c.id){
      if(v.protocolVersion!==1||v.type!=='cancelled'||v.cleanupComplete!==true||v.keptWarm!==true||JSON.stringify(v.target)!==JSON.stringify(c.target))throw Error('VOICE_CANCEL_PROTOCOL')
      if(voxWindowsProfile(this.config.executionProfile)&&(v.reuseAudit?.nativePid!==this.audit?.nativePid||v.reuseAudit?.referenceCacheBuilds!==this.audit?.referenceCacheBuilds))throw Error('VOICE_CANCEL_PROTOCOL')
      this.ggufActive=false
      if(p?.id===c.target.requestId)this.fail(Error('VOICE_CANCELLED'))
      c.boundary=typeof v.boundary==='string'?v.boundary:undefined;c.reuseAudit=v.reuseAudit;c.resolve();continue
     }
     if(v.protocolVersion!==1||!p||v.requestId!==p.id)throw Error('VOICE_PROTOCOL')
     if(v.type==='synthesis-started'&&(p.expected==='audio-ready'||p.expected==='synthesis-finished'))continue
     if(v.type==='audio-chunk'&&p.chunk){p.chunk(v);continue}
     if(v.type==='error'){this.fail(Error(typeof v.code==='string'&&/^[A-Z_]{1,60}$/.test(v.code)?v.code:'VOICE_WORKER_ERROR'));void this.stop().catch(()=>{});return}
     if(v.type!==p.expected)throw Error('VOICE_PROTOCOL')
     this.ggufActive=false
     this.pending=null;clearTimeout(p.timer);p.resolve(v)
    }catch(e){this.fail(e instanceof Error&&e.message==='VOICE_SEED_MISMATCH'?e:Error('VOICE_PROTOCOL'));void this.stop().catch(()=>{});return}
   }
  })
  // Drain, but never persist upstream text/path logs by default.
  child.stderr.on('data',()=>{})
  try {
   this.audit=await this.call('init','ready',{modelVerification:qwenGguf?'full':this.config.modelVerification,keepRaw:this.config.keepRaw,engine:this.config.engine||'voxcpm2',qwen:this.config.qwen,ggufRuntime:this.config.ggufRuntime,gguf:this.config.gguf,ggufModelKind:this.config.ggufModelKind,runtimeSessionId:this.sessionId,package:packagePath,model:this.config.model,cache:this.cache,executionProfile:voxGguf?this.config.executionProfile!.replace(/-complete$/,''):this.config.executionProfile?.startsWith('cuda-compiled')?'compiled':this.config.executionProfile==='gguf-metal-f16-complete'?'gguf-metal-f16':this.config.executionProfile||'baseline',baseModel:publicVox||this.config.windowsBase===true||this.config.nativeBase===true,...(conditioning?{conditioning}:{}),compilerCache:this.config.compilerCache,ggufCache:join(this.config.cacheRoot,'..','gguf-cache')})
   if(this.child!==child)throw Error('VOICE_CANCELLED')
   if(this.audit?.seedContract!==1)throw Error('VOICE_SEED_UNSUPPORTED')
   const capabilities=this.audit?.capabilities as Record<string,unknown>|undefined
   if(this.config.engine==='qwen3-tts-06b'&&(!capabilities||capabilities.engine!==this.config.engine||capabilities.synthesisStreaming!==!!this.config.executionProfile?.startsWith('qwen-mlx')||capabilities.cancellation!=='owned-process-termination'||capabilities.warmCancellationReuse!==false))throw Error('QWEN_CAPABILITIES')
   if(qwenGguf){const backend=this.config.executionProfile!.includes('-vulkan')?'vulkan:0':'cuda:0';if(!capabilities||capabilities.engine!==this.config.engine||capabilities.synthesisStreaming!==true||capabilities.cancellation!=='cooperative-with-process-fallback'||capabilities.warmCancellationReuse!==true||capabilities.backend!==backend||capabilities.backendDevice!==(backend==='cuda:0'?'CUDA0':'Vulkan0')||capabilities.abiVersion!==5)throw Error('QWEN_GGUF_CAPABILITIES')}
   if(voxGguf){
    const audit=this.audit!,backend=this.config.executionProfile!.startsWith('gguf-cuda-')?'CUDA0':'Vulkan0',components=audit.componentBackends as Record<string,unknown>|undefined
    const componentNames=['ResidualLM','LocEnc','LocDiT','FSQ','AudioVAE','Projections','StopPredictor']
    const packageSha=typeof audit.packageSha256==='string'?audit.packageSha256:''
    const derivative=/^[a-f0-9]{64}$/.test(packageSha)&&Object.hasOwn(voxWindowsPolicy.derivatives,packageSha)?voxWindowsPolicy.derivatives[packageSha as keyof typeof voxWindowsPolicy.derivatives]:undefined
    if(!capabilities||capabilities.engine!=='voxcpm2'||capabilities.synthesisStreaming!==true||capabilities.cancellation!=='cooperative-stream-with-owned-process-fallback'||capabilities.warmCancellationReuse!==true||audit.backend!==backend||audit.backendFamily!==(backend==='CUDA0'?'CUDA':'Vulkan')||!components||Object.keys(components).length!==componentNames.length||componentNames.some(name=>components[name]!==backend)||audit.offloadedLayers!==29||!Number.isSafeInteger(audit.nativePid)||Number(audit.nativePid)<=0||audit.executionProfile!==this.config.executionProfile!.replace(/-complete$/,'')||audit.dtype!=='float16-weights')throw Error('VOX_GGUF_CAPABILITIES')
    if(!publicVox){
     if(!derivative||audit.adapterSha256!==derivative.adapterSha256||audit.derivativeManifestSha256!==derivative.conversionSha256||audit.adapterRepresentation!=='merged-once-fp32-then-f16'||audit.mergedKeys!==384||audit.mergedMatrices!==192||audit.missingKeys!==0||audit.skippedKeys!==0||audit.referenceCacheBuilds!==1||audit.modelRevision!==ENGINE.model_revision||audit.sourceCommit!==ENGINE.source_commit||audit.nativeSourceCommit!==voxWindowsPolicy.sourceCommit||typeof audit.referenceSha256!=='string'||!/^[a-f0-9]{64}$/.test(audit.referenceSha256)||typeof audit.runtimeFingerprint!=='string'||!/^[a-f0-9]{64}$/.test(audit.runtimeFingerprint)||audit.ggufVerification!=='full-sha256'||audit.originalModelVerification!=='provenance-and-presence'||audit.defaultVoice!=null||audit.mode!=null||audit.ggufModelKind!=null)throw Error('VOX_GGUF_TRAINED_IDENTITY')
    }else{
     const pinned=voxWindowsPolicy.publicModel,files=audit.modelFiles as Record<string,{bytes:number;sha256:string}>|undefined
     if(!pinned||typeof pinned.repo!=='string'||!/^[a-f0-9]{40}$/.test(pinned.revision)||!files||Object.keys(files).length!==Object.keys(pinned.files).length||Object.entries(pinned.files).some(([name,file])=>!Object.hasOwn(files,name)||files[name]?.bytes!==file.bytes||files[name]?.sha256!==file.sha256)||audit.ggufModelKind!=='public-base'||audit.modelRepository!==pinned.repo||audit.publisher!==pinned.repo.split('/')[0]||audit.modelRevision!==pinned.revision||audit.sourceCommit!==voxWindowsPolicy.sourceCommit||audit.nativeSourceCommit!==voxWindowsPolicy.sourceCommit||audit.packageSha256!==null||audit.adapterSha256!==null||audit.derivativeManifestSha256!==null||audit.adapterRepresentation!=='none'||audit.mergedKeys!==0||audit.mergedMatrices!==0||audit.missingKeys!==0||audit.skippedKeys!==0||audit.ggufVerification!=='full-sha256'||audit.originalModelVerification!=='not-applicable-public-gguf'||typeof audit.runtimeFingerprint!=='string'||!/^[a-f0-9]{64}$/.test(audit.runtimeFingerprint))throw Error('VOX_GGUF_PUBLIC_IDENTITY')
     if(conditioning){if(audit.mode!=='wav-reference'||audit.referenceMode!=='wav-reference'||audit.defaultVoice!==null)throw Error('VOICE_REFERENCE_RUNTIME')}
     else {const defaults=audit.defaultVoice as typeof defaultVoice|undefined;if(!defaults||audit.mode!=='base'||audit.referenceMode!=='base'||audit.referenceContract!==1||audit.referenceSha256!==null||audit.conditioningFingerprint!==null||audit.referenceCacheBuilds!==0||defaults.description!==defaultVoice.description||defaults.seed!==defaultVoice.seed||Object.keys(defaults).length!==2)throw Error('VOX_GGUF_PUBLIC_IDENTITY')}
    }
   }
   if(conditioning&&(this.audit?.mode!=='wav-reference'||this.audit.referenceContract!==1||this.audit.referenceSha256!==conditioning.sha256||this.audit.conditioningFingerprint!==conditioning.fingerprint||this.audit.referenceCacheBuilds!==1||this.audit.adapterSha256!==null||this.audit.defaultVoice!=null))throw Error('VOICE_REFERENCE_RUNTIME')
   this.key=fingerprint
  }
  catch(e){await this.stop();throw e}
 }
 async prewarm(){
  if(this.config.engine!=='qwen3-tts-06b'&&this.config.engine!=='qwen3-tts-06b-gguf'&&!this.config.diagnosticPrewarm)return
  const result=await this.call('prewarm','warmed')
  this.audit={...this.audit,...result}
 }
 async synthesize(text:string,binding:SpeechBinding,segmentIndex:number):Promise<AudioResult> {
  if(!validVoiceSeed(binding.effectiveSeed))throw Error('VOICE_SEED_INVALID')
  if(this.conditioning?binding.conditioningFingerprint!==this.conditioning.fingerprint:this.config.ggufModelKind==='public-base'&&binding.conditioningFingerprint!=null)throw Error('VOICE_REFERENCE_BINDING')
  if(['gguf-metal-f16-complete','cuda-compiled-complete','gguf-cuda-f16-complete','gguf-vulkan-f16-complete'].includes(this.config.executionProfile||'')){
   const parts:Buffer[]=[];let header:Buffer|undefined,samples=0
   const result=await this.stream(text,binding,segmentIndex,async chunk=>{
    if(chunk.bytes.length!==44+chunk.sampleCount*2)throw Error('VOICE_INVALID_WAV')
    header??=Buffer.from(chunk.bytes.subarray(0,44));parts.push(Buffer.from(chunk.bytes.subarray(44)));samples+=chunk.sampleCount
    if(samples>48000*60)throw Error('VOICE_INVALID_WAV')
   })
   if(!header||!samples)throw Error('VOICE_INVALID_WAV')
   header.writeUInt32LE(36+samples*2,4);header.writeUInt32LE(samples*2,40)
   const bytes=Buffer.concat([header,...parts]);verifyWav(bytes)
   return {audioId:randomUUID(),bytes,durationMs:samples/48,generationMs:result.generationMs,rtf:result.rtf}
  }
  const audioId=randomUUID(),cache=this.cache,child=this.child
  if(!cache||!child||binding.runtimeSessionId!==this.sessionId)throw Error('VOICE_SESSION')
  const result=await this.call('synthesize','audio-ready',{audioId,text,binding,seed:binding.effectiveSeed,segmentIndex,style:null})
  if(result.effectiveSeed!==binding.effectiveSeed)throw Error('VOICE_SEED_MISMATCH');
  if(result.audioId!==audioId||result.segmentIndex!==segmentIndex||JSON.stringify(result.binding)!==JSON.stringify(binding)||cache!==this.cache||this.child!==child||this.ending)throw Error('VOICE_AUDIO_BINDING')
  const path=join(cache,audioId+'.wav')
  try {const stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>5_800_000)throw Error('VOICE_INVALID_WAV');const bytes=await readFile(path),durationMs=verifyWav(bytes);if(cache!==this.cache||this.child!==child||this.ending||binding.runtimeSessionId!==this.sessionId)throw Error('VOICE_CANCELLED');return {audioId,bytes,durationMs,generationMs:result.generationMs,rtf:result.rtf,peakAllocatedBytes:result.peakAllocatedBytes,peakReservedBytes:result.peakReservedBytes,rawSampleRate:result.rawSampleRate,rawDurationMs:result.rawDurationMs,firstAudioReadyMs:result.firstAudioReadyMs,ramWorkingSetBytes:result.ramWorkingSetBytes,ramPeakWorkingSetBytes:result.ramPeakWorkingSetBytes,ramCommitBytes:result.ramCommitBytes}}
  finally {await rm(path,{force:true}).catch(()=>{})}
 }
 async stream(text:string,binding:SpeechBinding,segmentIndex:number,accept:(audio:AudioChunk)=>Promise<void>) {
  if(!validVoiceSeed(binding.effectiveSeed))throw Error('VOICE_SEED_INVALID')
  if(this.conditioning?binding.conditioningFingerprint!==this.conditioning.fingerprint:this.config.ggufModelKind==='public-base'&&binding.conditioningFingerprint!=null)throw Error('VOICE_REFERENCE_BINDING')
  const synthesisId=randomUUID(),cache=this.cache,child=this.child
  if(!cache||!child||binding.runtimeSessionId!==this.sessionId)throw Error('VOICE_SESSION')
  let index=0,offset=0,reads=Promise.resolve(),failure:Error|null=null,retired=false,delivered=false,nextCredit=0,discardCredits=false
  const credits:Array<{requestId:string;ready:boolean}>=[]
  const flushCredits=()=>{
   while(credits[nextCredit]?.ready){const chunkIndex=nextCredit++,credit=credits[chunkIndex]
    if(!discardCredits&&this.child===child&&this.cancellation?.target.requestId!==credit.requestId)child.stdin.write(JSON.stringify({protocolVersion:1,type:'credit',requestId:credit.requestId,chunkIndex})+'\n',()=>{})
   }
   if(delivered&&nextCredit===index)this.streams.delete(owner)
  }
  // Retiring a speech is independent of child identity or the pending request.
  // A previous sentence still owns its playback errors until the service retires
  // the entire speech. Terminal tails drain once; an active cancelled producer
  // must stay blocked until cancel-stream instead of computing discarded chunks.
  const owner={retire:()=>{retired=true;discardCredits ||= this.pending?.target?.synthesisId===synthesisId;for(const credit of credits)credit.ready=true;flushCredits();this.streams.delete(owner)}}
  this.streams.add(owner)
  const failStream=(error:Error)=>{failure=error;if(!retired&&this.child===child){this.fail(error);void this.stop().catch(()=>{})}}
  const ids=new Set<string>()
  try{
  const result=await this.call('stream','synthesis-finished',{streamVersion:1,synthesisId,text,binding,seed:binding.effectiveSeed,segmentIndex,style:null},v=>{
   if(v.effectiveSeed!==binding.effectiveSeed)throw Error('VOICE_SEED_MISMATCH');
   if(v.synthesisId!==synthesisId||v.segmentIndex!==segmentIndex||JSON.stringify(v.binding)!==JSON.stringify(binding)||v.chunkIndex!==index||v.sampleOffset!==offset||!Number.isSafeInteger(v.sampleCount)||v.sampleCount<1||v.sampleCount>48000||v.sampleRate!==48000||!/^[-a-f0-9]{36}$/.test(v.audioId)||offset+v.sampleCount>48000*60)throw Error('VOICE_STREAM_SEQUENCE')
   if(ids.has(v.audioId))throw Error('VOICE_STREAM_SEQUENCE')
   ids.add(v.audioId);++index;offset+=v.sampleCount
   const credit={requestId:v.requestId,ready:retired};credits.push(credit);if(retired)flushCredits()
   ++this.deliveries
   reads=reads.then(async()=>{
    const path=join(cache,v.audioId+'.wav')
    let bytes:Buffer
    try{if(retired||this.cache!==cache||this.child!==child)throw Error('VOICE_CANCELLED');const stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>96044)throw Error('VOICE_INVALID_WAV');bytes=await readFile(path);if(verifyWav(bytes)!==v.sampleCount/48)throw Error('VOICE_INVALID_WAV')}
    finally{await rm(path,{force:true}).catch(()=>{})}
    if(retired||this.cache!==cache||this.child!==child)throw Error('VOICE_CANCELLED')
    // Dispatch ordered chunks without awaiting playback. Three producer credits
    // bound bytes and scheduled audio; consumption returns each credit separately.
    void accept({audioId:v.audioId,bytes,durationMs:v.sampleCount/48,generationMs:0,rtf:0,synthesisId,chunkIndex:v.chunkIndex,sampleOffset:v.sampleOffset,sampleCount:v.sampleCount,firstChunkReadyMs:v.firstChunkReadyMs}).then(()=>{
     credit.ready=true;flushCredits()
    }).catch(failStream)
   }).catch(failStream).finally(()=>{--this.deliveries})
  })
  await reads
  if(retired)throw Error('VOICE_CANCELLED')
  if(failure)throw failure
  if(result.effectiveSeed!==binding.effectiveSeed)throw Error('VOICE_SEED_MISMATCH');
  if(result.synthesisId!==synthesisId||result.totalSamples!==offset||result.totalChunks!==index||!index)throw Error('VOICE_STREAM_TOTAL')
  return result
  }catch(e){failStream(e as Error);throw e}
  finally{delivered=true;flushCredits()}
 }
 stop():Promise<void> {
  this.cancellation?.reject(Error('VOICE_CANCEL_ABORTED'))
  this.retireSpeech()
  ++this.revision
  if(this.ending)return this.ending
  const wasBusy=!!this.pending||!!this.starting||this.windowsGguf&&(this.ggufActive||!!this.cancellation)
  this.fail(Error('VOICE_CANCELLED'));this.key=''
  const child=this.child,exited=this.exit,cache=this.cache
  const task=(async()=>{
   if(child){
    const wait=async(ms:number)=>{let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([exited.then(()=>true),new Promise<false>(resolve=>{timer=setTimeout(()=>resolve(false),ms)})])}finally{clearTimeout(timer)}}
    if(process.platform==='win32'&&this.windowsGguf&&!wasBusy&&child.exitCode===null&&!child.stdin.destroyed){
     // Let only this engine's idle native context release CUDA allocations and
     // cached references before its Python redirector exits. Bound the wait;
     // active generation or an unresponsive shutdown still owns one tree.
     child.stdout.removeAllListeners('data');child.stdout.resume()
     child.stdin.end(JSON.stringify({protocolVersion:1,type:'shutdown',requestId:randomUUID()})+'\n');await wait(1000)
    }
    // Windows venv launchers can have a Python child. Kill only this owned tree.
    if(process.platform==='win32'&&child.pid&&child.exitCode===null){
     await new Promise<void>((resolve,reject)=>{
      const killer=spawn('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,shell:false,stdio:'ignore',timeout:5000})
      killer.once('error',()=>reject(Error('VOICE_WORKER_STOP')))
      killer.once('exit',code=>{if(code===0||child.exitCode!==null)resolve();else reject(Error('VOICE_WORKER_STOP'))})
     })
    }else if(process.platform==='darwin'){
     // Ignore only this retiring worker's protocol. Keep draining its pipe.
     child.stdout.removeAllListeners('data');child.stdout.resume()
     if(!wasBusy&&!child.stdin.destroyed){child.stdin.end(JSON.stringify({protocolVersion:1,type:'shutdown',requestId:randomUUID()})+'\n');await wait(500)}
     if(child.exitCode===null&&child.signalCode==null){child.kill('SIGTERM');if(!await wait(1500)){child.kill('SIGKILL');if(!await wait(2000))throw Error('VOICE_WORKER_STOP_TIMEOUT')}}
    }else if(!this.windowsGguf||child.exitCode===null)child.kill()
    let timer:ReturnType<typeof setTimeout>|undefined
    try{await Promise.race([exited,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('VOICE_WORKER_STOP_TIMEOUT')),5000)})])}finally{if(timer)clearTimeout(timer)}
   }
   if(cache){await rm(cache,{recursive:true,force:true,maxRetries:3,retryDelay:100}).catch(()=>{throw Error('VOICE_CACHE_CLEANUP')});if(this.cache===cache)this.cache=null}
  })()
  this.ending=task
  void task.finally(()=>{if(this.ending===task)this.ending=null}).catch(()=>{})
  return task
 }
}
