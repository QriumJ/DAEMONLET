import { spawn, type ChildProcess } from "node:child_process"

/** Polls only the current Option flag; no event tap, key text, or wheel capture. */
export class ModifierStateMonitor {
  private child: ChildProcess | null = null
  private stale: ReturnType<typeof setTimeout> | null = null
  private buffer = ""
  private failed = false
  constructor(private readonly executable: string, private readonly sample: (pressed: boolean) => void,
    private readonly warning: () => void, private readonly launch: typeof spawn = spawn) {}
  start() {
    if (this.child || this.failed) return
    try {
      const child = this.child = this.launch(this.executable, [], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true })
      this.buffer = ""
      const fail = () => { if (this.child !== child) return; this.failed = true; this.stop(); this.warning() }
      child.once("error", fail); child.once("exit", fail)
      child.stdout?.on("data", (data: Buffer) => {
        if (this.child !== child) return
        this.buffer += data.toString("ascii")
        if (this.buffer.length > 64 || /[^01\n]/.test(this.buffer)) { fail(); return }
        const lines = this.buffer.split("\n"); this.buffer = lines.pop()!
        for (const line of lines) {
          if (line !== "0" && line !== "1") { fail(); return }
          if (this.stale) clearTimeout(this.stale)
          this.sample(line === "1")
          this.stale = setTimeout(() => { this.stale = null; this.sample(false) }, 350)
          this.stale.unref()
        }
      })
    } catch { this.failed = true; this.sample(false); this.warning() }
  }
  stop() {
    const child = this.child; this.child = null
    if (this.stale) clearTimeout(this.stale)
    this.stale = null; this.buffer = ""; this.sample(false)
    if (child && child.exitCode === null && !child.killed) child.kill("SIGTERM")
  }
}
