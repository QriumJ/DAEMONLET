import {afterEach,expect,it,vi} from 'vitest'
import {EventEmitter} from 'node:events'
const exec=vi.hoisted(()=>vi.fn())
vi.mock('node:child_process',()=>({execFile:exec}))
import {checkWindowsModel} from '../electron/main/character-voice/WindowsModelCheck'
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();exec.mockReset()})
function fixture(){
 vi.stubGlobal('process',{...process,platform:'win32'})
 let callback!:(error:Error|null,stdout:string)=>void,tree!:(error:Error|null)=>void
 const child=Object.assign(new EventEmitter(),{pid:12345,kill:vi.fn()})
 exec.mockImplementation((command,args,options,cb)=>{if(command==='taskkill.exe'){tree=error=>cb(error,'');return new EventEmitter()};callback=cb;return child})
 const controller=new AbortController(),promise=checkWindowsModel('/python','/model','/worker.py','voxcpm2',controller.signal)
 return {child,controller,promise,complete:(error:Error|null=null,stdout='{"status":"PASS"}')=>callback(error,stdout),treeDone:(error:Error|null=null)=>tree(error)}
}
it('pre-aborted admission never launches a process',async()=>{
 const controller=new AbortController();controller.abort()
 await expect(checkWindowsModel('/python','/model','/worker.py','voxcpm2',controller.signal)).rejects.toThrow('VOICE_MODEL_CHECK_CANCELLED');expect(exec).not.toHaveBeenCalled()
})
it('Windows abort kills only its owned tree and drains close plus termination completion before a late PASS can settle',async()=>{
 const f=fixture();let settled=false;const task=f.promise.catch(e=>e.message).finally(()=>settled=true)
 f.controller.abort();expect(exec.mock.calls[1].slice(0,2)).toEqual(['taskkill.exe',['/PID','12345','/T','/F']]);expect(f.child.kill).not.toHaveBeenCalled()
 f.complete();await Promise.resolve();expect(settled).toBe(false);f.child.emit('close');await Promise.resolve();expect(settled).toBe(false)
 f.treeDone();expect(await task).toBe('VOICE_MODEL_CHECK_CANCELLED')
})
it('owned deadline uses tree termination, not Node parent-only signal/timeout',async()=>{
 vi.useFakeTimers();const f=fixture(),task=f.promise.catch(e=>e.message)
 expect(exec.mock.calls[0][2]).not.toHaveProperty('signal');expect(exec.mock.calls[0][2]).not.toHaveProperty('timeout')
 await vi.advanceTimersByTimeAsync(600000);expect(exec.mock.calls[1][1]).toEqual(['/PID','12345','/T','/F'])
 f.complete();f.treeDone();f.child.emit('close');expect(await task).toBe('VOICE_MODEL_CHECK_FAILED')
})
it('failed tree termination keeps admission blocked while the inherited checker pipes remain live',async()=>{
 const f=fixture();let settled=false;const task=f.promise.catch(e=>e.message).finally(()=>settled=true)
 f.controller.abort();f.treeDone(Error('private taskkill data'));f.complete(Error('private upstream data'),'private output');await Promise.resolve();expect(settled).toBe(false)
 f.child.emit('close');expect(await task).toBe('VOICE_MODEL_CHECK_CANCELLED')
})
it('normal PASS still requires both callback and drained close, and clears the deadline',async()=>{
 vi.useFakeTimers();const f=fixture();let settled=false;const task=f.promise.then(()=>settled=true)
 f.child.emit('close');await Promise.resolve();expect(settled).toBe(false);f.complete();await task;expect(settled).toBe(true)
 await vi.advanceTimersByTimeAsync(600000);expect(exec).toHaveBeenCalledTimes(1)
})
it.each([{error:Error('private path'),stdout:'private output'},{error:null,stdout:'private invalid JSON'},{error:null,stdout:'{"status":"FAIL","detail":"private"}'}])('failed checks expose only a private allowlisted code (%j)',async({error,stdout})=>{
 const f=fixture(),task=f.promise.catch(e=>e.message);f.complete(error,stdout);f.child.emit('close');expect(await task).toBe('VOICE_MODEL_CHECK_FAILED')
})
