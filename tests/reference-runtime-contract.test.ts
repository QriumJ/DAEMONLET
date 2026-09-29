import {afterEach,expect,it} from 'vitest'
import {EventEmitter} from 'node:events'
import {PassThrough} from 'node:stream'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {TtsRuntimeSupervisor} from '../electron/main/character-voice/TtsRuntimeSupervisor'
const cleanup:Array<()=>Promise<unknown>>=[]
afterEach(async()=>{for(const fn of cleanup.splice(0))await fn()})
async function fixture(audit:Record<string,unknown>){
 const root=await mkdtemp(join(tmpdir(),'reference-contract-')),requests:any[]=[]
 const runtime=new TtsRuntimeSupervisor({nativeBase:true,python:process.execPath,model:root,worker:join(root,'worker'),cacheRoot:root,executionProfile:'gguf-metal-f16'},1000,()=>{
  const child:any=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.exitCode=null
  child.kill=()=>{child.exitCode=0;queueMicrotask(()=>child.emit('close',0));return true};child.stdin.on('data',(bytes:Buffer)=>{for(const line of bytes.toString().trim().split('\n')){const r=JSON.parse(line);requests.push(r);if(r.type==='init')queueMicrotask(()=>child.stdout.write(JSON.stringify({protocolVersion:1,requestId:r.requestId,type:'ready',seedContract:1,...audit})+'\n'));if(r.type==='shutdown')child.kill()}});return child
 });cleanup.push(async()=>{await runtime.stop();await rm(root,{recursive:true,force:true})})
 const condition={kind:'wav-reference' as const,path:join(root,'reference.wav'),sha256:'a'.repeat(64),fingerprint:'b'.repeat(64),preprocessingVersion:'mono-pcm16-round-v1',sampleRate:16000,samples:32000}
 return{runtime,root,condition,requests}
}
const valid={mode:'wav-reference',referenceContract:1,referenceSha256:'a'.repeat(64),conditioningFingerprint:'b'.repeat(64),referenceCacheBuilds:1,adapterSha256:null,defaultVoice:null}
it.each([{}, {...valid,mode:'base'},{...valid,referenceCacheBuilds:0},{...valid,adapterSha256:'adapter'},{...valid,defaultVoice:{description:'female'}},{...valid,conditioningFingerprint:'old'},{...valid,referenceContract:0}])('refuses unsupported or contaminated ready audit %j',async audit=>{
 const f=await fixture(audit);await expect(f.runtime.start(f.root,'key',f.condition)).rejects.toThrow('VOICE_REFERENCE_RUNTIME');expect(f.runtime.running).toBe(false)
})
it('binds managed condition at init and refuses stale speech before sending to worker',async()=>{
 const f=await fixture(valid);await f.runtime.start(f.root,'key',f.condition);expect(f.requests[0]).toMatchObject({conditioning:f.condition,baseModel:true});const session=f.runtime.sessionId;await f.runtime.start(f.root,'key',f.condition);expect(f.runtime.sessionId).toBe(session)
 await expect(f.runtime.stream('new speech',{effectiveSeed:42,runtimeSessionId:session,conditioningFingerprint:'old'} as any,0,async()=>{})).rejects.toThrow('VOICE_REFERENCE_BINDING');expect(f.requests.filter(r=>r.type==='stream')).toEqual([])
})
