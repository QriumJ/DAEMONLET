import {afterEach,expect,it,vi} from 'vitest'
import {EventEmitter} from 'node:events'
import {mkdtemp,writeFile,access,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {BelleTunnelRuntime} from '../electron/main/dot/BelleTunnelRuntime'
import {OwnedTunnelCleanupError} from '../electron/main/dot/OwnedTunnelCleanupError'
const launch=vi.hoisted(()=>vi.fn())
vi.mock('node:child_process',async original=>({...await original<typeof import('node:child_process')>(),spawn:launch}))
const dirs:string[]=[]
afterEach(async()=>{vi.useRealTimers();launch.mockReset();for(const dir of dirs.splice(0))await rm(dir,{recursive:true,force:true})})
it('an aborted before-ready start with failed owned stop returns a retryable owner and keeps its private profile',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'belle-not-ready-'));dirs.push(dir);const adapter=join(dir,'adapter.mjs');await writeFile(adapter,'')
 const child=Object.assign(new EventEmitter(),{exitCode:null as number|null,signalCode:null as NodeJS.Signals|null,stdin:Object.assign(new EventEmitter(),{end:vi.fn()}),kill:vi.fn(()=>false)})
 launch.mockReturnValue(child)
 const runtime=new BelleTunnelRuntime(adapter,'win32',{}, {client:'probe-client',node:process.execPath,host:'probe-owned-host'})
 // Simulate checked prerequisites only; no credential, official client, PID or network is used.
 Object.assign(runtime,{client:'probe-client',node:process.execPath})
 vi.useFakeTimers();const abort=new AbortController()
 const pending=runtime.start({tunnelId:'tunnel_'+'a'.repeat(32),organizationId:'org-test123',consentVersion:1,autoConnect:false},'sk-'+'synthetic'.repeat(4),{port:12345,token:'synthetic-session'},abort.signal,vi.fn()).catch(e=>e)
 await vi.waitFor(()=>expect(launch).toHaveBeenCalledOnce());const profile=launch.mock.calls[0][1][1];abort.abort()
 await vi.advanceTimersByTimeAsync(7000);const error=await pending
 expect(error).toBeInstanceOf(OwnedTunnelCleanupError);expect(error.message).toBe('CONNECTION_FAILED');await expect(access(profile)).resolves.toBeUndefined();expect(await error.running.ready()).toBe(false)
 child.exitCode=0;child.emit('exit',0);await error.running.stop();await expect(access(profile)).rejects.toThrow();expect(child.kill).toHaveBeenCalledOnce()
})
