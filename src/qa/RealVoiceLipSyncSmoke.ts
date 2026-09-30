import './AudioLipSyncSmoke'
import {AudioPlaybackController} from '../character-chat/AudioPlaybackController'
import type {MouthLevel} from '../character-chat/PlaybackMouthMeter'
import type {VoiceApi,VoiceEvent} from '../../electron/shared/character-voice-contract'
const qa=(window as any).lipQa
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms))
let context:AudioContext|null=null,gain:GainNode|null=null,player:AudioPlaybackController|null=null,quietOutput:MediaStreamAudioDestinationNode|null=null,epoch=1,trial=0
let stage='idle',meta:any,bytes:Uint8Array[]=[],whole:Uint8Array
const observations:any[]=[],mouth:any[]=[],actions:any[]=[],starts:any[]=[],ended:any[]=[]
const stamp=()=>({at:performance.now(),contextTime:context?.currentTime??null,state:context?.state??'none',stage})
function measuredContext(){
 context=new AudioContext({sampleRate:48000});quietOutput=location.search.includes('quiet=1')?context.createMediaStreamDestination():null;observations.push({...stamp(),kind:'created',baseLatency:context.baseLatency,outputLatency:context.outputLatency,speakerOutput:!quietOutput,userActivation:navigator.userActivation.hasBeenActive})
 const analyserFactory=context.createAnalyser.bind(context),gainFactory=context.createGain.bind(context),sourceFactory=context.createBufferSource.bind(context)
 context.createGain=()=>{gain=gainFactory();return gain}
 context.createAnalyser=()=>{const node=analyserFactory();if(quietOutput){const connect=node.connect.bind(node);node.connect=((target:AudioNode)=>connect(target===context!.destination?quietOutput!:target)) as typeof node.connect}const sample=node.getFloatTimeDomainData.bind(node);node.getFloatTimeDomainData=data=>{sample(data);let sum=0;for(const v of data)sum+=v*v;const output=context!.getOutputTimestamp();observations.push({...stamp(),kind:'sample',rms:Math.sqrt(sum/data.length),outputContextTime:output.contextTime,outputPerformanceTime:output.performanceTime})};return node}
 context.createBufferSource=()=>{const node=sourceFactory(),start=node.start.bind(node);node.start=(when=0,offset=0,duration?:number)=>{starts.push({...stamp(),when,duration:node.buffer?.duration,length:node.buffer?.length});node.addEventListener('ended',()=>ended.push(stamp()));if(duration===undefined)start(when,offset);else start(when,offset,duration)};return node}
 context.addEventListener('statechange',()=>observations.push({...stamp(),kind:'state'}));return context
}
const data=new Map<string,Uint8Array>()
function createPlayer(){player?.dispose();quietOutput?.stream.getTracks().forEach(track=>track.stop());quietOutput=null;context=null;gain=null;data.clear();player=new AudioPlaybackController({audio:async id=>data.get(id)!,action:async value=>{actions.push({...stamp(),...value});return {} as any}} as Pick<VoiceApi,'audio'|'action'>,measuredContext,{sink:(level,voiceEpoch)=>{mouth.push({...stamp(),level,epoch:voiceEpoch});qa.applyMouth(level)}});player.setVolume(.5)}
async function fetchBytes(path:string):Promise<Uint8Array>{const response=await fetch(path);const buffer:ArrayBuffer=await response.arrayBuffer();return new Uint8Array(buffer)}
async function setup(){meta=await fetch('voice/generation.json').then(r=>r.json());if(meta.status!=='PASS')throw Error('QA_REAL_VOICE_NOT_READY');bytes=await Promise.all((meta.chunks as Array<{file:string}>).map(chunk=>fetchBytes('voice/'+chunk.file)));whole=await fetchBytes('voice/belle-actual.wav');let nonzero=0,first=-1,offset=0;for(const chunk of bytes){const view=new DataView(chunk.buffer,chunk.byteOffset);for(let at=44;at<chunk.length;at+=2){if(view.getInt16(at,true)!==0){nonzero++;if(first<0)first=offset}offset++}}return {text:meta.text,totalSamples:offset,nonzeroSamples:nonzero,firstNonzeroInputMs:first/48,peak:meta.peak,rms:meta.rms,chunkCount:bytes.length}}

async function stream(){
 const synthesisId='real-'+(++trial),currentEpoch=++epoch
 for(let index=0;index<bytes.length;index++){const audioId=synthesisId+'-'+index;data.set(audioId,bytes[index]);await player!.receive({type:'audio',audioId,epoch:currentEpoch,binding:{} as any,segmentIndex:0,stream:{synthesisId,chunkIndex:index,sampleOffset:meta.chunks[index].sampleOffset,sampleCount:meta.chunks[index].samples}});if(index<bytes.length-1)await sleep(350)}
 const deadline=performance.now()+12000
 while(actions.filter(a=>a.epoch===currentEpoch&&a.type==='played').length<bytes.length&&performance.now()<deadline)await sleep(40)
 return currentEpoch
}
async function runTrial(name:'cold-stream'|'warm-stream'|'fresh-complete'){
 stage=name;if(name!=='warm-stream')createPlayer()
 const before={samples:observations.length,mouth:mouth.length,starts:starts.length,actions:actions.length},started=performance.now();let currentEpoch=epoch
 if(name==='fresh-complete'){const id='complete-'+(++trial);data.set(id,whole);currentEpoch=++epoch;await player!.receive({type:'audio',audioId:id,epoch:currentEpoch,binding:{} as any,segmentIndex:0});const deadline=performance.now()+12000;while(!actions.some(a=>a.type==='played'&&a.audioId===id)&&performance.now()<deadline)await sleep(40)}else currentEpoch=await stream()
 const output=observations.slice(before.samples),shape=mouth.slice(before.mouth),scheduled=starts.slice(before.starts),ack=actions.slice(before.actions),firstSample=output.find(o=>o.kind==='sample'&&o.rms>.00001),firstMouth=shape.find(o=>o.level>0),errors=ack.filter(a=>a.error)
 return {name,epoch:currentEpoch,warmed:name==='warm-stream',elapsedMs:performance.now()-started,scheduled,contextAdvanced:output.filter(o=>o.kind==='sample').at(-1)?.contextTime??0,peakOutputRms:Math.max(0,...output.map(o=>o.rms??0)),firstOutputMs:firstSample?firstSample.at-started:null,firstMouthMs:firstMouth?firstMouth.at-started:null,firstMouthAfterOutputMs:firstSample&&firstMouth?firstMouth.at-firstSample.at:null,nonzeroMouth:!!firstMouth,closedAtEnd:qa.parameters().mouthOpen===0,played:ack.filter(a=>a.type==='played').length,errors,observations:output,mouth:shape}
}
let video:string|null=null
async function recordDemo(){
 if(!context||!gain)throw Error('QA_NO_OUTPUT_GRAPH')
 stage='recorded actual Belle voice';const videoCanvas=document.createElement('canvas');videoCanvas.width=500;videoCanvas.height=560;const draw=videoCanvas.getContext('2d')!,original=document.querySelector('canvas')!,destination=context.createMediaStreamDestination();gain.connect(destination)
 const stream=videoCanvas.captureStream(30);stream.addTrack(destination.stream.getAudioTracks()[0]);const mime=['video/webm;codecs=vp9,opus','video/webm;codecs=vp8,opus'].find(type=>MediaRecorder.isTypeSupported(type));if(!mime)throw Error('QA_RECORDER_UNAVAILABLE')
 const recorder=new MediaRecorder(stream,{mimeType:mime,videoBitsPerSecond:1800000}),parts:Blob[]=[];recorder.ondataavailable=e=>{if(e.data.size)parts.push(e.data)}
 let label='Actual Belle VoxCPM2 · mouth only',animation=0,stopped=false
 const render=()=>{draw.fillStyle='#f4f3f5';draw.fillRect(0,0,500,560);draw.fillStyle='#282334';draw.font='16px system-ui';draw.fillText(label,15,28);draw.fillText(document.querySelector('#level')!.textContent!,15,55);draw.drawImage(original,20,80,460,460);if(!stopped)animation=requestAnimationFrame(render)};render();recorder.start(250)
 const marks:any[]=[];const mark=(value:string)=>{label=value;marks.push({...stamp(),label:value,mouthOpen:qa.parameters().mouthOpen})}
 const id='demo-'+(++trial);data.set(id,whole);await player!.receive({type:'audio',audioId:id,epoch:++epoch,binding:{} as any,segmentIndex:0});await sleep(1700);player!.setVolume(0);await sleep(80);mark('Muted · mouth closed');const muteClosed=qa.parameters().mouthOpen===0;await sleep(800);player!.setVolume(.5);mark('Unmuted · actual audio resumes');await sleep(1600);player!.stop();await sleep(80);mark('Stopped · mouth closed');const stopClosed=qa.parameters().mouthOpen===0;await sleep(900)
 const done=new Promise<void>(resolve=>recorder.onstop=()=>resolve());recorder.stop();await done;stopped=true;cancelAnimationFrame(animation);gain.disconnect(destination);destination.disconnect();stream.getTracks().forEach(track=>track.stop());const blob=new Blob(parts,{type:mime});video=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve((reader.result as string).slice((reader.result as string).indexOf('base64,')+7));reader.onerror=reject;reader.readAsDataURL(blob)})
 return {mime,bytes:blob.size,marks,muteClosed,stopClosed,durationMs:5160}
}
const api={setup,runTrial,recordDemo,video:()=>video,diagnostics:()=>({starts,ended,actions,observations,mouth}),async dispose(){player?.dispose();quietOutput?.stream.getTracks().forEach(track=>track.stop());qa.dispose();await sleep(120)}}
;(window as any).realLipQa=api
