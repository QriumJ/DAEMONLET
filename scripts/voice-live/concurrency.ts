/** Opt-in real-device benchmark. Reuses the production Gemma supervisor/settings. */
import {RuntimeSupervisor} from '../../electron/main/character-chat/RuntimeSupervisor'
import {CHAT_MODELS,CHAT_RUNTIME_COMMIT} from '../../electron/main/character-chat/catalog'
import {speechSegments} from '../../electron/shared/character-voice-contract'
import {createHash,randomUUID} from 'node:crypto'
import {createReadStream} from 'node:fs'
import {readFile,writeFile,mkdir,stat} from 'node:fs/promises'
import {resolve,join} from 'node:path'
import {execFileSync} from 'node:child_process'
const flags=Object.fromEntries(process.argv.slice(2).reduce<string[][]>((a,v,i,all)=>i%2?a:[...a,[v.replace(/^--/,''),all[i+1]]],[]))
const root=resolve(flags.repo),out=resolve(flags.output),base=flags.voice||'http://127.0.0.1:47862'
if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(base)||out===root||out.startsWith(root+'/'))throw Error('Use loopback and new private output')
const model=CHAT_MODELS['12B'];const runtime=new RuntimeSupervisor(resolve(flags.binary))
const hashFile=async(p:string)=>{const h=createHash('sha256');for await(const b of createReadStream(p))h.update(b);return h.digest('hex')}
const now=()=>performance.timeOrigin+performance.now()
const report:any={status:'RUNNING',modelId:'12B',modelSha256:model.sha256,runtimeCommit:CHAT_RUNTIME_COMMIT,settings:'production RuntimeSupervisor, 8192 context, all layers Metal, 512 max tokens, fixed app sampling/schema',tts:'selected GGUF F16, CFG 2, 10 timesteps, seed 42',cases:[],llm:[],physicalListening:'NOT_TESTED',appIntegration:'NOT_TESTED'}
await mkdir(out,{recursive:false})
const save=()=>writeFile(join(out,'result.json'),JSON.stringify(report,null,2)+'\n')
const phase=async(s:string)=>{console.log(s);await writeFile(join(out,'phase.txt'),s);await save()}
function memory(){return {at:now(),vm:execFileSync('/usr/bin/vm_stat',{encoding:'utf8'}),swap:execFileSync('/usr/sbin/sysctl',['vm.swapusage'],{encoding:'utf8'})}}
let token='';
async function api(path:string,data:unknown){const r=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',Origin:base,'X-Live-Token':token},body:JSON.stringify(data),signal:AbortSignal.timeout(180000)});if(!r.ok)throw Error(await r.text());return r}
async function tts(label:string,text:string){
 const id=randomUUID(),started=now(),result:any={label,text,started,chunks:[],audioSamples:0};const digest=createHash('sha256');let index=0
 const response=await api('/stream',{id,text});const reader=response.body!.getReader();const decoder=new TextDecoder();let tail='',ended=false
 try{while(true){const x=await reader.read();if(x.done)break;tail+=decoder.decode(x.value,{stream:true});let pos:number;while((pos=tail.indexOf('\n'))>=0){const line=tail.slice(0,pos);tail=tail.slice(pos+1);if(!line)continue;const row=JSON.parse(line);if(row.id!==id)throw Error('TTS_ID');if(row.type==='end'){if(!row.cleanupComplete||row.cancelled||row.error)throw Error(row.error||'TTS_END');Object.assign(result,{ended:now(),nativeSeconds:row.seconds,pid:row.pid});ended=true;continue}if(row.index!==index++||row.offset!==result.audioSamples||row.pcm.some((v:number)=>!Number.isFinite(v)))throw Error('TTS_CHUNK');digest.update(Buffer.from(new Float32Array(row.pcm).buffer));result.chunks.push({at:now(),nativeSeconds:row.seconds,samples:row.pcm.length});result.audioSamples+=row.pcm.length;await api('/credit',{id,index:row.index})}}
 if(!ended)throw Error('TTS_NO_END')
 }finally{if(!ended)await api('/cancel',{id}).catch(()=>{})}
 result.audioSeconds=result.audioSamples/48000;result.rtf=result.nativeSeconds/result.audioSeconds;result.wallRtf=(result.ended-started)/1000/result.audioSeconds;result.firstChunkMs=result.chunks[0].at-started;result.pcmSha256=digest.digest('hex')
 const c=result.chunks;result.steadyRtf=(c.at(-1).nativeSeconds-c[0].nativeSeconds)/((result.audioSamples-c[0].samples)/48000);result.maxChunkGapMs=Math.max(...c.slice(1).map((r:any,i:number)=>(r.nativeSeconds-c[i].nativeSeconds)*1000))
 report.cases.push(result);await save();console.log(JSON.stringify({label,rtf:result.rtf,steadyRtf:result.steadyRtf,audioSeconds:result.audioSeconds,firstChunkMs:result.firstChunkMs}));return result
}
const fixed=['오빠, 오늘은 어떤 이야기를 할까?','먼저 파일을 확인할게. 문제가 없으면 다음 작업으로 넘어가자.']
let messages:any[]=[],serial=0
async function llm(label:string,onFirst=()=>{}){
 const trace:any={label,started:now(),visibleEvents:0};report.llm.push(trace)
 try{const reply=await runtime.generate([...messages,{role:'user',content:`비가 오는 날 책방에서 함께 하루를 보내는 장면을 너의 대사로 여섯 문장 정도 이야기해 줘. 250자 정도로 자연스럽게 이어 줘. 이번에는 ${++serial}번째 분위기로 조금 다르게 말해 줘.`}],text=>{if(!trace.firstText){trace.firstText=now();onFirst()}trace.lastText=now();trace.visibleEvents++;trace.characters=text.length});trace.reply=reply;trace.completed=true;return reply}
 catch(e){trace.error=String(e);return null}
 finally{trace.ended=now();await save()}
}
async function concurrent(label:string,text:string,waitFirst:boolean){
 let stop=false,first!:()=>void;const gate=new Promise<void>(r=>first=r);let jobs=0
 const work=(async()=>{while(!stop&&jobs++<12)await llm(label+'-llm-'+jobs,first)})()
 if(waitFirst)await Promise.race([gate,new Promise((_,reject)=>setTimeout(()=>reject(Error('LLM_FIRST_TIMEOUT')),45000).unref())])
 const result=await tts(label,text);stop=true;await runtime.cancel();await work
 const spans=report.llm.filter((j:any)=>j.label.startsWith(label+'-llm-'));result.llmBusyOverlapSeconds=spans.reduce((s:number,j:any)=>s+Math.max(0,Math.min(result.ended,j.ended)-Math.max(result.started,j.started))/1000,0);result.llmDecodeOverlapSeconds=spans.reduce((s:number,j:any)=>s+Math.max(0,Math.min(result.ended,j.lastText||j.ended)-Math.max(result.started,j.firstText||j.ended))/1000,0);result.llmSpans=spans.length;await save()
}
try{
 if((await stat(flags.model)).size!==model.bytes||await hashFile(flags.model)!==model.sha256)throw Error('12B model identity mismatch')
 const page=await(await fetch(base)).text();token=/name="live-token" content="([^"]+)"/.exec(page)![1]
 report.voiceInitial=await(await fetch(base+'/status')).json();if(!report.voiceInitial.ready||report.voiceInitial.busy)throw Error('Voice unavailable/busy')
 const source=await readFile(join(root,'electron/main/character-chat/CharacterChatService.ts'),'utf8');const policy=/^const policy='(.*)'$/m.exec(source)![1]
 const persona=JSON.parse(await readFile(join(flags.character,'persona.json'),'utf8')),chat=JSON.parse(await readFile(join(flags.character,'chat.json'),'utf8'))
 const binding={...persona,name:chat.profile.displayName||'Belle',examples:chat.profile.examples.length?[]:persona.examples.slice(0,4),chatProfile:chat.profile}
 messages=[{role:'system',content:policy+'\n캐릭터 자료:\n'+JSON.stringify(binding)+'\n사용자가 명시적으로 저장한 사실(현재 대화와 구분):\n[]'}]
 report.personaSha256=await hashFile(join(flags.character,'persona.json'));report.memoryBefore=memory()
 await phase('TTS_ONLY');await tts('tts-only-warmup',fixed[0]);for(let i=0;i<2;i++)await tts('tts-only-'+i,fixed[i])
 await phase('LOAD_GEMMA_12B');const load=now();await runtime.start(flags.model);report.llmLoadSeconds=(now()-load)/1000;report.llmProps=await runtime.api('/props');report.llmPid=(runtime as any).current.child.pid
 await phase('LLM_WARMUP');await llm('llm-warmup');
 for(let i=0;i<2;i++)await tts('llm-resident-idle-'+i,fixed[i])
 await phase('CONCURRENT_DECODE');for(let i=0;i<2;i++)await concurrent('decode-overlap-'+i,fixed[i],true)
 await phase('CONCURRENT_PREFILL');await concurrent('prefill-overlap',fixed[1],false)
 await phase('COMPLETED_REPLY_THEN_TTS');const reply=await llm('completed-reply');if(reply){for(const s of speechSegments(reply.text).slice(0,2))await tts('reply-segment-'+s.index,s.text)}
 const hold=Number(flags.hold||0)
 if(hold>0){await phase('LIVE_BROWSER_CONCURRENT_READY');const until=now()+Math.min(hold,90)*1000;while(now()<until)await llm('browser-live-overlap');}
 report.memoryAfter=memory();await writeFile(join(out,'llm-runtime.log'),(runtime as any).current?.log||'')
 report.status='PASS_MEASUREMENT_ONLY';await phase('MEASUREMENTS_COMPLETE')
}catch(e){report.status='FAIL';report.error=String(e);console.error(e);await save();process.exitCode=1}
finally{await runtime.stop();report.llmOwnedProcessStopped=true;await save()}
