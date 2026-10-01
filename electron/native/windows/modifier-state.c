#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <string.h>
#ifdef DAEMONLET_MODIFIER_QA
#include <stdlib.h>
#endif
// Only current modifier high bits. No hooks, text/key history, wheel capture or input injection.
static int editing(unsigned flags) { return (flags & 1u) && !(flags & 62u); }
static int pressed(int key) { return (GetAsyncKeyState(key) & 0x8000) != 0; }
static int current(void) {
 unsigned flags=(unsigned)pressed(VK_LMENU);
 flags|=(unsigned)pressed(VK_RMENU)<<1;
 flags|=(unsigned)pressed(VK_CONTROL)<<2;
 flags|=(unsigned)pressed(VK_SHIFT)<<3;
 flags|=(unsigned)pressed(VK_LWIN)<<4;
 flags|=(unsigned)pressed(VK_RWIN)<<5;
 return editing(flags);
}
static int output(int value) {
 const char row[2]={value?'1':'0','\n'};DWORD written=0;
 return WriteFile(GetStdHandle(STD_OUTPUT_HANDLE),row,2,&written,NULL) && written==2;
}
int main(int argc,char **argv) {
#ifdef DAEMONLET_MODIFIER_QA
 if(argc==3 && !strcmp(argv[1],"--policy")) {
  char *end=NULL;unsigned long flags=strtoul(argv[2],&end,10);
  if(!*argv[2] || *end || flags>63)return 1;
  return output(editing((unsigned)flags))?0:1;
 }
#endif
 const int once=argc==2 && !strcmp(argv[1],"--once");
 if(argc!=1 && !once)return 1;
 do {
  // Inactive/inaccessible desktops report zero and remain click-through.
  if(!output(current()))return 0; // App read-pipe closure retires the helper, including parent crash.
  if(once)return 0;
  Sleep(100);
 } while(1);
}
