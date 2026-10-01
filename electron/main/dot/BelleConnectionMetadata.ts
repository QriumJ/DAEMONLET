import {readFile,writeFile,rename,mkdir,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {restoredConnectionConfig,type BelleConnectionConfig} from '../../shared/belle-connection'
export class BelleConnectionMetadata{
 constructor(private root:string){}
 async load(){try{const bytes=await readFile(join(this.root,'belle-connection.json'));if(bytes.length>2048)return null;return restoredConnectionConfig(JSON.parse(bytes.toString('utf8')))}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;return null}}
 async save(value:BelleConnectionConfig|null){
  if(value&&!restoredConnectionConfig(value))throw Error('INVALID_CONFIG')
  await mkdir(this.root,{recursive:true,mode:0o700});const target=join(this.root,'belle-connection.json')
  if(!value){await rm(target,{force:true});return}
  const temp=join(this.root,'.belle-connection-'+randomUUID()+'.tmp')
  try{await writeFile(temp,JSON.stringify(restoredConnectionConfig(value))+'\n',{mode:0o600,flag:'wx'});await rename(temp,target)}catch{await rm(temp,{force:true});throw Error('SAVE_FAILED')}
 }
}
