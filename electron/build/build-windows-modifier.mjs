import {execFileSync} from 'node:child_process'
import {mkdir,writeFile,rm} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {randomUUID} from 'node:crypto'
if((process.env.PET_BUILD_PLATFORM??process.platform)==='win32'){
 if(process.platform!=='win32'||(process.env.PET_BUILD_ARCH??process.arch)!=='x64')throw Error('Build Windows x64 modifier helper on Windows x64')
 const qa=process.argv.includes('--modifier-qa')
 if(qa&&process.argv.includes('--production'))throw Error('QA modifier helper cannot be built for production')
 const root=resolve(import.meta.dirname,'../..'),native=join(root,'dist-electron/native')
 const vswhere=join(process.env['ProgramFiles(x86)']??'C:\\Program Files (x86)','Microsoft Visual Studio/Installer/vswhere.exe')
 const installation=execFileSync(vswhere,['-latest','-products','*','-requires','Microsoft.VisualStudio.Component.VC.Tools.x86.x64','-property','installationPath'],{encoding:'utf8',windowsHide:true}).trim()
 if(!installation)throw Error('Windows modifier helper requires existing Visual Studio C++ tools')
 const work=join(tmpdir(),'daemonlet-modifier-build-'+randomUUID());await mkdir(work);await mkdir(native,{recursive:true})
 try{
  const script=join(work,'compile.cmd'),names=['DaemonletModifierState.exe',...(qa?['DaemonletModifierStateQA.exe']:[])]
  await writeFile(script,'@echo off\r\ncall "'+join(installation,'VC/Auxiliary/Build/vcvars64.bat')+'" >nul\r\nif errorlevel 1 exit /b 1\r\n'+names.map((name,i)=>`cl /nologo /O2 /W4 /WX /GS /MT /TC ${i?'/DDAEMONLET_MODIFIER_QA':''} "${join(root,'electron/native/windows/modifier-state.c')}" /Fo"${join(work,`modifier-${i}.obj`)}" /link /DYNAMICBASE /NXCOMPAT /OUT:"${join(native,name)}" user32.lib kernel32.lib\r\nif errorlevel 1 exit /b 1\r\n`).join(''))
  execFileSync(process.env.ComSpec??'C:\\Windows\\System32\\cmd.exe',['/d','/s','/c',`"${script}"`],{cwd:work,stdio:'inherit',windowsHide:true,windowsVerbatimArguments:true})
 }finally{await rm(work,{recursive:true,force:true,maxRetries:10,retryDelay:100})}
}
