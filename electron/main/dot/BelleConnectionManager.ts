import {connectionIds,restoredConnectionConfig,validRuntimeKey,type BelleConnectionConfig,type BelleConnectionSnapshot} from '../../shared/belle-connection'
export interface RuntimeCredentialStore{available():Promise<boolean>;has():Promise<boolean>;put(key:string):Promise<void>;get(signal?:AbortSignal):Promise<string>;remove():Promise<void>}
export interface RunningTunnel{stop():Promise<void>;ready():Promise<boolean>}
export interface TunnelRuntime{probe():Promise<{clientVersion:string;nodeVersion:string}>;start(config:BelleConnectionConfig,key:string,bridge:{port:number;token:string},signal:AbortSignal,onExit:()=>void):Promise<RunningTunnel>}
export interface ConnectionMetadata{load():Promise<unknown>;save(value:BelleConnectionConfig|null):Promise<void>}
const publicCodes=new Set(['STORE_UNAVAILABLE','STORE_LOCKED','STORE_DENIED','KEY_MISSING','CLIENT_MISSING','CLIENT_VERSION','NODE_MISSING','NODE_VERSION','ADAPTER_MISSING','EXTERNAL_SESSION','LOCAL_NOT_READY','CONNECTION_FAILED','SAVE_FAILED','INVALID_CONFIG','INVALID_KEY','SHUTTING_DOWN'])
export const connectionError=(e:unknown)=>e instanceof Error&&publicCodes.has(e.message)?e.message:'CONNECTION_FAILED'
/** Serial operations, immediate abort on stop, generation guards and bounded owned-child retries. */
export class BelleConnectionManager{
 private config:BelleConnectionConfig|null=null
 private value:BelleConnectionSnapshot={state:'unconfigured',config:null,credentialStored:false,secureStore:'unavailable',clientVersion:null,nodeVersion:null,error:null,retry:0,muted:true}
 private listeners=new Set<(v:BelleConnectionSnapshot)=>void>();private queue:Promise<unknown>=Promise.resolve()
 private attempt:AbortController|null=null;private running:RunningTunnel|null=null;private timer:ReturnType<typeof setTimeout>|null=null;private monitor:ReturnType<typeof setInterval>|null=null
 private closed=false;private desired=false;private generation=0;private healthBusy=false
 constructor(private options:{store:RuntimeCredentialStore;metadata:ConnectionMetadata;runtime:TunnelRuntime;bridge:{start(signal:AbortSignal):Promise<{port:number;token:string}>;stop():Promise<void>};external?:boolean;retryDelay?:(attempt:number)=>number}){}
 snapshot(){return structuredClone(this.value)}
 subscribe(listener:(v:BelleConnectionSnapshot)=>void){this.listeners.add(listener);return()=>{this.listeners.delete(listener)}}
 private emit(patch:Partial<BelleConnectionSnapshot>){this.value={...this.value,...patch,config:this.config?{...this.config}:null};for(const l of this.listeners)l(this.snapshot())}
 private serial<T>(task:()=>Promise<T>):Promise<T>{const next=this.queue.then(task,task);this.queue=next.catch(()=>{});return next}
 async initialize(){
  if(this.options.external){this.emit({state:'external'});return this.snapshot()}
  try{this.config=restoredConnectionConfig(await this.options.metadata.load());const available=await this.options.store.available();const stored=available&&await this.options.store.has();this.emit({secureStore:available?'macos-keychain':'unavailable',credentialStored:stored,state:this.options.external?'external':this.config?'disconnected':'unconfigured',error:null})}
  catch(e){this.emit({state:'error',error:connectionError(e)})}
  if(!this.options.external&&this.value.secureStore==='macos-keychain'){try{this.emit(await this.options.runtime.probe())}catch(e){this.emit({error:connectionError(e)})}}
  if(this.config?.autoConnect&&!this.options.external&&this.value.secureStore==='macos-keychain'&&this.value.credentialStored&&!this.value.error)void this.connect().catch(()=>{})
  return this.snapshot()
 }
 refresh(){return this.serial(async()=>{this.ensureOpen();if(this.options.external)return this.snapshot();const available=await this.options.store.available();const stored=available&&await this.options.store.has();this.emit({secureStore:available?'macos-keychain':'unavailable',credentialStored:stored,error:available?null:'STORE_UNAVAILABLE'});if(available){try{this.emit(await this.options.runtime.probe())}catch(e){this.emit({error:connectionError(e)})}}return this.snapshot()})}
 configure(value:{tunnelId:string;organizationId:string;key:string}){
  const ids=connectionIds(value);if(!ids||Object.keys(value).some(k=>!['tunnelId','organizationId','key'].includes(k)))return Promise.reject(Error('INVALID_CONFIG'))
  if(!validRuntimeKey(value.key))return Promise.reject(Error('INVALID_KEY'))
  // Caller has already obtained action-time consent. No secret is retained in config/state.
  return this.serial(async()=>{
   this.ensureOpen();if(this.options.external)throw Error('EXTERNAL_SESSION');if(!await this.options.store.available())throw Error('STORE_UNAVAILABLE')
   this.desired=false;this.abort();await this.cleanup()
   const previous=this.config,next:BelleConnectionConfig={...ids,autoConnect:false,consentVersion:1}
   await this.options.metadata.save(next)
   try{await this.options.store.put(value.key)}catch(e){await this.options.metadata.save(previous).catch(()=>{});throw e}finally{value.key=''}
   this.config=next;this.emit({state:'disconnected',secureStore:'macos-keychain',credentialStored:true,error:null,retry:0,muted:true});return this.snapshot()
  })
 }
 async setAutoConnect(enabled:boolean){return this.serial(async()=>{this.ensureOpen();if(typeof enabled!=='boolean'||!this.config)throw Error('INVALID_CONFIG');if(enabled&&(!await this.options.store.available()||!await this.options.store.has()))throw Error('STORE_UNAVAILABLE');const next={...this.config,autoConnect:enabled};await this.options.metadata.save(next);this.config=next;this.emit({error:null});return this.snapshot()})}
 connect(){return this.serial(async()=>{this.ensureOpen();if(this.options.external)throw Error('EXTERNAL_SESSION');if(this.running||this.desired)return this.snapshot();if(!this.config)throw Error('INVALID_CONFIG');this.desired=true;this.emit({retry:0,error:null});await this.launch();return this.snapshot()})}
 private ensureOpen(){if(this.closed)throw Error('SHUTTING_DOWN')}
 private async launch(){
  if(!this.desired||this.closed)return
  const generation=++this.generation,controller=this.attempt=new AbortController();this.emit({state:this.value.retry?'reconnecting':'checking',error:null,muted:true})
  try{
   if(!await this.options.store.available())throw Error('STORE_UNAVAILABLE')
   const versions=await this.options.runtime.probe();if(controller.signal.aborted)return;this.emit({...versions,state:'connecting'})
   let key=await this.options.store.get(controller.signal);if(!validRuntimeKey(key))throw Error('KEY_MISSING')
   try{
    const bridge=await this.options.bridge.start(controller.signal)
    const running=await this.options.runtime.start(this.config!,key,bridge,controller.signal,()=>{if(generation===this.generation&&this.desired&&!this.closed){this.abort();void this.serial(()=>this.lost())}})
    if(controller.signal.aborted||generation!==this.generation){await running.stop();return}
    this.running=running
   }finally{key=''}
   this.emit({state:'ready',credentialStored:true,error:null})
   this.monitor=setInterval(()=>{if(this.healthBusy||!this.running)return;this.healthBusy=true;const current=this.running;void current.ready().then(ready=>{if(current===this.running&&generation===this.generation)this.emit({state:ready?'ready':'reconnecting'})}).catch(()=>{if(current===this.running)this.emit({state:'reconnecting'})}).finally(()=>{this.healthBusy=false})},5000)
   this.monitor.unref?.()
  }catch(e){if(!controller.signal.aborted&&generation===this.generation){await this.cleanup();this.emit({state:'error',error:connectionError(e)});this.scheduleRetry()}else await this.cleanup()}
 }
 private scheduleRetry(){
  if(!this.desired||this.closed)return
  // Locked/denied storage, invalid dependencies and auth readiness failures need user action.
  if(this.value.error!=='CONNECTION_FAILED'||this.value.retry>=3){this.desired=false;return}
  this.emit({state:'reconnecting',retry:this.value.retry+1});const generation=this.generation
  this.timer=setTimeout(()=>{this.timer=null;if(generation===this.generation&&this.desired&&!this.closed)void this.serial(()=>this.launch())},this.options.retryDelay?.(this.value.retry)??1000*2**(this.value.retry-1));this.timer.unref?.()
 }
 private async lost(){await this.cleanup();if(!this.desired||this.closed)return;this.emit({state:'error',error:'CONNECTION_FAILED'});this.scheduleRetry()}
 private abort(){this.generation++;this.attempt?.abort();this.attempt=null;if(this.timer)clearTimeout(this.timer);this.timer=null;if(this.monitor)clearInterval(this.monitor);this.monitor=null}
 private async cleanup(){const running=this.running;this.running=null;if(this.monitor)clearInterval(this.monitor);this.monitor=null;await running?.stop();await this.options.bridge.stop()}
 disconnect(){this.desired=false;this.abort();return this.serial(async()=>{await this.cleanup();if(this.config?.autoConnect){const next={...this.config,autoConnect:false};await this.options.metadata.save(next);this.config=next}this.emit({state:this.options.external?'external':this.config?'disconnected':'unconfigured',error:null,retry:0,muted:true});return this.snapshot()})}
 forget(){this.desired=false;this.abort();return this.serial(async()=>{this.ensureOpen();if(this.options.external)throw Error('EXTERNAL_SESSION');await this.cleanup();await this.options.store.remove();await this.options.metadata.save(null);this.config=null;this.emit({state:'unconfigured',credentialStored:false,error:null,retry:0,muted:true});return this.snapshot()})}
 async close(){this.closed=true;this.desired=false;this.abort();await this.serial(()=>this.cleanup());this.listeners.clear()}
}
