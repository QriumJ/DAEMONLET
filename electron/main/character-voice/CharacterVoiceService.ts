import {mkdir,readdir,readFile,rm,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import type {ChatMessage,LocalChatSnapshot} from '../../shared/character-chat-contract'
import {speechSegments,type SpeechBinding,type VoiceEvent,type VoiceSnapshot} from '../../shared/character-voice-contract'
import {importVoicePackage,profileKey,SELECTED_VOICE,verifyVoicePackage} from './VoicePackage'
import {TtsRuntimeSupervisor,type TtsConfig} from './TtsRuntimeSupervisor'
import {replaceFile} from '../character-chat/replaceFile'

export class CharacterVoiceService {
 private state:VoiceSnapshot={epoch:0,enabled:false,autoRead:true,volume:0.8,profiles:[],bindings:{},status:'off',error:null,runtimeConfigured:false}
 private config:{python:string;model:string}|null=null
 private runtime:TtsRuntimeSupervisor|null=null
 private serial:Promise<unknown>=Promise.resolve()
 private operation=0
 private seen=new Set<string>()
 private active:{id:string;epoch:number;bytes:Uint8Array;claimed:boolean;resolve:()=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>}|null=null
 private disposed=false
 private currentSpeech:(()=>boolean)|null=null
 constructor(readonly root:string,private worker:string,private chat:()=>LocalChatSnapshot,private changed:(state:VoiceSnapshot)=>void,private event:(event:VoiceEvent)=>void,private makeRuntime:(config:TtsConfig)=>TtsRuntimeSupervisor=config=>new TtsRuntimeSupervisor(config),private diagnostic:(value:Record<string,unknown>)=>void=()=>{}){}
 snapshot(){return structuredClone(this.state)}
 private emit(){this.changed(this.snapshot())}
 async initialize(){
  try {
   await mkdir(join(this.root,'profiles'),{recursive:true})
   // Previous process owns no active cache after an app restart.
   await rm(join(this.root,'cache'),{recursive:true,force:true,maxRetries:2}).catch(()=>{})
   try{const saved=JSON.parse(await readFile(join(this.root,'settings.json'),'utf8'))
    if(saved.version!==1||typeof saved.enabled!=='boolean'||typeof saved.autoRead!=='boolean'||!Number.isFinite(saved.volume)||saved.volume<0||saved.volume>1||!saved.bindings||typeof saved.bindings!=='object'||Array.isArray(saved.bindings))throw Error('VOICE_SETTINGS')
    this.state.enabled=saved.enabled;this.state.autoRead=saved.autoRead;this.state.volume=saved.volume
    this.state.bindings=Object.fromEntries(Object.entries(saved.bindings).filter(([k,v])=>k.length<=80&&typeof v==='string'&&v.length<=170)) as Record<string,string>
    if(saved.runtime&&typeof saved.runtime.python==='string'&&typeof saved.runtime.model==='string'){this.config=saved.runtime;this.state.runtimeConfigured=true}
   }catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw Error('VOICE_SETTINGS')}
   for(const entry of await readdir(join(this.root,'profiles'),{withFileTypes:true}))if(entry.isDirectory()&&!entry.name.startsWith('.')){
    const p=await verifyVoicePackage(join(this.root,'profiles',entry.name),SELECTED_VOICE)
    if(entry.name!==profileKey(p.profile))throw Error('VOICE_PROFILE_PATH')
    this.state.profiles.push(p.profile)
   }
   for(const [character,key] of Object.entries(this.state.bindings))if(!this.state.profiles.some(p=>profileKey(p)===key))delete this.state.bindings[character]
   this.state.status=this.state.enabled?'idle':'off';this.emit()
  }catch{this.error(Error('VOICE_STORAGE'))}
 }
 private async save(){
  await mkdir(this.root,{recursive:true});const temp=join(this.root,'settings-'+randomUUID()+'.tmp')
  try{await writeFile(temp,JSON.stringify({version:1,enabled:this.state.enabled,autoRead:this.state.autoRead,volume:this.state.volume,bindings:this.state.bindings,runtime:this.config})+'\n',{flag:'wx'});await replaceFile(temp,join(this.root,'settings.json'))}
  finally{await rm(temp,{force:true}).catch(()=>{})}
 }
 private mutate(work:()=>Promise<void>){const task=this.serial.then(async()=>{if(this.disposed)return;const previous=this.snapshot(),config=this.config;try{await work();await this.save();this.emit()}catch(e){this.state={...previous,epoch:this.state.epoch};this.config=config;this.error(e)}});this.serial=task.catch(()=>{});return task}
 error(e:unknown){this.state.error=e instanceof Error&&/^[A-Z_]{1,80}$/.test(e.message)?e.message:'VOICE_ERROR';this.state.status='error';this.emit()}
 async importPackage(path:string){return this.mutate(async()=>{const p=await importVoicePackage(path,join(this.root,'profiles'),SELECTED_VOICE);if(!this.state.profiles.some(v=>profileKey(v)===profileKey(p.profile)))this.state.profiles.push(p.profile);this.state.error=null})}
 configure(python:string,model:string){void this.stop().catch(()=>{});return this.mutate(async()=>{await this.stop();this.config={python,model};this.state.runtimeConfigured=true;this.runtime=null;this.state.error=null})}
 enabled(value:boolean){void this.stop().catch(()=>{});return this.mutate(async()=>{await this.stop();this.state.enabled=value;this.state.status=value?'idle':'off';this.state.error=null})}
 auto(value:boolean){return this.mutate(async()=>{this.state.autoRead=value})}
 volume(value:number){return this.mutate(async()=>{this.state.volume=value})}
 bind(characterId:string,profile:string|null){void this.stop().catch(()=>{});return this.mutate(async()=>{await this.stop();if(profile&&!this.state.profiles.some(p=>profileKey(p)===profile))throw Error('VOICE_PROFILE');if(profile)this.state.bindings[characterId]=profile;else delete this.state.bindings[characterId];this.state.error=null})}
 remove(profile:string){void this.stop().catch(()=>{});return this.mutate(async()=>{
  await this.stop();const p=this.state.profiles.find(v=>profileKey(v)===profile);if(!p)throw Error('VOICE_PROFILE')
  const previous=this.snapshot();this.state.profiles=this.state.profiles.filter(v=>v!==p);for(const [id,key] of Object.entries(this.state.bindings))if(key===profile)delete this.state.bindings[id]
  // Persist unbinding before touching package bytes. Failure preserves the package.
  try{await this.save()}catch(e){this.state=previous;throw e}
  await rm(join(this.root,'profiles',profile),{recursive:true,force:true,maxRetries:3})
 })}
 cancel(){void this.stop(true,false).catch(e=>this.error(e))}
 onChatChanged(){if(this.currentSpeech&&!this.currentSpeech())this.cancel()}
 completed(message:ChatMessage){if(this.state.enabled&&this.state.autoRead){const key=message.id+':'+this.state.bindings[message.binding?.characterId||''];if(this.seen.has(key))return;this.seen.add(key);if(this.seen.size>1000)this.seen.delete(this.seen.values().next().value!);void this.read(message).catch(e=>this.error(e))}}
 readMessage(id:string){const m=this.chat().conversation?.messages.find(m=>m.id===id);if(!m)throw Error('VOICE_MESSAGE');void this.read(m).catch(e=>this.error(e))}
 test(){const chat=this.chat(),character=chat.character;if(!character)throw Error('VOICE_CHARACTER');const id=randomUUID();void this.read({id,role:'assistant',status:'complete',text:'응, 듣고 있어. 지금은 어떤 이야기를 할까?',createdAt:new Date().toISOString(),binding:{characterId:character.id,revision:character.revision,conversationId:chat.conversation?.id||'',personaHash:'test',semanticHash:'test',modelId:chat.model,requestId:id,epoch:chat.epoch}},true).catch(e=>this.error(e))}
 private async read(message:ChatMessage,test=false){
  if(this.disposed||!this.state.enabled)return
  if(message.role!=='assistant'||message.status!=='complete'||!message.binding)throw Error('VOICE_MESSAGE')
  const before=this.chat(),source=structuredClone(message),profile=this.state.profiles.find(p=>profileKey(p)===this.state.bindings[before.character?.id||''])
  if(!profile)throw Error('VOICE_NOT_INSTALLED');if(!this.config)throw Error('VOICE_RUNTIME_MISSING')
  const op=++this.operation;await this.stop(false);if(op!==this.operation||this.disposed)return
  const epoch=this.state.epoch,origin=before.character
  const current=()=>{const s=this.chat();return !this.disposed&&this.state.enabled&&op===this.operation&&epoch===this.state.epoch&&s.character?.id===source.binding!.characterId&&s.character.revision===source.binding!.revision&&s.epoch===before.epoch&&s.model===before.model&&s.conversation?.id===before.conversation?.id&&this.state.bindings[s.character.id]===profileKey(profile)&&(test||!!s.conversation?.messages.some(m=>m.id===source.id&&m.status==='complete'&&m.text===source.text))}
  if(!origin||!current())return
  this.currentSpeech=current
  try {
   const segments=speechSegments(source.text)
   this.runtime??=this.makeRuntime({...this.config,worker:this.worker,cacheRoot:join(this.root,'cache')})
   const runtime=this.runtime
   this.state.error=null;this.state.status=runtime.running?'synthesizing':'loading';this.emit()
   await runtime.start(join(this.root,'profiles',profileKey(profile)),profile.fingerprint)
   if(!current())return
   this.diagnostic({type:'runtime-ready',at:Date.now(),session:runtime.sessionId,audit:runtime.audit})
   const binding:SpeechBinding={...source.binding!,messageId:source.id,speechEpoch:epoch,voiceProfileId:profile.id,voiceProfileVersion:profile.version,voiceFingerprint:profile.fingerprint,runtimeSessionId:runtime.sessionId}
   for(const segment of segments){
    if(!current())return
    if(!segment.text.trim())continue
    this.state.status='synthesizing';this.emit()
    const audio=await runtime.synthesize(segment.text,binding,segment.index)
    if(!current())return
    this.diagnostic({type:'audio-ready',at:Date.now(),epoch,index:segment.index,audioId:audio.audioId,textLength:segment.text.length,durationMs:audio.durationMs,generationMs:audio.generationMs,rtf:audio.rtf,peakAllocatedBytes:audio.peakAllocatedBytes,peakReservedBytes:audio.peakReservedBytes})
    // Backpressure: only one bounded WAV exists; next synthesis follows playback ack.
    await new Promise<void>((resolve,reject)=>{
     const timer=setTimeout(()=>{if(this.active?.id===audio.audioId){this.active=null;reject(Error('VOICE_PLAYBACK_TIMEOUT'))}},audio.durationMs+30_000)
     this.active={id:audio.audioId,epoch,bytes:audio.bytes,claimed:false,resolve,reject,timer}
     this.state.status='playing';this.emit();this.event({type:'audio',audioId:audio.audioId,epoch,binding,segmentIndex:segment.index})
    })
   }
   if(current()){this.currentSpeech=null;this.state.status='idle';this.emit()}
  }catch(e){if(current()){await this.stop();this.error(e)}}
 }
 audio(id:string,epoch:number){const a=this.active;if(!a||a.id!==id||a.epoch!==epoch||epoch!==this.state.epoch||a.claimed||!this.currentSpeech?.())throw Error('VOICE_AUDIO_EXPIRED');a.claimed=true;return a.bytes}
 played(id:string,epoch:number,error=false){const a=this.active;if(!a||a.id!==id||a.epoch!==epoch)return;this.active=null;clearTimeout(a.timer);this.diagnostic({type:error?'playback-error':'playback-ended',at:Date.now(),epoch,audioId:id,claimed:a.claimed});if(error)a.reject(Error('VOICE_PLAYBACK'));else if(a.claimed)a.resolve();else a.reject(Error('VOICE_PLAYBACK_UNCLAIMED'))}
 async stop(invalidate=true,unload=true){
  const hadSpeech=!!this.currentSpeech
  if(invalidate)++this.operation
  ++this.state.epoch;this.currentSpeech=null
  this.event({type:'stop',epoch:this.state.epoch})
  this.diagnostic({type:'speech-invalidated',at:Date.now(),epoch:this.state.epoch})
  if(this.active){clearTimeout(this.active.timer);this.active.resolve();this.active=null}
  this.state.status=this.state.enabled?'stopped':'off';this.emit()
  // Stop only a busy worker. Warm idle workers survive normal completion, not OFF/close.
  if(this.runtime&&((invalidate&&unload)||hadSpeech))await this.runtime.stop()
 }
 async close(){this.disposed=true;await this.stop();await this.serial.catch(()=>{})}
}
