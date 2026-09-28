// Explicit diagnostic installer; the application uses the same manager from its button.
import {resolve} from 'node:path'
import {WindowsVoiceInstaller} from '../electron/main/character-voice/WindowsVoiceInstaller'
const [root,resources]=process.argv.slice(2)
if(!root||!resources)throw Error('Pass a new private data root and the packaged voice resource folder')
let progress=''
const installer=new WindowsVoiceInstaller(resolve(root),resolve(resources),()=>{const s=installer.snapshot(),value=s.phase+':'+Math.floor(s.bytes/s.total*100);if(value!==progress){progress=value;console.log(JSON.stringify(s))}})
try{await installer.install();await installer.ready();console.log(JSON.stringify({status:'PASS',state:installer.snapshot(),python:installer.executable,model:installer.path}))}
catch(e){console.error(e);process.exitCode=1}
