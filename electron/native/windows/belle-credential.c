#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <wincred.h>
#include <stdio.h>
#include <string.h>
// Fixed app-owned target. QA builds cannot access the production item.
#ifdef DAEMONLET_CREDENTIAL_QA
static wchar_t target[] = L"io.github.ddol2ya.daemonlet.belle-connection.qa-v1";
#else
static wchar_t target[] = L"io.github.ddol2ya.daemonlet.belle-connection.runtime-v1";
#endif
static int fail(DWORD code) {
 const char *value = code == ERROR_NOT_FOUND ? "KEY_MISSING" : code == ERROR_ACCESS_DENIED ? "STORE_DENIED" : code == ERROR_NO_SUCH_LOGON_SESSION ? "STORE_LOCKED" : "STORE_UNAVAILABLE";
 printf("{\"ok\":false,\"code\":\"%s\"}", value); return 0;
}
static int valid(const BYTE *key, DWORD size) {
 if(size < 23 || size > 1023 || memcmp(key,"sk-",3)) return 0;
 for(DWORD i=3;i<size;i++) if(!((key[i]>='A'&&key[i]<='Z')||(key[i]>='a'&&key[i]<='z')||(key[i]>='0'&&key[i]<='9')||key[i]=='_'||key[i]=='-')) return 0;
 return 1;
}
static void retire(PCREDENTIALW item) {
 if(item->CredentialBlob) SecureZeroMemory(item->CredentialBlob,item->CredentialBlobSize);
 CredFree(item);
}
int main(int argc,char **argv) {
 if(argc!=2) return fail(ERROR_INVALID_PARAMETER);
 if(!strcmp(argv[1],"put")) {
  BYTE input[2049]={0}; size_t n=fread(input,1,sizeof(input),stdin);
  // Main writes exactly JSON.stringify({key}); no escapes are valid in a key.
  if(n>2048 || n<10 || memcmp(input,"{\"key\":\"",8) || memcmp(input+n-2,"\"}",2) || !valid(input+8,(DWORD)n-10)) {
   SecureZeroMemory(input,sizeof(input)); printf("{\"ok\":false,\"code\":\"INVALID_KEY\"}");return 0;
  }
  CREDENTIALW item={0};item.Type=CRED_TYPE_GENERIC;item.TargetName=target;
  item.CredentialBlob=input+8;item.CredentialBlobSize=(DWORD)n-10;
  item.Persist=CRED_PERSIST_LOCAL_MACHINE;item.UserName=L"runtime-v1";
  item.Comment=L"DAEMONLET Belle restricted tunnel runtime key";
  BOOL ok=CredWriteW(&item,0);DWORD error=ok?0:GetLastError();SecureZeroMemory(input,sizeof(input));
  if(!ok)return fail(error);printf("{\"ok\":true}");return 0;
 }
 if(!strcmp(argv[1],"remove")) {
  if(!CredDeleteW(target,CRED_TYPE_GENERIC,0) && GetLastError()!=ERROR_NOT_FOUND)return fail(GetLastError());
  printf("{\"ok\":true}");return 0;
 }
 if(strcmp(argv[1],"available") && strcmp(argv[1],"has") && strcmp(argv[1],"get")) return fail(ERROR_INVALID_PARAMETER);
 PCREDENTIALW item=NULL;BOOL found=CredReadW(target,CRED_TYPE_GENERIC,0,&item);DWORD error=found?0:GetLastError();
 if(!found && error!=ERROR_NOT_FOUND)return fail(error);
 if(!strcmp(argv[1],"available")) {if(found)retire(item);printf("{\"ok\":true,\"available\":true}");return 0;}
 if(!strcmp(argv[1],"has")) {if(found)retire(item);printf("{\"ok\":true,\"stored\":%s}",found?"true":"false");return 0;}
 if(!found)return fail(ERROR_NOT_FOUND);
 if(!item->CredentialBlob || !valid(item->CredentialBlob,item->CredentialBlobSize)){retire(item);return fail(ERROR_INVALID_DATA);}
 printf("{\"ok\":true,\"key\":\"");fwrite(item->CredentialBlob,1,item->CredentialBlobSize,stdout);printf("\"}");retire(item);return 0;
}
