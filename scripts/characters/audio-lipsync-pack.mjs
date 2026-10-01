import {mkdir,readFile,writeFile} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {createHash} from 'node:crypto'
import {createRequire} from 'node:module'
import {createWriteStream} from 'node:fs'
import {pipeline} from 'node:stream/promises'
const repo=resolve(import.meta.dirname,'../..')
const [sourceArg,outputArg,version]=process.argv.slice(2)
if(!sourceArg||!outputArg||!/^\d+\.\d+\.\d+$/.test(version??''))throw Error('Usage: node scripts/characters/audio-lipsync-pack.mjs <reviewed pack directory> <new output directory> <new version>')
const source=resolve(sourceArg),output=resolve(outputArg),payload=join(output,'payload')
if(output===source||output.startsWith(source+'/'))throw Error('OUTPUT_MUST_BE_SEPARATE')
const hash=data=>createHash('sha256').update(data).digest('hex')
await mkdir(output,{recursive:false});await mkdir(payload);const original=JSON.parse(await readFile(join(source,'pack.json'),'utf8'))
for(const file of original.files){const bytes=await readFile(join(source,file.path));if(hash(bytes)!==file.sha256)throw Error('SOURCE_INTEGRITY '+file.path);await mkdir(resolve(payload,file.path,'..'),{recursive:true});await writeFile(join(payload,file.path),bytes)}
const {withPackTools}=await import(join(repo,'scripts/characters/pack-tools.mjs'))
const report=[]
const validated=await withPackTools(async t=>{
 t.initializeCanvas(()=>{throw Error('Canvas unexpected')},(width,height)=>({width,height,data:new Uint8ClampedArray(width*height*4),colorSpace:'srgb'}))
 for(const file of original.files.filter(f=>/^poses\/[^/]+\/pose.json$/.test(f.path))){
  const directory=resolve(payload,file.path,'..'),manifest=JSON.parse(await readFile(join(payload,file.path),'utf8')),overrides=JSON.parse(await readFile(join(directory,manifest.overrides),'utf8')),bytes=await readFile(join(directory,manifest.psd))
  const result=new t.PsdRigLoader().loadArrayBuffer(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),manifest.id,overrides),rig=result.model.rig
  let profile=rig.anchors.mouth.speechMorph??rig.anchors.mouth.morph,derived=false
  if(!profile){profile=t.deriveSpeechMouthProfile(rig.layers,rig.anchors.mouth);overrides.anchorOverrides.mouth.speechMorph=profile;await writeFile(join(directory,manifest.overrides),JSON.stringify(overrides,null,2)+'\n');derived=true}
  const closed=t.speechClosedExpression(profile)
  if(!closed||![closed,'open'].every(expression=>rig.layers.some(layer=>layer.mouthExpression===expression)))throw Error('NO_CLOSED_ART '+manifest.id)
  await writeFile(join(payload,file.path),JSON.stringify({...manifest,audioLipSync:'amplitude-3'},null,2)+'\n')
  report.push({id:manifest.id,derived,closed,openGap:Math.max(...profile.open.lower.map((v,i)=>v-profile.open.upper[i])),profile})
 }
 const files=[],changed=[]
 for(const file of original.files){const bytes=await readFile(join(payload,file.path));files.push({...file,bytes:bytes.length,sha256:hash(bytes)});if(hash(bytes)!==file.sha256)changed.push(file.path)}
 if(changed.some(path=>!/^poses\/[^/]+\/(pose.json|rig-overrides.json)$/.test(path)))throw Error('UNEXPECTED_ART_CHANGE')
 await writeFile(join(payload,'pack.json'),JSON.stringify({...original,version,runtime:{...original.runtime,capabilities:[...original.runtime.capabilities,'audio-lipsync-closed-target-v1']},files},null,2)+'\n')
 const result=await t.validatePackDirectory(payload)
 return {revision:result.revision,changed,unchangedFiles:files.length-changed.length,files}
})
const require=createRequire(join(repo,'package.json')),{ZipFile}=require('yazl'),zip=new ZipFile(),archive=join(output,'Belle-'+version+'-all-pose-mouth-only.petchar')
for(const name of ['pack.json',...validated.files.map(f=>f.path)].sort())zip.addFile(join(payload,name),name,{mtime:new Date('2000-01-01T00:00:00Z'),mode:0o100644,compress:true})
zip.end();await pipeline(zip.outputStream,createWriteStream(archive,{flags:'wx',mode:0o600}))
const result={status:'METADATA_VALID',version,poseCount:report.length,revision:validated.revision,archive,bytes:(await readFile(archive)).length,sha256:hash(await readFile(archive)),changed:validated.changed,unchangedFiles:validated.unchangedFiles,artChanged:0,poses:report}
await writeFile(join(output,'report.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({...result,poses:report.map(({profile,...p})=>p)}))
