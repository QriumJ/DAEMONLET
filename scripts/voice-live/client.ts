import {AudioPlaybackController} from '../../src/character-chat/AudioPlaybackController'
import type {VoiceApi,VoiceEvent} from '../../electron/shared/character-voice-contract'
const $=(id:string)=>document.getElementById(id)!
const token=(document.querySelector('meta[name="live-token"]') as HTMLMetaElement).content
const context=new AudioContext({sampleRate:48000})
let cleanupOk=true,starting=false
let epoch=0,active='',finished:Promise<void>=Promise.resolve(),endResolve=()=>{},generated=false,played=0,received=0,start=0,total=0,first=0,gaps=0,maxGap=0,pid=0
const cache=new Map<string,Uint8Array>(),indices=new Map<string,number>()
let sendChain=Promise.resolve()
const post=async(path:string,data:unknown)=>{const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json','X-Live-Token':token},body:JSON.stringify(data)});if(!r.ok)throw Error(await r.text());return r}
function log(text:string){$('log').textContent=(text+'\n'+$('log').textContent).slice(0,12000)}
function buttons(busy:boolean){($('start') as HTMLButtonElement).disabled=busy;($('stop') as HTMLButtonElement).disabled=!busy}
function stats(){ $('metrics').textContent=`worker PID ${pid} · 수신 ${received} / 재생 ${played} 청크 · 첫 재생 예약 ${first?first.toFixed(0)+'ms':'—'} · 공백 ${gaps}회 / 최대 ${maxGap.toFixed(1)}ms` }
const player=new AudioPlaybackController({
 audio:async(id:string)=>{const bytes=cache.get(id);if(!bytes)throw Error('retired audio');cache.delete(id);return bytes},
 action:async(v:any)=>{
  if(v.epoch!==epoch)return {} as any
  if(v.type==='scheduled'){if(!first)first=performance.now()-start+v.delayMs;if(v.gapMs>1){gaps++;maxGap=Math.max(maxGap,v.gapMs)}stats()}
  if(v.type==='played'){
   if(v.error){log('오디오 출력 오류');void stop();return {} as any}
   played++;const index=indices.get(v.audioId);indices.delete(v.audioId)
   if(active&&index!==undefined&&!generated){const id=active;sendChain=sendChain.then(()=>post('/credit',{id,index})).then(()=>{}).catch(e=>{log(String(e));void stop()})}
   stats();if(generated&&played===received){log('재생 완료');active='';buttons(false)}
  }
  return {} as any
 },subscribe:()=>()=>{},onEvent:()=>()=>{}
} as VoiceApi,()=>context)
player.setVolume(.35)
function wav(pcm:number[]){const a=new ArrayBuffer(44+pcm.length*2),v=new DataView(a);const s=(o:number,t:string)=>[...t].forEach((c,i)=>v.setUint8(o+i,c.charCodeAt(0)));s(0,'RIFF');v.setUint32(4,a.byteLength-8,true);s(8,'WAVE');s(12,'fmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,48000,true);v.setUint32(28,96000,true);v.setUint16(32,2,true);v.setUint16(34,16,true);s(36,'data');v.setUint32(40,pcm.length*2,true);pcm.forEach((x,i)=>{if(!Number.isFinite(x))throw Error('nonfinite');v.setInt16(44+i*2,Math.trunc(Math.max(-1,Math.min(1,x))*32767),true)});return new Uint8Array(a)}
async function stop(){const old=active;active='';++epoch;player.stop();cache.clear();indices.clear();if(old){log('출력 중단 · worker 정리 대기');try{await post('/cancel',{id:old});await finished;if(!cleanupOk)throw Error('Worker 정리 미확인 · 시험 서버를 다시 시작하세요');log('정리 확인 · 다시 생성 가능')}catch(e){log(String(e))}}buttons(false)}
async function run(){
 if(starting||active)return;starting=true
 try{await stop();await context.resume();if(context.state!=='running')throw Error('오디오 장치가 정지 상태입니다')}finally{starting=false}
 const id=crypto.randomUUID();active=id;const ownEpoch=++epoch;cleanupOk=false;generated=false;received=played=total=first=gaps=maxGap=0;start=performance.now();buttons(true);stats();log('실제 Metal 합성 시작');finished=new Promise(r=>endResolve=r)
 try{
  const r=await post('/stream',{id,text:($('text') as HTMLTextAreaElement).value});const reader=r.body!.getReader();const decoder=new TextDecoder();let tail='',sawEnd=false
  while(true){const x=await reader.read();if(x.done)break;tail+=decoder.decode(x.value,{stream:true});let n:number;while((n=tail.indexOf('\n'))>=0){const line=tail.slice(0,n);tail=tail.slice(n+1);if(!line)continue;const j=JSON.parse(line);if(j.id!==id)throw Error('발화 ID 불일치');if(j.type==='end'){sawEnd=true;if(!j.cleanupComplete||j.error)throw Error(j.error||'cleanup failed');cleanupOk=true;if(active===id){generated=true;log(`생성 완료 · ${j.samples/48000}초 · 생성·대기 RTF ${(j.seconds/(j.samples/48000)).toFixed(3)} · PID ${j.pid}`);if(played===received){active='';buttons(false)}}continue}if(active!==id||epoch!==ownEpoch)continue;
   if(j.type!=='chunk'||j.index!==received||j.offset!==total||!Array.isArray(j.pcm)||!j.pcm.length||j.pcm.length>48000)throw Error('청크 순서/크기 오류')
   const audioId=id+':'+j.index;cache.set(audioId,wav(j.pcm));indices.set(audioId,j.index);received++;total+=j.pcm.length;stats();await player.receive({type:'audio',epoch:ownEpoch,audioId,binding:{} as any,segmentIndex:0,stream:{synthesisId:id,chunkIndex:j.index,sampleOffset:j.offset,sampleCount:j.pcm.length}} as VoiceEvent)
  }}
  if(!sawEnd)throw Error('Worker cleanup acknowledgment missing')
 }catch(e){log('시험 오류: '+e);if(active===id){active='';++epoch;player.stop();buttons(false);void post('/cancel',{id}).catch(()=>{})}}
 finally{endResolve()}
}
$('start').onclick=()=>void run().catch(e=>log(String(e)))
$('stop').onclick=()=>void stop()
$('volume').oninput=()=>player.setVolume(Number(($('volume') as HTMLInputElement).value))
$('example').onclick=()=>{($('text') as HTMLTextAreaElement).value='먼저 파일을 확인할게. 문제가 없으면 다음 작업으로 넘어가자.'}
window.addEventListener('pagehide',()=>{player.stop();if(active)navigator.sendBeacon('/cancel',JSON.stringify({id:active,token}))})
document.addEventListener('visibilitychange',()=>{if(document.hidden)void stop()})
fetch('/status').then(r=>r.json()).then(s=>{if(!s.ready)throw Error('Worker is not ready');pid=s.pid;stats();$('status').textContent='Metal FP16 준비됨 · 저장 WAV가 아닌 실시간 합성';buttons(false)}).catch(e=>log(String(e)))
;(window as any).liveVoice={run,stop,snapshot:()=>({pid,active,epoch,received,played,first,gaps,maxGap,generated,context:context.state})}
