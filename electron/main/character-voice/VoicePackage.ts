import {createHash,randomUUID} from 'node:crypto'
import {createReadStream} from 'node:fs'
import {lstat,readdir,readFile,mkdir,cp,rename,rm,realpath} from 'node:fs/promises'
import {join,resolve,relative,isAbsolute} from 'node:path'
import type {VoiceProfile} from '../../shared/character-voice-contract'

export const SELECTED_VOICE = Object.freeze({id:'belle_candidates_6000',version:'0.5.0-selected-6000-e2',checkpoint:'step_0002660',adapter:'e7d8b3b99af702c3df135ef194596c2b13cf99bb00b8e7204f684c435be50eb2',checksums:'1a7d036f437b611307dbdceca564af75424efa27f77f761a01c015de24005f4f'})
export const ENGINE = Object.freeze({model_id:'openbmb/VoxCPM2',model_revision:'32279effe8c19989596f05d353d1447f51d9e915',source_commit:'f772e498a45fbb5fb8e13fbf9b9c48be9fe33e69'})
export const VOICE_LIMITS = {files:128,bytes:1024**3,json:1024**2}
export type VoiceManifest = {schema_version:string;voice_id:string;display_name:string;version:string;checkpoint:string;engine:typeof ENGINE;lora:string;reference:string;preview:string;mode:string;output_sample_rate:number;inference:{cfg_value:number;inference_timesteps:number;normalize:boolean;denoise:boolean;retry_badcase:boolean;max_len:number;seed:number}}
export async function sha256(path:string) {const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);return hash.digest('hex')}
export function safeRelative(name:string) {
 if(!name||name.length>240||name.includes('\\')||/[:\x00-\x1f]/.test(name)||isAbsolute(name)||name.split('/').some(p=>!p||p==='.'||p==='..'||/[. ]$/.test(p)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)))throw Error('VOICE_PATH')
 return name
}
export async function regularTree(root:string,limits=VOICE_LIMITS) {
 const files=new Map<string,number>();let bytes=0,entries=0
 // Reject links at every ancestor, including a user-selected junction root.
 for(let p=resolve(root);;){const s=await lstat(p);if(s.isSymbolicLink())throw Error('VOICE_LINK');const parent=resolve(p,'..');if(parent===p)break;p=parent}
 const canonical=await realpath(root)
 async function walk(dir:string) {for(const e of await readdir(dir,{withFileTypes:true})) {
  if(++entries>limits.files*2)throw Error('VOICE_LIMIT')
  const path=join(dir,e.name),name=relative(root,path).replaceAll('\\','/');safeRelative(name)
  const s=await lstat(path);if(s.isSymbolicLink()||isAbsolute(relative(canonical,await realpath(path)))||relative(canonical,await realpath(path)).startsWith('..'))throw Error('VOICE_LINK')
  if(s.isDirectory()) {if(name.split('/').length>8)throw Error('VOICE_LIMIT');await walk(path)}
  else if(s.isFile()){bytes+=s.size;files.set(name,s.size);if(files.size>limits.files||bytes>limits.bytes)throw Error('VOICE_LIMIT')}
  else throw Error('VOICE_FILE_TYPE')
 }}
 await walk(root);return files
}
export async function boundedJson(path:string) {if((await lstat(path)).size>VOICE_LIMITS.json)throw Error('VOICE_JSON_LIMIT');return JSON.parse(await readFile(path,'utf8'))}
export async function verifyVoicePackage(root:string,selected?:typeof SELECTED_VOICE):Promise<{profile:VoiceProfile;manifest:VoiceManifest}> {
 const files=await regularTree(root)
 if(!files.has('checksums.sha256')||files.get('checksums.sha256')!>VOICE_LIMITS.json)throw Error('VOICE_CHECKSUMS')
 const digest=await sha256(join(root,'checksums.sha256')), listed=new Map<string,string>(),folded=new Set<string>()
 for(const line of (await readFile(join(root,'checksums.sha256'),'utf8')).trim().split(/\r?\n/)) {
  const m=/^([a-f0-9]{64})  (.+)$/.exec(line);if(!m)throw Error('VOICE_CHECKSUM_FORMAT')
  const name=safeRelative(m[2]);if(name==='checksums.sha256'||folded.has(name.toLowerCase()))throw Error('VOICE_CHECKSUM_DUPLICATE')
  listed.set(name,m[1]);folded.add(name.toLowerCase())
 }
 if(listed.size!==files.size-1)throw Error('VOICE_UNLISTED_FILE')
 for(const [name,hash] of listed)if(!files.has(name)||await sha256(join(root,name))!==hash)throw Error('VOICE_CHECKSUM_MISMATCH')
 const v=await boundedJson(join(root,'voice.json')) as VoiceManifest
 if(v.schema_version!=='voicelab.experimental.v1'||!/[a-z0-9]/.test(v.voice_id)||! /^[a-z0-9_-]{1,80}$/.test(v.voice_id)||! /^[a-zA-Z0-9._-]{1,80}$/.test(v.version)||typeof v.display_name!=='string'||v.display_name.length>120)throw Error('VOICE_SCHEMA')
 for(const [k,value] of Object.entries(ENGINE))if(v.engine?.[k as keyof typeof ENGINE]!==value)throw Error('VOICE_ENGINE')
 if(v.mode!=='reference'||v.output_sample_rate!==48000)throw Error('VOICE_MODE')
 for(const name of [v.lora+'/lora_config.json',v.lora+'/lora_weights.safetensors',v.reference,v.preview,'provenance.json','SOURCE_AND_USAGE_NOTES.md','VOXCPM-LICENSE'])if(!listed.has(safeRelative(name)))throw Error('VOICE_REQUIRED_FILE')
 const cfg=await boundedJson(join(root,v.lora,'lora_config.json'))
 if(cfg.base_model!==ENGINE.model_id||cfg.lora_config?.r!==32||cfg.lora_config?.alpha!==32||cfg.lora_config?.enable_lm!==true||cfg.lora_config?.enable_dit!==true||cfg.lora_config?.enable_proj!==false||cfg.lora_config?.dropout!==0)throw Error('VOICE_LORA_CONFIG')
 const inf=v.inference,keys=['cfg_value','inference_timesteps','normalize','denoise','retry_badcase','max_len','seed']
 if(!inf||Object.keys(inf).some(k=>!keys.includes(k))||inf.cfg_value!==2||inf.inference_timesteps!==10||inf.normalize!==false||inf.denoise!==false||inf.retry_badcase!==false||inf.max_len!==600||inf.seed!==42)throw Error('VOICE_INFERENCE')
 const adapter=listed.get(v.lora+'/lora_weights.safetensors')!
 const provenance=await boundedJson(join(root,'provenance.json'))
 if(provenance.adapter_sha256!==adapter||provenance.checkpoint!==v.checkpoint||provenance.condition?.reference_sha256!==listed.get(v.reference))throw Error('VOICE_PROVENANCE')
 if(selected&&(v.voice_id!==selected.id||v.version!==selected.version||v.checkpoint!==selected.checkpoint||adapter!==selected.adapter||digest!==selected.checksums))throw Error('VOICE_SELECTION_MISMATCH')
 return {manifest:v,profile:{id:v.voice_id,version:v.version,name:v.display_name,fingerprint:digest,adapterSha256:adapter}}
}
export const profileKey=(p:VoiceProfile)=>p.id+'@'+p.version
export async function importVoicePackage(source:string,profilesRoot:string,selected?:typeof SELECTED_VOICE) {
 const verified=await verifyVoicePackage(source,selected)
 await mkdir(profilesRoot,{recursive:true})
 const destination=join(profilesRoot,profileKey(verified.profile))
 try {const old=await verifyVoicePackage(destination,selected);if(old.profile.fingerprint!==verified.profile.fingerprint)throw Error('VOICE_VERSION_CONFLICT');return old}
 catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e}
 const staging=join(profilesRoot,'.import-'+randomUUID())
 try {await cp(source,staging,{recursive:true,dereference:false,errorOnExist:true,force:false});const copied=await verifyVoicePackage(staging,selected);if(copied.profile.fingerprint!==verified.profile.fingerprint)throw Error('VOICE_CHANGED_DURING_COPY');await rename(staging,destination);return copied}
 finally {await rm(staging,{recursive:true,force:true}).catch(()=>{})}
}
