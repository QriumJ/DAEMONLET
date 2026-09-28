// Explicit private service probe. Renderer acknowledgements are synthetic: this
// measures verification/loading/first delivery, not native audio-device playback.
import {mkdir,writeFile} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import assert from 'node:assert/strict'
import {CharacterVoiceService} from '../electron/main/character-voice/CharacterVoiceService'
import {VoiceBaseInstaller} from '../electron/main/character-voice/VoiceBaseInstaller'
import {WindowsVoiceInstaller} from '../electron/main/character-voice/WindowsVoiceInstaller'
import {TtsRuntimeSupervisor} from '../electron/main/character-voice/TtsRuntimeSupervisor'
import type {LocalChatSnapshot,ChatMessage} from '../electron/shared/character-chat-contract'
import type {ExecutionProfile} from '../electron/shared/character-voice-contract'
const [kind,installed,resources,output,compilerCache]=process.argv.slice(2)
if(!['metal','cuda'].includes(kind)||!output)throw Error('Pass metal|cuda, installation root, voice resources, NEW result root, optional compiler cache')
const root=resolve(output);await mkdir(root)
const report:any={status:'RUNNING',scope:'production service with synthetic renderer acknowledgements; no native GUI/audio',kind,modes:[]}
for(const complete of [false,true]){
 const mode:ExecutionProfile=kind==='metal'?(complete?'gguf-metal-f16-complete':'gguf-metal-f16'):(complete?'cuda-compiled-complete':'cuda-compiled')
 const base=kind==='metal'?new VoiceBaseInstaller(resolve(installed),join(resolve(resources),'base-native'),()=>{}):new WindowsVoiceInstaller(resolve(installed),resolve(resources),()=>{})
 const counts={fullVerifications:0,pythonVerifications:0,modelHashPasses:0},diagnostics:any[]=[],workers:TtsRuntimeSupervisor[]=[]
 const ready=base.ready.bind(base);base.ready=async()=>{++counts.fullVerifications;return ready()}
 if(base instanceof WindowsVoiceInstaller){const run=(base as any).run.bind(base);(base as any).run=(exe:string,args:string[],...rest:any[])=>{if(args.includes('--verify'))++counts.pythonVerifications;return run(exe,args,...rest)};const check=(base as any).checkFile.bind(base);(base as any).checkFile=(...args:any[])=>{++counts.modelHashPasses;return check(...args)}}
 else{const verify=base.verify.bind(base);base.verify=async signal=>{++counts.modelHashPasses;return verify(signal)}}
 const chat={epoch:1,model:'12B',character:{id:'diagnostic',revision:'1'},conversation:{id:'diagnostic',messages:[]}} as unknown as LocalChatSnapshot
 const service=new CharacterVoiceService(join(root,mode),join(resolve(resources),'worker.py'),()=>chat,()=>{},event=>{
  if(event.type==='audio')queueMicrotask(()=>{service.audio(event.audioId,event.epoch);service.scheduled(event.audioId,event.epoch,0,0);service.played(event.audioId,event.epoch)})
 },config=>{const worker=new TtsRuntimeSupervisor({...config,...(compilerCache?{compilerCache:resolve(compilerCache)}:{})});workers.push(worker);return worker},value=>diagnostics.push(value),base)
 const result:any={mode,counts,utterances:[]};report.modes.push(result)
 try{
  const init=Date.now();await service.initialize();result.offInitializeMs=Date.now()-init;assert.equal(counts.fullVerifications,0);assert.equal(counts.pythonVerifications,0);assert.equal(service.snapshot().runtimeConfigured,true)
  await service.executionProfile(mode);service.setOutputReady(true);await service.enabled(true)
  let session:string|undefined
  for(const [index,text] of ['응, 듣고 있어.','내일 오후 세 시에 다시 확인해 줘.','오늘도 수고 많았어.'].entries()){
   const message:ChatMessage={id:'sample-'+index,role:'assistant',status:'complete',text,createdAt:'diagnostic',binding:{characterId:'diagnostic',revision:'1',conversationId:'diagnostic',requestId:'request-'+index,epoch:1,personaHash:'test',semanticHash:'test',modelId:'12B' as any}}
   chat.conversation!.messages.push(message);const begin=diagnostics.length
   await (service as any).read(message)
   assert.equal(service.snapshot().status,'idle');assert.equal(service.snapshot().error,null)
   const rows=diagnostics.slice(begin),runtime=workers.at(-1)!;session??=runtime.sessionId;assert.equal(runtime.sessionId,session)
   result.utterances.push({verification:rows.find(v=>v.type==='base-verification'),firstChunkMs:rows.find(v=>v.type==='audio-chunk')?.firstChunkReadyMs??null,firstDeliveryMs:rows.find(v=>v.type==='playback-scheduled'&&v.first)?.firstPlaybackMs,rtfs:rows.filter(v=>['audio-ready','synthesis-finished'].includes(v.type)).map(v=>v.rtf),session})
  }
  assert.equal(counts.fullVerifications,1);assert.equal(counts.pythonVerifications,kind==='cuda'?1:0)
  assert.deepEqual(result.utterances.map((v:any)=>v.verification.reused),[false,true,true]);result.status='PASS'
 }catch(e){result.status='FAIL';result.error=String(e);report.status='FAIL';throw e}
 finally{await service.close();result.ownedWorkersExited=workers.every(w=>!w.running);await writeFile(join(root,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(result))}
}
report.status='PASS';await writeFile(join(root,'report.json'),JSON.stringify(report,null,2))
