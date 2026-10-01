#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <string>
#include <fstream>
// QA wrapper only, compiled explicitly by the native-test build.
static std::wstring q(const std::wstring &s){std::wstring r=L"\"";size_t n=0;for(auto c:s){if(c==L'\\'){n++;continue;}r.append(c==L'"'?n*2+1:n,L'\\');r+=c;n=0;}r.append(n*2,L'\\');return r+L'"';}
int wmain(int argc,wchar_t **argv){
 wchar_t path[32768];if(!GetModuleFileNameW(NULL,path,32768))return 1;std::wstring dir(path);dir=dir.substr(0,dir.find_last_of(L"\\/")+1);
 std::ifstream file(dir+L"node-path.txt");std::string text;std::getline(file,text);if(text.empty())return 1;
 int length=MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,text.data(),(int)text.size(),NULL,0);if(length<=0)return 1;std::wstring node(length,L'\0');MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,text.data(),(int)text.size(),node.data(),length);
 std::wstring command=q(node)+L" "+q(dir+L"client.cjs");for(int i=1;i<argc;i++)command+=L" "+q(argv[i]);
 STARTUPINFOW si={};si.cb=sizeof(si);si.dwFlags=STARTF_USESTDHANDLES;si.hStdInput=GetStdHandle(STD_INPUT_HANDLE);si.hStdOutput=GetStdHandle(STD_OUTPUT_HANDLE);si.hStdError=GetStdHandle(STD_ERROR_HANDLE);PROCESS_INFORMATION pi={0};if(!CreateProcessW(node.c_str(),command.data(),NULL,NULL,TRUE,CREATE_NO_WINDOW,NULL,NULL,&si,&pi))return 1;
 CloseHandle(pi.hThread);WaitForSingleObject(pi.hProcess,INFINITE);DWORD code=1;GetExitCodeProcess(pi.hProcess,&code);CloseHandle(pi.hProcess);return (int)code;
}
