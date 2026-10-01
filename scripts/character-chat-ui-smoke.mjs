import {mkdtemp,mkdir,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {spawn} from 'node:child_process'
import {build as bundle} from 'esbuild'
import {build as renderer} from 'vite'
import electron from 'electron'
const root=resolve(import.meta.dirname,'..'),profile=await mkdtemp(join(tmpdir(),'daemonlet-chat-ux-')),evidence=resolve(process.env.CHAT_QA_EVIDENCE??join(tmpdir(),'daemonlet-chat-ux-evidence'))
await mkdir(evidence,{recursive:true});await mkdir(join(profile,'dist-electron'),{recursive:true})
await renderer({root,build:{outDir:join(profile,'dist'),emptyOutDir:true},logLevel:'warn'})
const common={bundle:true,platform:'node',target:'node24',format:'cjs',external:['electron'],logLevel:'warning',define:{__APP_QA__:'true',__SETUP_SMOKE__:'false'}}
for(const [entry,output] of [['electron/preload/character-chat-preload.ts','dist-electron/character-chat-preload.cjs'],['electron/preload/settings-preload.ts','dist-electron/settings-preload.cjs'],['electron/main/character-chat/CharacterChatUiSmoke.ts','smoke.cjs'],['electron/main/main.ts','dist-electron/compile-only-main.cjs']])await bundle({...common,entryPoints:[join(root,entry)],outfile:join(profile,output)})
const env={CHAT_QA_ROOT:profile,CHAT_QA_EVIDENCE:evidence,ELECTRON_SMOKE_USER_DATA:join(profile,'userData'),ELECTRON_SMOKE_TEST:'1'}
for(const k of ['HOME','PATH','LANG','TMPDIR'])if(process.env[k])env[k]=process.env[k]
await mkdir(env.ELECTRON_SMOKE_USER_DATA,{recursive:true})
const child=spawn(electron,[join(profile,'smoke.cjs')],{cwd:root,env,stdio:['ignore','ignore','pipe']}),timer=setTimeout(()=>child.kill('SIGTERM'),60000)
let diagnostic='';child.stderr.on('data',value=>{if(diagnostic.length<16000)diagnostic+=value.toString()});
const code=await new Promise(resolve=>child.once('exit',resolve));clearTimeout(timer)
let result;try{result=JSON.parse(await readFile(join(evidence,'result.json'),'utf8'))}catch{result={passed:false,error:'NO_UI_RESULT',exitCode:code,diagnostic}}
await rm(profile,{recursive:true,force:true});console.log(JSON.stringify({evidence,...result}));if(code!==0||!result.passed)process.exitCode=1
