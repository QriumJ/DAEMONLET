import {mkdtemp,mkdir,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {spawn} from 'node:child_process'
import {build} from 'esbuild'
import electron from 'electron'
const root=resolve(import.meta.dirname,'..'),profile=await mkdtemp(join(tmpdir(),'daemonlet-belle-ui-')),evidence=resolve(process.env.BELLE_QA_EVIDENCE??join(profile,'evidence'))
await mkdir(evidence,{recursive:true})
const entry=join(profile,'smoke.cjs');await build({entryPoints:[join(root,'electron/main/dot/BelleConnectionUiSmoke.ts')],outfile:entry,bundle:true,platform:'node',target:'node24',format:'cjs',external:['electron'],logLevel:'warning'})
const env={BELLE_QA_ROOT:root,BELLE_QA_EVIDENCE:evidence,ELECTRON_SMOKE_USER_DATA:profile,ELECTRON_SMOKE_TEST:'1'}
for(const k of ['HOME','PATH','LANG','TMPDIR'])if(process.env[k])env[k]=process.env[k]
const child=spawn(electron,[entry],{cwd:root,env,stdio:'ignore'}),timer=setTimeout(()=>child.kill('SIGTERM'),60000)
const code=await new Promise(resolve=>child.once('exit',resolve));clearTimeout(timer)
let result;try{result=JSON.parse(await readFile(join(evidence,'result.json'),'utf8'))}catch{result={passed:false,error:'NO_UI_RESULT'}}
await rm(profile,{recursive:true,force:true});console.log(JSON.stringify({evidence,...result}));if(code!==0||!result.passed)process.exitCode=1
