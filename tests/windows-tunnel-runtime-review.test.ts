import {afterEach,expect,it,vi} from 'vitest'
import {EventEmitter} from 'node:events'
import type {ChildProcess} from 'node:child_process'
import {windowsPathEntries,stopOwnedTunnel} from '../electron/main/dot/BelleTunnelRuntime'
afterEach(()=>vi.useRealTimers())
it('normalizes paired PATH quotes without accepting embedded quotes or empty directories',()=>{
 expect(windowsPathEntries(' "C:\\custom tools" ; C:\\plain ;"D:\\Node";;"";"bad;one";x"y;\0bad')).toEqual(['C:\\custom tools','C:\\plain','D:\\Node'])
})
function fixture(){
 const child=Object.assign(new EventEmitter(),{exitCode:null as number|null,signalCode:null as NodeJS.Signals|null,stdin:{end:vi.fn()},kill:vi.fn(()=>false)})
 return child
}
it('rejects a surviving owned supervisor after graceful EOF and failed kill, without broad process termination',async()=>{
 vi.useFakeTimers();const child=fixture(),stop=stopOwnedTunnel(child as unknown as ChildProcess,'win32');const check=expect(stop).rejects.toThrow('CONNECTION_FAILED')
 await vi.advanceTimersByTimeAsync(6000);await check
 expect(child.stdin.end).toHaveBeenCalledOnce();expect(child.kill).toHaveBeenCalledOnce();expect(child.kill).toHaveBeenCalledWith();expect(child.listenerCount('exit')).toBe(0)
})
it('confirms owned supervisor exit after fallback kill and clears wait timers/listeners',async()=>{
 vi.useFakeTimers();const child=fixture();child.kill.mockImplementation(()=>{child.exitCode=0;child.emit('exit',0);return true})
 const stop=stopOwnedTunnel(child as unknown as ChildProcess,'win32');await vi.advanceTimersByTimeAsync(3000);await stop
 expect(child.kill).toHaveBeenCalledOnce();expect(child.listenerCount('exit')).toBe(0);expect(vi.getTimerCount()).toBe(0)
})
it('an already exited supervisor needs no kill or timeout',async()=>{
 vi.useFakeTimers();const child=fixture();child.exitCode=0;await stopOwnedTunnel(child as unknown as ChildProcess,'win32');expect(child.kill).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0)
})
