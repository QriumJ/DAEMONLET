export type MouthLevel = 0 | 1 | 2
export type MouthSink = (level: MouthLevel, epoch: number) => void
export type MouthClock = {request(callback: FrameRequestCallback): number; cancel(id: number): void}
const browserClock: MouthClock = {request: callback => requestAnimationFrame(callback), cancel: id => cancelAnimationFrame(id)}
/** Measures rendered samples after output gain. It never consults synthesis progress. */
export class PlaybackMouthMeter {
 private frame: number | null = null
 private samples = new Float32Array(1024)
 private envelope = 0
 private level: MouthLevel = 0
 private lastSent = -Infinity
 private lastSample = -Infinity
 private listening = false
 constructor(private context: AudioContext, private analyser: AnalyserNode, private sink: MouthSink, private epoch: () => number, private audible: () => boolean, private clock: MouthClock = browserClock) {
  analyser.fftSize = this.samples.length
  analyser.smoothingTimeConstant = 0
  context.addEventListener('statechange', this.stateChanged)
 }
 private stateChanged = () => {if (this.context.state !== 'running') this.reset(); else if (this.listening) this.schedule()}
 start() {this.listening = true; this.schedule()}
 private schedule() {if (this.frame === null && this.listening && this.context.state === 'running') this.frame = this.clock.request(this.tick)}
 private emit(level: MouthLevel, now: number, force = false) {
  if (force || level !== this.level || now - this.lastSent >= 100) {this.level = level; this.lastSent = now; try {this.sink(level, this.epoch())} catch { /* Animation cannot interrupt playback. */ }}
 }
 private tick = (now: number) => {
  this.frame = null
  if (!this.listening) return
  if (this.context.state !== 'running') {this.reset(); return}
  if (!this.audible()) {this.stop(); return}
  if (now - this.lastSample >= 30) {
   this.lastSample = now
   this.analyser.getFloatTimeDomainData(this.samples)
   let mean = 0; for (const sample of this.samples) mean += sample; mean /= this.samples.length
   let energy = 0; for (const sample of this.samples) energy += (sample - mean) ** 2
   const rms = Math.sqrt(energy / this.samples.length)
   this.envelope += (rms - this.envelope) * (rms > this.envelope ? .75 : .45)
   const level: MouthLevel = this.envelope < (this.level ? .006 : .010) ? 0 : this.envelope >= (this.level === 2 ? .045 : .065) ? 2 : 1
   this.emit(level, now)
  }
  this.schedule()
 }
 reset() {if (this.frame !== null) this.clock.cancel(this.frame); this.frame = null; this.envelope = 0; this.lastSample = -Infinity; this.emit(0, 0, true)}
 stop() {this.listening = false; this.reset()}
 dispose() {this.stop(); this.context.removeEventListener('statechange', this.stateChanged); this.analyser.disconnect()}
}
