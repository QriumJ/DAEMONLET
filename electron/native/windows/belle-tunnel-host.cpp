#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <string>
#include <cwchar>
#include <cstdio>
static bool diagnostics=false;
static ULONGLONG began=0;
static void report(unsigned phase,DWORD error=0,DWORD code=0) {
 if(!diagnostics)return;
 ULONGLONG elapsed=GetTickCount64()-began;if(elapsed>3600000)elapsed=3600000;
 std::printf("{\"source\":3,\"phase\":%u,\"elapsedMs\":%llu,\"win32\":%lu,\"exit\":%lu}\n",phase,elapsed,error,code);std::fflush(stdout);
}
// CreateProcess quoting, never shell expansion or credential argv.
static std::wstring quote(const wchar_t *text) {
 std::wstring result=L"\"";size_t slashes=0;
 for(const wchar_t *p=text;*p;p++) {
  if(*p==L'\\'){slashes++;continue;}
  if(*p==L'"'){result.append(slashes*2+1,L'\\');result+=L'"';}
  else {result.append(slashes,L'\\');result+=*p;}
  slashes=0;
 }
 result.append(slashes*2,L'\\');return result+L'"';
}
static DWORD WINAPI watchPipe(void *event) {
 BYTE ignored;DWORD read=0;HANDLE pipe=GetStdHandle(STD_INPUT_HANDLE);
 while(true){BOOL ok=ReadFile(pipe,&ignored,1,&read,NULL);if(!ok){report(13,GetLastError());break;}if(!read){report(13);break;}}
 SetEvent((HANDLE)event);return 0;
}
int wmain(int argc,wchar_t **argv) {
 bool adapter=argc==4 && !wcscmp(argv[1],L"--adapter");
 diagnostics=argc==5 && !wcscmp(argv[4],L"--numeric-diagnostics");began=GetTickCount64();
 if(!adapter && ((argc!=4&&!diagnostics) || wcsncmp(argv[3],L"org-",4)))return 1;
 report(1);
 const wchar_t *exe=adapter?argv[2]:argv[1];
 if(adapter) {SetEnvironmentVariableW(L"CONTROL_PLANE_API_KEY",NULL);SetEnvironmentVariableW(L"OPENAI_API_KEY",NULL);}
 std::wstring command=quote(exe);
 if(adapter)command+=L" "+quote(argv[3]);
 else command+=L" run --profile-file "+quote(argv[2])+L" --control-plane.organization-id "+quote(argv[3])+L" --mcp.stdio-send-initialized-notification";
 HANDLE job=NULL,event=NULL,thread=NULL;
 if(!adapter) {
  job=CreateJobObjectW(NULL,NULL);if(!job){report(2,GetLastError());return 1;}report(2);
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits={0};limits.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if(!SetInformationJobObject(job,JobObjectExtendedLimitInformation,&limits,sizeof(limits))){report(3,GetLastError());CloseHandle(job);return 1;}report(3);
  event=CreateEventW(NULL,TRUE,FALSE,NULL);if(!event){report(4,GetLastError());CloseHandle(job);return 1;}report(4);
 }
 STARTUPINFOW startup={};startup.cb=sizeof(startup);PROCESS_INFORMATION process={0};
 // Adapter needs the client's stdio pipes; supervisor never gives its parent pipe to the client.
 if(adapter){startup.dwFlags=STARTF_USESTDHANDLES;startup.hStdInput=GetStdHandle(STD_INPUT_HANDLE);startup.hStdOutput=GetStdHandle(STD_OUTPUT_HANDLE);startup.hStdError=GetStdHandle(STD_ERROR_HANDLE);}
 BOOL created=CreateProcessW(exe,command.data(),NULL,NULL,adapter?TRUE:FALSE,CREATE_NO_WINDOW|CREATE_SUSPENDED,NULL,NULL,&startup,&process);
 DWORD launchError=created?0:GetLastError();report(5,launchError);
 if(!adapter) {SetEnvironmentVariableW(L"CONTROL_PLANE_API_KEY",NULL);SetEnvironmentVariableW(L"OPENAI_API_KEY",NULL);}
 if(!created){if(event)CloseHandle(event);if(job)CloseHandle(job);return 1;}
 if(!adapter && !AssignProcessToJobObject(job,process.hProcess)) {report(6,GetLastError());TerminateProcess(process.hProcess,1);WaitForSingleObject(process.hProcess,5000);CloseHandle(process.hThread);CloseHandle(process.hProcess);CloseHandle(event);CloseHandle(job);return 1;}
 if(!adapter)report(6);
 if(ResumeThread(process.hThread)==(DWORD)-1){report(7,GetLastError());TerminateProcess(process.hProcess,1);if(job)CloseHandle(job);CloseHandle(process.hThread);CloseHandle(process.hProcess);if(event)CloseHandle(event);return 1;}
 if(!adapter)report(7);
 CloseHandle(process.hThread);
 if(adapter){WaitForSingleObject(process.hProcess,INFINITE);DWORD code=1;GetExitCodeProcess(process.hProcess,&code);CloseHandle(process.hProcess);return (int)code;}
 thread=CreateThread(NULL,0,watchPipe,event,0,NULL);
 if(thread){report(8);HANDLE waits[]={process.hProcess,event};DWORD wait=WaitForMultipleObjects(2,waits,FALSE,INFINITE);
  if(wait==WAIT_OBJECT_0){DWORD code=1;if(GetExitCodeProcess(process.hProcess,&code))report(9,0,code);else report(9,GetLastError());}
  else if(wait==WAIT_OBJECT_0+1)report(10);else report(11,GetLastError());
 }else report(8,GetLastError());
 // Last non-inherited job handle closes on EOF, child exit, launch failure or supervisor termination.
 CloseHandle(job);WaitForSingleObject(process.hProcess,5000);CloseHandle(process.hProcess);
 if(thread){CancelSynchronousIo(thread);WaitForSingleObject(thread,5000);CloseHandle(thread);}CloseHandle(event);report(12);return 0;
}
