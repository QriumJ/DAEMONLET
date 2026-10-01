import {afterEach,expect,it,vi} from 'vitest'
import {mkdtemp,writeFile,readFile,chmod,rm,access} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawn} from 'node:child_process'
import {BelleTunnelRuntime} from '../electron/main/dot/BelleTunnelRuntime'
import type {RunningTunnel} from '../electron/main/dot/BelleConnectionManager'
const cleanup:string[]=[],running:RunningTunnel[]=[]
afterEach(async()=>{for(const r of running.splice(0))await r.stop();for(const d of cleanup.splice(0))await rm(d,{recursive:true,force:true})})
const posix=it.skipIf(process.platform==='win32')
async function fixture(){
 const dir=await mkdtemp(join(tmpdir(),'belle-owned-client-test-'));cleanup.push(dir);const client=join(dir,'client'),adapter=join(dir,'adapter.mjs'),evidence=join(dir,'evidence.json')
 await writeFile(adapter,'export {}')
 await writeFile(client,'#!'+process.execPath+'\n'+`
const fs=require('node:fs'),http=require('node:http'),{spawn}=require('node:child_process');
if(process.argv.includes('--version')){console.log('0.0.14');process.exit(0)}
if(process.argv.includes('--help')){console.log('--health.url-file --health.listen-addr --mcp.stdio-send-initialized-notification');process.exit(0)}
const path=process.argv[process.argv.indexOf('--profile-file')+1],profile=JSON.parse(fs.readFileSync(path,'utf8'));
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
fs.writeFileSync(${JSON.stringify(evidence)},JSON.stringify({pid:process.pid,child:child.pid,path,keyInProfile:JSON.stringify(profile).includes(process.env.CONTROL_PLANE_API_KEY),keyInArgs:process.argv.some(v=>v.includes(process.env.CONTROL_PLANE_API_KEY)),adapterCommand:profile.mcp.commands[0].command,admin:profile.admin_ui,origin:profile.control_plane.base_url,health:profile.health.listen_addr,rawLogging:profile.log.http_raw_unsafe||false}));
const server=http.createServer((req,res)=>{res.writeHead(req.url==='/readyz'?204:404);res.end()});
server.listen(0,'127.0.0.1',()=>fs.writeFileSync(profile.health.url_file,'http://127.0.0.1:'+server.address().port));
process.on('SIGTERM',()=>{server.close(()=>process.exit(0))});
`);await chmod(client,0o700)
 const runtime=new BelleTunnelRuntime(adapter,'darwin',{HOME:dir},{client,node:process.execPath,supervisor:join(import.meta.dirname,'../scripts/belle-tunnel-supervisor.mjs')});await runtime.probe();return {dir,runtime,evidence}
}
posix('real owned process uses nonsecret profile/argv, readyz and process-group cleanup',async()=>{
 const f=await fixture(),controller=new AbortController(),key='sk-'+Array.from({length:24},()=> 'k').join('')
 const r=await f.runtime.start({tunnelId:'tunnel_'+'a'.repeat(32),organizationId:'org-example123',autoConnect:false,consentVersion:1},key,{port:12345,token:'session'},controller.signal,vi.fn());running.push(r)
 expect(await r.ready()).toBe(true);const info=JSON.parse(await readFile(f.evidence,'utf8'));expect(info).toMatchObject({keyInProfile:false,keyInArgs:false,admin:{open_browser:false},origin:'https://api.openai.com',health:'127.0.0.1:0',rawLogging:false});expect(info.adapterCommand).toContain('-u CONTROL_PLANE_API_KEY -u OPENAI_API_KEY')
 await Promise.all([r.stop(),r.stop()]);await expect(access(info.path)).rejects.toThrow()
 await vi.waitFor(()=>{expect(()=>process.kill(info.pid,0)).toThrow();expect(()=>process.kill(info.child,0)).toThrow()},{timeout:5000})
})
posix('abort closes its own live client and never reports readiness afterwards',async()=>{const f=await fixture(),controller=new AbortController(),r=await f.runtime.start({tunnelId:'tunnel_'+'a'.repeat(32),organizationId:'org-example123',autoConnect:false,consentVersion:1},'sk-'+Array.from({length:24},()=> 'k').join(''),{port:12345,token:'session'},controller.signal,vi.fn());running.push(r);controller.abort();await r.stop();expect(await r.ready()).toBe(false);const info=JSON.parse(await readFile(f.evidence,'utf8'));expect(()=>process.kill(info.pid,0)).toThrow()})

posix('parent pipe EOF cleans supervisor, client and adapter without an app stop command',async()=>{const f=await fixture(),profile=join(f.dir,'profile.json'),health=join(f.dir,'health.url');await writeFile(profile,JSON.stringify({control_plane:{base_url:'https://api.openai.com'},health:{url_file:health,listen_addr:'127.0.0.1:0'},log:{},mcp:{commands:[{command:'mock'}]}}));const supervisor=spawn(process.execPath,[join(import.meta.dirname,'../scripts/belle-tunnel-supervisor.mjs'),join(f.dir,'client'),profile,'org-example123'],{env:{CONTROL_PLANE_API_KEY:'sk-'+Array.from({length:24},()=> 'k').join('')},detached:true,stdio:['pipe','ignore','ignore']});try{await vi.waitFor(async()=>{await access(f.evidence)},{timeout:5000});const info=JSON.parse(await readFile(f.evidence,'utf8'));supervisor.stdin.end();await vi.waitFor(()=>{expect(()=>process.kill(supervisor.pid!,0)).toThrow();expect(()=>process.kill(info.pid,0)).toThrow();expect(()=>process.kill(info.child,0)).toThrow()},{timeout:5000})}finally{try{process.kill(-supervisor.pid!,'SIGKILL')}catch{}}})
