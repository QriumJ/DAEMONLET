import {afterEach,expect,it} from 'vitest'
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createHash} from 'node:crypto'
import {ENGINE,verifyVoicePackage,importVoicePackage,regularTree,safeRelative,SELECTED_VOICE} from '../electron/main/character-voice/VoicePackage'
const roots:string[]=[]
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true})})
const hash=(s:string)=>createHash('sha256').update(s).digest('hex')
async function fixture(){const root=await mkdtemp(join(tmpdir(),'voice-package-'));roots.push(root)
 const files:Record<string,string>={'lora/lora_weights.safetensors':'synthetic-not-a-model','lora/lora_config.json':JSON.stringify({base_model:ENGINE.model_id,lora_config:{r:32,alpha:32,enable_lm:true,enable_dit:true,enable_proj:false,dropout:0}}),'reference/reference.wav':'synthetic-not-a-wav','samples/preview.wav':'synthetic','SOURCE_AND_USAGE_NOTES.md':'test','VOXCPM-LICENSE':'test'}
 files['voice.json']=JSON.stringify({schema_version:'voicelab.experimental.v1',voice_id:'synthetic',version:'1',display_name:'Synthetic',checkpoint:'synthetic',engine:ENGINE,lora:'lora',reference:'reference/reference.wav',preview:'samples/preview.wav',mode:'reference',output_sample_rate:48000,inference:{cfg_value:2,inference_timesteps:10,normalize:false,denoise:false,retry_badcase:false,max_len:600,seed:42}})
 files['provenance.json']=JSON.stringify({adapter_sha256:hash(files['lora/lora_weights.safetensors']),checkpoint:'synthetic',condition:{reference_sha256:hash(files['reference/reference.wav'])}})
 async function save(){for(const [name,text] of Object.entries(files)){await mkdir(join(root,name,'..'),{recursive:true});await writeFile(join(root,name),text)}await writeFile(join(root,'checksums.sha256'),Object.entries(files).map(([name,text])=>hash(text)+'  '+name).join('\n')+'\n')}
 await save();return{root,files,save}
}
it('verifies complete synthetic packages and imports idempotently without altering source',async()=>{const {root}=await fixture(),dest=await mkdtemp(join(tmpdir(),'voice-registry-'));roots.push(dest);const original=await readFile(join(root,'checksums.sha256'));const a=await importVoicePackage(root,dest),b=await importVoicePackage(root,dest);expect(a).toEqual(b);expect(await readFile(join(root,'checksums.sha256'))).toEqual(original)})
it('selected policy refuses synthetic or earlier packages',async()=>{const {root}=await fixture();await expect(verifyVoicePackage(root,SELECTED_VOICE)).rejects.toThrow('SELECTION')})
it.each(['../outside','/absolute','C:/escape','\\\\host\\share','a/../b','a\\b','file:stream','trailing.','NUL.txt','a//b'])('rejects unsafe path %s',name=>{expect(()=>safeRelative(name)).toThrow()})
it('rejects tampered, missing, unlisted and duplicate checksums',async()=>{
 const {root,save}=await fixture();await writeFile(join(root,'voice.json'),'tampered');await expect(verifyVoicePackage(root)).rejects.toThrow('MISMATCH');await save()
 await rm(join(root,'voice.json'));await expect(verifyVoicePackage(root)).rejects.toThrow();await save()
 await writeFile(join(root,'extra.txt'),'unlisted');await expect(verifyVoicePackage(root)).rejects.toThrow('UNLISTED');await rm(join(root,'extra.txt'))
 const checksums=await readFile(join(root,'checksums.sha256'),'utf8');await writeFile(join(root,'checksums.sha256'),checksums+checksums.split('\n')[0]+'\n');await expect(verifyVoicePackage(root)).rejects.toThrow('DUPLICATE')
})
it('rejects revision and inference changes even with updated hashes',async()=>{const {root,files,save}=await fixture();const manifest=JSON.parse(files['voice.json']);manifest.engine.model_revision='wrong';files['voice.json']=JSON.stringify(manifest);await save();await expect(verifyVoicePackage(root)).rejects.toThrow('ENGINE');manifest.engine=ENGINE;manifest.inference.normalize=true;files['voice.json']=JSON.stringify(manifest);await save();await expect(verifyVoicePackage(root)).rejects.toThrow('INFERENCE')})
it('rejects conflicts and enforces file/byte limits',async()=>{const {root,files,save}=await fixture(),dest=await mkdtemp(join(tmpdir(),'voice-registry-'));roots.push(dest);await importVoicePackage(root,dest);files['SOURCE_AND_USAGE_NOTES.md']='changed';await save();await expect(importVoicePackage(root,dest)).rejects.toThrow('CONFLICT');await expect(regularTree(root,{files:2,bytes:100000,json:10000})).rejects.toThrow('LIMIT');await expect(regularTree(root,{files:128,bytes:2,json:10000})).rejects.toThrow('LIMIT')})
it('rejects junctions at both package root and nested paths',async()=>{const {root}=await fixture(),links=await mkdtemp(join(tmpdir(),'voice-link-'));roots.push(links);await symlink(root,join(links,'alias'),'junction');await expect(verifyVoicePackage(join(links,'alias'))).rejects.toThrow('LINK');await symlink(links,join(root,'nested'),'junction');await expect(verifyVoicePackage(root)).rejects.toThrow('LINK');await rm(join(root,'nested'))})

it('always pins the adopted Belle identity while allowing other compatible packages',async()=>{
 const {root,files,save}=await fixture();expect((await verifyVoicePackage(root)).profile.id).toBe('synthetic')
 const manifest=JSON.parse(files['voice.json']);manifest.voice_id=SELECTED_VOICE.id;manifest.version=SELECTED_VOICE.version;files['voice.json']=JSON.stringify(manifest);await save()
 await expect(verifyVoicePackage(root)).rejects.toThrow('VOICE_SELECTION_MISMATCH')
})
