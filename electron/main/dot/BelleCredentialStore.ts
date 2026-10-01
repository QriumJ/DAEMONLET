import {spawn} from 'node:child_process'
import {access} from 'node:fs/promises'
import type {RuntimeCredentialStore} from './BelleConnectionManager'
/** Fixed native OS credential item, private pipe transport, no file or plaintext fallback. */
export class BelleCredentialStore implements RuntimeCredentialStore{
 readonly kind: 'macos-keychain'|'windows-credential-manager'
 constructor(private helper:string,private platform=process.platform){this.kind=platform==='win32'?'windows-credential-manager':'macos-keychain'}
 private async invoke(operation:'available'|'has'|'get'|'put'|'remove',key?:string,signal?:AbortSignal):Promise<Record<string,unknown>>{
  if(this.platform!=='darwin'&&this.platform!=='win32')throw Error('STORE_UNAVAILABLE')
  try{await access(this.helper)}catch{throw Error('STORE_UNAVAILABLE')}
  return new Promise((resolve,reject)=>{
   const child=spawn(this.helper,[operation],{env:this.platform==='win32'?{SystemRoot:process.env.SystemRoot,WINDIR:process.env.WINDIR}:{},stdio:['pipe','pipe','ignore'],windowsHide:true});let output='',settled=false
   const fail=(code='STORE_UNAVAILABLE')=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);child.kill('SIGKILL');output='';reject(Error(code))}
   const timer=setTimeout(()=>fail('STORE_DENIED'),60000)
   const abort=()=>fail('STORE_DENIED');signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted){abort();return}
   child.on('error',()=>fail());child.stdin.on('error',()=>fail())
   child.stdout.on('data',chunk=>{if(Buffer.byteLength(output)+chunk.length>4096){fail();return}output+=chunk})
   child.on('close',code=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);try{const value=JSON.parse(output);output='';if(code!==0||value.ok!==true)throw Error(['KEY_MISSING','STORE_LOCKED','STORE_DENIED','INVALID_KEY'].includes(value.code)?value.code:'STORE_UNAVAILABLE');resolve(value)}catch(e){output='';reject(e instanceof Error&&/^STORE_|^KEY_MISSING$|^INVALID_KEY$/.test(e.message)?e:Error('STORE_UNAVAILABLE'))}})
   child.stdin.end(operation==='put'?JSON.stringify({key}):'');key=undefined
  })
 }
 async available(){if(this.platform!=='darwin'&&this.platform!=='win32')return false;try{return (await this.invoke('available')).available===true}catch{return false}}
 async has(){return (await this.invoke('has')).stored===true}
 async put(key:string){await this.invoke('put',key)}
 async get(signal?:AbortSignal){const v=await this.invoke('get',undefined,signal);if(typeof v.key!=='string')throw Error('KEY_MISSING');return v.key}
 async remove(){await this.invoke('remove')}
}
