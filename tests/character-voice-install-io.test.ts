import {it,expect,vi} from 'vitest'
import {createServer} from 'node:http'
import {mkdtemp,readFile,rm,stat} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {VoiceBaseInstaller} from '../electron/main/character-voice/VoiceBaseInstaller'
import {WindowsVoiceInstaller} from '../electron/main/character-voice/WindowsVoiceInstaller'
import catalog from '../electron/voice/base-model.json'
// Only capacity is synthetic. Real class admission, HTTP streaming, abort and
// partial-file IO execute; Windows is cancelled before any extraction/tool setup.
vi.mock('node:fs/promises',async original=>({...await original<typeof import('node:fs/promises')>(),statfs:vi.fn(async()=>({bavail:64*1024**3,bsize:1}))}))
for(const windows of [false,true])it(`${windows?'Windows':'Mac'}: real loopback download has one writer and cancellation retains partial bytes`,async()=>{
 const root=await mkdtemp(join(tmpdir(),'voice-install-io-'));let started!:()=>void,closed!:()=>void,requests=0
 const begun=new Promise<void>(r=>started=r),disconnected=new Promise<void>(r=>closed=r)
 const server=createServer((_req,res)=>{++requests;res.writeHead(200,{'content-length':'6'});res.write('abc');res.on('close',closed);started()})
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${(server.address() as any).port}/weights`
 const model=structuredClone(catalog);for(const f of Object.values(model.files)){f.bytes=6;f.sha256=createHash('sha256').update('abcdef').digest('hex')}
 const installer=windows?new WindowsVoiceInstaller(root,'/unused',()=>{}):new VoiceBaseInstaller(root,'/unused',()=>{}, {catalog:model,verifyRuntime:async()=>{},fetch:(_url,options)=>fetch(url,options)})
 ;(installer as any).status.supported=true
 const run=windows?vi.spyOn(installer as any,'run'):null,publish=vi.spyOn(installer as any,'publish')
 if(windows)vi.spyOn(installer as any,'assets').mockReturnValue([{name:'sample.bin',file:{url,bytes:6,sha256:createHash('sha256').update('abcdef').digest('hex')}}])
 const pending=installer.install()
 try{
  await begun;await vi.waitFor(()=>expect(installer.snapshot().bytes).toBe(3));expect(installer.install()).toBe(pending)
  await installer.cancel();await pending;await disconnected
  expect(requests).toBe(1);expect(installer.snapshot()).toMatchObject({installed:false,phase:'idle',error:null});expect(publish).not.toHaveBeenCalled();if(run)expect(run).not.toHaveBeenCalled()
  const partial=windows?join(root,'downloads/sample.bin'):join(installer.path+'.download','VoxCPM2-BaseLM-F16.gguf')
  expect(await readFile(partial,'utf8')).toBe('abc');await expect(stat(installer.path)).rejects.toThrow()
 }finally{await installer.cancel();await pending.catch(()=>{});server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await rm(root,{recursive:true,force:true});vi.restoreAllMocks()}
})
