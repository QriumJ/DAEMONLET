export function opacityWheelDelta(event: Pick<WheelEvent, "altKey" | "ctrlKey" | "metaKey" | "deltaX" | "deltaY" | "deltaMode" | "getModifierState">, rightAlt = false): number | null {
  if (!event.altKey || event.ctrlKey || event.metaKey || rightAlt || event.getModifierState("AltGraph") || !Number.isFinite(event.deltaY) || !Number.isFinite(event.deltaX) || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return null
  const pixels = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1)
  return Math.max(-100, Math.min(100, pixels)) / 1000
}

/** Only a modifier wheel over painted pet pixels. Never listens outside this canvas. */
export class OpacityWheelController {
  private rightAlt = false
  private queued: number | null = null
  private sending = false
  private inFlight: number | null = null
  private disposed = false
  private timer: ReturnType<typeof setTimeout> | null = null
  constructor(private readonly canvas: HTMLElement, private readonly options: {
    platform: string; allowed(): boolean; hit(x: number, y: number): boolean; opacity(): number;
    update(opacity: number): Promise<unknown>; failed?(): void
  }) {
    canvas.addEventListener("wheel", this.wheel, { passive: false, capture: true })
    window.addEventListener("keydown", this.key, true); window.addEventListener("keyup", this.key, true); window.addEventListener("blur", this.clear)
  }
  private key = (event: KeyboardEvent) => { if (this.options.platform === "win32" && event.code === "AltRight") this.rightAlt = event.type === "keydown" }
  private clear = () => { this.rightAlt = false; this.queued = null; if (this.timer) clearTimeout(this.timer); this.timer = null }
  private wheel = (event: WheelEvent) => {
    if (this.disposed || !this.options.allowed()) return
    const delta = opacityWheelDelta(event, this.rightAlt)
    if (delta === null) return
    try { if (!this.options.hit(event.clientX, event.clientY)) return } catch { return }
    event.preventDefault(); event.stopImmediatePropagation()
    this.queued = Math.round(Math.max(0, Math.min(1, (this.queued ?? this.inFlight ?? this.options.opacity()) - delta)) * 100) / 100
    if (!this.timer) this.timer = setTimeout(() => { this.timer = null; void this.flush() }, 80)
  }
  private async flush() {
    if (this.disposed || this.sending || this.queued === null) return
    const opacity = this.queued; this.queued = null; this.sending = true; this.inFlight = opacity
    try { await this.options.update(opacity) } catch { this.options.failed?.() }
    finally { this.sending = false; this.inFlight = null; if (!this.disposed && this.queued !== null) void this.flush() }
  }
  dispose() {
    this.disposed = true; this.clear()
    this.canvas.removeEventListener("wheel", this.wheel, true)
    window.removeEventListener("keydown", this.key, true); window.removeEventListener("keyup", this.key, true); window.removeEventListener("blur", this.clear)
  }
}
