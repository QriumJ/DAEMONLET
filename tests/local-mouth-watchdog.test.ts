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
