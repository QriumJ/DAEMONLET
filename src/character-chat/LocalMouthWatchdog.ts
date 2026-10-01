import type {MouthLevel} from './PlaybackMouthMeter'
/** A local renderer heartbeat can never write after another presentation takes ownership. */
export class LocalMouthWatchdog {
 private timer:ReturnType<typeof setTimeout>|null=null
 private generation=0
 constructor(private apply:(level:MouthLevel)=>void,private owned:()=>boolean){}
 receive(level:MouthLevel){this.revoke();if(!this.owned())return;this.apply(level);const generation=this.generation;this.timer=setTimeout(()=>{this.timer=null;if(generation===this.generation&&this.owned())this.apply(0)},250)}
 revoke(){++this.generation;if(this.timer)clearTimeout(this.timer);this.timer=null}
 stop(){this.revoke();if(this.owned())this.apply(0)}
}
