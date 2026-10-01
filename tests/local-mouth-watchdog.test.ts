import {afterEach,expect,it,vi} from 'vitest'
import {LocalMouthWatchdog} from '../src/character-chat/LocalMouthWatchdog'
afterEach(()=>vi.useRealTimers())
it('local heartbeat expiry closes its own mouth, but cannot close a new dot owner',()=>{
 vi.useFakeTimers();let local=true;const apply=vi.fn(),watchdog=new LocalMouthWatchdog(apply,()=>local)
 watchdog.receive(2);vi.advanceTimersByTime(249);expect(apply).toHaveBeenLastCalledWith(2)
 local=false;watchdog.revoke();apply(2);vi.advanceTimersByTime(500);expect(apply).toHaveBeenCalledTimes(2);expect(vi.getTimerCount()).toBe(0)
 local=true;watchdog.receive(1);vi.advanceTimersByTime(250);expect(apply).toHaveBeenLastCalledWith(0)
})
it('missed explicit revoke still checks ownership, and repeated updates leave only one timer',()=>{
 vi.useFakeTimers();let local=true;const apply=vi.fn(),watchdog=new LocalMouthWatchdog(apply,()=>local)
 watchdog.receive(1);watchdog.receive(2);expect(vi.getTimerCount()).toBe(1);local=false;vi.advanceTimersByTime(250);expect(apply).toHaveBeenLastCalledWith(2)
 local=true;watchdog.receive(2);watchdog.stop();expect(apply).toHaveBeenLastCalledWith(0);expect(vi.getTimerCount()).toBe(0)
})

it('local watchdog and runtime lease distinguish immediate zero from authored recovery, with safe dot handoff',async()=>{
 const {AudioMouthLease}=await import('../src/engine/anime25d/AudioMouthLease')
 vi.useFakeTimers();const lease=new AudioMouthLease(()=>Date.now());let local=true
 const watchdog=new LocalMouthWatchdog(level=>lease.set(level),()=>local)
 watchdog.receive(2);vi.advanceTimersByTime(249);expect(lease.get()).toBe(2)
 vi.advanceTimersByTime(1);expect(lease.get()).toBe(0);vi.advanceTimersByTime(249);expect(lease.get()).toBe(0)
 vi.advanceTimersByTime(1);expect(lease.get()).toBeNull()
 watchdog.receive(2);local=false;watchdog.revoke();lease.set(1);vi.advanceTimersByTime(250);expect(lease.get()).toBeNull()
 local=true;watchdog.receive(2);watchdog.stop();expect(lease.get()).toBe(0);vi.advanceTimersByTime(250);expect(lease.get()).toBeNull()
})
