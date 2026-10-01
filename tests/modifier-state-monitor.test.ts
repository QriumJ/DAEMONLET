import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ModifierStateMonitor } from "../electron/main/ModifierStateMonitor"
afterEach(()=>vi.useRealTimers())
function fixture() {
  const child=Object.assign(new EventEmitter(),{stdout:new PassThrough(),exitCode:null,killed:false,kill:vi.fn(function(this:any){this.killed=true})})
  const launch=vi.fn(()=>child),sample=vi.fn(),warning=vi.fn()
  const monitor=new ModifierStateMonitor("/owned/ModifierState",sample,warning,launch as never)
  return {child,launch,sample,warning,monitor}
}
describe("narrow modifier polling lifecycle",()=>{
  it("parses bounded fragmented boolean heartbeats, expires a lost keyup, and kills only its owned process",()=>{
    vi.useFakeTimers();const f=fixture();f.monitor.start();f.monitor.start();expect(f.launch).toHaveBeenCalledOnce()
    f.child.stdout.write("1");expect(f.sample).not.toHaveBeenCalled();f.child.stdout.write("\n0\n1\n")
    expect(f.sample.mock.calls.map(x=>x[0])).toEqual([true,false,true]);vi.advanceTimersByTime(350);expect(f.sample).toHaveBeenLastCalledWith(false)
    f.monitor.stop();expect(f.child.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");f.child.emit("exit",0);expect(f.warning).not.toHaveBeenCalled()
  })
  it.each(["secret", "10\n", "\n", "1".repeat(65)])("fails closed on malformed output without echoing it",output=>{
    const f=fixture();f.monitor.start();f.child.stdout.write(output);expect(f.sample).toHaveBeenLastCalledWith(false);expect(f.warning).toHaveBeenCalledOnce();expect(f.child.kill).toHaveBeenCalledOnce()
    f.monitor.start();expect(f.launch).toHaveBeenCalledOnce()
  })
  it("fails closed on unavailable helper and ignores stale events after stop",()=>{
    const f=fixture();f.monitor.start();f.child.stdout.write("1\n");f.child.emit("error",Error("unavailable"));expect(f.warning).toHaveBeenCalledOnce()
    f.sample.mockClear();f.child.stdout.write("1\n");expect(f.sample).not.toHaveBeenCalled()
  })
})
