import {readFile,mkdir,copyFile,writeFile} from 'node:fs/promises'
import {resolve,join,dirname} from 'node:path'
import {verifyRuntime} from '../electron/main/character-chat/runtime-artifacts.mjs'
const trusted=JSON.parse(await readFile('electron/voice/runtime-base-macos.json','utf8')),target='darwin-arm64',entry=trusted.targets[target]
const source=process.argv[2];if(!source)throw Error('Pass the reviewed private native base build directory')
const dest=resolve('.generated/voice-base-runtime',target);await mkdir(dest,{recursive:true})
for(const name of Object.keys(entry.files)){
 const license=name.startsWith('licenses/')?resolve('distribution/licenses/character-chat',name.slice(9)):null
 const input=license&&await readFile(license).then(()=>true,()=>false)?license:join(source,name)
 await mkdir(dirname(join(dest,name)),{recursive:true});await copyFile(input,join(dest,name))
}
await writeFile(join(dest,'runtime-lock.json'),JSON.stringify(entry,null,2)+'\n');await verifyRuntime(dest,target,{trusted});console.log('Verified base voice runtime staged; no model weights included')
