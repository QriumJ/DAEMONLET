// Bundle the small TypeScript CLI without importing Electron or installing tsx.
import {build} from 'esbuild'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
const temporary=await mkdtemp(join(tmpdir(),'daemonlet-voice-cli-'))
try{const path=join(temporary,'voice.mjs');await build({entryPoints:['scripts/voice-cli.ts'],outfile:path,bundle:true,platform:'node',format:'esm',target:'node22'});await import(pathToFileURL(path).href)}
finally{await rm(temporary,{recursive:true,force:true})}
