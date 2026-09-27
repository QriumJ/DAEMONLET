import {lstat,realpath} from 'node:fs/promises'
import {basename,dirname,join} from 'node:path'
import {boundedJson,sha256} from './VoicePackage'

// A venv interpreter link is legitimate; links inside voice packages remain forbidden.
export async function verifyMacInterpreter(python:string,profile='mps-fp32-baseline'){
 if(process.platform!=='darwin'||process.arch!=='arm64'||!/^python(?:3(?:\.11)?)?$/.test(basename(python))||basename(dirname(python))!=='bin')throw Error('VOICE_RUNTIME_CONFIG')
 const prefix=await realpath(join(dirname(python),'..')),target=await realpath(python)
 if(!(await lstat(target)).isFile())throw Error('VOICE_RUNTIME_CONFIG')
 const receipt=await boundedJson(join(prefix,'voice-runtime.json'))
 if(receipt.schemaVersion!==2||receipt.profile!==(profile.startsWith('gguf-metal-')?'macos-arm64-gguf-f16-v1':'macos-arm64-mps-fp32-v1')||receipt.prefix!==prefix||receipt.interpreter!==target||receipt.interpreter_sha256!==await sha256(target))throw Error('RUNTIME_RECEIPT')
 // Launch the venv path, not the canonical base executable (which would lose sys.prefix).
 return {prefix,target}
}
