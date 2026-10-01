import {afterEach,expect,it,vi} from 'vitest'
import {access,copyFile,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {spawn} from 'node:child_process'
import {BelleCredentialStore} from '../electron/main/dot/BelleCredentialStore'
import {nativeDiagnosticReader,type TunnelDiagnostic} from '../electron/main/dot/BelleTunnelDiagnostics'
import {BelleTunnelRuntime} from '../electron/main/dot/BelleTunnelRuntime'
const native=resolve('dist-electron/native'),key='sk-'+'syntheticQA'.repeat(3)
const run=it.skipIf(process.platform!=='win32'||process.env.DAEMONLET_WINDOWS_NATIVE_TESTS!=='1')
const credential=it.skipIf(process.platform!=='win32'||process.env.DAEMONLET_WINDOWS_CREDENTIAL_TESTS!=='1')
const locked=it.skipIf(process.platform!=='win32'||process.env.DAEMONLET_WINDOWS_CREDENTIAL_TESTS!=='blocked')
const cleanup:(()=>Promise<void>)[]=[]
afterEach(async()=>{for(const f of cleanup.splice(0).reverse())await f()})
credential('real Windows Credential Manager QA item: missing, save, replace, reject, remove; production target untouched',async()=>{
 const store=new BelleCredentialStore(join(native,'DaemonletBelleCredentialQA.exe'))
 expect(await store.available()).toBe(true);expect(await store.has()).toBe(false)
 cleanup.push(()=>store.remove())
 await expect(store.get()).rejects.toThrow('KEY_MISSING')
 await store.put(key);expect(await store.has()).toBe(true);expect(await store.get()).toBe(key)
 await expect(store.put('invalid')).rejects.toThrow('INVALID_KEY');expect(await store.get()).toBe(key)
 const replacement=key+'r';await store.put(replacement);expect(await store.get()).toBe(replacement)
 await store.remove();await store.remove();expect(await store.has()).toBe(false)
})
locked('SSH network-logon store is unavailable and rejects synthetic key operations without file fallback',async()=>{
 const store=new BelleCredentialStore(join(native,'DaemonletBelleCredentialQA.exe'))
 expect(await store.available()).toBe(false)
 await expect(store.has()).rejects.toThrow('STORE_LOCKED')
 await expect(store.put(key)).rejects.toThrow('STORE_LOCKED')
 await expect(store.get()).rejects.toThrow('STORE_LOCKED')
})
async function fixture(options:{diagnostic?:(e:TunnelDiagnostic)=>void;exit?:number;status?:number}={}){
 const unrelated=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});cleanup.push(async()=>{if(unrelated.exitCode===null&&unrelated.signalCode===null)unrelated.kill()})
 const dir=await mkdtemp(join(tmpdir(),'belle Windows QA space '));cleanup.push(()=>rm(dir,{recursive:true,force:true}))
 const client=join(dir,'client.exe'),adapter=join(dir,'adapter.mjs'),evidence=join(dir,'evidence.json')
 await copyFile(join(native,'DaemonletBelleTestClient.exe'),client);await writeFile(join(dir,'node-path.txt'),process.execPath)
 await writeFile(adapter,`process.stdout.write(JSON.stringify({noApiKey:!process.env.CONTROL_PLANE_API_KEY&&!process.env.OPENAI_API_KEY}));setInterval(()=>{},1000)`)
 await writeFile(join(dir,'client.cjs'),`
const fs=require('node:fs'),http=require('node:http'),{spawn}=require('node:child_process'),path=require('node:path');
if(process.argv.includes('--version')){console.log('0.0.14');process.exit(0)}
if(process.argv.includes('--help')){console.log('--health.url-file --health.listen-addr --mcp.stdio-send-initialized-notification');process.exit(0)}
if(${options.exit!==undefined})process.exit(${options.exit??0});
const profilePath=process.argv[process.argv.indexOf('--profile-file')+1],profile=JSON.parse(fs.readFileSync(profilePath,'utf8'));
// v0.0.14 runtime flavor rejects a non-default full-client log-buffer override before startup.
if(profile.admin_ui?.log_buffer_events!==undefined&&profile.admin_ui.log_buffer_events!==2000)process.exit(42);
// Same quoted argv form as v0.0.14 parseCommandArgv, no shell or backslash paths.
const parts=[...profile.mcp.commands[0].command.matchAll(/"([^"]+)"|([^ ]+)/g)].map(v=>v[1]||v[2]);
const adapter=spawn(parts[0],parts.slice(1),{stdio:['pipe','pipe','ignore']});
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
let adapterOutput='';adapter.stdout.on('data',b=>{adapterOutput+=b;save()});
function save(){fs.writeFileSync(${JSON.stringify(evidence)},JSON.stringify({pid:process.pid,child:child.pid,adapter:adapter.pid,profilePath,profile,adapterOutput,keyInProfile:JSON.stringify(profile).includes(process.env.CONTROL_PLANE_API_KEY),keyInArgs:process.argv.some(v=>v.includes(process.env.CONTROL_PLANE_API_KEY))}))}
save();const server=http.createServer((req,res)=>{res.writeHead(req.url==='/readyz'?${options.status??204}:404);res.end()});server.listen(0,'127.0.0.1',()=>fs.writeFileSync(profile.health.url_file,'http://127.0.0.1:'+server.address().port));
`)
 const runtime=new BelleTunnelRuntime(adapter,'win32',{}, {client,node:process.execPath,host:join(native,'DaemonletBelleTunnelHost.exe')},options.diagnostic);await runtime.probe()
 return {dir,client,adapter,evidence,runtime,unrelated}
}
async function gone(info:any){await vi.waitFor(()=>{for(const pid of [info.pid,info.child,info.adapter])expect(()=>process.kill(pid,0)).toThrow()},{timeout:6000})}
run.each(['disconnect','abort'] as const)('Windows Job cleanup on %s, sanitized adapter, nonsecret profile and quoted paths',async mode=>{
 const f=await fixture(),ac=new AbortController(),r=await f.runtime.start({tunnelId:'tunnel_'+'a'.repeat(32),organizationId:'org-example123',autoConnect:false,consentVersion:1},key,{port:12345,token:'t'.repeat(64)},ac.signal,vi.fn());cleanup.push(()=>r.stop())
 expect(await r.ready()).toBe(true);await vi.waitFor(async()=>expect(JSON.parse((JSON.parse(await readFile(f.evidence,'utf8'))).adapterOutput)).toEqual({noApiKey:true}))
 const info=JSON.parse(await readFile(f.evidence,'utf8'));expect(info.keyInProfile).toBe(false);expect(info.keyInArgs).toBe(false);expect(info.profile.health.listen_addr).toBe('127.0.0.1:0');expect(info.profile.admin_ui).toEqual({open_browser:false})
 if(mode==='abort')ac.abort();await Promise.all([r.stop(),r.stop()]);expect(await r.ready()).toBe(false);await gone(info);expect(()=>process.kill(f.unrelated.pid!,0)).not.toThrow();await expect(access(info.profilePath)).rejects.toThrow()
},15000)
run.each(['eof','kill'] as const)('Windows native supervisor %s closes client and descendants without PID sweeping',async mode=>{
 const f=await fixture(),profile=join(f.dir,'profile.json');await writeFile(profile,JSON.stringify({health:{url_file:join(f.dir,'health.url')},mcp:{commands:[{command:'"'+join(native,'DaemonletBelleTunnelHost.exe').replaceAll('\\','/')+'" --adapter "'+process.execPath.replaceAll('\\','/')+'" "'+f.adapter.replaceAll('\\','/')+'"'}]}}))
 const child=spawn(join(native,'DaemonletBelleTunnelHost.exe'),[f.client,profile,'org-example123'],{stdio:['pipe','ignore','ignore'],env:{CONTROL_PLANE_API_KEY:key},windowsHide:true})
 cleanup.push(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill()})
 await vi.waitFor(async()=>{await access(f.evidence)},{timeout:5000});const info=JSON.parse(await readFile(f.evidence,'utf8'))
 if(mode==='eof')child.stdin.end();else child.kill();await gone(info);expect(()=>process.kill(f.unrelated.pid!,0)).not.toThrow()
},15000)

run('numeric diagnostics distinguish a native launch failure without any raw client output',async()=>{
 const f=await fixture(),events:TunnelDiagnostic[]=[],child=spawn(join(native,'DaemonletBelleTunnelHost.exe'),[join(f.dir,'missing.exe'),join(f.dir,'unused.json'),'org-example123','--numeric-diagnostics'],{stdio:['pipe','pipe','ignore'],env:{SystemRoot:'C:\\Windows'},windowsHide:true})
 child.stdout.on('data',nativeDiagnosticReader(e=>events.push(e)))
 await new Promise<void>(resolve=>child.once('close',()=>resolve()))
 expect(events).toEqual(expect.arrayContaining([expect.objectContaining({source:3,phase:5,win32:2})]));expect(child.exitCode).toBe(1)
})
run('numeric diagnostics preserve early child exit code and remove its private profile',async()=>{
 const events:TunnelDiagnostic[]=[],f=await fixture({exit:23,diagnostic:e=>events.push(e)})
 await expect(f.runtime.start({tunnelId:'tunnel_'+'a'.repeat(32),organizationId:'org-example123',autoConnect:false,consentVersion:1},key,{port:12345,token:'t'.repeat(64)},new AbortController().signal,vi.fn())).rejects.toThrow('CONNECTION_FAILED')
 expect(events).toEqual(expect.arrayContaining([expect.objectContaining({source:3,phase:9,exit:23})]));expect(events.some(e=>e.source===2&&e.phase===4)).toBe(true);expect(JSON.stringify(events)).not.toContain(key)
 expect(()=>process.kill(f.unrelated.pid!,0)).not.toThrow()
},15000)
run('numeric diagnostics capture local HTTP 401, cancel safely and leave the unrelated process alive',async()=>{
 const events:TunnelDiagnostic[]=[],f=await fixture({status:401,diagnostic:e=>events.push(e)}),ac=new AbortController()
 const start=f.runtime.start({tunnelId:'tunnel_'+'a'.repeat(32),organizationId:'org-example123',autoConnect:false,consentVersion:1},key,{port:12345,token:'t'.repeat(64)},ac.signal,vi.fn());const rejected=expect(start).rejects.toThrow('CONNECTION_FAILED')
 await vi.waitFor(()=>expect(events.some(e=>e.http===401)).toBe(true),{timeout:5000});ac.abort();await rejected
 const info=JSON.parse(await readFile(f.evidence,'utf8'));await gone(info);await expect(access(info.profilePath)).rejects.toThrow();expect(()=>process.kill(f.unrelated.pid!,0)).not.toThrow();expect(JSON.stringify(events)).not.toContain(key)
},15000)
