import {spawn} from 'node:child_process'
import {resolve} from 'node:path'
import electron from 'electron'
const index=process.argv.indexOf('--data')
if(index<0||!process.argv[index+1])throw Error('Pass --data <isolated test profile>')
const env={...process.env,DAEMONLET_DATA_HOME:resolve(process.argv[index+1])}
delete env.ELECTRON_RUN_AS_NODE
const child=spawn(electron,[resolve('dist-electron/main.cjs'),'--character-chat'],{env,stdio:'inherit',windowsHide:true,shell:false})
child.once('exit',code=>{process.exitCode=code??1})
child.once('error',()=>{process.exitCode=1})
