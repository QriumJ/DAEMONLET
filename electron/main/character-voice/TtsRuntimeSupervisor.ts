import {spawn,type ChildProcessWithoutNullStreams,type SpawnOptionsWithoutStdio} from 'node:child_process'
import {randomUUID} from 'node:crypto'
import {join,isAbsolute} from 'node:path'
import {mkdir,mkdtemp,readFile,lstat,rm} from 'node:fs/promises'
import type {SpeechBinding} from '../../shared/character-voice-contract'

export type TtsConfig={python:string;model:string;worker:string;cacheRoot:string}
export type SpawnWorker=(command:string,args:string[],options:SpawnOptionsWithoutStdio)=>ChildProcessWithoutNullStreams
export type AudioResult={audioId:string;bytes:Uint8Array;durationMs:number;generationMs:number;rtf:number;peakAllocatedBytes?:number;peakReservedBytes?:number}
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
 private pending:{id:string;expected:string;resolve:(v:any)=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>}|null=null
 private starting:Promise<void>|null=null
 private revision=0
 audit:Record<string,unknown>|null=null
 constructor(readonly config:TtsConfig,private timeoutMs=180_000,private spawnProcess:SpawnWorker=spawn){}
 get running(){return !!this.child}
 private call(type:string,expected:string,data:object={}) {
  if(!this.child||this.pending)return Promise.reject(Error('VOICE_WORKER_BUSY'))
  return new Promise<any>((resolve,reject)=>{
   const id=randomUUID(),timer=setTimeout(()=>{this.fail(Error('VOICE_TIMEOUT'));void this.stop().catch(()=>{})},this.timeoutMs)
   this.pending={id,expected,resolve,reject,timer}
   this.child!.stdin.write(JSON.stringify({protocolVersion:1,type,requestId:id,...data})+'\n',error=>{if(error)this.fail(Error('VOICE_WORKER_IO'))})
  })
 }
 private fail(error:Error){const p=this.pending;this.pending=null;if(p){clearTimeout(p.timer);p.reject(error)}}
 async start(packagePath:string,fingerprint:string) {
  if(this.ending)await this.ending
  if(this.starting){await this.starting.catch(()=>{});if(this.key===fingerprint)return;if(this.ending)await this.ending}
  if(this.child&&this.key===fingerprint)return
  if(this.child)await this.stop()
  const task=this.launch(packagePath,fingerprint,this.revision);this.starting=task
  try{await task}finally{if(this.starting===task)this.starting=null}
 }
 private async launch(packagePath:string,fingerprint:string,revision:number) {
  for(const p of [this.config.python,this.config.model,this.config.worker,this.config.cacheRoot])if(!isAbsolute(p))throw Error('VOICE_RUNTIME_CONFIG')
  await mkdir(this.config.cacheRoot,{recursive:true});const cache=await mkdtemp(join(this.config.cacheRoot,'session-'))
  if(revision!==this.revision){await rm(cache,{recursive:true,force:true});throw Error('VOICE_CANCELLED')}
  this.cache=cache;this.sessionId=randomUUID()
  const child=this.child=this.spawnProcess(this.config.python,['-B','-u',this.config.worker],{cwd:this.cache,windowsHide:true,shell:false,stdio:['pipe','pipe','pipe'],env:{...process.env,PYTHONPATH:'',PYTHONNOUSERSITE:'1',PYTHONDONTWRITEBYTECODE:'1',PYTHONUTF8:'1',HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1',HF_HOME:join(this.cache,'hf'),TORCH_HOME:join(this.cache,'torch'),NUMBA_CACHE_DIR:join(this.cache,'numba'),TEMP:this.cache,TMP:this.cache}})
  this.exit=new Promise(resolve=>{child.once('close',()=>{if(this.child===child){this.child=null;this.key='';this.fail(Error('VOICE_WORKER_EXIT'))}resolve()});child.once('error',()=>{this.fail(Error('VOICE_WORKER_START'))})})
  child.stdin.on('error',()=>this.fail(Error('VOICE_WORKER_IO')))
  let buffer=''
  child.stdout.setEncoding('utf8');child.stdout.on('data',(chunk:string)=>{
   if(this.child!==child)return
   buffer+=chunk
   if(buffer.length>65536){this.fail(Error('VOICE_PROTOCOL_LIMIT'));void this.stop().catch(()=>{});return}
   while(buffer.includes('\n')){const index=buffer.indexOf('\n'),line=buffer.slice(0,index);buffer=buffer.slice(index+1)
    try {const v=JSON.parse(line),p=this.pending
     if(v.protocolVersion!==1||!p||v.requestId!==p.id)throw Error('VOICE_PROTOCOL')
     if(v.type==='synthesis-started'&&p.expected==='audio-ready')continue
     if(v.type==='error'){this.fail(Error(typeof v.code==='string'&&/^[A-Z_]{1,60}$/.test(v.code)?v.code:'VOICE_WORKER_ERROR'));void this.stop().catch(()=>{});return}
     if(v.type!==p.expected)throw Error('VOICE_PROTOCOL')
     this.pending=null;clearTimeout(p.timer);p.resolve(v)
    }catch{this.fail(Error('VOICE_PROTOCOL'));void this.stop().catch(()=>{});return}
   }
  })
  // Drain, but never persist upstream text/path logs by default.
  child.stderr.on('data',()=>{})
  try {this.audit=await this.call('init','ready',{package:packagePath,model:this.config.model,cache:this.cache});if(this.child!==child)throw Error('VOICE_CANCELLED');this.key=fingerprint}
  catch(e){await this.stop();throw e}
 }
 async synthesize(text:string,binding:SpeechBinding,segmentIndex:number):Promise<AudioResult> {
  const audioId=randomUUID(),cache=this.cache
  if(!cache||binding.runtimeSessionId!==this.sessionId)throw Error('VOICE_SESSION')
  const result=await this.call('synthesize','audio-ready',{audioId,text,binding,segmentIndex,style:null})
  if(result.audioId!==audioId||result.segmentIndex!==segmentIndex||JSON.stringify(result.binding)!==JSON.stringify(binding)||cache!==this.cache)throw Error('VOICE_AUDIO_BINDING')
  const path=join(cache,audioId+'.wav')
  try {const stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>5_800_000)throw Error('VOICE_INVALID_WAV');const bytes=await readFile(path),durationMs=verifyWav(bytes);return {audioId,bytes,durationMs,generationMs:result.generationMs,rtf:result.rtf,peakAllocatedBytes:result.peakAllocatedBytes,peakReservedBytes:result.peakReservedBytes}}
  finally {await rm(path,{force:true}).catch(()=>{})}
 }
 stop():Promise<void> {
  ++this.revision
  if(this.ending)return this.ending
  this.fail(Error('VOICE_CANCELLED'));this.key=''
  const child=this.child,exited=this.exit,cache=this.cache
  const task=(async()=>{
   if(child){
    // Windows venv launchers can have a Python child. Kill only this owned tree.
    if(process.platform==='win32'&&child.pid&&child.exitCode===null){
     await new Promise<void>((resolve,reject)=>{
      const killer=spawn('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,shell:false,stdio:'ignore',timeout:5000})
      killer.once('error',()=>reject(Error('VOICE_WORKER_STOP')))
      killer.once('exit',code=>{if(code===0||child.exitCode!==null)resolve();else reject(Error('VOICE_WORKER_STOP'))})
     })
    }else child.kill()
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
