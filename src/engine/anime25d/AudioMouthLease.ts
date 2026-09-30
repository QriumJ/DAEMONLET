import type {MouthLevel} from '../../character-chat/PlaybackMouthMeter'
/** Meter heartbeats renew a short lease. A final zero closes now, then releases the
 * authored expression; stale samples never remain active across a pose change. */
export class AudioMouthLease {
 private level: MouthLevel | null = null
 private expires = -Infinity
 constructor(private now = () => performance.now(), private ttlMs = 250) {}
 set(level: MouthLevel | null) {
  this.level = level === 0 || level === 1 || level === 2 ? level : null
  this.expires = this.level === null ? -Infinity : this.now()+this.ttlMs
 }
 get(): MouthLevel | null {
  if (this.now() >= this.expires) this.level = null
  return this.level
 }
 poseChanged() {if (this.get() !== null) this.level = 0}
}
