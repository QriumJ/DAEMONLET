import {nativeDiagnosticReader,type TunnelDiagnosticSink} from './BelleTunnelDiagnostics'
import {spawn,execFile,type ChildProcess} from 'node:child_process'
import {promisify} from 'node:util'
import {access,readFile,writeFile,mkdtemp,rm,stat} from 'node:fs/promises'
import {homedir,tmpdir} from 'node:os'
import {dirname,join} from 'node:path'
import type {BelleConnectionConfig} from '../../shared/belle-connection'
import type {TunnelRuntime,RunningTunnel} from './BelleConnectionManager'
import {OwnedTunnelCleanupError} from './OwnedTunnelCleanupError'
const exec=promisify(execFile)
/** Never inherits API keys, proxy/CA overrides, raw logging flags or the user's helper state. */
export function tunnelBaseEnv(source:NodeJS.ProcessEnv=process.env){const env:NodeJS.ProcessEnv={};for(const key of ['HOME','USER','LOGNAME','LANG','LC_ALL','TMPDIR','SystemRoot','WINDIR','TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA'])if(source[key])env[key]=source[key];return env}
export function clientVersion(value:string){const match=value.trim().match(/^(\d+)\.(\d+)\.(\d+)(?:[+\s-]|$)/);if(!match)return null;const [,a,b,c]=match.map(Number);return a>0||b>0||c>=14?match[0].trim().replace(/[+-]$/,''):null}
export function nodeVersion(value:string){const match=value.trim().match(/^v(\d+)\.(\d+)\.(\d+)$/);if(!match)return null;return +match[1]>22||+match[1]===22&&+match[2]>=13?value.trim():null}
export function windowsPathEntries(value:string){return value.split(';').map(entry=>{
 const trimmed=entry.trim();return trimmed.startsWith('"')&&trimmed.endsWith('"')?trimmed.slice(1,-1):trimmed
}).filter(entry=>entry.length>0&&!/["\0]/.test(entry))}
const abort=()=>Error('CONNECTION_FAILED')
export async function stopOwnedTunnel(child:ChildProcess,platform=process.platform){
 if(platform==='win32'){
  // EOF asks the native supervisor to close its Job. Killing the supervisor also closes its only Job handle.
  child.stdin?.end();
  const alive=()=>child.exitCode===null&&child.signalCode===null;
  const wait=()=>new Promise<void>(resolve=>{
   let timer:ReturnType<typeof setTimeout>;
   const done=()=>{clearTimeout(timer);child.removeListener('exit',done);resolve()};
   timer=setTimeout(done,3000);child.once('exit',done);if(!alive())done();
  });
  if(alive())await wait();
  if(alive()){try{child.kill()}catch{}await wait()}
  if(alive())throw abort();
  return
 }
 if(!child.pid)return
 const pid=child.pid,kill=(signal:NodeJS.Signals)=>{try{process.kill(-pid,signal)}catch{try{child.kill(signal)}catch{}}}
 // Each client is a new POSIX process group; stdio adapter descendants die with it.
 const exited=child.exitCode!==null||child.signalCode!==null
 kill('SIGTERM')
 if(!exited)await Promise.race([new Promise<void>(r=>child.once('exit',()=>r())),new Promise<void>(r=>setTimeout(r,3000))])
 kill('SIGKILL')
 if(child.exitCode===null&&child.signalCode===null)await Promise.race([new Promise<void>(r=>child.once('exit',()=>r())),new Promise<void>(r=>setTimeout(r,1000))])
}
/** Native OS secure store and app-owned process lifetime; unsupported platforms fail closed. */
export class BelleTunnelRuntime implements TunnelRuntime{
 private client='';private node=''
 constructor(private adapter:string,private platform=process.platform,private base=tunnelBaseEnv(),private paths?:{client:string;node:string;supervisor?:string;host?:string},private diagnostic?:TunnelDiagnosticSink){}
 private async executable(candidates:string[],missing:string){for(const path of candidates){try{const s=await stat(path);if(s.isFile()){await access(path,this.platform==='win32'?0:1);return path}}catch{}}throw Error(missing)}
 private windowsHost(){return this.paths?.host??join(dirname(this.adapter),'../native/DaemonletBelleTunnelHost.exe')}
 private windowsCandidates(name:string){const local=process.env.LOCALAPPDATA??'',program=process.env.ProgramFiles??'C:\\Program Files';return [join(homedir(),'.local/bin',name),join(local,'Programs/tunnel-client',name),join(program,name==='node.exe'?'nodejs':'tunnel-client',name),...windowsPathEntries(process.env.PATH??'').map(p=>join(p,name))]}
 private supervisor(){return this.paths?.supervisor??join(dirname(this.adapter),'belle-tunnel-supervisor.mjs')}
 async probe(){
  if(this.platform!=='darwin'&&this.platform!=='win32')throw Error('STORE_UNAVAILABLE')
  this.client=await this.executable(this.paths?[this.paths.client]:this.platform==='win32'?[...this.windowsCandidates('tunnel-client-runtime.exe'),...this.windowsCandidates('tunnel-client.exe')]:['/opt/homebrew/bin/tunnel-client','/usr/local/bin/tunnel-client',join(homedir(),'.local/bin/tunnel-client')],'CLIENT_MISSING')
  this.node=await this.executable(this.paths?[this.paths.node]:this.platform==='win32'?this.windowsCandidates('node.exe'):['/opt/homebrew/bin/node','/usr/local/bin/node',join(homedir(),'.local/bin/node')],'NODE_MISSING')
  try{await access(this.adapter);await access(this.platform==='win32'?this.windowsHost():this.supervisor())}catch{throw Error('ADAPTER_MISSING')}
  const options={env:this.base,timeout:5000,maxBuffer:65536,windowsHide:true}
  let clientOutput,nodeOutput,help
  try{[clientOutput,nodeOutput,help]=await Promise.all([exec(this.client,['--version'],options),exec(this.node,['--version'],options),exec(this.client,['run','--help'],options)])}catch{throw Error('CLIENT_VERSION')}
  const cv=clientVersion(clientOutput.stdout),nv=nodeVersion(nodeOutput.stdout)
  if(!cv||!['--health.url-file','--health.listen-addr','--mcp.stdio-send-initialized-notification'].every(flag=>(help.stdout+help.stderr).includes(flag)))throw Error('CLIENT_VERSION')
  if(!nv)throw Error('NODE_VERSION')
  return {clientVersion:cv,nodeVersion:nv}
 }
 async start(config:BelleConnectionConfig,key:string,bridge:{port:number;token:string},signal:AbortSignal,onExit:()=>void):Promise<RunningTunnel>{
  if((this.platform!=='darwin'&&this.platform!=='win32')||!this.client||!this.node)throw Error('CLIENT_MISSING')
  if(signal.aborted)throw abort()
  const began=Date.now();let phase=1;const record=(fields:Partial<{http:number;exit:number;code:number}>={})=>{try{this.diagnostic?.({source:2,phase,elapsedMs:Math.min(3600000,Date.now()-began),...fields})}catch{}}
  record();let work:string
  try{work=await mkdtemp(join(tmpdir(),'daemonlet-belle-connection-'))}catch{record({code:1});key='';throw abort()}
  const profile=join(work,'client.yaml'),health=join(work,'health.url')
  let child:ChildProcess|null=null,stopped=false,settled=false,healthUrl='',stopPromise:Promise<void>|null=null
  const stop=()=>stopPromise??=(async()=>{stopped=true;signal.removeEventListener('abort',onAbort);if(child)await stopOwnedTunnel(child,this.platform);await rm(work,{recursive:true,force:true})})().catch(e=>{stopPromise=null;throw e})
  const onAbort=()=>{void stop().catch(()=>{})}
  const quote=(v:string)=>"'"+v.replaceAll("'","'\\''")+"'"
  // The key never reaches the stdio adapter environment. Paths originate in Main, never the renderer.
  const windowsQuote=(v:string)=>{if(/[\0\r\n"%!&|<>^]/.test(v))throw abort();return '"'+v.replaceAll('\\','/')+'"'}
  const command=()=>this.platform==='win32'?windowsQuote(this.windowsHost())+' --adapter '+windowsQuote(this.node)+' '+windowsQuote(this.adapter):'/usr/bin/env -u CONTROL_PLANE_API_KEY -u OPENAI_API_KEY '+quote(this.node)+' '+quote(this.adapter)
  try{
   phase=2;record();await writeFile(profile,JSON.stringify({config_version:1,control_plane:{base_url:'https://api.openai.com',tunnel_id:config.tunnelId,api_key:'env:CONTROL_PLANE_API_KEY',organization_id:config.organizationId},health:{listen_addr:'127.0.0.1:0',url_file:health},admin_ui:{open_browser:false},log:{level:'error',format:'json'},mcp:{commands:[{channel:'main',command:command()}]}}),{mode:0o600,flag:'wx'})
   if(signal.aborted)throw abort()
   phase=3;record();child=this.platform==='win32'?spawn(this.windowsHost(),[this.client,profile,config.organizationId,...(this.diagnostic?['--numeric-diagnostics']:[])],{env:{...this.base,CONTROL_PLANE_API_KEY:key,DAEMONLET_DOT_PORT:String(bridge.port),DAEMONLET_DOT_TOKEN:bridge.token},stdio:['pipe',this.diagnostic?'pipe':'ignore','ignore'],windowsHide:true}):spawn(this.node,[this.supervisor(),this.client,profile,config.organizationId],{env:{...this.base,CONTROL_PLANE_API_KEY:key,DAEMONLET_DOT_PORT:String(bridge.port),DAEMONLET_DOT_TOKEN:bridge.token},stdio:['pipe','ignore','ignore'],detached:true,windowsHide:true})
   key='';if(this.diagnostic&&child.stdout)child.stdout.on('data',nativeDiagnosticReader(this.diagnostic));let failed=false
   child.stdin?.on('error',()=>{record({code:2});failed=true})
   child.on('error',()=>{record({code:3});failed=true;if(settled&&!stopped)onExit()})
   child.on('exit',code=>{record({...(code!==null&&code>=0?{exit:code>>>0}:{}),code:4});failed=true;if(settled&&!stopped)onExit()})
   signal.addEventListener('abort',onAbort,{once:true});if(signal.aborted)throw abort()
   phase=4;record();let lastHttp=0
   const ready=async()=>{
    if(stopped||failed||signal.aborted)return false
    if(!healthUrl){try{const b=await readFile(health);if(b.length>256)return false;const value=b.toString('utf8').trim();if(!/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}\/?$/.test(value)||+new URL(value).port>65535)return false;healthUrl=value.replace(/\/$/,'');phase=5;record()}catch{return false}}
    try{const response=await fetch(healthUrl+'/readyz',{redirect:'error',signal:AbortSignal.timeout(2000)});await response.body?.cancel();if(response.status!==lastHttp){lastHttp=response.status;record({http:response.status})}return response.status===200||response.status===204}catch{return false}
   }
   for(let i=0;i<90;i++){if(signal.aborted||failed)throw abort();if(await ready()){phase=6;record();settled=true;return {stop,ready}}await new Promise(r=>setTimeout(r,500))}
   throw abort()
  }catch{record({code:5});key='';try{await stop()}catch{throw new OwnedTunnelCleanupError({stop,ready:async()=>false})}throw abort()}
 }
}
