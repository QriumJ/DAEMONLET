import { afterEach, describe, expect, it, vi } from "vitest"
import { OpacityWheelController, opacityWheelDelta } from "../src/pet/OpacityWheelController"
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals()})
const input={altKey:true,ctrlKey:false,metaKey:false,shiftKey:false,deltaX:0,deltaY:100,deltaMode:0,getModifierState:()=>false}
function fixture() {
 vi.useFakeTimers();const host=new EventTarget(),canvas=new EventTarget();vi.stubGlobal("window",host)
 let opacity=1,allowed=true;const hit=vi.fn(()=>true),update=vi.fn(async value=>{opacity=value})
 const controller=new OpacityWheelController(canvas as HTMLElement,{platform:"win32",allowed:()=>allowed,hit,opacity:()=>opacity,update})
 const wheel=(patch={})=>{const e=Object.assign(new Event("wheel",{cancelable:true}),input,{clientX:20,clientY:20},patch);canvas.dispatchEvent(e);return e}
 return {controller,host,wheel,update,hit,disallow:()=>{allowed=false},opacity:()=>opacity,setOpacity:(value:number)=>{opacity=value}}
}
describe("pet-only opacity wheel",()=>{
 it.each([{altKey:false},{ctrlKey:true},{metaKey:true},{shiftKey:true},{deltaY:NaN},{deltaY:0},{deltaX:200},{getModifierState:()=>true}])("leaves unrelated wheel input untouched %o",patch=>expect(opacityWheelDelta({...input,...patch})).toBeNull())
 it("bounds wheel/line/page deltas and consumes only painted modifier input",async()=>{
  const f=fixture();expect(f.wheel({altKey:false}).defaultPrevented).toBe(false);f.hit.mockReturnValue(false);expect(f.wheel().defaultPrevented).toBe(false)
  f.hit.mockReturnValue(true);expect(f.wheel().defaultPrevented).toBe(true);f.wheel();await vi.advanceTimersByTimeAsync(80);expect(f.opacity()).toBe(.8)
  for(let i=0;i<15;i++)f.wheel({deltaY:9000});await vi.advanceTimersByTimeAsync(80);expect(f.opacity()).toBe(0)
  f.wheel({deltaY:-3,deltaMode:1});await vi.advanceTimersByTimeAsync(80);expect(f.opacity()).toBe(.05)
  f.disallow();expect(f.wheel().defaultPrevented).toBe(false);f.controller.dispose()
 })
 it("serializes rapid async updates without losing the accumulated desired value",async()=>{
  const f=fixture();let done!:()=>void;f.update.mockImplementationOnce(()=>new Promise<void>(resolve=>{done=resolve}))
  f.wheel();await vi.advanceTimersByTimeAsync(80);f.wheel();f.wheel();await vi.advanceTimersByTimeAsync(80);expect(f.update).toHaveBeenCalledOnce()
  done();await vi.advanceTimersByTimeAsync(0);expect(f.update).toHaveBeenLastCalledWith(.7);f.controller.dispose()
 })
 it("rejects right Alt/AltGraph, cancels queued momentum on blur and detaches on disposal",async()=>{
  const f=fixture();f.host.dispatchEvent(Object.assign(new Event("keydown"),{code:"AltRight"}));expect(f.wheel().defaultPrevented).toBe(false)
  f.host.dispatchEvent(new Event("blur"));f.wheel();f.host.dispatchEvent(new Event("blur"));await vi.advanceTimersByTimeAsync(100);expect(f.update).not.toHaveBeenCalled()
  f.controller.dispose();expect(f.wheel().defaultPrevented).toBe(false)
 })
})

it.each([1,2,4])('accumulates repeated %spx trackpad deltas across flushes',async delta=>{
 const f=fixture();for(let n=0;n<20;n++){f.wheel({deltaY:delta});await vi.advanceTimersByTimeAsync(100)}
 expect(f.opacity()).toBe(1-20*delta/1000);f.controller.dispose()
})

it('resets fractional motion when Settings changes opacity externally',async()=>{
 const f=fixture();f.wheel({deltaY:2});await vi.advanceTimersByTimeAsync(100);f.setOpacity(.5)
 f.wheel({deltaY:100});await vi.advanceTimersByTimeAsync(100);expect(f.opacity()).toBe(.4);f.controller.dispose()
})

it('retains flushed sub-percent remainder across native blur, but drops unsent momentum',async()=>{
 const f=fixture();for(let n=0;n<20;n++){f.wheel({deltaY:1});await vi.advanceTimersByTimeAsync(100);f.host.dispatchEvent(new Event('blur'))}
 expect(f.opacity()).toBe(.98);f.wheel({deltaY:100});f.host.dispatchEvent(new Event('blur'));await vi.advanceTimersByTimeAsync(100);expect(f.opacity()).toBe(.98);f.controller.dispose()
})

it('drops an unsent wheel target when Settings changes opacity before the flush',async()=>{
 const f=fixture();f.wheel({deltaY:100});f.setOpacity(.5)
 f.wheel({deltaY:100});await vi.advanceTimersByTimeAsync(80)
 expect(f.update).toHaveBeenCalledOnce();expect(f.opacity()).toBe(.4);f.controller.dispose()
})
