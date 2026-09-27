import type {VoiceApi,VoiceEvent} from '../../electron/shared/character-voice-contract'

export class AudioPlaybackController {
 private context:AudioContext|null=null
 private gain:GainNode|null=null
 private source:AudioBufferSourceNode|null=null
 private epoch=0
 private generation=0
 private seen=new Set<string>()
 private volume=0.8
 private disposed=false
 private visible=true
 private sources=new Set<AudioBufferSourceNode>()
 private decoding=Promise.resolve()
 private nextTime=0
 private streaming=false
 private queued=0
 private streams=new Map<string,{index:number;offset:number;segment:number}>()
 private lastSegment=-1
 constructor(private api:VoiceApi,private createContext=()=>new AudioContext()){}
 setVisible(value:boolean){this.visible=value;if(!value)this.stop()}
 setVolume(value:number){this.volume=value;if(this.gain)this.gain.gain.value=value}
 stop(){++this.generation;for(const source of this.sources){source.onended=null;try{source.stop()}catch{}source.disconnect()}this.sources.clear();this.source=null;this.nextTime=0;this.streaming=false;this.queued=0;this.streams.clear();this.lastSegment=-1;this.decoding=Promise.resolve()}
 async receive(event:VoiceEvent){
  if(event.epoch<this.epoch)return
  if(event.type==='stop'){this.epoch=event.epoch;this.stop();if(event.requestedAt)void this.api.action({type:'outputStopped',epoch:event.epoch,elapsedMs:Math.max(0,Date.now()-event.requestedAt)}).catch(()=>{});return}
  if(this.disposed||!this.visible)return
  if(this.seen.has(event.audioId))return
  this.seen.add(event.audioId);if(this.seen.size>1000)this.seen.delete(this.seen.values().next().value!)
  if(!event.stream||event.epoch!==this.epoch||!this.streaming)this.stop()
  this.epoch=event.epoch
  if(event.stream){
   this.streaming=true
   const {synthesisId,chunkIndex,sampleOffset,sampleCount}=event.stream,old=this.streams.get(synthesisId)
   if(chunkIndex!==(old?.index||0)||sampleOffset!==(old?.offset||0)||!Number.isSafeInteger(sampleCount)||sampleCount<1||sampleCount>48000||event.segmentIndex<this.lastSegment||old&&old.segment!==event.segmentIndex||++this.queued>6){this.stop();void this.api.action({type:'played',audioId:event.audioId,epoch:event.epoch,error:true}).catch(()=>{});return}
   this.streams.set(synthesisId,{index:chunkIndex+1,offset:sampleOffset+sampleCount,segment:event.segmentIndex});this.lastSegment=event.segmentIndex
  }
  const generation=this.generation,current=()=>!this.disposed&&this.visible&&generation===this.generation&&event.epoch===this.epoch
  const play=async()=>{
  if(!current())return
  try{
   const bytes=await this.api.audio(event.audioId,event.epoch);if(!current())return
   const context=this.context??=this.createContext()
   if(!this.gain){this.gain=context.createGain();this.gain.connect(context.destination)}
   this.gain.gain.value=this.volume
   const buffer=await context.decodeAudioData(Uint8Array.from(bytes).buffer);if(!current())return
   if(event.stream&&(buffer.sampleRate!==48000||buffer.length!==event.stream.sampleCount||buffer.numberOfChannels!==1)){
    // decodeAudioData resamples to the output device rate; duration is invariant.
    if(buffer.numberOfChannels!==1||Math.abs(buffer.duration-event.stream.sampleCount/48000)>1/24000)throw Error('VOICE_CHUNK_DECODE')
   }
   if(context.state==='suspended')await context.resume()
   if(!current())return
   if(context.state!=='running')throw Error('AUDIO_SUSPENDED')
   const source=this.source=context.createBufferSource();source.buffer=buffer;source.connect(this.gain)
   this.sources.add(source)
   const now=context.currentTime||0,previous=this.nextTime
   const start=event.stream?Math.max(now+(previous?0.005:0.24),previous):now
   if(event.stream){if(start-now+buffer.duration>6)throw Error('VOICE_QUEUE_LIMIT');this.nextTime=start+buffer.duration}
   source.onended=()=>{if(current()){source.disconnect();this.sources.delete(source);if(this.source===source)this.source=null;if(event.stream)--this.queued;void this.api.action({type:'played',audioId:event.audioId,epoch:event.epoch}).catch(()=>{})}}
   source.start(start)
   void this.api.action({type:'scheduled',audioId:event.audioId,epoch:event.epoch,delayMs:(start-now)*1000,gapMs:previous?Math.max(0,start-previous)*1000:0}).catch(()=>{})
  }catch{if(current()){this.stop();void this.api.action({type:'played',audioId:event.audioId,epoch:event.epoch,error:true}).catch(()=>{})}}
  }
  if(event.stream){const task=this.decoding.then(play);this.decoding=task.catch(()=>{});await task}else await play()
 }
 dispose(){this.disposed=true;this.stop();void this.context?.close().catch(()=>{});this.context=null}
}
