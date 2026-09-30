import {DEFAULT_VOICE_SEED,validSeedSettings,validVoiceSeed,type VoiceSeedSettings,type VoiceGenerationPlan} from '../../shared/voice-seed'
import {VoiceReplayCache,type ReplayCandidate} from './VoiceReplayCache'
import {VoiceAssetIdentity} from './VoiceAssetIdentity'
import {mkdir,readdir,readFile,rm,writeFile,realpath} from 'node:fs/promises'
import {dirname,join} from 'node:path'
import {createHash,randomUUID,randomInt} from 'node:crypto'
import type {ChatMessage,LocalChatSnapshot} from '../../shared/character-chat-contract'
import {isManagedVoice,isReferenceProfile,DEFAULT_SPEECH_POLICY,planSpeech,type SpeechPolicy,isStreamingProfile,voiceCapabilities,type SpeechBinding,type PlaybackBinding,type VoiceEvent,type VoiceSnapshot,type ExecutionProfile} from '../../shared/character-voice-contract'
import {importVoicePackage,profileKey,SELECTED_VOICE,verifyVoicePackage} from './VoicePackage'
import {TtsRuntimeSupervisor,type TtsConfig,type AudioChunk} from './TtsRuntimeSupervisor'
import {verifyMacInterpreter} from './VoiceRuntimeProfile'
import {type BaseVoiceInstallation,BASE_VOICE,BASE_KEY} from './VoiceBaseInstaller'
import {ReferenceProfileStore,referenceKey,workerReferenceConverter,type ReferenceCondition} from './ReferenceProfileStore'
import {replaceFile} from '../character-chat/replaceFile'

export class CharacterVoiceService {
 private state:VoiceSnapshot={seedSettings:{...DEFAULT_VOICE_SEED},seedError:false,epoch:0,enabled:false,autoRead:true,volume:0.8,profiles:[],bindings:{},status:'off',error:null,runtimeConfigured:false,availableProfiles:voiceCapabilities(process.platform,process.arch),executionProfile:process.platform==='darwin'?'gguf-metal-f16':'baseline'}
 private replay=new VoiceReplayCache()
 readonly references:ReferenceProfileStore
 private referenceOperation:{controller:AbortController;task:Promise<void>}|null=null
 private referenceImportError:string|null=null
 private installingBase:Promise<void>|null=null
 private installEpoch=0
 private baseExecutionProfile:ExecutionProfile='cuda-compiled'
 private verifiedBase:{runtime:TtsRuntimeSupervisor;session:string;key:string;identity:string}|null=null
 private config:{python:string;model:string}|null=null
 private runtime:TtsRuntimeSupervisor|null=null
 private serial:Promise<unknown>=Promise.resolve()
 private operation=0
 private seen=new Set<string>()
 private active:{id:string;epoch:number;bytes:Uint8Array;claimed:boolean;resolve:()=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>}|null=null
 private outputReady=false
 private observedRequests=new Set<string>()
 private allowedRequests=new Set<string>()
 private pendingRemoval=new Set<string>()
 private disposed=false
 private currentSpeech:(()=>boolean)|null=null
 private preparing:Promise<void>|null=null
 private chunks=new Map<string,{epoch:number;bytes:Uint8Array;durationMs:number;claimed:boolean;resolve:()=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>;segmentIndex:number;chunkIndex:number}>()
 private speechStartedAt=0
 private requestTimes=new Map<string,number>()
 private spokenRequestAt=0
 private firstPlayback=false
 private lastPlaybackEndAt=0
 constructor(readonly root:string,private worker:string,private chat:()=>LocalChatSnapshot,private changed:(state:VoiceSnapshot)=>void,private event:(event:VoiceEvent)=>void,private makeRuntime:(config:TtsConfig)=>TtsRuntimeSupervisor=config=>new TtsRuntimeSupervisor(config),private diagnostic:(value:Record<string,unknown>)=>void=()=>{},private base?:BaseVoiceInstallation,private speechPolicy:SpeechPolicy=DEFAULT_SPEECH_POLICY,referenceStore?:ReferenceProfileStore,private chooseRandom:()=>number=()=>randomInt(1,0x80000000)){this.references=referenceStore??new ReferenceProfileStore(join(root,'reference-profiles'),workerReferenceConverter(join(dirname(worker),'reference-import-worker.cjs')))}
 snapshot(){
  this.syncReplayScope()
  const s=structuredClone(this.state),selected=this.selectedProfile(),managed=isManagedVoice(selected)
  s.results=this.replay.infos()
  s.executionProfile=this.activeProfile();s.runtimeConfigured=!!this.configured();s.referenceImport={busy:!!this.referenceOperation,error:this.referenceImportError}
  if(this.base){s.baseInstall=this.base.snapshot();if(s.baseInstall.supported){s.defaultProfile=this.baseKey();if(!this.base.native)s.availableProfiles=managed?['cuda-compiled','cuda-compiled-complete']:['baseline','cached','compiled']}}
  if(this.state.enabled&&((managed&&!s.runtimeConfigured)||isReferenceProfile(selected)&&selected.error||referenceKey(this.bindingKey(this.chat().character?.id||''))&&!selected)){
   s.status='unavailable';s.error=isReferenceProfile(selected)&&selected.error?selected.error:!selected?'VOICE_REFERENCE_UNAVAILABLE':s.error||'VOICE_BASE_NOT_INSTALLED'
  }
  if(s.seedError){s.status='error';s.error='VOICE_SEED_SETTINGS'}
  return s
 }
 private baseKey(){return this.base?profileKey(this.base.profile):BASE_KEY}
 private activeProfile():ExecutionProfile{return isManagedVoice(this.selectedProfile())&&this.base&&!this.base.native?this.baseExecutionProfile:this.state.executionProfile||'baseline'}
 private bindingKey(id:string){return this.state.bindings[id]??(this.base?.snapshot().supported?this.baseKey():'')}
 refreshBase(){this.emit()}
 installBase():Promise<void>{
  if(this.disposed)return Promise.resolve()
  if(this.installingBase)return this.installingBase
  if(!this.base)return Promise.reject(Error('VOICE_BASE_UNSUPPORTED'))
  const epoch=this.installEpoch
  const task:Promise<void>=Promise.resolve().then(async()=>{
   if(this.disposed||epoch!==this.installEpoch)return
   await this.base!.install()
   if(this.disposed||epoch!==this.installEpoch||!this.base!.snapshot().installed)return
   this.state.error=null;this.emit();await this.prepare()
  }).finally(()=>{if(this.installingBase===task)this.installingBase=null})
  this.installingBase=task;return task
 }
 async cancelInstallBase(){++this.installEpoch;const pending=this.installingBase;try{await this.base?.cancel()}finally{await pending?.catch(()=>{})}}
 private selectedProfile(){return this.state.profiles.find(p=>profileKey(p)===this.bindingKey(this.chat().character?.id||''))}
 private configured(){const p=this.selectedProfile();return isReferenceProfile(p)&&p.error?false:isManagedVoice(p)?this.base?.snapshot().installed:!!this.config}
 private bestEffort(work:()=>void){try{work()}catch{console.warn('[voice] VOICE_NOTIFICATION_FAILED')}}
 private emit(){this.bestEffort(()=>this.changed(this.snapshot()))}
 private notify(event:VoiceEvent){this.bestEffort(()=>this.event(event))}
 private diagnose(value:Record<string,unknown>){this.bestEffort(()=>this.diagnostic(value))}
 setOutputReady(ready:boolean){
  if(this.outputReady===(ready&&!this.disposed))return
  this.outputReady=ready&&!this.disposed
  if(!this.outputReady){this.allowedRequests.clear();void this.stop().catch(e=>this.error(e))}
  else void this.prepare()
 }

 async initialize(){
  try {
   await mkdir(join(this.root,'profiles'),{recursive:true})
   // Previous process owns no active cache after an app restart.
   await rm(join(this.root,'cache'),{recursive:true,force:true,maxRetries:2}).catch(()=>{})
   try{const saved=JSON.parse(await readFile(join(this.root,'settings.json'),'utf8'))
    if(saved.version!==1||typeof saved.enabled!=='boolean'||typeof saved.autoRead!=='boolean'||!Number.isFinite(saved.volume)||saved.volume<0||saved.volume>1||!saved.bindings||typeof saved.bindings!=='object'||Array.isArray(saved.bindings))throw Error('VOICE_SETTINGS')
    this.pendingRemoval=new Set(Array.isArray(saved.pendingRemoval)?saved.pendingRemoval.filter((v:unknown)=>typeof v==='string'&&/^[a-z0-9_-]+@[a-zA-Z0-9._-]+$/.test(v)):[])
    if(Object.hasOwn(saved,'seedSettings')){if(validSeedSettings(saved.seedSettings))this.state.seedSettings={...saved.seedSettings};else{this.state.seedError=true;this.state.error='VOICE_SEED_SETTINGS'}}
    this.state.enabled=saved.enabled;this.state.autoRead=saved.autoRead;this.state.volume=saved.volume
    const supported=this.state.availableProfiles||[], selected=saved.executionProfile||'baseline'
    if(supported.includes(selected))this.state.executionProfile=selected
    else {this.state.executionProfile=supported[0];this.state.enabled=false;this.state.error='VOICE_PLATFORM_PROFILE'}
    this.baseExecutionProfile=saved.baseExecutionProfile==='cuda-compiled-complete'||saved.executionProfile==='cuda-compiled-complete'?'cuda-compiled-complete':'cuda-compiled'
    // Migrate only the new managed-mode names; preserve every legacy external mode.
    if(this.state.executionProfile?.startsWith('cuda-compiled'))this.state.executionProfile='compiled'
    this.state.bindings=Object.fromEntries(Object.entries(saved.bindings).filter(([k,v])=>k.length<=80&&typeof v==='string'&&v.length<=170)) as Record<string,string>
    if(saved.runtime&&typeof saved.runtime.python==='string'&&typeof saved.runtime.model==='string'){this.config=saved.runtime;this.state.runtimeConfigured=true}
   }catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw Error('VOICE_SETTINGS')}
   await this.references.initialize().catch(()=>{this.referenceImportError='VOICE_REFERENCE_STORAGE'})
   for(const key of this.pendingRemoval)await this.removeFiles(key).catch(()=>{this.state.error='VOICE_CLEANUP_PENDING'})
   for(const entry of await readdir(join(this.root,'profiles'),{withFileTypes:true}))if(entry.isDirectory()&&!entry.name.startsWith('.')){
    if(this.pendingRemoval.has(entry.name)){await this.removeFiles(entry.name).catch(()=>{this.state.error='VOICE_CLEANUP_PENDING'});continue}
    const p=await verifyVoicePackage(join(this.root,'profiles',entry.name),process.platform==='darwin'?undefined:SELECTED_VOICE)
    if(entry.name!==profileKey(p.profile))throw Error('VOICE_PROFILE_PATH')
    this.state.profiles.push(p.profile)
   }
   this.state.profiles.push(...this.references.list().filter(p=>!this.pendingRemoval.has(profileKey(p))))
   if(this.base){await this.base.initialize();if(this.base.snapshot().supported)this.state.profiles.push(this.base.profile)}
   for(const [character,key] of Object.entries(this.state.bindings))if(!referenceKey(key)&&!this.state.profiles.some(p=>profileKey(p)===key))delete this.state.bindings[character]
   this.state.status=this.state.enabled?'idle':'off';this.emit()
  }catch{this.error(Error('VOICE_STORAGE'))}
 }
 private async save(){
  await mkdir(this.root,{recursive:true});const temp=join(this.root,'settings-'+randomUUID()+'.tmp')
  try{await writeFile(temp,JSON.stringify({version:1,enabled:this.state.enabled,autoRead:this.state.autoRead,volume:this.state.volume,bindings:this.state.bindings,runtime:this.config,pendingRemoval:[...this.pendingRemoval],executionProfile:this.state.executionProfile||'baseline',baseExecutionProfile:this.baseExecutionProfile,seedSettings:this.state.seedError?{invalid:true}:this.state.seedSettings})+'\n',{flag:'wx'});await replaceFile(temp,join(this.root,'settings.json'))}
  finally{await rm(temp,{force:true}).catch(()=>{})}
 }
 private mutate(work:()=>Promise<void>){const task=this.serial.then(async()=>{if(this.disposed)return;const previous=structuredClone(this.state),config=this.config,baseMode=this.baseExecutionProfile,removals=new Set(this.pendingRemoval);try{await work();await this.save();this.emit()}catch(e){this.state={...previous,epoch:this.state.epoch};this.config=config;this.baseExecutionProfile=baseMode;this.pendingRemoval=removals;this.error(e)}});this.serial=task.catch(()=>{});return task}
 error(e:unknown){this.state.error=e instanceof Error&&/^[A-Z_]{1,80}$/.test(e.message)?e.message:'VOICE_ERROR';this.state.status='error';this.emit()}
 async importPackage(path:string){return this.mutate(async()=>{const p=await importVoicePackage(path,join(this.root,'profiles'),process.platform==='darwin'?undefined:SELECTED_VOICE);if(!this.state.profiles.some(v=>profileKey(v)===profileKey(p.profile)))this.state.profiles.push(p.profile);this.pendingRemoval.delete(profileKey(p.profile));this.state.error=null})}
 importReference(path:string,name:string,current=()=>true):Promise<void>{
  if(this.disposed)return Promise.resolve()
  if(this.referenceOperation)return this.referenceOperation.task
  const controller=new AbortController(),operation={controller,task:Promise.resolve()}
  this.referenceImportError=null;this.referenceOperation=operation
  operation.task=Promise.resolve().then(async()=>{
   const poll=setInterval(()=>{if(!current()||this.disposed)controller.abort()},50)
   try{const p=await this.references.import(path,name,controller.signal,()=>!this.disposed&&current());const publish=this.serial.then(()=>{this.state.profiles.push(p)});this.serial=publish.catch(()=>{});await publish}
   catch(e){if(!controller.signal.aborted&&!this.disposed&&!(e instanceof Error&&e.message==='VOICE_REFERENCE_CANCELLED'))this.referenceImportError=e instanceof Error&&/^VOICE_REFERENCE_[A-Z_]+$/.test(e.message)?e.message:'VOICE_REFERENCE_IMPORT'}
   finally{clearInterval(poll);if(this.referenceOperation===operation)this.referenceOperation=null;this.emit()}
  });this.emit();return operation.task
 }
 async cancelReferenceImport(){const operation=this.referenceOperation;if(operation){operation.controller.abort();await operation.task}}
 renameReference(profile:string,name:string,current=()=>true){const task=this.serial.then(async()=>{if(this.disposed||!current())throw Error('CHAT_SETTINGS_EXPIRED');await this.references.rename(profile,name,()=>!this.disposed&&current());const p=this.references.list().find(p=>profileKey(p)===profile);if(p)this.state.profiles=this.state.profiles.map(old=>profileKey(old)===profile?p:old);this.emit()});this.serial=task.catch(()=>{});return task}
 configure(python:string,model:string){void this.stop().catch(()=>{});return this.mutate(async()=>{await this.stop();if(this.state.executionProfile?.startsWith('mps-')||this.state.executionProfile?.startsWith('gguf-metal-'))await verifyMacInterpreter(python,this.state.executionProfile);this.config={python,model};this.state.runtimeConfigured=true;this.runtime=null;this.state.error=null})}
 enabled(value:boolean){void this.stop().catch(()=>{});return this.mutate(async()=>{await this.stop();if(value&&!this.snapshot().availableProfiles?.length)throw Error('UNSUPPORTED_DEVICE');this.state.enabled=value;this.state.status=value?'idle':'off';this.state.error=null})}
 seedSettings(value:VoiceSeedSettings,current=()=>true){if(!validSeedSettings(value))throw Error('VOICE_SEED_INVALID');return this.mutate(async()=>{if(!current())throw Error('CHAT_SETTINGS_EXPIRED');this.state.seedSettings={...value};this.state.seedError=false;if(this.state.error==='VOICE_SEED_SETTINGS')this.state.error=null})}
 auto(value:boolean){return this.mutate(async()=>{this.state.autoRead=value})}
 volume(value:number){return this.mutate(async()=>{this.state.volume=value})}
 executionProfile(value:ExecutionProfile){void this.stop().catch(()=>{});return this.mutate(async()=>{await this.stop();if(isManagedVoice(this.selectedProfile())&&this.base&&!this.base.native)this.baseExecutionProfile=value;else this.state.executionProfile=value;this.runtime=null;this.state.error=null}).then(()=>this.prepare())}
 private getRuntime(){const config:{python:string;model:string;nativeBase?:boolean;windowsBase?:boolean}=isManagedVoice(this.selectedProfile())?{python:this.base!.executable,model:this.base!.path,nativeBase:this.base!.native,windowsBase:!this.base!.native}:this.config!;if(this.runtime&&this.runtime.config?.nativeBase!==config.nativeBase){void this.runtime.stop().catch(()=>{});this.runtime=null}return this.runtime??=this.makeRuntime({...config,worker:this.worker,cacheRoot:join(this.root,'cache'),compilerCache:join(this.root,'compiler-cache'),executionProfile:this.activeProfile()})}
 private async startRuntime(profile:VoiceSnapshot['profiles'][number],runtime:TtsRuntimeSupervisor,current:()=>boolean){
  let key=profile.fingerprint+':'+this.activeProfile();const started=Date.now()
  if(!isManagedVoice(profile)){if(!current())throw Error('VOICE_CANCELLED');await runtime.start(join(this.root,'profiles',profileKey(profile)),key);return}
  try{
   let conditioning:ReferenceCondition|undefined
   if(isReferenceProfile(profile)){conditioning=await this.references.resolve(profileKey(profile));if(conditioning.fingerprint!==profile.fingerprint)throw Error('VOICE_REFERENCE_CHANGED')}
   const identity=await this.base!.identity(),lease=this.verifiedBase
   if(conditioning){conditioning={...conditioning,fingerprint:createHash('sha256').update(JSON.stringify({profile:conditioning.fingerprint,base:this.base!.profile.fingerprint,assets:identity,executionProfile:this.activeProfile()})).digest('hex')};key+=':'+conditioning.fingerprint}
   if(!current())throw Error('VOICE_CANCELLED')
   if(identity&&lease?.runtime===runtime&&lease.session===runtime.sessionId&&lease.key===key&&lease.identity===identity&&runtime.ready){
    this.diagnose({type:'base-verification',reused:true,verifyMs:0,metadataMs:Date.now()-started,session:runtime.sessionId});return
   }
   this.verifiedBase=null
   if(runtime.running)await runtime.stop()
   if(!current())throw Error('VOICE_CANCELLED')
   const verifying=Date.now();await this.base!.ready()
   const verifyMs=Date.now()-verifying
   if(!current())throw Error('VOICE_CANCELLED')
   if(identity&&identity!==await this.base!.identity())throw Error('VOICE_BASE_CHANGED')
   if(!current())throw Error('VOICE_CANCELLED')
   const loading=Date.now();await runtime.start(join(this.root,'profiles',profileKey(profile)),key,conditioning)
   if(!current())throw Error('VOICE_CANCELLED')
   if(identity&&identity!==await this.base!.identity())throw Error('VOICE_BASE_CHANGED')
   if(!current())throw Error('VOICE_CANCELLED')
   if(identity)this.verifiedBase={runtime,session:runtime.sessionId,key,identity}
   this.diagnose({type:'base-verification',reused:false,verifyMs,loadMs:Date.now()-loading,session:runtime.sessionId})
  }catch(e){this.verifiedBase=null;if(current())await runtime.stop();throw e}
 }
 prepare():Promise<void>{
  if(this.preparing)return this.preparing
  const profile=this.selectedProfile()
  if(this.disposed||this.state.seedError||!this.outputReady||!this.state.enabled||!this.configured()||!profile||(!isStreamingProfile(this.activeProfile())&&!this.activeProfile().endsWith('-complete'))||this.currentSpeech)return Promise.resolve()
  const operation=this.operation,runtime=this.getRuntime()
  this.state.status='loading';this.emit()
  const task=this.startRuntime(profile,runtime,()=>operation===this.operation&&this.outputReady&&!this.disposed&&this.state.enabled).then(()=>{
   if(operation===this.operation&&this.outputReady&&!this.disposed){this.state.status='idle';this.state.error=null;this.emit();this.diagnose({type:'preparation-ready',at:Date.now(),session:runtime.sessionId,audit:runtime.audit})}
  }).catch(e=>{if(operation===this.operation&&!this.disposed&&this.outputReady)this.error(e)}).finally(()=>{if(this.preparing===task)this.preparing=null})
  this.preparing=task;return task
 }
 bind(characterId:string,profile:string|null,current=()=>true){void this.stop().catch(()=>{});return this.mutate(async()=>{await this.stop();if(!current())throw Error('CHAT_SETTINGS_EXPIRED');this.runtime=null;if((profile===this.baseKey()||profile===null||!!profile&&referenceKey(profile))&&this.base?.native&&this.base.snapshot().supported&&!this.state.executionProfile?.startsWith('gguf-metal-'))this.state.executionProfile='gguf-metal-f16';if(profile&&!this.state.profiles.some(p=>profileKey(p)===profile))throw Error('VOICE_PROFILE');if(profile)this.state.bindings[characterId]=profile;else delete this.state.bindings[characterId];this.state.error=null})}
 private async removeFiles(profile:string){if(referenceKey(profile)){await this.references.remove(profile);return}await rm(join(this.root,'gguf-cache',profile),{recursive:true,force:true,maxRetries:3});await rm(join(this.root,'profiles',profile),{recursive:true,force:true,maxRetries:3})}
 remove(profile:string){
  if(profile===this.baseKey())throw Error('VOICE_BASE_BUILTIN')
  void this.stop().catch(e=>this.error(e))
  const task=this.serial.then(async()=>{
   if(this.disposed)return
   await this.stop()
   const found=this.state.profiles.some(v=>profileKey(v)===profile)
   if(!found&&!this.pendingRemoval.has(profile)){this.error(Error('VOICE_PROFILE'));return}
   if(found){
    const previous=structuredClone(this.state)
    this.state.profiles=this.state.profiles.filter(v=>profileKey(v)!==profile)
    for(const [id,key] of Object.entries(this.state.bindings))if(key===profile)delete this.state.bindings[id]
    this.pendingRemoval.add(profile)
    // The single commit point precedes deletion. A persisted tombstone prevents
    // a leftover folder from re-registering after deletion fails or the app exits.
    try{await this.save()}catch(e){this.state=previous;this.pendingRemoval.delete(profile);this.error(e);return}
   }
   try{await this.removeFiles(profile);this.state.error=null;this.emit()}
   catch{this.error(Error('VOICE_CLEANUP_PENDING'))}
  })
  this.serial=task.catch(()=>{});return task
 }
 cancel(){void this.stop(true,false).catch(e=>this.error(e))}
 requestStarted(id:string){
  if(this.observedRequests.has(id))return
  this.observedRequests.add(id)
  this.requestTimes.set(id,Date.now());if(this.requestTimes.size>1000)this.requestTimes.delete(this.requestTimes.keys().next().value!)
  if(this.outputReady&&!this.disposed)this.allowedRequests.add(id)
  if(this.observedRequests.size>1000){const old=this.observedRequests.values().next().value!;this.observedRequests.delete(old);this.allowedRequests.delete(old)}
 }
 private syncReplayScope(){const s=this.chat();if(this.replay.setScope(JSON.stringify([s.character?.id,s.character?.revision,s.conversation?.id,s.model,this.bindingKey(s.character?.id||'')]))){this.state.lastGeneration=undefined}}
 onChatChanged(){this.syncReplayScope();if(this.currentSpeech&&!this.currentSpeech())this.cancel()}
 completed(message:ChatMessage){
  const id=message.binding?.requestId
  const allowed=!!id&&this.allowedRequests.delete(id)
  if(!allowed||!this.outputReady||!this.state.enabled||!this.state.autoRead)return
  const key=message.id+':'+this.state.bindings[message.binding?.characterId||'']
  if(this.seen.has(key))return
  this.seen.add(key);if(this.seen.size>1000)this.seen.delete(this.seen.values().next().value!)
  void this.read(message,false,true).catch(e=>this.error(e))
 }
 readMessage(id:string,mode:'read'|'replay'|'reroll'|'reproduce'='read'){const m=this.chat().conversation?.messages.find(m=>m.id===id);if(!m)throw Error('VOICE_MESSAGE');void this.read(m,false,false,mode).catch(e=>this.error(e))}
 test(){const chat=this.chat(),character=chat.character;if(!character)throw Error('VOICE_CHARACTER');const id=randomUUID();void this.read({id,role:'assistant',status:'complete',text:'응, 듣고 있어. 지금은 어떤 이야기를 할까?',createdAt:new Date().toISOString(),binding:{characterId:character.id,revision:character.revision,conversationId:chat.conversation?.id||'',personaHash:'test',semanticHash:'test',modelId:chat.model,requestId:id,epoch:chat.epoch}},true).catch(e=>this.error(e))}
 private async read(message:ChatMessage,test=false,automatic=false,mode:'read'|'replay'|'reroll'|'reproduce'='read'){
  const requestedAt=Date.now()
  if(this.disposed||!this.outputReady||!this.state.enabled)return
  if(message.role!=='assistant'||message.status!=='complete'||!message.binding)throw Error('VOICE_MESSAGE')
  if(this.state.seedError&&mode!=='replay')throw Error('VOICE_SEED_SETTINGS')
  this.syncReplayScope()
  const seedSettings={...(this.state.seedSettings||DEFAULT_VOICE_SEED)},executionProfile=this.activeProfile()
  const before=this.chat(),source=structuredClone(message),profile=this.selectedProfile()
  if(!profile)throw Error(referenceKey(this.bindingKey(before.character?.id||''))?'VOICE_REFERENCE_UNAVAILABLE':'VOICE_NOT_INSTALLED');if(isReferenceProfile(profile)&&profile.error)throw Error(profile.error);if(mode!=='replay'&&!this.configured())throw Error(isManagedVoice(profile)?'VOICE_BASE_NOT_INSTALLED':'VOICE_RUNTIME_MISSING')
  const op=++this.operation;await this.stop(false);if(op!==this.operation||this.disposed)return
  const epoch=this.state.epoch,origin=before.character
  const current=()=>{const s=this.chat();return !this.disposed&&this.outputReady&&this.state.enabled&&op===this.operation&&epoch===this.state.epoch&&s.character?.id===source.binding!.characterId&&s.character.revision===source.binding!.revision&&s.epoch===before.epoch&&s.model===before.model&&s.conversation?.id===before.conversation?.id&&this.bindingKey(s.character.id)===profileKey(profile)&&(test||!!s.conversation?.messages.some(m=>m.id===source.id&&m.status==='complete'&&m.text===source.text))}
  if(!origin||!current())return
  this.currentSpeech=current
  let candidate:ReplayCandidate|undefined
  try {
   const plan=planSpeech(source.text,this.speechPolicy),segments=plan.segments
   this.diagnose({type:'speech-plan',policy:plan.policy,preferredLength:plan.preferredLength,segments:segments.map(({start,end,index,cutReason,readableGraphemes,tinyReason})=>({start,end,index,cutReason,readableGraphemes,tinyReason}))})
   const speechPlanFingerprint=createHash('sha256').update(JSON.stringify(plan)).digest('hex')
   const identity=await this.replayIdentity(source,profile,speechPlanFingerprint,executionProfile)
   if(!current())return
   const previousResult=this.replay.previous(source.id,identity)
   if(mode==='replay'){
    const recorded=this.replay.get(source.id,identity)
    if(!recorded){if(!previousResult)this.replay.forget(source.id);throw Error('VOICE_REPLAY_MISSING')}
    this.speechStartedAt=requestedAt;this.firstPlayback=false;this.lastPlaybackEndAt=0;this.spokenRequestAt=0
    const binding:PlaybackBinding={...source.binding!,messageId:source.id,speechEpoch:epoch,voiceProfileId:profile.id,voiceProfileVersion:profile.version,voiceFingerprint:profile.fingerprint,playbackId:randomUUID(),sourceGenerationId:recorded.plan.generationId,effectiveSeed:recorded.plan.effectiveSeed}
    this.diagnose({type:'voice-replay',generationId:recorded.plan.generationId,effectiveSeed:recorded.plan.effectiveSeed,cache:'hit'})
    const streams=new Map<number,string>(),inflight:Promise<void>[]=[]
    for(const part of recorded.parts){
     if(!current())return
     if(createHash('sha256').update(part.bytes).digest('hex')!==part.hash)throw Error('VOICE_REPLAY_CHANGED')
     const durationMs=(part.bytes.byteLength-44)/96,audio={audioId:randomUUID(),bytes:Uint8Array.from(part.bytes),durationMs,generationMs:0,rtf:0}
     if(part.stream){if(!streams.has(part.segmentIndex))streams.set(part.segmentIndex,randomUUID());inflight.push(this.enqueueChunk({...audio,...part.stream,synthesisId:streams.get(part.segmentIndex)!,firstChunkReadyMs:0},binding,part.segmentIndex));if(inflight.length>=3)await inflight.shift()}
     else{await Promise.all(inflight.splice(0));await this.playComplete(audio,binding,part.segmentIndex)}
    }
    await Promise.all(inflight)
    if(current()){this.currentSpeech=null;this.state.status='idle';this.emit()}return
   }
   if(mode==='reproduce'&&!previousResult){this.replay.forget(source.id);throw Error('VOICE_REPRODUCE_CHANGED')}
   let effectiveSeed=mode==='reproduce'?previousResult!.effectiveSeed:seedSettings.mode==='fixed'&&mode!=='reroll'?seedSettings.fixedSeed:this.chooseRandom()
   if(mode==='reroll'&&previousResult&&effectiveSeed===previousResult.effectiveSeed){
    // Uniform draw over the remaining range; production retries unbiased OS draws.
    let attempts=0;do{if(++attempts>32)throw Error('VOICE_SEED_INVALID');effectiveSeed=this.chooseRandom()}while(effectiveSeed===previousResult.effectiveSeed)
   }
   if(!validVoiceSeed(effectiveSeed))throw Error('VOICE_SEED_INVALID')
   const generation:VoiceGenerationPlan=Object.freeze({generationId:randomUUID(),effectiveSeed,seedPolicy:mode==='reroll'?'reroll':mode==='reproduce'?'reproduce':seedSettings.mode,messageId:source.id,voiceFingerprint:profile.fingerprint,speechPlanFingerprint})
   this.diagnose({type:'voice-generation',...generation,cache:'miss'})
   const runtime=this.getRuntime()
   this.speechStartedAt=requestedAt;this.spokenRequestAt=automatic?(this.requestTimes.get(source.binding!.requestId)||this.speechStartedAt):0;this.firstPlayback=false;this.lastPlaybackEndAt=0
   this.state.error=null;this.state.status=runtime.running?'synthesizing':'loading';this.emit()
   if(!current())return
   await this.startRuntime(profile,runtime,current)
   if(!current())return
   this.diagnose({type:'runtime-ready',at:Date.now(),session:runtime.sessionId,audit:runtime.audit})
   candidate=this.replay.begin(identity,generation,{runtimeFingerprint:runtime.audit?.runtimeFingerprint,modelRevision:runtime.audit?.modelRevision,sourceCommit:runtime.audit?.sourceCommit,adapterSha256:runtime.audit?.adapterSha256,referenceSha256:runtime.audit?.referenceSha256,executionProfile})
   const binding:SpeechBinding={effectiveSeed:generation.effectiveSeed,generationId:generation.generationId,...source.binding!,messageId:source.id,speechEpoch:epoch,voiceProfileId:profile.id,voiceProfileVersion:profile.version,voiceFingerprint:profile.fingerprint,runtimeSessionId:runtime.sessionId,executionProfile,...(isReferenceProfile(profile)?{conditioningFingerprint:String(runtime.audit?.conditioningFingerprint||'')}: {})}
   if(isStreamingProfile(binding.executionProfile)){
    let previous=Promise.resolve()
    for(const segment of segments){
     if(!current())return
     if(!segment.text.trim())continue
     const consumed:Promise<void>[]=[]
     this.state.status='synthesizing';this.emit()
     const result=await runtime.stream(segment.text,binding,segment.index,audio=>{
      if(!current())return Promise.reject(Error('VOICE_CANCELLED'))
      this.replay.append(candidate!,audio.bytes,segment.index,{chunkIndex:audio.chunkIndex,sampleOffset:audio.sampleOffset,sampleCount:audio.sampleCount})
      const done=this.enqueueChunk(audio,binding,segment.index);consumed.push(done);return done
     })
     if(!current())return
     this.diagnose({type:'synthesis-finished',at:Date.now(),epoch,index:segment.index,...result})
     const drained=Promise.all(consumed).then(()=>{});void drained.catch(()=>{})
     // GPU may generate only the immediate successor while its predecessor plays.
     await previous;previous=drained
    }
    await previous
   }else{
   for(const segment of segments){
    if(!current())return
    if(!segment.text.trim())continue
    this.state.status='synthesizing';this.emit()
    if(!current())return
    const audio=await runtime.synthesize(segment.text,binding,segment.index)
    if(!current())return
    this.diagnose({type:'audio-ready',at:Date.now(),epoch,index:segment.index,audioId:audio.audioId,textLength:segment.text.length,durationMs:audio.durationMs,generationMs:audio.generationMs,rtf:audio.rtf,peakAllocatedBytes:audio.peakAllocatedBytes,peakReservedBytes:audio.peakReservedBytes})
    this.replay.append(candidate!,audio.bytes,segment.index)
    await this.playComplete(audio,binding,segment.index)
   }
   }
   if(current()){this.state.lastGeneration=this.replay.publish(candidate!);candidate=undefined;this.currentSpeech=null;this.state.status='idle';this.emit()}
  }catch(e){if(current()){await this.stop(true,true,false);this.error(e)}}finally{if(candidate)this.replay.discard(candidate)}
 }
 private async replayAssets(profile:VoiceSnapshot['profiles'][number]){return new VoiceAssetIdentity(profile.fingerprint,[this.config!.model,dirname(this.worker),dirname(dirname(this.config!.python)),join(this.root,'profiles',profileKey(profile))],[{path:await realpath(this.config!.python)}]).snapshot()}
 private async replayIdentity(message:ChatMessage,profile:VoiceSnapshot['profiles'][number],speechPlan:string,execution:ExecutionProfile){
  const reference=isReferenceProfile(profile)?(await this.references.resolve(profileKey(profile))).sha256:undefined
  const assets=isManagedVoice(profile)?await this.base!.identity():await this.replayAssets(profile)
  return createHash('sha256').update(JSON.stringify({binding:message.binding,messageId:message.id,text:message.text,profile:profile.fingerprint,reference,assets,execution,speechPlan,config:isManagedVoice(profile)?null:this.config})).digest('hex')
 }
 private playComplete(audio:{audioId:string;bytes:Uint8Array;durationMs:number},binding:PlaybackBinding,segmentIndex:number){
  return new Promise<void>((resolve,reject)=>{const epoch=binding.speechEpoch,timer=setTimeout(()=>{if(this.active?.id===audio.audioId){this.active=null;reject(Error('VOICE_PLAYBACK_TIMEOUT'))}},audio.durationMs+30_000);this.active={id:audio.audioId,epoch,bytes:audio.bytes,claimed:false,resolve,reject,timer};this.state.status='playing';this.emit();this.notify({type:'audio',audioId:audio.audioId,epoch,binding,segmentIndex})})
 }
 private enqueueChunk(audio:AudioChunk,binding:PlaybackBinding,segmentIndex:number){
  if(this.chunks.size>=6||[...this.chunks.values()].reduce((n,a)=>n+a.durationMs,0)+audio.durationMs>6000)throw Error('VOICE_QUEUE_LIMIT')
  const done=new Promise<void>((resolve,reject)=>{
   const timer=setTimeout(()=>{this.chunks.delete(audio.audioId);reject(Error('VOICE_PLAYBACK_TIMEOUT'))},30_000)
   this.chunks.set(audio.audioId,{epoch:binding.speechEpoch,bytes:audio.bytes,durationMs:audio.durationMs,claimed:false,resolve,reject,timer,segmentIndex,chunkIndex:audio.chunkIndex})
   this.state.status='playing';this.emit()
   this.diagnose({type:'audio-chunk',at:Date.now(),epoch:binding.speechEpoch,index:segmentIndex,chunkIndex:audio.chunkIndex,durationMs:audio.durationMs,firstChunkReadyMs:audio.firstChunkReadyMs})
   this.notify({type:'audio',audioId:audio.audioId,epoch:binding.speechEpoch,binding,segmentIndex,stream:{synthesisId:audio.synthesisId,chunkIndex:audio.chunkIndex,sampleOffset:audio.sampleOffset,sampleCount:audio.sampleCount}})
  });void done.catch(()=>{});return done
 }
 scheduled(id:string,epoch:number,delayMs:number,gapMs:number){
  const chunk=this.chunks.get(id),active=chunk||(this.active?.id===id?this.active:null)
  if(!active?.claimed||active.epoch!==epoch||epoch!==this.state.epoch)return
  this.diagnose({type:'playback-scheduled',at:Date.now(),epoch,audioId:id,first:!this.firstPlayback,firstPlaybackMs:this.firstPlayback?undefined:Date.now()-this.speechStartedAt+delayMs,endToEndFirstAudioMs:this.firstPlayback||!this.spokenRequestAt?undefined:Date.now()-this.spokenRequestAt+delayMs,delayMs,gapMs:chunk?gapMs:this.lastPlaybackEndAt?Date.now()-this.lastPlaybackEndAt:0,index:chunk?.segmentIndex,chunkIndex:chunk?.chunkIndex})
  this.firstPlayback=true
 }
 audio(id:string,epoch:number){const a=this.chunks.get(id)||(this.active?.id===id?this.active:null);if(!a||a.epoch!==epoch||epoch!==this.state.epoch||a.claimed||!this.currentSpeech?.())throw Error('VOICE_AUDIO_EXPIRED');a.claimed=true;const bytes=a.bytes;if(this.chunks.has(id))a.bytes=new Uint8Array();return bytes}
 played(id:string,epoch:number,error=false){const a=this.chunks.get(id)||(this.active?.id===id?this.active:null);if(!a||a.epoch!==epoch)return;this.chunks.delete(id);if(this.active?.id===id)this.active=null;clearTimeout(a.timer);this.lastPlaybackEndAt=Date.now();this.diagnose({type:error?'playback-error':'playback-ended',at:Date.now(),epoch,audioId:id,claimed:a.claimed});if(error)a.reject(Error('VOICE_PLAYBACK'));else if(a.claimed)a.resolve();else a.reject(Error('VOICE_PLAYBACK_UNCLAIMED'))}
 async stop(invalidate=true,unload=true,clearReplay=invalidate&&unload){
  const stopStartedAt=Date.now()
  const hadSpeech=!!this.currentSpeech
  this.replay.discardPending()
  const verification=this.base?.cancelVerification()
  if(clearReplay){this.replay.clear();this.state.lastGeneration=undefined}
  if(invalidate)++this.operation
  ++this.state.epoch;this.currentSpeech=null
  // Revoke producer callbacks before resolving consumers. The same warm child
  // may already accept a new speech while retired final-chunk IO is completing.
  this.runtime?.retireSpeech()
  this.notify({type:'stop',epoch:this.state.epoch,requestedAt:stopStartedAt})
  this.diagnose({type:'speech-invalidated',at:Date.now(),epoch:this.state.epoch})
  if(this.active){clearTimeout(this.active.timer);this.active.resolve();this.active=null}
  for(const a of this.chunks.values()){clearTimeout(a.timer);a.resolve()}this.chunks.clear()
  this.state.status=this.state.enabled?'stopped':'off';this.emit()
  // OFF/hide/close/runtime changes still unload. Voice-only stop/replacement
  // waits for owner-thread cleanup before reusing an active streaming worker.
  try{if(this.runtime&&((invalidate&&unload)||(invalidate&&this.runtime.busy===true)||(hadSpeech&&this.runtime.busy!==false)||this.runtime.cancellationPending)){
   try{
    if(invalidate&&unload){await this.runtime.stop();this.diagnose({type:'worker-stopped',at:Date.now(),workerStopMs:Date.now()-stopStartedAt})}
    else {const result=await this.runtime.cancelSpeech();this.diagnose({type:'speech-cancelled',at:Date.now(),...result})}
   }
   catch(e){this.diagnose({type:'worker-stop-failed',at:Date.now()});this.error(e);throw e}
  }}finally{await verification}
 }
 outputStopped(epoch:number,elapsedMs:number){if(epoch===this.state.epoch)this.diagnose({type:'output-stopped',at:Date.now(),epoch,mainActionToRendererStopMs:elapsedMs})}
 async close(){this.disposed=true;this.outputReady=false;this.allowedRequests.clear();const installation=Promise.all([this.cancelInstallBase(),this.cancelReferenceImport()]);void installation.catch(()=>{});try{await this.stop()}finally{await installation;await this.serial.catch(()=>{})}}
}
