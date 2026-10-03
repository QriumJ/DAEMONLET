import {afterEach,expect,it,vi} from 'vitest'
import {EventEmitter} from 'node:events'
import {PassThrough} from 'node:stream'
import {mkdtemp,rm,readdir,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {randomUUID} from 'node:crypto'
import type {ExecutionProfile,SpeechBinding} from '../electron/shared/character-voice-contract'
import {ENGINE} from '../electron/main/character-voice/VoicePackage'
import policy from '../electron/voice/runtime-gguf-windows-voxcpm2.json'
import defaultVoice from '../electron/voice/base-voice-defaults.json'
import type {ReferenceCondition} from '../electron/main/character-voice/ReferenceProfileStore'
const treeKill=vi.hoisted(()=>vi.fn())
vi.mock('node:child_process',async importOriginal=>({...await importOriginal<typeof import('node:child_process')>(),spawn:treeKill}))
import {TtsRuntimeSupervisor,type TtsConfig} from '../electron/main/character-voice/TtsRuntimeSupervisor'

// The synthetic child never launches a native worker, Python, GPU or taskkill.
const clean:Array<()=>Promise<unknown>>=[]
const [packageSha256,derivative]=Object.entries(policy.derivatives)[0]
afterEach(async()=>{for(const fn of clean.splice(0))await fn();vi.unstubAllGlobals();treeKill.mockReset()})
const wav=()=>{const b=Buffer.alloc(9644);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(48000,24);b.writeUInt32LE(96000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(9600,40);return b}
async function fixture(options:{profile?:ExecutionProfile;publicMode?:'base'|'wav-reference';config?:Partial<TtsConfig>;audit?:Record<string,unknown>;shutdown?:'hang';cancel?:'hang'|'wrong-target';reuseAudit?:Record<string,unknown>}={}){
 vi.stubGlobal('process',{...process,platform:'win32',arch:'x64'})
 const root=await mkdtemp(join(tmpdir(),'vox-gguf-supervisor-')),requests:any[]=[],children:any[]=[]
 const config:TtsConfig={engine:'voxcpm2',python:process.execPath,model:join(root,'original'),worker:join(root,'voxcpm_windows_gguf_worker.py'),cacheRoot:join(root,'cache'),executionProfile:options.profile||'gguf-cuda-f16',gguf:{runtimeDir:join(root,'runtime'),derivativeDir:join(root,'derivative'),receipt:join(root,'runtime-receipt.json')},...options.config}
 if(options.publicMode){config.ggufModelKind='public-base';config.model=config.gguf!.derivativeDir}
 const conditioning:ReferenceCondition|undefined=options.publicMode==='wav-reference'?{kind:'wav-reference',path:join(root,'reference.wav'),sha256:'a'.repeat(64),fingerprint:'c'.repeat(64),preprocessingVersion:'mono-pcm16-round-v1',sampleRate:24000,samples:48000}:undefined
 const backend=config.executionProfile!.startsWith('gguf-cuda-')?'CUDA0':'Vulkan0'
 const valid={seedContract:1,executionProfile:config.executionProfile!.replace(/-complete$/,''),backend,backendFamily:backend==='CUDA0'?'CUDA':'Vulkan',componentBackends:Object.fromEntries(['ResidualLM','LocEnc','LocDiT','FSQ','AudioVAE','Projections','StopPredictor'].map(name=>[name,backend])),offloadedLayers:29,nativePid:34567,dtype:'float16-weights',packageSha256,adapterSha256:derivative.adapterSha256,derivativeManifestSha256:derivative.conversionSha256,adapterRepresentation:'merged-once-fp32-then-f16',mergedKeys:384,mergedMatrices:192,missingKeys:0,skippedKeys:0,referenceCacheBuilds:1,modelRevision:ENGINE.model_revision,sourceCommit:ENGINE.source_commit,nativeSourceCommit:policy.sourceCommit,referenceSha256:'a'.repeat(64),runtimeFingerprint:'b'.repeat(64),ggufVerification:'full-sha256',originalModelVerification:'provenance-and-presence',capabilities:{engine:'voxcpm2',synthesisStreaming:true,cancellation:'cooperative-stream-with-owned-process-fallback',warmCancellationReuse:true}}
 if(options.publicMode)Object.assign(valid,{ggufModelKind:'public-base',modelRepository:policy.publicModel.repo,modelRevision:policy.publicModel.revision,modelFiles:structuredClone(policy.publicModel.files),publisher:policy.publicModel.repo.split('/')[0],sourceCommit:policy.sourceCommit,packageSha256:null,adapterSha256:null,derivativeManifestSha256:null,adapterRepresentation:'none',mergedKeys:0,mergedMatrices:0,originalModelVerification:'not-applicable-public-gguf',mode:options.publicMode,referenceMode:options.publicMode,referenceContract:1,referenceCacheBuilds:conditioning?1:0,referenceSha256:conditioning?.sha256??null,conditioningFingerprint:conditioning?.fingerprint??null,defaultVoice:conditioning?null:structuredClone(defaultVoice)})
 let cache=''
 const runtime=new TtsRuntimeSupervisor(config,2000,()=>{
  const child:any=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.pid=24680+children.length;child.exitCode=null;child.signalCode=null;let active:any=null
  child.close=()=>{if(child.exitCode!==null)return;active=null;child.exitCode=0;queueMicrotask(()=>child.emit('close',0))};child.kill=vi.fn(()=>{child.close();return true});children.push(child)
  const send=(r:any,type:string,extra:object={})=>child.stdout.write(JSON.stringify({protocolVersion:1,requestId:r.requestId,type,...(r.seed===undefined?{}:{effectiveSeed:r.seed}),...extra})+'\n')
  const chunk=async(r:any,index:number)=>{const audioId=randomUUID();await writeFile(join(cache,audioId+'.wav'),wav());send(r,'audio-chunk',{synthesisId:r.synthesisId,audioId,binding:r.binding,segmentIndex:r.segmentIndex,chunkIndex:index,sampleOffset:index*4800,sampleCount:4800,sampleRate:48000,firstChunkReadyMs:1})}
  child.stdin.on('data',(bytes:Buffer)=>{for(const line of bytes.toString().trim().split('\n')){
   const r=JSON.parse(line);requests.push(r)
   if(r.type==='init'){cache=r.cache;queueMicrotask(()=>send(r,'ready',{...valid,...options.audit}))}
   if(r.type==='stream'){
    const producer={request:r,initial:Promise.resolve(),completion:null as Promise<void>|null};active=producer
    producer.initial=(async()=>{for(let i=0;i<3;i++){if(active!==producer)return;await chunk(r,i)}})()
   }
   if(r.type==='credit'&&r.chunkIndex===0&&active?.request.requestId===r.requestId&&!active.completion){const producer=active;producer.completion=producer.initial.then(async()=>{if(active!==producer)return;await chunk(producer.request,3);if(active!==producer)return;active=null;send(producer.request,'synthesis-finished',{synthesisId:producer.request.synthesisId,totalSamples:19200,totalChunks:4,generationMs:2,rtf:.005})})}
   if(r.type==='cancel-stream'&&options.cancel!=='hang'){active=null;queueMicrotask(()=>send(r,'cancelled',{target:options.cancel==='wrong-target'?{...r.target,speechEpoch:999}:r.target,cleanupComplete:true,keptWarm:true,boundary:'native-reset',reuseAudit:{nativePid:valid.nativePid,referenceCacheBuilds:valid.referenceCacheBuilds,...options.reuseAudit}}))}
   if(r.type==='shutdown'&&options.shutdown!=='hang'){send(r,'shutdown-complete',{cleanupComplete:true});child.close()}
  }})
  return child
 })
 treeKill.mockImplementation((_exe,args)=>{const killer=new EventEmitter();queueMicrotask(()=>{children.find(child=>String(child.pid)===args[1])?.close();killer.emit('exit',0)});return killer})
 clean.push(async()=>{await runtime.stop();await rm(root,{recursive:true,force:true})})
 const start=()=>runtime.start(options.publicMode?'':join(root,'trained-package'),options.publicMode?'public-fingerprint':'trained-fingerprint',conditioning)
 const binding=(epoch=1)=>({engine:'voxcpm2',executionProfile:config.executionProfile,runtimeSessionId:runtime.sessionId,effectiveSeed:42,speechEpoch:epoch,...(conditioning?{conditioningFingerprint:conditioning.fingerprint}:{})}) as SpeechBinding
 return{runtime,root,requests,children,config,start,binding,valid,conditioning}
}

it.each(['gguf-cuda-f16','gguf-cuda-f16-complete','gguf-vulkan-f16','gguf-vulkan-f16-complete'] as const)('admits %s with unchanged original model and distinct trained derivative paths',async profile=>{
 const f=await fixture({profile});await f.start();const session=f.runtime.sessionId
 expect(f.requests[0]).toMatchObject({engine:'voxcpm2',model:f.config.model,gguf:f.config.gguf,baseModel:false,executionProfile:profile.replace(/-complete$/,'')});await f.start();expect(f.children).toHaveLength(1);expect(f.runtime.sessionId).toBe(session)
})
it.each([{gguf:undefined},{gguf:{runtimeDir:'relative',derivativeDir:'/derivative',receipt:'/receipt'}},{gguf:{runtimeDir:'/runtime',derivativeDir:'relative',receipt:'/receipt'}},{gguf:{runtimeDir:'/runtime',derivativeDir:'/derivative',receipt:'relative'}},{engine:'qwen3-tts-06b' as const},{nativeBase:true},{windowsBase:true}])('rejects Vox GGUF configuration before spawn %j',async config=>{
 const f=await fixture({config});await expect(f.start()).rejects.toThrow('VOX_GGUF_RUNTIME_CONFIG');expect(f.children).toHaveLength(0)
})
it('rejects non-Windows-x64, missing trained package and WAV-only conditioning',async()=>{
 const f=await fixture();vi.stubGlobal('process',{...process,arch:'arm64'});await expect(f.start()).rejects.toThrow('VOX_GGUF_RUNTIME_CONFIG');vi.stubGlobal('process',{...process,arch:'x64'})
 await expect(f.runtime.start('','key')).rejects.toThrow('VOX_GGUF_RUNTIME_CONFIG')
 await expect(f.runtime.start(join(f.root,'pack'),'key',{kind:'wav-reference',path:join(f.root,'reference.wav'),sha256:'a'.repeat(64),fingerprint:'b'.repeat(64),preprocessingVersion:'mono-pcm16-round-v1',sampleRate:24000,samples:48000})).rejects.toThrow('VOICE_REFERENCE_RUNTIME');expect(f.children).toHaveLength(0)
})
it.each([{backend:'CPU'},{backend:'CUDA1'},{backendFamily:'Vulkan'},{componentBackends:{ResidualLM:'CUDA0'}},{componentBackends:Object.fromEntries(['ResidualLM','LocEnc','LocDiT','FSQ','AudioVAE','Projections','StopPredictor'].map(name=>[name,name==='AudioVAE'?'CPU':'CUDA0']))},{offloadedLayers:28},{nativePid:0},{executionProfile:'gguf-vulkan-f16'},{dtype:'float32'},{capabilities:{engine:'voxcpm2',synthesisStreaming:true,cancellation:'owned-process-termination',warmCancellationReuse:false}}])('refuses partial/off-device/native capability proof %j',async audit=>{
 const f=await fixture({audit});await expect(f.start()).rejects.toThrow('VOX_GGUF_CAPABILITIES');expect(f.runtime.running).toBe(false);expect(treeKill.mock.calls[0].slice(0,2)).toEqual(['taskkill.exe',['/PID','24680','/T','/F']])
})
it.each([{packageSha256:'c'.repeat(64)},{packageSha256:'__proto__'},{packageSha256:'constructor'},{adapterSha256:'c'.repeat(64)},{derivativeManifestSha256:'c'.repeat(64)},{adapterRepresentation:'merged-twice'},{mergedKeys:383},{mergedMatrices:191},{missingKeys:1},{skippedKeys:1},{referenceCacheBuilds:0},{modelRevision:'other'},{sourceCommit:'other'},{nativeSourceCommit:'other'},{referenceSha256:'invalid'},{runtimeFingerprint:'invalid'},{ggufVerification:'size-only'},{originalModelVerification:'full-sha256'},{mode:'wav-reference'},{defaultVoice:{name:'default'}}])('refuses mismatched trained derivative identity %j',async audit=>{
 const f=await fixture({audit});await expect(f.start()).rejects.toThrow('VOX_GGUF_TRAINED_IDENTITY');expect(f.runtime.running).toBe(false)
})
it.each(['gguf-cuda-f16-complete','gguf-vulkan-f16-complete'] as const)('collects %s through ordered streaming without changing speech bindings',async profile=>{
 const f=await fixture({profile});await f.start();const audio=await f.runtime.synthesize('complete',f.binding(),0)
 expect(audio.durationMs).toBe(400);expect(audio.bytes.length).toBe(38444);expect(f.requests.some(r=>r.type==='synthesize')).toBe(false);expect(f.requests.find(r=>r.type==='stream').binding.executionProfile).toBe(profile)
})
it('cancels a credit-blocked native stream and reuses both session and merged voice',async()=>{
 const f=await fixture();await f.start();const session=f.runtime.sessionId;let delivered=0
 const old=f.runtime.stream('blocked',f.binding(),0,()=>{delivered++;return new Promise(()=>{})}).catch(e=>e.message)
 await vi.waitFor(()=>expect(delivered).toBe(3));expect(await f.runtime.cancelSpeech()).toMatchObject({keptWarm:true,boundary:'native-reset',reuseAudit:{nativePid:34567,referenceCacheBuilds:1}});expect(await old).toBe('VOICE_CANCELLED');expect(treeKill).not.toHaveBeenCalled()
 expect((await f.runtime.stream('replacement',f.binding(2),0,async()=>{})).totalChunks).toBe(4);expect(f.runtime.sessionId).toBe(session);expect(f.children).toHaveLength(1)
})
it.each(['hang','wrong-target'] as const)('cancel %s cannot reuse an unconfirmed native context',async cancel=>{
 const f=await fixture({cancel});await f.start();let delivered=0;const old=f.runtime.stream('blocked',f.binding(),0,()=>{delivered++;return new Promise(()=>{})}).catch(e=>e.message)
 await vi.waitFor(()=>expect(delivered).toBe(3));expect((await f.runtime.cancelSpeech(50)).keptWarm).toBe(false);await old;expect(f.runtime.running).toBe(false);expect(f.requests.some(r=>r.type==='shutdown')).toBe(false)
 expect(treeKill.mock.calls[0].slice(0,2)).toEqual(['taskkill.exe',['/PID','24680','/T','/F']])
})
it.each([{nativePid:98765},{referenceCacheBuilds:2}])('a cancel ack cannot claim warm reuse after native identity changes %j',async reuseAudit=>{
 const f=await fixture({reuseAudit});await f.start();let delivered=0;const old=f.runtime.stream('blocked',f.binding(),0,()=>{delivered++;return new Promise(()=>{})}).catch(e=>e.message)
 await vi.waitFor(()=>expect(delivered).toBe(3));expect((await f.runtime.cancelSpeech()).keptWarm).toBe(false);await old;expect(f.runtime.running).toBe(false);expect(treeKill).toHaveBeenCalledOnce()
})
it('idle native shutdown frees its context and cache without a force kill',async()=>{
 const f=await fixture();await f.start();await f.runtime.stop();expect(f.requests.filter(r=>r.type==='shutdown')).toHaveLength(1);expect(treeKill).not.toHaveBeenCalled();expect(f.children[0].kill).not.toHaveBeenCalled();expect(await readdir(join(f.root,'cache'))).toEqual([])
})
it('an unresponsive idle native shutdown falls back only on its owned Python tree',async()=>{
 const f=await fixture({shutdown:'hang'});await f.start();await f.runtime.stop();expect(treeKill).toHaveBeenCalledOnce();expect(treeKill.mock.calls[0].slice(0,2)).toEqual(['taskkill.exe',['/PID','24680','/T','/F']]);expect(f.runtime.running).toBe(false)
})

it.each(['gguf-cuda-f16','gguf-cuda-f16-complete','gguf-vulkan-f16','gguf-vulkan-f16-complete'] as const)('admits a pinned public %s pair without a Torch model or trained package',async profile=>{
 const f=await fixture({profile,publicMode:'base'});await f.start()
 expect(f.requests[0]).toMatchObject({ggufModelKind:'public-base',baseModel:true,package:'',model:f.config.gguf!.derivativeDir,executionProfile:profile.replace(/-complete$/,'')});expect(f.requests[0].conditioning).toBeUndefined()
 expect(f.runtime.audit).toMatchObject({adapterRepresentation:'none',adapterSha256:null,packageSha256:null,mergedKeys:0,referenceCacheBuilds:0,defaultVoice})
 await f.runtime.stop();expect(treeKill).not.toHaveBeenCalled()
})
it.each(['gguf-cuda-f16','gguf-vulkan-f16'] as const)('binds public %s WAV conditioning to the exact managed reference',async profile=>{
 const f=await fixture({profile,publicMode:'wav-reference'});await f.start();expect(f.requests[0].conditioning).toEqual(f.conditioning)
 const changed={...f.binding(),conditioningFingerprint:'d'.repeat(64)}
 await expect(f.runtime.stream('stale reference',changed,0,async()=>{})).rejects.toThrow('VOICE_REFERENCE_BINDING');expect(f.requests.some(r=>r.type==='stream')).toBe(false)
 expect((await f.runtime.stream('verified reference',f.binding(),0,async()=>{})).totalChunks).toBe(4)
})
it('rejects stale WAV replay identity in public default voice before generation',async()=>{
 const f=await fixture({publicMode:'base'});await f.start();const changed={...f.binding(),conditioningFingerprint:'c'.repeat(64)}
 await expect(f.runtime.synthesize('stale WAV',changed,0)).rejects.toThrow('VOICE_REFERENCE_BINDING');await expect(f.runtime.stream('stale WAV',changed,0,async()=>{})).rejects.toThrow('VOICE_REFERENCE_BINDING');expect(f.requests.some(r=>r.type==='stream'||r.type==='synthesize')).toBe(false)
})
it('a public request cannot silently use a trained package, original Torch root or legacy base flags',async()=>{
 const f=await fixture({publicMode:'base'});await expect(f.runtime.start(join(f.root,'private-pack'),'wrong')).rejects.toThrow('VOX_GGUF_RUNTIME_CONFIG')
 f.config.model=join(f.root,'original');await expect(f.start()).rejects.toThrow('VOX_GGUF_RUNTIME_CONFIG');f.config.model=f.config.gguf!.derivativeDir;f.config.windowsBase=true;await expect(f.start()).rejects.toThrow('VOX_GGUF_RUNTIME_CONFIG');expect(f.children).toHaveLength(0)
})
it('public ready identity cannot be admitted into the trained route',async()=>{
 const f=await fixture({publicMode:'base'});f.config.ggufModelKind=undefined;f.config.model=join(f.root,'original')
 await expect(f.runtime.start(join(f.root,'private-pack'),'private')).rejects.toThrow('VOX_GGUF_TRAINED_IDENTITY');expect(f.runtime.running).toBe(false)
})
it.each([{ggufModelKind:undefined},{ggufModelKind:'trained'},{modelRepository:'OpenBMB/VoxCPM2'},{publisher:'OpenBMB'},{modelRevision:ENGINE.model_revision},{sourceCommit:ENGINE.source_commit},{nativeSourceCommit:'other'},{modelFiles:{}},{modelFiles:{...policy.publicModel.files,'injected.gguf':{bytes:1,sha256:'a'.repeat(64)}}},{modelFiles:{...policy.publicModel.files,'VoxCPM2-BaseLM-F16.gguf':{...policy.publicModel.files['VoxCPM2-BaseLM-F16.gguf'],sha256:'c'.repeat(64)}}},{packageSha256},{adapterSha256:derivative.adapterSha256},{derivativeManifestSha256:derivative.conversionSha256},{adapterRepresentation:'merged-once-fp32-then-f16'},{mergedKeys:384},{mergedMatrices:192},{missingKeys:1},{skippedKeys:1},{originalModelVerification:'provenance-and-presence'},{ggufVerification:'installed'},{runtimeFingerprint:'invalid'},{mode:'wav-reference'},{referenceMode:'reference'},{referenceContract:0},{referenceSha256:'a'.repeat(64)},{conditioningFingerprint:'c'.repeat(64)},{referenceCacheBuilds:1},{defaultVoice:null},{defaultVoice:{...defaultVoice,seed:7}},{defaultVoice:{...defaultVoice,description:'different'}},{defaultVoice:{...defaultVoice,adapter:'private'}}])('rejects public/trained provenance or default voice contamination %j',async audit=>{
 const f=await fixture({publicMode:'base',audit});await expect(f.start()).rejects.toThrow('VOX_GGUF_PUBLIC_IDENTITY');expect(f.runtime.running).toBe(false)
})
it.each([{mode:'base'},{referenceMode:'base'},{referenceContract:0},{referenceCacheBuilds:0},{referenceSha256:'d'.repeat(64)},{conditioningFingerprint:'d'.repeat(64)},{defaultVoice}])('rejects altered public WAV preparation identity %j',async audit=>{
 const f=await fixture({publicMode:'wav-reference',audit});await expect(f.start()).rejects.toThrow('VOICE_REFERENCE_RUNTIME')
})
it('public default cancellation proves zero reference caches and preserves the same native session',async()=>{
 const f=await fixture({publicMode:'base'});await f.start();const session=f.runtime.sessionId;let delivered=0
 const old=f.runtime.stream('blocked',f.binding(),0,()=>{delivered++;return new Promise(()=>{})}).catch(e=>e.message)
 await vi.waitFor(()=>expect(delivered).toBe(3));expect(await f.runtime.cancelSpeech()).toMatchObject({keptWarm:true,reuseAudit:{nativePid:34567,referenceCacheBuilds:0}});expect(await old).toBe('VOICE_CANCELLED')
 expect((await f.runtime.stream('next default',f.binding(2),0,async()=>{})).totalChunks).toBe(4);expect(f.runtime.sessionId).toBe(session);expect(treeKill).not.toHaveBeenCalled()
})
