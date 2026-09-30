import {Anime25DRuntime} from '../engine/anime25d/Anime25DRuntime'
import {AudioPlaybackController} from '../character-chat/AudioPlaybackController'
import {parsePoseManifest} from '../pose/PoseManifest'
import type {VoiceApi,VoiceEvent} from '../../electron/shared/character-voice-contract'
import type {MouthLevel} from '../character-chat/PlaybackMouthMeter'
const canvas=document.querySelector('canvas')!,runtime=new Anime25DRuntime(canvas),levels:Array<{time:number;level:MouthLevel;epoch:number}>=[]
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms))
let cached:Uint8Array|null=null
let epoch=1,id=0,context:AudioContext|null=null
const chunks=new Map<string,Uint8Array>()
const api={audio:async(key:string)=>chunks.get(key)!,action:async()=>({})} as unknown as VoiceApi
const player=new AudioPlaybackController(api,()=>context??=new AudioContext({sampleRate:48000}),{sink:(level,epoch)=>{levels.push({time:performance.now(),level,epoch});runtime.setAudioMouth(level);document.querySelector('#level')!.textContent=['Closed','Small open','Wide open'][level]}})
// Test PCM is synthesized locally, never model speech. Quiet output still crosses fixed post-gain thresholds.
player.setVolume(.15)
function wav(amplitude:number,duration:number){const count=Math.round(duration*48000),data=new Uint8Array(44+count*2),v=new DataView(data.buffer);const ascii=(start:number,text:string)=>[...text].forEach((c,i)=>v.setUint8(start+i,c.charCodeAt(0)));ascii(0,'RIFF');v.setUint32(4,data.length-8,true);ascii(8,'WAVE');ascii(12,'fmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,48000,true);v.setUint32(28,96000,true);v.setUint16(32,2,true);v.setUint16(34,16,true);ascii(36,'data');v.setUint32(40,count*2,true);for(let i=0;i<count;i++)v.setInt16(44+i*2,Math.round(Math.sin(i/48000*Math.PI*2*220)*amplitude*32767),true);return data}
const event=(audioId:string,stream?:Extract<VoiceEvent,{type:'audio'}>['stream']):VoiceEvent=>({type:'audio',epoch,audioId,binding:{} as any,segmentIndex:0,...(stream?{stream}:{})})
async function play(amplitude:number,duration=1.2,stream=false){const audioId='qa-'+(++id),bytes=wav(amplitude,duration);chunks.set(audioId,bytes);cached=bytes;await player.receive(event(audioId,stream?{synthesisId:audioId,chunkIndex:0,sampleOffset:0,sampleCount:Math.round(duration*48000)}:undefined));return audioId}
async function replay(){if(!cached)throw Error('QA_CACHE_EMPTY');const audioId='qa-cache-'+(++id);chunks.set(audioId,cached);await player.receive(event(audioId))}
async function init(){
 const [bytes,overrides,manifestRaw]=await Promise.all([fetch('pose/model.psd').then(r=>r.arrayBuffer()),fetch('pose/rig-overrides.json').then(r=>r.json()),fetch('pose/pose.json').then(r=>r.json())])
 const manifest=parsePoseManifest(manifestRaw).value,result=runtime.loader.loadArrayBuffer(bytes,'Belle waiting-open',overrides)
 const url=new URL('pose/pose.json',location.href).toString(),asset=await runtime.poseLoader.load(url,result.model.rig,{manifest,prepared:result})
 runtime.applyPreparedCharacter(result,{characterId:'belle-preview',sourceReferenceUrl:new URL('pose/source.png',location.href).toString()},[{manifestUrl:url,manifest}],[asset]);runtime.setAutoBlink(false);runtime.start();await runtime.transitionToPose(manifest.id);await sleep(450)
 document.querySelector('#status')!.textContent='Belle · waiting-open · isolated audio QA (tone, not model voice)';return {pose:runtime.getDiagnostics().pose?.id,mouthLayers:result.model.rig.layers.filter(l=>l.mouthExpression).map(l=>l.name),morph:!!result.model.rig.anchors.mouth.morph}
}
async function level(value:MouthLevel){document.querySelector('#level')!.textContent=['Closed','Small open','Wide open'][value];runtime.setAudioMouth(value);await sleep(180);return runtime.getAudioMouthOpen()}
async function stop(){await player.receive({type:'stop',epoch:++epoch});await sleep(150);return runtime.getAudioMouthOpen()}
function jawProof(){
 const renderer=runtime.renderer as any,p=runtime.getDiagnostics().parameters
 const face=renderer.poseLayers.find((layer:any)=>layer.baseName==='face'),mouth=renderer.poseLayers.find((layer:any)=>layer.mouthExpression==='open')
 const sample=(open:number)=>{renderer.render(p,7777,false,{...p,mouthOpen:open,mouthForm:0,mouthEase:0});return {face:Array.from(face.current) as number[],mouth:Array.from(mouth.current) as number[]}}
 const closed=sample(.3),wide=sample(.7)
 return {faceIdentical:closed.face.every((value,i)=>value===wide.face[i]),mouthChanged:closed.mouth.some((value,i)=>value!==wide.mouth[i]),faceVertices:closed.face.length/2}
}
async function expiry(){const {DotPresentationService}=await import('../../electron/main/dot/DotPresentationService');let active=false;const controller=new DotPresentationService(()=>({characterId:'qa',revision:'1',definition:{} as any}),frame=>{active=!!frame;if(!frame)player.stop()},async()=>{await play(1,2)},async()=>player.stop());controller.muted=false;await controller.present({type:'present',text:'QA',speak:true,durationMs:1000});await sleep(1350);const result={active,closed:runtime.getAudioMouthOpen()===0};await controller.close();return result}
const qa={applyMouth(value:MouthLevel){runtime.setAudioMouth(value);document.querySelector('#level')!.textContent=['Closed','Small open','Wide open'][value]},init,level,play,replay,stop,expiry,jawProof,levels,parameters:()=>({...runtime.getDiagnostics().parameters,mouthOpen:runtime.getAudioMouthOpen()}),globalParameters:()=>runtime.getDiagnostics().parameters,resources:()=>runtime.getResourceDiagnostics(),state:()=>context?.state??'none',mute:()=>player.setVolume(0),unmute:()=>player.setVolume(.15),pause:()=>context?.suspend(),resume:()=>context?.resume(),resize:(size:number)=>{canvas.style.width=size+'px';canvas.style.height=size+'px';runtime.resize()},async fallback(){await runtime.exitPose();runtime.setAudioMouth(2);await sleep(400);return runtime.getAudioMouthOpen()},dispose(){player.dispose();runtime.stop();runtime.unload()}}
;(window as unknown as {lipQa:typeof qa}).lipQa=qa
