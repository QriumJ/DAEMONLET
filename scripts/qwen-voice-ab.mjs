import {build} from 'esbuild'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
const root=await mkdtemp(join(tmpdir(),'daemonlet-qwen-ab-'))
try{const file=join(root,'ab.mjs');await build({entryPoints:['scripts/qwen-voice-ab.ts'],outfile:file,bundle:true,platform:'node',format:'esm',target:'node22'});await import(pathToFileURL(file).href)}finally{await rm(root,{recursive:true,force:true})}
