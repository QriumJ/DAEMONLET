import {createReadStream} from 'node:fs'
import {mkdir,open,symlink,link,lstat,readlink,realpath,readdir} from 'node:fs/promises'
import {dirname,join,posix,relative,isAbsolute} from 'node:path'
import {createGunzip} from 'node:zlib'
import {createHash} from 'node:crypto'
import {digestFile} from '../character-chat/ModelManager'
import {safeRelative} from './VoicePackage'

// Extract only the pinned portable-Python bundle. Files precede links, so an
// archive link can never redirect a later write. Relative internal vendor links
// are retained; wheels/models and all pre-existing managed paths reject links.
export async function extractQwenPython(archive:string,destination:string,signal:AbortSignal,verify=false){
 const source=createReadStream(archive),stream=source.pipe(createGunzip()),iterator=stream[Symbol.asyncIterator]()
 source.on('error',error=>stream.destroy(error))
 const abort=()=>stream.destroy(signal.reason instanceof Error?signal.reason:Error('QWEN_INSTALL_CANCELLED'))
 signal.addEventListener('abort',abort,{once:true})
 let buffer=Buffer.alloc(0),expanded=0,count=0,total=0,pax:Record<string,string>={},longName='',longLink=''
 const names=new Set<string>(),links:Array<{name:string;target:string;hard:boolean}>=[]
 const files:Record<string,{bytes:number;sha256:string}>={}
 async function read(size:number){
  signal.throwIfAborted()
  while(buffer.length<size){const next=await iterator.next();if(next.done)throw Error('QWEN_ARCHIVE_INVALID');const b=Buffer.from(next.value);expanded+=b.length;if(expanded>512*1024**2)throw Error('QWEN_ARCHIVE_LIMIT');buffer=Buffer.concat([buffer,b])}
  const result=buffer.subarray(0,size);buffer=buffer.subarray(size);return result
 }
 const str=(b:Buffer)=>b.toString('utf8').replace(/\0.*$/s,'')
 const octal=(b:Buffer)=>{const s=str(b).trim();if(!/^[0-7]*$/.test(s))throw Error('QWEN_ARCHIVE_INVALID');return parseInt(s||'0',8)}
 function records(b:Buffer){const values:Record<string,string>={};let offset=0;while(offset<b.length){const space=b.indexOf(32,offset),length=Number(b.subarray(offset,space).toString());if(space<offset||!Number.isSafeInteger(length)||length<=space-offset+1||offset+length>b.length)throw Error('QWEN_ARCHIVE_INVALID');const record=b.subarray(space+1,offset+length).toString();if(!record.endsWith('\n'))throw Error('QWEN_ARCHIVE_INVALID');const equal=record.indexOf('=');if(equal<1)throw Error('QWEN_ARCHIVE_INVALID');values[record.slice(0,equal)]=record.slice(equal+1,-1);offset+=length}return values}
 try{
  while(true){
   const header=await read(512);if(header.every(b=>b===0))break
   if(++count>40000)throw Error('QWEN_ARCHIVE_LIMIT')
   const checksum=octal(header.subarray(148,156));let sum=0;for(let i=0;i<512;i++)sum+=i>=148&&i<156?32:header[i];if(sum!==checksum)throw Error('QWEN_ARCHIVE_INVALID')
   const type=str(header.subarray(156,157))||'0',size=octal(header.subarray(124,136))
   if(size>512*1024**2)throw Error('QWEN_ARCHIVE_LIMIT')
   if(['x','L','K'].includes(type)){
    if(size>64*1024)throw Error('QWEN_ARCHIVE_LIMIT');const body=await read(size);await read((512-size%512)%512)
    if(type==='x')pax=records(body);else if(type==='L')longName=str(body).replace(/\n$/,'');else longLink=str(body).replace(/\n$/,'');continue
   }
   if(pax.size!==undefined&&Number(pax.size)!==size)throw Error('QWEN_ARCHIVE_INVALID')
   const prefix=str(header.subarray(345,500)),name=safeRelative((pax.path||longName||[prefix,str(header.subarray(0,100))].filter(Boolean).join('/')).replace(/\/$/,''))
   const target=pax.linkpath||longLink||str(header.subarray(157,257));pax={};longName='';longLink=''
   if(name!=='python'&&!name.startsWith('python/'))throw Error('QWEN_ARCHIVE_PATH')
   const folded=name.toLowerCase();if(names.has(folded))throw Error('QWEN_ARCHIVE_PATH');names.add(folded)
   const path=join(destination,name)
   if(type==='5'){if(size)throw Error('QWEN_ARCHIVE_INVALID');if(verify){const s=await lstat(path);if(!s.isDirectory()||s.isSymbolicLink())throw Error('QWEN_INSTALL_CHANGED')}else await mkdir(path,{recursive:true,mode:0o700})}
   else if(type==='0'){
    total+=size;if(total>512*1024**2)throw Error('QWEN_ARCHIVE_LIMIT');if(!verify)await mkdir(dirname(path),{recursive:true,mode:0o700});const out=verify?null:await open(path,'wx',octal(header.subarray(100,108))&0o111?0o700:0o600),hash=createHash('sha256')
    try{for(let left=size;left;){const n=Math.min(left,128*1024),body=await read(n);hash.update(body);await out?.writeFile(body);left-=n}}finally{await out?.close()}
    const sha256=hash.digest('hex');files[name]={bytes:size,sha256}
    if(verify){const s=await lstat(path),parent=relative(destination,await realpath(dirname(path)));if(!s.isFile()||s.isSymbolicLink()||s.size!==size||parent.startsWith('..')||isAbsolute(parent)||await digestFile(path,signal)!==sha256)throw Error('QWEN_INSTALL_CHANGED')}
   }else if(type==='2'||type==='1'){
    if(size||!target||target.startsWith('/')||target.includes('\\')||/[:\x00-\x1f]/.test(target))throw Error('QWEN_ARCHIVE_PATH')
    const resolved=posix.normalize(type==='1'?target:posix.join(posix.dirname(name),target));safeRelative(resolved)
    if(!resolved.startsWith('python/'))throw Error('QWEN_ARCHIVE_PATH');links.push({name,target,hard:type==='1'})
   }else throw Error('QWEN_ARCHIVE_PATH')
   await read((512-size%512)%512)
  }
  for(const entry of links){
   signal.throwIfAborted();if(links.some(other=>entry.name.startsWith(other.name+'/')))throw Error('QWEN_ARCHIVE_PATH')
   const resolved=posix.normalize(entry.hard?entry.target:posix.join(posix.dirname(entry.name),entry.target))
   if(!names.has(resolved.toLowerCase()))throw Error('QWEN_ARCHIVE_PATH')
   const path=join(destination,entry.name)
   if(verify){const s=await lstat(path);if(entry.hard){const target=await lstat(join(destination,resolved));if(!s.isFile()||s.ino!==target.ino||s.dev!==target.dev)throw Error('QWEN_INSTALL_CHANGED')}else if(!s.isSymbolicLink()||await readlink(path)!==entry.target)throw Error('QWEN_INSTALL_CHANGED')}
   else {await mkdir(dirname(path),{recursive:true,mode:0o700});if(entry.hard){const source=join(destination,resolved);if(!(await lstat(source)).isFile())throw Error('QWEN_ARCHIVE_PATH');await link(source,path)}else await symlink(entry.target,path)}
  }
  if(verify)for(const name of await readdir(join(destination,'python'),{recursive:true})){const candidate=('python/'+name.replaceAll('\\','/')).toLowerCase();if(!names.has(candidate)&&![...names].some(n=>n.startsWith(candidate+'/')))throw Error('QWEN_INSTALL_CHANGED')}
  return files
 }finally{signal.removeEventListener('abort',abort);stream.destroy();source.destroy()}
}
