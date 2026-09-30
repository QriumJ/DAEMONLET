import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {mkdir} from 'node:fs/promises'
import {resolve} from 'node:path'
const root=resolve(import.meta.dirname,'../..'),platform=process.env.PET_BUILD_PLATFORM??process.platform
if(platform==='darwin'){
 if(process.platform!=='darwin')throw Error('Build the macOS Keychain helper on macOS')
 const native=resolve(root,'dist-electron/native'),cache=resolve(root,'.generated/swift-module-cache')
 await mkdir(native,{recursive:true});await mkdir(cache,{recursive:true})
 await promisify(execFile)('/usr/bin/xcrun',['swiftc','-O','-module-cache-path',cache,resolve(root,'electron/native/BelleCredential.swift'),'-o',resolve(native,'DaemonletBelleCredential'),'-framework','Security'],{timeout:120000,maxBuffer:1024*1024})
}
