import {mkdtemp,mkdir,writeFile,readFile,cp} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {createServer} from 'node:net'
import {randomBytes} from 'node:crypto'
import {spawn} from 'node:child_process'
import electron from 'electron'
const root=resolve(import.meta.dirname,'..'),profile=await mkdtemp(join(tmpdir(),'daemonlet-dot-smoke-')),evidence=resolve(process.env.ELECTRON_SMOKE_DOT_EVIDENCE??join(profile,'evidence')),home=join(profile,'codex')
await mkdir(home);await mkdir(evidence,{recursive:true})
if(process.env.ELECTRON_SMOKE_DOT_CHARACTER_STORE)await cp(resolve(process.env.ELECTRON_SMOKE_DOT_CHARACTER_STORE),join(profile,'characters'),{recursive:true})
const port=()=>new Promise((resolve,reject)=>{const s=createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const n=s.address().port;s.close(()=>resolve(n))})})
const result=join(evidence,'result.json')
await writeFile(join(profile,'desktop-settings.json'),JSON.stringify({version:1,characterId:process.env.ELECTRON_SMOKE_DOT_CHARACTER_ID??'gpichan',adapterAutoStart:false,updateAutoCheck:false,codexUsageEnabled:false,taskBubblesEnabled:true,speechBubblesEnabled:true,visible:true}))
await writeFile(join(profile,'codex-integration.json'),JSON.stringify({version:1,onboarding:'skipped',selection:{executablePath:null,codexHome:null},reviewedFingerprint:null}))
const env={...process.env,CODEX_HOME:process.env.ELECTRON_SMOKE_DOT_DESKTOP_HOME??home,CODEX_PET_DATA_DIR:join(profile,'adapter'),ELECTRON_SMOKE_USER_DATA:profile,ELECTRON_SMOKE_TEST:'1',ELECTRON_SMOKE_DOT:'1',ELECTRON_SMOKE_DOT_EVIDENCE:evidence,ELECTRON_SMOKE_RESULT:result,CODEX_PET_PROTOCOL_PORT:String(await port()),CODEX_PET_HOOK_PORT:String(await port()),DAEMONLET_DOT_BRIDGE:'1',DAEMONLET_DOT_PORT:String(await port()),DAEMONLET_DOT_TOKEN:randomBytes(32).toString('hex')}
delete env.ELECTRON_RUN_AS_NODE;delete env.DAEMONLET_DATA_HOME
const child=spawn(electron,[join(root,'dist-electron/main.cjs')],{cwd:root,env,stdio:['ignore','inherit','inherit']})
const timer=setTimeout(()=>{child.kill('SIGTERM')},120000)
const code=await new Promise(resolve=>child.once('exit',resolve));clearTimeout(timer)
let report;try{report=JSON.parse(await readFile(result,'utf8'))}catch{throw Error('DOT_SMOKE_NO_RESULT')}
process.stdout.write(JSON.stringify({profile,evidence,...report})+'\n');if(code!==0||!report.passed)process.exitCode=1
