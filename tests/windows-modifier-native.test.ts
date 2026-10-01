import {afterEach,expect,it,vi} from 'vitest'
import {spawn,execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {access,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
const exec=promisify(execFile),native=resolve('dist-electron/native')
const run=it.skipIf(process.platform!=='win32'||process.env.DAEMONLET_WINDOWS_MODIFIER_TESTS!=='1')
const cleanup:(()=>Promise<void>)[]=[]
afterEach(async()=>{for(const f of cleanup.splice(0).reverse())await f()})
run('native policy accepts left Alt alone and rejects every right Alt/Ctrl/Shift/Win combination',async()=>{
 for(let flags=0;flags<64;flags++){
  const {stdout,stderr}=await exec(join(native,'DaemonletModifierStateQA.exe'),['--policy',String(flags)],{windowsHide:true})
  expect(stdout).toBe(flags===1?'1\n':'0\n');expect(stderr).toBe('')
 }
 await expect(exec(join(native,'DaemonletModifierState.exe'),['--policy','1'],{windowsHide:true})).rejects.toThrow()
},15000)
run('current-state helper emits only bounded LF booleans and exits when its app read pipe closes',async()=>{
 const child=spawn(join(native,'DaemonletModifierState.exe'),[],{windowsHide:true,stdio:['ignore','pipe','ignore']})
 cleanup.push(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill()})
 let output='';child.stdout.on('data',b=>output+=b.toString('ascii'))
 await vi.waitFor(()=>expect(output.split('\n').filter(Boolean).length).toBeGreaterThanOrEqual(3))
 expect(output).toMatch(/^(?:[01]\n)+$/);child.stdout.destroy()
 await vi.waitFor(()=>expect(child.exitCode).toBe(0),{timeout:3000})
})
run('app parent termination closes the helper pipe and retires the helper without a process sweep',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'daemonlet-modifier-parent-test-'));cleanup.push(()=>rm(dir,{recursive:true,force:true}))
 const script=join(dir,'parent.cjs'),evidence=join(dir,'pid.txt')
 await writeFile(script,`const {spawn}=require('node:child_process'),fs=require('node:fs');const child=spawn(${JSON.stringify(join(native,'DaemonletModifierState.exe'))},[],{stdio:['ignore','pipe','ignore'],windowsHide:true});child.stdout.on('data',()=>fs.writeFileSync(${JSON.stringify(evidence)},String(child.pid)));setInterval(()=>{},1000)`)
 const parent=spawn(process.execPath,[script],{stdio:'ignore',windowsHide:true});cleanup.push(async()=>{if(parent.exitCode===null&&parent.signalCode===null)parent.kill()})
 await vi.waitFor(async()=>{await access(evidence)});const pid=Number(await readFile(evidence,'utf8'))
 expect(()=>process.kill(pid,0)).not.toThrow();parent.kill()
 await vi.waitFor(()=>expect(()=>process.kill(pid,0)).toThrow(),{timeout:3000})
})
