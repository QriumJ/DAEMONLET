import {afterEach,expect,it,vi} from 'vitest'
import {EventEmitter} from 'node:events'
import policy from '../electron/voice/runtime-gguf-windows-voxcpm2.json'
import defaultVoice from '../electron/voice/base-voice-defaults.json'
import type {ReferenceCondition} from '../electron/main/character-voice/ReferenceProfileStore'
const exec=vi.hoisted(()=>vi.fn())
vi.mock('node:child_process',()=>({execFile:exec}))
import {checkWindowsModel} from '../electron/main/character-voice/WindowsModelCheck'
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();exec.mockReset()})
const configured={runtimeDir:'/runtime',derivativeDir:'/derivative',receipt:'/receipt.json',package:'/trained-package',executionProfile:'gguf-vulkan-f16-complete' as const}
const [packageSha256,derivative]=Object.entries(policy.derivatives)[0]
const pass={status:'PASS',engine:'voxcpm2',executionProfile:'gguf-vulkan-f16',sourceCommit:policy.sourceCommit,packageSha256,adapterSha256:derivative.adapterSha256,referenceSha256:'a'.repeat(64),ggufVerification:'full-sha256',originalModelVerification:'provenance-and-presence',nativeExecuted:false}
const reference:ReferenceCondition={kind:'wav-reference',path:'/managed/reference.wav',sha256:'a'.repeat(64),fingerprint:'b'.repeat(64),preprocessingVersion:'mono-pcm16-round-v1',sampleRate:24000,samples:48000}
const publicPass=(mode:'base'|'wav-reference')=>({...pass,ggufModelKind:'public-base',mode,referenceContract:1,referenceCacheBuilds:mode==='base'?0:1,referenceSha256:mode==='base'?null:reference.sha256,conditioningFingerprint:mode==='base'?null:reference.fingerprint,defaultVoice:mode==='base'?structuredClone(defaultVoice):null,modelRepository:policy.publicModel.repo,modelRevision:policy.publicModel.revision,modelFiles:structuredClone(policy.publicModel.files),publisher:policy.publicModel.repo.split('/')[0],packageSha256:null,adapterSha256:null,originalModelVerification:'not-applicable-public-gguf'})
function fixture(publicMode?:'base'|'wav-reference'){
 vi.stubGlobal('process',{...process,platform:'win32'})
 let callback!:(error:Error|null,stdout:string)=>void,tree!:(error:Error|null)=>void
 const child=Object.assign(new EventEmitter(),{pid:12345,kill:vi.fn()})
 exec.mockImplementation((command,_args,_options,cb)=>{if(command==='taskkill.exe'){tree=error=>cb(error,'');return new EventEmitter()};callback=cb;return child})
 const controller=new AbortController(),promise=checkWindowsModel('/python',publicMode?configured.derivativeDir:'/original-model','/voice/worker.py','voxcpm2',controller.signal,{gguf:publicMode?{...configured,package:''}:configured,...(publicMode?{ggufModelKind:'public-base' as const}:{}),...(publicMode==='wav-reference'?{conditioning:reference}:{})})
 return{child,controller,promise,complete:(value:object=publicMode?publicPass(publicMode):pass)=>callback(null,JSON.stringify(value)),treeDone:()=>tree(null)}
}
it('runs only the isolated CPU verification CLI with explicit original/package/derivative/runtime/profile arguments',async()=>{
 const f=fixture()
 expect(exec.mock.calls[0].slice(0,2)).toEqual(['/python',['-I','-B','/voice/voxcpm_windows_gguf_runtime.py','--verify','--package','/trained-package','--model','/original-model','--runtime-dir','/runtime','--derivative-dir','/derivative','--receipt','/receipt.json','--execution-profile','gguf-vulkan-f16']])
 expect(exec.mock.calls[0][2]).toMatchObject({windowsHide:true,env:{PYTHONNOUSERSITE:'1',PYTHONDONTWRITEBYTECODE:'1'}})
 let settled=false;const task=f.promise.then(()=>settled=true);f.complete();await Promise.resolve();expect(settled).toBe(false);f.child.emit('close');await task
})
it.each([{nativeExecuted:true},{executionProfile:'gguf-cuda-f16'},{engine:'qwen3-tts-06b-gguf'},{sourceCommit:'other'},{ggufVerification:'size-only'},{originalModelVerification:'full-sha256'},{adapterSha256:'c'.repeat(64)},{packageSha256:'c'.repeat(64)},{packageSha256:'__proto__',adapterSha256:undefined},{referenceSha256:'private invalid'},{status:'FAIL',code:'VOX_GGUF_BUILD_PENDING'}])('rejects incomplete or mismatched GGUF verification %j',async changed=>{
 const f=fixture(),task=f.promise.catch(e=>e.message);f.complete({...pass,...changed});f.child.emit('close');expect(await task).toBe('VOICE_MODEL_CHECK_FAILED')
})
it('abort waits for its own checker tree and drained pipes before a late PASS can settle',async()=>{
 const f=fixture();let settled=false;const task=f.promise.catch(e=>e.message).finally(()=>settled=true)
 f.controller.abort();expect(exec.mock.calls[1].slice(0,2)).toEqual(['taskkill.exe',['/PID','12345','/T','/F']]);expect(f.child.kill).not.toHaveBeenCalled();f.complete();f.child.emit('close');await Promise.resolve();expect(settled).toBe(false);f.treeDone();expect(await task).toBe('VOICE_MODEL_CHECK_CANCELLED')
})
it('the existing owned deadline applies to full GGUF hashes without Node parent-only termination',async()=>{
 vi.useFakeTimers();const f=fixture(),task=f.promise.catch(e=>e.message)
 await vi.advanceTimersByTimeAsync(600000);expect(exec.mock.calls[1][1]).toEqual(['/PID','12345','/T','/F']);f.complete();f.treeDone();f.child.emit('close');expect(await task).toBe('VOICE_MODEL_CHECK_FAILED')
})
it.each([{...configured,derivativeDir:'relative'},{...configured,receipt:'relative'},{...configured,package:'relative'},{...configured,executionProfile:'baseline' as const}])('rejects incomplete CPU verification inputs before launching %j',async gguf=>{
 await expect(checkWindowsModel('/python','/model','/worker.py','voxcpm2',new AbortController().signal,{gguf})).rejects.toThrow('VOICE_RUNTIME_CONFIG');expect(exec).not.toHaveBeenCalled()
})
it.each(['base','wav-reference'] as const)('runs public %s CPU validation directly on the pinned pair without a trained package',async mode=>{
 const f=fixture(mode),args=exec.mock.calls[0][1] as string[]
 expect(args).toEqual(['-I','-B','/voice/voxcpm_windows_gguf_runtime.py','--verify','--package','','--model','/derivative','--runtime-dir','/runtime','--derivative-dir','/derivative','--receipt','/receipt.json','--execution-profile','gguf-vulkan-f16','--model-kind','public-base',...(mode==='wav-reference'?['--conditioning-json',JSON.stringify(reference)]:[])])
 f.complete();f.child.emit('close');await expect(f.promise).resolves.toBeUndefined()
})
it.each([{ggufModelKind:'trained'},{modelRepository:'OpenBMB/VoxCPM2'},{modelRevision:'other'},{publisher:'OpenBMB'},{modelFiles:{}},{modelFiles:{...policy.publicModel.files,'VoxCPM2-Acoustic-F16.gguf':{...policy.publicModel.files['VoxCPM2-Acoustic-F16.gguf'],sha256:'d'.repeat(64)}}},{packageSha256},{adapterSha256:derivative.adapterSha256},{originalModelVerification:'provenance-and-presence'},{nativeExecuted:true},{mode:'wav-reference'},{referenceContract:0},{referenceCacheBuilds:1},{referenceSha256:reference.sha256},{conditioningFingerprint:reference.fingerprint},{defaultVoice:null},{defaultVoice:{...defaultVoice,description:'other'}},{defaultVoice:{...defaultVoice,seed:7}},{defaultVoice:{...defaultVoice,adapter:'private'}}])('rejects a public CPU check that claims trained assets or mismatched provenance %j',async changed=>{
 const f=fixture('base'),task=f.promise.catch(e=>e.message);f.complete({...publicPass('base'),...changed});f.child.emit('close');expect(await task).toBe('VOICE_MODEL_CHECK_FAILED')
})
it.each([{mode:'base'},{referenceContract:0},{referenceCacheBuilds:0},{referenceSha256:'d'.repeat(64)},{conditioningFingerprint:'d'.repeat(64)},{defaultVoice}])('requires the exact WAV preparation in public CPU verification %j',async changed=>{
 const f=fixture('wav-reference'),task=f.promise.catch(e=>e.message);f.complete({...publicPass('wav-reference'),...changed});f.child.emit('close');expect(await task).toBe('VOICE_MODEL_CHECK_FAILED')
})
it('does not admit public or trained helper results into each other’s selected route',async()=>{
 const trained=fixture(),t=trained.promise.catch(e=>e.message);trained.complete(publicPass('base'));trained.child.emit('close');expect(await t).toBe('VOICE_MODEL_CHECK_FAILED')
 const base=fixture('base'),b=base.promise.catch(e=>e.message);base.complete(pass);base.child.emit('close');expect(await b).toBe('VOICE_MODEL_CHECK_FAILED')
})
it.each([{model:'/original-model',package:''},{model:'/derivative',package:'/private-pack'}])('rejects public/original/trained path mixing before CPU launch %j',async paths=>{
 await expect(checkWindowsModel('/python',paths.model,'/voice/worker.py','voxcpm2',new AbortController().signal,{gguf:{...configured,package:paths.package},ggufModelKind:'public-base'})).rejects.toThrow('VOICE_RUNTIME_CONFIG');expect(exec).not.toHaveBeenCalled()
})
it('rejects oversized or non-public conditioning before starting the checker',async()=>{
 await expect(checkWindowsModel('/python','/original-model','/voice/worker.py','voxcpm2',new AbortController().signal,{gguf:configured,conditioning:reference})).rejects.toThrow('VOICE_RUNTIME_CONFIG')
 await expect(checkWindowsModel('/python','/derivative','/voice/worker.py','voxcpm2',new AbortController().signal,{gguf:{...configured,package:''},ggufModelKind:'public-base',conditioning:{...reference,path:'/'+ 'a'.repeat(8192)}})).rejects.toThrow('VOICE_RUNTIME_CONFIG');expect(exec).not.toHaveBeenCalled()
})
