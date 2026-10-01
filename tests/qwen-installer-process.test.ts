import {afterEach,expect,it,vi} from 'vitest'
import {EventEmitter} from 'node:events'
const exec=vi.hoisted(()=>vi.fn())
vi.mock('node:child_process',async importOriginal=>({...await importOriginal<typeof import('node:child_process')>(),execFile:exec}))
import {QwenVoiceInstaller} from '../electron/main/character-voice/QwenVoiceInstaller'
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();exec.mockReset()})
function fixture(){
 vi.stubGlobal('process',{...process,platform:'win32'});let complete!:(error:Error|null,stdout:string)=>void,treeDone!:(error?:Error)=>void
 const child=Object.assign(new EventEmitter(),{pid:12345,kill:vi.fn(),exitCode:null})
 exec.mockImplementation((command,args,options,cb)=>{if(command==='taskkill.exe'){treeDone=error=>cb(error??null,'');return new EventEmitter()};complete=cb;return child})
 const installer=new QwenVoiceInstaller('X:/owned','X:/resources',()=>{}, {platform:'win32-x64'}),controller=new AbortController()
 const promise=(installer as any).run('X:/owned/env/Scripts/python.exe',['-I','-B','helper.py'],controller.signal)
 return {child,controller,promise,complete:()=>complete(null,'PASS'),treeDone:(error?:Error)=>treeDone(error)}
}
it('Windows cancellation kills exactly the owned tree and waits for close and taskkill completion',async()=>{
 const f=fixture();let settled=false;const check=f.promise.catch((e:Error)=>{settled=true;return e.message});f.controller.abort()
 expect(exec.mock.calls[1].slice(0,2)).toEqual(['taskkill.exe',['/PID','12345','/T','/F']]);expect(f.child.kill).not.toHaveBeenCalled()
 f.complete();await Promise.resolve();expect(settled).toBe(false);f.child.emit('close');await Promise.resolve();expect(settled).toBe(false);f.treeDone();expect(await check).toBe('QWEN_INSTALL_CANCELLED')
})
it('Windows owned deadline uses tree termination instead of execFile parent-only timeout',async()=>{
 vi.useFakeTimers();const f=fixture(),check=f.promise.catch((e:Error)=>e.message)
 expect(exec.mock.calls[0][2]).not.toHaveProperty('timeout');await vi.advanceTimersByTimeAsync(600000)
 expect(exec.mock.calls[1][1]).toEqual(['/PID','12345','/T','/F']);f.complete();f.treeDone();f.child.emit('close');expect(await check).toBe('QWEN_RUNTIME_INSTALL')
})
it('failed tree termination cannot complete or delete stage while the owned child is still live',async()=>{
 const f=fixture();let settled=false;const check=f.promise.catch(()=>settled=true);f.controller.abort();f.treeDone(Error("TASKKILL_FAILED"));f.complete();await Promise.resolve();expect(settled).toBe(false);f.child.emit('close');await check;expect(settled).toBe(true)
})
