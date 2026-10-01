import {afterEach,expect,it} from 'vitest'
import {mkdtempSync,readFileSync,rmSync,statSync,symlinkSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {nativeDiagnosticReader,numericDiagnostic,privateTunnelDiagnostics,type TunnelDiagnostic} from '../electron/main/dot/BelleTunnelDiagnostics'
const dirs:string[]=[]
afterEach(()=>{for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true})})
const event={source:3,phase:5,elapsedMs:12,win32:2,exit:0}
function file(){const dir=mkdtempSync(join(tmpdir(),'dots-numeric-'));dirs.push(dir);return join(dir,'diagnostic.jsonl')}
it('rejects secret, path, message, unknown fields and invalid numbers rather than stringifying them',()=>{
 for(const v of [null,[],{...event,key:'sk-canary'},{...event,path:'PRIVATE_PATH'},{...event,message:'PRIVATE'},{...event,win32:'2'},{...event,source:4},{...event,phase:33},{...event,http:600},{...event,exit:-1},{...event,elapsedMs:3600001},{...event,code:NaN},{...event,exit:Infinity}])expect(numericDiagnostic(v)).toBeNull()
 expect(numericDiagnostic(event)).toEqual(event)
})
it('parses split numeric supervisor messages and discards raw/oversized/client-schema output',()=>{
 const events:TunnelDiagnostic[]=[],read=nativeDiagnosticReader(e=>events.push(e)),line=JSON.stringify(event)+'\n'
 read(Buffer.from(line.slice(0,15)));read(Buffer.from(line.slice(15)+'PRIVATE_CANARY\n'+JSON.stringify({...event,raw:'sk-canary'})+'\n'+'x'.repeat(300)+'\n'+JSON.stringify({...event,source:2})+'\n'+line))
 expect(events).toEqual([event,event]);expect(JSON.stringify(events)).not.toContain('canary')
 read(Buffer.alloc(33000,120));read(Buffer.from(line));expect(events).toHaveLength(2)
})
it('writes only numeric schema with private permissions and bounds events and existing size',()=>{
 const path=file(),sink=privateTunnelDiagnostics(path);for(let i=0;i<300;i++)sink(event)
 const text=readFileSync(path,'utf8');expect(text.trim().split('\n')).toHaveLength(256);expect(statSync(path).size).toBeLessThan(131072)
 if(process.platform!=='win32')expect(statSync(path).mode&0o777).toBe(0o600)
 writeFileSync(path,'x'.repeat(131072));privateTunnelDiagnostics(path)(event);expect(statSync(path).size).toBe(131072)
})
it.skipIf(process.platform==='win32')('refuses symlinks and never overwrites their target',()=>{
 const path=file(),target=path+'.target';writeFileSync(target,'UNCHANGED');symlinkSync(target,path);privateTunnelDiagnostics(path)(event);expect(readFileSync(target,'utf8')).toBe('UNCHANGED')
})
