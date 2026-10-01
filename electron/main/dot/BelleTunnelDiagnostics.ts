import {closeSync,constants,fstatSync,lstatSync,openSync,writeSync} from 'node:fs'
/** Private opt-in diagnostics. Only a closed numeric schema crosses this boundary. */
export interface TunnelDiagnostic {source:number;phase:number;elapsedMs:number;win32?:number;exit?:number;http?:number;code?:number}
export type TunnelDiagnosticSink=(event:TunnelDiagnostic)=>void
const keys=new Set(['source','phase','elapsedMs','win32','exit','http','code'])
export function numericDiagnostic(value:unknown):TunnelDiagnostic|null{
 if(!value||typeof value!=='object'||Array.isArray(value))return null
 const v=value as Record<string,unknown>
 if(Object.keys(v).some(k=>!keys.has(k))||!['source','phase','elapsedMs'].every(k=>Object.hasOwn(v,k)))return null
 if(Object.values(v).some(n=>typeof n!=='number'||!Number.isSafeInteger(n)||n<0||n>0xffffffff))return null
 if(![1,2,3].includes(v.source as number)||(v.phase as number)<1||(v.phase as number)>32||(v.elapsedMs as number)>3600000)return null
 if(v.http!==undefined&&((v.http as number)<100||(v.http as number)>599))return null
 return {...v} as unknown as TunnelDiagnostic
}
export function privateTunnelDiagnostics(path:string):TunnelDiagnosticSink{
 let count=0
 return value=>{
  const event=numericDiagnostic(value);if(!event||count>=256)return
  let fd:number|undefined
  try{
   try{const s=lstatSync(path);if(!s.isFile()||s.isSymbolicLink()||s.size>=131072)return}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')return}
   fd=openSync(path,constants.O_WRONLY|constants.O_APPEND|constants.O_CREAT|(constants.O_NOFOLLOW??0),0o600)
   const s=fstatSync(fd),line=JSON.stringify(event)+'\n';if(!s.isFile()||s.size+Buffer.byteLength(line)>131072)return
   writeSync(fd,line);count++
  }catch{/* Diagnostic storage failure never changes connection behavior. */}finally{if(fd!==undefined)try{closeSync(fd)}catch{}}
 }
}
/** A supervisor pipe is numeric-only; oversized or non-schema lines are discarded, never retained. */
export function nativeDiagnosticReader(sink:TunnelDiagnosticSink){
 let pending='',dropping=false,total=0
 return (chunk:Buffer)=>{
  if(total+chunk.length>32768){pending='';dropping=true;total=32769;return}total+=chunk.length
  for(const c of chunk.toString('ascii')){
   if(c==='\n'){if(!dropping){try{const v=numericDiagnostic(JSON.parse(pending));if(v?.source===3)sink(v)}catch{}}pending='';dropping=false}
   else if(!dropping){pending+=c;if(pending.length>256){pending='';dropping=true}}
  }
 }
}
