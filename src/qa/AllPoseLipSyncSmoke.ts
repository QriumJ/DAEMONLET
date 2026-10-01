import {Anime25DRuntime} from '../engine/anime25d/Anime25DRuntime'
import {DEFAULT_PARAMETERS} from '../engine/anime25d/Anime25DParameters'
import {audioMouthParameters,speechClosedExpression} from '../engine/anime25d/AudioMouth'
import {deformMouthPoint} from '../engine/anime25d/MouthMorph'
import {parsePoseManifest} from '../pose/PoseManifest'
import {AudioPlaybackController} from '../character-chat/AudioPlaybackController'
const canvas=document.querySelector('canvas')!,runtime=new Anime25DRuntime(canvas),sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms))
let entries:any[]=[],asset:any,current='',player:AudioPlaybackController|null=null,ctx:AudioContext|null=null,destination:MediaStreamAudioDestinationNode|null=null
const samples:any[]=[],levels:any[]=[],bytes=new Map<string,Uint8Array>(),fixed={...DEFAULT_PARAMETERS}
const renderer=runtime.renderer as any
async function init(){const pack=await fetch('pack/pack.json').then(r=>r.json());entries=await Promise.all(pack.files.filter((f:any)=>/^poses\/[^/]+\/pose.json$/.test(f.path)).map(async(f:any)=>({manifestUrl:new URL('pack/'+f.path,location.href).href,manifest:parsePoseManifest(await fetch('pack/'+f.path).then(r=>r.json())).value})));return entries.map(e=>e.manifest.id)}
async function load(id:string){
 const entry=entries.find(e=>e.manifest.id===id);if(!entry)throw Error('POSE_NOT_FOUND')
 runtime.stop();runtime.unload();const base=new URL('.',entry.manifestUrl)
 const [buffer,overrides]=await Promise.all([fetch(new URL(entry.manifest.psd,base)).then(r=>r.arrayBuffer()),fetch(new URL(entry.manifest.overrides,base)).then(r=>r.json())])
 const result=runtime.loader.loadArrayBuffer(buffer,id,overrides);asset=await runtime.poseLoader.load(entry.manifestUrl,result.model.rig,{manifest:entry.manifest,prepared:result})
 runtime.applyPreparedCharacter(result,{characterId:'belle-isolated',sourceReferenceUrl:new URL(entry.manifest.source,base).href},entries,[asset]);runtime.setAutoBlink(false);runtime.start();await runtime.transitionToPose(id);await sleep(60);runtime.stop();current=id
 return {pose:id,state:runtime.getDiagnostics().pose?.state,closed:speechClosedExpression(result.model.rig.anchors.mouth.speechMorph??result.model.rig.anchors.mouth.morph!),layers:result.model.rig.layers.length}
}
function render(level:0|1|2|null){
 runtime.setAudioMouth(level);const mouth=audioMouthParameters(fixed,level,asset,'ACTIVE_LOOP',false)
 renderer.render(fixed,7777,false,mouth===fixed?undefined:mouth)
 const layers=renderer.poseLayers.map((l:any)=>({name:l.name,mouth:l.mouthExpression,vertices:Array.from(l.current),alpha:renderer.fadeAlpha(l,fixed),indices:Array.from(l.indices),base:Array.from(l.base)}))
 const profile=asset.result.model.rig.anchors.mouth.speechMorph??asset.result.model.rig.anchors.mouth.morph,closed=speechClosedExpression(profile),gaps=[]
 if(level!==null)for(let i=0;i<profile.open.upper.length;i++){
  const t=i/(profile.open.upper.length-1),x=profile.center.cx+profile.open.u0+(profile.open.u1-profile.open.u0)*t
  const top=deformMouthPoint(x,profile.center.cy+profile.open.upper[i],'open',mouth.mouthOpen,0,profile,closed!),bottom=deformMouthPoint(x,profile.center.cy+profile.open.lower[i],'open',mouth.mouthOpen,0,profile,closed!)
  gaps.push(Math.hypot(bottom[0]-top[0],bottom[1]-top[1]))
 }
 return {layers,gap:Math.max(0,...gaps),mouthOpen:mouth.mouthOpen,canvas:canvas.toDataURL('image/png').split(',')[1]}
}
function proof(){
 const stages=[render(0),render(1),render(2)],nonmouth=stages[0].layers.filter((l:any)=>!l.mouth)
 const nonmouthIdentical=stages.slice(1).every(s=>nonmouth.every((l:any)=>{const other=s.layers.find((o:any)=>o.name===l.name);return l.alpha===other.alpha&&l.vertices.every((v:number,i:number)=>v===other.vertices[i])}))
 const finite=stages.every(s=>s.layers.every((l:any)=>l.vertices.every(Number.isFinite)))
 let flipped=0;for(const s of stages)for(const l of s.layers)for(let i=0;i<l.indices.length;i+=3){const [a,b,c]=l.indices.slice(i,i+3);const area=(v:number[])=>((v[b*2]-v[a*2])*(v[c*2+1]-v[a*2+1])-(v[b*2+1]-v[a*2+1])*(v[c*2]-v[a*2]));if(area(l.base)*area(l.vertices)<-.01)flipped++}
 const closed=[0,1,2].map((_,i)=>stages[i].layers.filter((l:any)=>l.mouth!=='open'&&l.mouth).filter((l:any)=>l.alpha>0).length)
 const anchor=asset.result.model.rig.anchors.mouth,independent=renderer.poseLayers.find((l:any)=>l.independent)?.independent
 const normal=render(null),speechProfile=independent.anchors.mouth.speechMorph
 delete independent.anchors.mouth.speechMorph;const original=render(null);if(speechProfile)independent.anchors.mouth.speechMorph=speechProfile
 const nonAudioPreserved=normal.layers.every((l:any)=>{const other=original.layers.find((o:any)=>o.name===l.name);return l.alpha===other.alpha&&l.vertices.every((v:number,i:number)=>v===other.vertices[i])})
 return {id:current,center:anchor.speechMorph?.center??anchor.morph?.center,nonmouthIdentical,nonmouthCount:nonmouth.length,nonAudioPreserved,finite,flipped,gaps:stages.map(s=>s.gap),closedLayers:closed,images:stages.map(s=>s.canvas)}
}
async function transitions(){runtime.start();runtime.setAudioMouth(2);const before=runtime.getAudioMouthOpen();await runtime.transitionToPose('bored');const noFresh=(runtime as any).audioMouth.get();runtime.setAudioMouth(2);await sleep(50);const fresh=runtime.getAudioMouthOpen();runtime.setAudioMouth(0);await sleep(30);const zero=runtime.getAudioMouthOpen();await sleep(300);const released=(runtime as any).audioMouth.get();runtime.stop();return {before,noFresh,fresh,zero,released}}
function createPlayer(){player?.dispose();destination?.stream.getTracks().forEach(t=>t.stop());ctx=null;destination=null;samples.length=0;levels.length=0
 player=new AudioPlaybackController({audio:async (id:string)=>bytes.get(id)!,action:async()=>({})} as any,()=>{ctx=new AudioContext({sampleRate:48000});destination=ctx.createMediaStreamDestination();const factory=ctx.createAnalyser.bind(ctx);ctx.createAnalyser=()=>{const node=factory(),connect=node.connect.bind(node),sample=node.getFloatTimeDomainData.bind(node);node.connect=((target:AudioNode)=>connect(target===ctx!.destination?destination!:target)) as typeof node.connect;node.getFloatTimeDomainData=data=>{sample(data);samples.push({at:performance.now(),rms:Math.sqrt(data.reduce((sum,x)=>sum+x*x,0)/data.length),contextTime:ctx!.currentTime})};return node};return ctx},{sink:(level,epoch)=>{runtime.setAudioMouth(level);levels.push({at:performance.now(),level,epoch})}});player.setVolume(.5)}
async function voice(id:string){await load(id);runtime.start();createPlayer();const buffer:ArrayBuffer=await fetch('voice/belle-actual.wav').then(r=>r.arrayBuffer());const wav=new Uint8Array(buffer);bytes.set('actual',wav);const started=performance.now();await player!.receive({type:'audio',audioId:'actual',epoch:1,binding:{},segmentIndex:0} as any);await sleep(500);const playing=levels.some(l=>l.level>0),firstSample=samples.find(s=>s.rms>.0001),firstMouth=levels.find(l=>l.level>0);player!.setVolume(0);await sleep(400);const muted=(runtime as any).audioMouth.get()===0;const unmuteAt=performance.now();player!.setVolume(.5);const deadline=unmuteAt+1600;while(!levels.some(l=>l.at>=unmuteAt&&l.level>0)&&performance.now()<deadline)await sleep(40);const resumed=levels.some(l=>l.at>=unmuteAt&&l.level>0),resumedPcm=samples.some(s=>s.at>=unmuteAt&&s.rms>.01);await ctx!.suspend();await sleep(400);const paused=(runtime as any).audioMouth.get()===0;await ctx!.resume();const resumeAt=performance.now();while(!levels.some(l=>l.at>=resumeAt&&l.level>0)&&performance.now()<resumeAt+1600)await sleep(40);const pauseResumed=levels.some(l=>l.at>=resumeAt&&l.level>0);player!.stop();await sleep(40);const stopped=(runtime as any).audioMouth.get()===0;await sleep(300);const released=(runtime as any).audioMouth.get()===null;runtime.stop();return {id,playing,muted,resumed,resumedPcm,paused,pauseResumed,stopped,released,speakerOutput:false,silentPrewarm:false,firstPcmMs:firstSample?firstSample.at-started:null,firstMouthMs:firstMouth?firstMouth.at-started:null}}
const qa={init,load,render,proof,transitions,voice,dispose(){player?.dispose();destination?.stream.getTracks().forEach(t=>t.stop());runtime.stop();runtime.unload()}}
;(window as any).allPoseQa=qa
