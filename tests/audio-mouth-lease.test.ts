import {expect,it} from 'vitest'
import {AudioMouthLease} from '../src/engine/anime25d/AudioMouthLease'
it('closes at stop, then restores authored idle/touch expression without a heartbeat',()=>{
 let now=0;const lease=new AudioMouthLease(()=>now)
 lease.set(2);now=100;lease.set(0);expect(lease.get()).toBe(0)
 now=349;expect(lease.get()).toBe(0);now=350;expect(lease.get()).toBeNull()
})
it('active silent audio renews zero; release/null and expired levels do not revive',()=>{
 let now=0;const lease=new AudioMouthLease(()=>now)
 for(now=0;now<1000;now+=100){lease.set(0);expect(lease.get()).toBe(0)}
 now=1200;expect(lease.get()).toBeNull();lease.poseChanged();expect(lease.get()).toBeNull()
 lease.set(2);lease.set(null);expect(lease.get()).toBeNull()
})
it('A to B cannot inherit a nonzero level; only a fresh heartbeat opens B',()=>{
 let now=0;const lease=new AudioMouthLease(()=>now)
 lease.set(2);now=80;lease.poseChanged();expect(lease.get()).toBe(0)
 now=249;expect(lease.get()).toBe(0);now=250;expect(lease.get()).toBeNull()
 lease.set(1);expect(lease.get()).toBe(1);lease.poseChanged();lease.set(2);expect(lease.get()).toBe(2)
})
