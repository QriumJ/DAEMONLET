import {execFileSync} from 'node:child_process'
import {mkdir,writeFile,rm} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {randomUUID} from 'node:crypto'
const platform=process.env.PET_BUILD_PLATFORM??process.platform
if(platform==='win32'){
 if(process.platform!=='win32')throw Error('Build Windows Belle helpers on Windows')
 if((process.env.PET_BUILD_ARCH??process.arch)!=='x64')throw Error('Windows Belle helpers currently require x64')
 if(process.argv.includes('--production')&&process.argv.includes('--credential-qa'))throw Error('QA helpers cannot be built for production')
 const root=resolve(import.meta.dirname,'../..'),native=join(root,'dist-electron/native')
 const vswhere=join(process.env['ProgramFiles(x86)']??'C:\\Program Files (x86)','Microsoft Visual Studio/Installer/vswhere.exe')
 const installation=execFileSync(vswhere,['-latest','-products','*','-requires','Microsoft.VisualStudio.Component.VC.Tools.x86.x64','-property','installationPath'],{encoding:'utf8',windowsHide:true}).trim()
 if(!installation)throw Error('Windows Belle helpers require existing Visual Studio C++ build tools')
 const work=join(tmpdir(),'daemonlet-belle-build-'+randomUUID());await mkdir(work);await mkdir(native,{recursive:true})
 try{
  const specs=[['belle-credential.c','DaemonletBelleCredential.exe','advapi32.lib',''],['belle-tunnel-host.cpp','DaemonletBelleTunnelHost.exe','kernel32.lib','']]
  // Compile-time isolated test item; never included by normal or production builds.
  if(process.argv.includes('--credential-qa')){specs.push(['belle-credential.c','DaemonletBelleCredentialQA.exe','advapi32.lib','/DDAEMONLET_CREDENTIAL_QA']);specs.push(['../../../tests/fixtures/windows-belle-client.cpp','DaemonletBelleTestClient.exe','kernel32.lib',''])}
  const script=join(work,'compile.cmd')
  await writeFile(script,'@echo off\r\ncall "'+join(installation,'VC/Auxiliary/Build/vcvars64.bat')+'" >nul\r\nif errorlevel 1 exit /b 1\r\n'+specs.map(([source,name,libs,flags],i)=>`cl /nologo /O2 /W4 /WX /GS /MT /EHsc /std:c++17 ${flags} "${join(root,'electron/native/windows',source)}" /Fo"${join(work,`native-${i}.obj`)}" /link /DYNAMICBASE /NXCOMPAT /OUT:"${join(native,name)}" ${libs}\r\nif errorlevel 1 exit /b 1\r\n`).join(''))
  execFileSync(process.env.ComSpec??'C:\\Windows\\System32\\cmd.exe',['/d','/s','/c',`"${script}"`],{cwd:work,stdio:'inherit',windowsHide:true,windowsVerbatimArguments:true})
 }finally{await rm(work,{recursive:true,force:true,maxRetries:10,retryDelay:100})}
}
