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
 constructor(private api:VoiceApi,private createContext=()=>new AudioContext()){}
 setVisible(value:boolean){this.visible=value;if(!value)this.stop()}
 setVolume(value:number){this.volume=value;if(this.gain)this.gain.gain.value=value}
 stop(){++this.generation;if(this.source){this.source.onended=null;try{this.source.stop()}catch{}this.source.disconnect();this.source=null}}
 async receive(event:VoiceEvent){
  if(event.epoch<this.epoch)return
  if(event.type==='stop'){this.epoch=event.epoch;this.stop();return}
  if(this.disposed||!this.visible)return
  if(this.seen.has(event.audioId))return
  this.seen.add(event.audioId);if(this.seen.size>1000)this.seen.delete(this.seen.values().next().value!)
  this.stop();this.epoch=event.epoch
  const generation=this.generation,current=()=>!this.disposed&&this.visible&&generation===this.generation&&event.epoch===this.epoch
  try{
   const bytes=await this.api.audio(event.audioId,event.epoch);if(!current())return
   const context=this.context??=this.createContext()
   if(!this.gain){this.gain=context.createGain();this.gain.connect(context.destination)}
   this.gain.gain.value=this.volume
   const buffer=await context.decodeAudioData(Uint8Array.from(bytes).buffer);if(!current())return
   if(context.state==='suspended')await context.resume()
   if(!current())return
   if(context.state!=='running')throw Error('AUDIO_SUSPENDED')
   const source=this.source=context.createBufferSource();source.buffer=buffer;source.connect(this.gain)
   source.onended=()=>{if(current()){source.disconnect();this.source=null;void this.api.action({type:'played',audioId:event.audioId,epoch:event.epoch}).catch(()=>{})}}
   source.start()
  }catch{if(current()){this.stop();void this.api.action({type:'played',audioId:event.audioId,epoch:event.epoch,error:true}).catch(()=>{})}}
 }
 dispose(){this.disposed=true;this.stop();void this.context?.close().catch(()=>{});this.context=null}
}
