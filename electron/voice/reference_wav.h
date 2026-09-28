// Strict canonical input validation for the managed Mac engine. No source-file fallback.
#pragma once
#include "reference_policy.h"
#include <CommonCrypto/CommonDigest.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#include <filesystem>
#include <vector>
#include <cmath>
#include <algorithm>
#include <stdexcept>
#include <cstring>
struct ManagedReference { std::vector<float> samples; int rate=0; std::string hash,fingerprint; };
static ManagedReference read_managed_reference(const nlohmann::ordered_json& c){
 auto fail=[]()->void{throw std::runtime_error("VOICE_REFERENCE_CHANGED");};
 if(!c.is_object()||c.size()!=7||c.value("kind","")!="wav-reference"||c.value("preprocessingVersion","")!=REFERENCE_PREPROCESSING)fail();
 auto hex=[](const std::string&s){return s.size()==64&&std::all_of(s.begin(),s.end(),[](char x){return (x>='0'&&x<='9')||(x>='a'&&x<='f');});};
 ManagedReference r;r.hash=c.at("sha256").get<std::string>();r.fingerprint=c.at("fingerprint").get<std::string>();if(!hex(r.hash)||!hex(r.fingerprint))fail();
 std::filesystem::path path=c.at("path").get<std::string>();if(!path.is_absolute()||path.filename()!="reference.wav"||path.lexically_normal()!=path)fail();
 for(auto p=path;!p.empty();p=p.parent_path()){if(std::filesystem::is_symlink(std::filesystem::symlink_status(p)))fail();if(p==p.parent_path())break;}
 int fd=open(path.c_str(),O_RDONLY|O_NOFOLLOW);if(fd<0)fail();
 struct Close{int fd;~Close(){close(fd);}} close_fd{fd};struct stat before{},after{};if(fstat(fd,&before)||!S_ISREG(before.st_mode)||before.st_size<44||before.st_size>44+REFERENCE_MAX_SECONDS*48000*2)fail();
 std::vector<unsigned char>b(size_t(before.st_size));size_t offset=0;
 while(offset<b.size()){ssize_t n=read(fd,b.data()+offset,b.size()-offset);if(n<=0)fail();offset+=size_t(n);}
 if(fstat(fd,&after)||before.st_dev!=after.st_dev||before.st_ino!=after.st_ino||before.st_size!=after.st_size||before.st_mtimespec.tv_sec!=after.st_mtimespec.tv_sec||before.st_mtimespec.tv_nsec!=after.st_mtimespec.tv_nsec||before.st_ctimespec.tv_sec!=after.st_ctimespec.tv_sec||before.st_ctimespec.tv_nsec!=after.st_ctimespec.tv_nsec)fail();
 unsigned char hash[CC_SHA256_DIGEST_LENGTH];CC_SHA256(b.data(),CC_LONG(b.size()),hash);std::string actual;const char*digits="0123456789abcdef";for(auto x:hash){actual+=digits[x>>4];actual+=digits[x&15];}if(actual!=r.hash)fail();
 auto u16=[&](size_t i){return uint32_t(b[i])|(uint32_t(b[i+1])<<8);};auto u32=[&](size_t i){return u16(i)|(u16(i+2)<<16);};
 if(memcmp(b.data(),"RIFF",4)||u32(4)+8!=b.size()||memcmp(b.data()+8,"WAVEfmt ",8)||u32(16)!=16||u16(20)!=1||u16(22)!=1||u16(32)!=2||u16(34)!=16||memcmp(b.data()+36,"data",4)||u32(40)!=b.size()-44||u32(40)%2)fail();
 r.rate=int(u32(24));int count=int(u32(40)/2);if(std::find(std::begin(REFERENCE_RATES),std::end(REFERENCE_RATES),r.rate)==std::end(REFERENCE_RATES)||u32(28)!=uint32_t(r.rate*2)||count<r.rate*REFERENCE_MIN_SECONDS||count>r.rate*REFERENCE_MAX_SECONDS||!c.at("sampleRate").is_number_integer()||!c.at("samples").is_number_integer()||c.at("sampleRate")!=r.rate||c.at("samples")!=count)fail();
 r.samples.reserve(count);double sum=0,squared=0;for(int i=0;i<count;i++){float x=int16_t(u16(44+size_t(i)*2))/32768.0f;r.samples.push_back(x);sum+=x;squared+=double(x)*x;}
 if(std::sqrt(std::max(0.0,squared/count-(sum/count)*(sum/count)))<REFERENCE_MIN_AC_RMS)fail();return r;
}
