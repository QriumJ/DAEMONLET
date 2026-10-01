import {constants} from 'node:fs'
import {execFile} from 'node:child_process'
import {createHash,randomUUID} from 'node:crypto'
import {copyFile,lstat,mkdir,readFile,readdir,realpath,rename,rm,statfs,writeFile} from 'node:fs/promises'
import {dirname,isAbsolute,join,relative,resolve} from 'node:path'
import macPolicy from '../../voice/qwen-mlx-policy.json'
import windowsPolicy from '../../voice/qwen-policy.json'
import macLock from '../../voice/install-qwen-darwin-arm64.json'
import windowsLock from '../../voice/install-qwen-win32-x64.json'
import {downloadVoiceFile,type PinnedVoiceFile} from './PinnedVoiceDownload'
import {digestFile} from '../character-chat/ModelManager'
import {safeRelative} from './VoicePackage'
import {extractQwenPython} from './QwenArchive'
import type {QwenInstallState} from '../../shared/character-voice-contract'

export type QwenConnection={python:string;model:string}
export interface QwenInstallation {snapshot():QwenInstallState;initialize():Promise<void>;install(reuseModel?:string):Promise<QwenConnection|null>;cancel():Promise<void>;applying(value:boolean):void}
type ModelPolicy={engine:string;model:string;revision:string;license:string;totalBytes:number;files:Record<string,{bytes:number;sha256?:string;gitSha1?:string}>}
type InstallLock={schemaVersion:number;platform:string;python:PinnedVoiceFile & {filename:string;version:string;license:string};minimumFreeBytes:number;modelSha256:Record<string,string>;wheels:Array<PinnedVoiceFile & {name:string;version:string;filename:string;license:unknown}>}
type Options={platform?:string;policy?:ModelPolicy;lock?:InstallLock;fetch?:typeof fetch;freeBytes?:()=>Promise<number>;run?:(command:string,args:string[],signal:AbortSignal)=>Promise<string>}

export class QwenVoiceInstaller implements QwenInstallation {
 private canonicalRoot:string|null=null
 private get rootPath(){return this.canonicalRoot??this.root}
 private platform:string
 private policy:ModelPolicy
 private lock:InstallLock
 private fingerprint:string
 private operation:Promise<QwenConnection|null>|null=null
 private controller:AbortController|null=null
 private lastUpdate=0
 private state:QwenInstallState
 constructor(readonly root:string,private resources:string,private changed:()=>void,private options:Options={}){
  this.platform=options.platform??process.platform+'-'+process.arch
  this.policy=options.policy??(this.platform==='darwin-arm64'?macPolicy:windowsPolicy)
  this.lock=options.lock??(this.platform==='darwin-arm64'?macLock:windowsLock)
  this.fingerprint=createHash('sha256').update(JSON.stringify({policy:this.policy,lock:this.lock,installerVersion:1})).digest('hex')
  const total=this.assets().reduce((n,a)=>n+a.file.bytes,0)
  this.state={supported:['darwin-arm64','win32-x64'].includes(this.platform),installed:false,repairNeeded:false,phase:'idle',bytes:0,total,error:null,model:this.policy.model,modelBytes:this.policy.totalBytes,runtimeBytes:total-this.policy.totalBytes,minimumFreeBytes:this.lock.minimumFreeBytes,communityConversion:this.platform==='darwin-arm64',license:this.policy.license}
 }
 private get target(){return join(this.rootPath,this.fingerprint)}
 private connection():QwenConnection{return {python:join(this.target,'env',this.platform==='darwin-arm64'?'bin':'Scripts',this.platform==='darwin-arm64'?'python':'python.exe'),model:join(this.target,'model')}}
 snapshot(){return {...this.state}}
 private update(value:Partial<QwenInstallState>){const notify=value.phase!==undefined||value.error!==undefined||Date.now()-this.lastUpdate>150;Object.assign(this.state,value);if(notify){this.lastUpdate=Date.now();this.changed()}}
 applying(value:boolean){this.update({phase:value?'applying':'idle'})}
 private assets():Array<{name:string;file:PinnedVoiceFile}>{return [
  {name:'python.tar.gz',file:this.lock.python},...this.lock.wheels.map(w=>({name:'wheels/'+safeRelative(w.filename),file:w})),
  ...Object.entries(this.policy.files).map(([name,f])=>({name:'model/'+safeRelative(name),file:{url:`https://huggingface.co/${this.policy.model}/resolve/${this.policy.revision}/${name}`,bytes:f.bytes,sha256:this.lock.modelSha256[name as keyof typeof this.lock.modelSha256]}})),
 ]}
 private async directory(path:string,create=false){
  if(!isAbsolute(path))throw Error('QWEN_INSTALL_CHANGED')
  const ancestors=[];for(let p=resolve(path);;p=dirname(p)){ancestors.unshift(p);if(dirname(p)===p)break}
  for(const p of ancestors){let s;try{s=await lstat(p)}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT'||!create)throw e;await mkdir(p,{mode:0o700});s=await lstat(p)}
   if(s.isSymbolicLink()&&!(process.platform==='darwin'&&['/tmp','/var'].includes(p))||!s.isDirectory()&&!s.isSymbolicLink())throw Error('QWEN_INSTALL_CHANGED')
  }
  return realpath(path)
 }
 private async file(path:string,bytes?:number,sha256?:string,signal?:AbortSignal){
  await this.directory(dirname(path));const s=await lstat(path);if(!s.isFile()||s.isSymbolicLink()||bytes!==undefined&&s.size!==bytes||sha256&&await digestFile(path,signal)!==sha256)throw Error('QWEN_INSTALL_CHANGED')
 }
 private run(command:string,args:string[],signal:AbortSignal):Promise<string>{
  if(this.options.run)return this.options.run(command,args,signal)
  return new Promise((done,fail)=>{
   let closed=false,result:{error:Error|null;stdout:string}|undefined,timer:ReturnType<typeof setTimeout>|undefined
   const finish=()=>{if(!closed||!result)return;signal.removeEventListener('abort',abort);if(timer)clearTimeout(timer);if(result.error||signal.aborted)fail(Error(signal.aborted?'QWEN_INSTALL_CANCELLED':'QWEN_RUNTIME_INSTALL'));else done(result.stdout)}
   const child=execFile(command,args,{windowsHide:true,timeout:600000,maxBuffer:1024**2,env:{...process.env,PYTHONPATH:'',PYTHONNOUSERSITE:'1',PYTHONDONTWRITEBYTECODE:'1',PYTHONUTF8:'1',HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1'}},(error,stdout)=>{result={error,stdout};finish()})
   // Only this owned child, and no pip/subprocess package hooks. Wait for close
   // before deleting its stage. TERM may be ignored during native imports.
   const abort=()=>{child.kill();timer=setTimeout(()=>child.kill('SIGKILL'),2000)}
   child.once('close',()=>{closed=true;finish()});signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort()
  })
 }
 private helperArgs(){return ['-I','-B',join(this.resources,'install_qwen.py'),'--policy',join(this.resources,this.platform==='darwin-arm64'?'qwen-mlx-policy.json':'qwen-policy.json'),'--lock',join(this.resources,'install-qwen-'+this.platform+'.json')]}
 private async check(target:string,signal:AbortSignal,full:boolean){
  await this.directory(target);await this.file(join(target,'install-receipt.json'));const receipt=JSON.parse(await readFile(join(target,'install-receipt.json'),'utf8'));if(receipt.fingerprint!==this.fingerprint)throw Error('QWEN_INSTALL_CHANGED')
  await this.directory(join(target,'model'));const names=await readdir(join(target,'model'),{recursive:true});const expected=new Set(Object.keys(this.policy.files))
  for(const name of names){const path=join(target,'model',name),s=await lstat(path);if(s.isSymbolicLink()||!s.isDirectory()&&!expected.has(name.replaceAll('\\','/')))throw Error('QWEN_INSTALL_CHANGED')}
  for(const [name,f] of Object.entries(this.policy.files))await this.file(join(target,'model',name),f.bytes,full?this.lock.modelSha256[name as keyof typeof this.lock.modelSha256]:undefined,signal)
  const python=join(target,'env',this.platform==='darwin-arm64'?'bin':'Scripts',this.platform==='darwin-arm64'?'python':'python.exe');await this.file(python);await this.file(join(target,'env','qwen-runtime.json'))
  if(full){
   const archive=join(this.rootPath,'downloads',this.fingerprint,'python.tar.gz');await this.file(archive,this.lock.python.bytes,this.lock.python.sha256,signal)
   const files=await extractQwenPython(archive,target,signal,true),interpreter=files[this.platform==='darwin-arm64'?'python/bin/python3.12':'python/Lib/venv/scripts/nt/python.exe'];if(!interpreter)throw Error('QWEN_INSTALL_CHANGED');await this.file(python,interpreter.bytes,interpreter.sha256,signal)
   const base=join(target,'python',this.platform==='darwin-arm64'?'bin':'',this.platform==='darwin-arm64'?'python3.12':'python.exe')
   await this.file(join(target,'env','pyvenv.cfg'));const cfgText=await readFile(join(target,'env','pyvenv.cfg'),'utf8');if(cfgText.length>8192)throw Error('QWEN_INSTALL_CHANGED');const cfg=new Map<string,string>();for(const line of cfgText.trim().split(/\r?\n/)){const match=/^([a-z-]+) = (.*)$/.exec(line);if(!match||cfg.has(match[1]))throw Error('QWEN_INSTALL_CHANGED');cfg.set(match[1],match[2])}
   if(cfg.get('home')!==dirname(base)||cfg.get('executable')!==base||cfg.get('version')!==this.lock.python.version||cfg.get('include-system-site-packages')!=='false'||cfg.get('command')!=='managed Qwen offline installation')throw Error('QWEN_INSTALL_CHANGED')
   await this.run(base,['-I','-B','-S',...this.helperArgs().slice(2),'--audit-env',join(target,'env'),'--downloads',join(this.rootPath,'downloads',this.fingerprint)],signal)
   await this.run(python,[...this.helperArgs(),'--verify'],signal)
  }
 }
 async initialize(){if(!this.state.supported)return;try{this.canonicalRoot=await this.directory(this.root);await this.check(this.target,new AbortController().signal,false);this.state.installed=true}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')Object.assign(this.state,{repairNeeded:true,error:'QWEN_INSTALL_CHANGED'})}}
 install(reuseModel?:string):Promise<QwenConnection|null>{
  if(this.operation)return this.operation
  if(!this.state.supported)return Promise.reject(Error('QWEN_INSTALL_UNSUPPORTED'))
  const controller=this.controller=new AbortController()
  const task:Promise<QwenConnection|null>=Promise.resolve().then(async()=>{
   this.update({phase:'preparing',error:null});controller.signal.throwIfAborted()
   // Healthy existing installation: no downloads and no model/GPU load.
   if(this.state.installed){this.update({phase:'verifying'});try{await this.check(this.target,controller.signal,true);controller.signal.throwIfAborted();return this.connection()}catch(e){if(controller.signal.aborted)throw e;this.update({installed:false,repairNeeded:true})}}
   await this.prepare(controller.signal,reuseModel);controller.signal.throwIfAborted();return this.connection()
  }).then(connection=>{if(this.operation===task)this.update({installed:true,repairNeeded:false,phase:'idle',bytes:this.state.total,error:null});return connection}).catch(e=>{
   if(this.operation===task)this.update({phase:'idle',error:controller.signal.aborted?null:e instanceof Error&&/^(QWEN_|VOICE_DOWNLOAD_|VOICE_DISK_SPACE)[A-Z_]*$/.test(e.message)?e.message:'QWEN_RUNTIME_INSTALL'})
   if(controller.signal.aborted)return null;throw e
  }).finally(()=>{if(this.operation===task){this.operation=null;if(this.controller===controller)this.controller=null}})
  this.operation=task;Object.assign(this.state,{phase:'preparing',bytes:0,error:null});return task
 }
 async cancel(){this.controller?.abort();await this.operation?.catch(()=>{})}
 private async prepare(signal:AbortSignal,reuseModel?:string){
  this.canonicalRoot=await this.directory(this.root,true);signal.throwIfAborted();const disk=await statfs(this.root),free=this.options.freeBytes?await this.options.freeBytes():disk.bavail*disk.bsize;if(free<this.lock.minimumFreeBytes)throw Error('VOICE_DISK_SPACE')
  const downloads=join(this.rootPath,'downloads',this.fingerprint);await this.directory(downloads,true)
  let completed=0;this.update({phase:'downloading',bytes:0})
  for(const asset of this.assets()){
   signal.throwIfAborted();const path=join(downloads,asset.name);await this.directory(dirname(path),true)
   if(reuseModel&&asset.name.startsWith('model/')){
    const source=join(reuseModel,asset.name.slice(6));try{await this.file(source,asset.file.bytes,asset.file.sha256,signal);try{await lstat(path)}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;await copyFile(source,path,constants.COPYFILE_FICLONE)}}catch(e){if(signal.aborted)throw e;/* Optional local reuse never weakens download verification. */}
   }
   await downloadVoiceFile(path,asset.file,signal,bytes=>this.update({bytes:completed+bytes}),this.options.fetch);completed+=asset.file.bytes
  }
  const stage=join(this.rootPath,'.install-'+randomUUID());await this.directory(stage,true)
  try{
   this.update({phase:'installing'});const bootstrap=await extractQwenPython(join(downloads,'python.tar.gz'),stage,signal)
   await extractQwenPython(join(downloads,'python.tar.gz'),stage,signal,true)
   const base=join(stage,'python',this.platform==='darwin-arm64'?'bin':'',this.platform==='darwin-arm64'?'python3.12':'python.exe');const actual=await realpath(base),rel=relative(stage,actual);if(rel.startsWith('..')||isAbsolute(rel))throw Error('QWEN_ARCHIVE_PATH')
   await this.file(actual);await this.run(actual,['-I','-B','-m','venv','--without-pip','--copies',join(stage,'env')],signal)
   const python=join(stage,'env',this.platform==='darwin-arm64'?'bin':'Scripts',this.platform==='darwin-arm64'?'python':'python.exe');const interpreter=bootstrap[this.platform==='darwin-arm64'?'python/bin/python3.12':'python/Lib/venv/scripts/nt/python.exe'];if(!interpreter)throw Error('QWEN_INSTALL_CHANGED');await this.file(python,interpreter.bytes,interpreter.sha256,signal)
   await this.directory(join(stage,'model'),true)
   for(const [name,f] of Object.entries(this.policy.files)){const path=join(stage,'model',name);await this.directory(dirname(path),true);await copyFile(join(downloads,'model',name),path,constants.COPYFILE_FICLONE);await this.file(path,f.bytes,this.lock.modelSha256[name as keyof typeof this.lock.modelSha256],signal)}
   this.update({phase:'verifying'});signal.throwIfAborted()
   await this.run(python,[...this.helperArgs(),'--downloads',downloads,'--final-env',join(this.target,'env'),'--final-python',join(this.target,'python',this.platform==='darwin-arm64'?'bin':'',this.platform==='darwin-arm64'?'python3.12':'python.exe'),'--model',join(this.target,'model')],signal)
   await writeFile(join(stage,'install-receipt.json'),JSON.stringify({schemaVersion:1,fingerprint:this.fingerprint,model:this.policy.model,revision:this.policy.revision,modelSha256:this.lock.modelSha256,python:this.lock.python,wheels:this.lock.wheels})+'\n',{flag:'wx',mode:0o600})
   await this.publish(stage,signal)
  }finally{await rm(stage,{recursive:true,force:true}).catch(()=>{})}
 }
 private async publish(stage:string,signal:AbortSignal){
  signal.throwIfAborted();await this.directory(this.root);await this.directory(stage)
  let previous:string|undefined,published=false
  try{
   try{await this.directory(this.target);previous=this.target+'.previous-'+randomUUID();signal.throwIfAborted();await rename(this.target,previous)}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e}
   signal.throwIfAborted();await rename(stage,this.target);published=true
   await this.check(this.target,signal,true);signal.throwIfAborted()
  }catch(e){if(published)await rename(this.target,stage);if(previous)await rename(previous,this.target);throw e}
  // Previous managed bundle remains a recovery copy. External environments and
  // model/reference folders are never moved, removed, or rewritten.
 }
}
