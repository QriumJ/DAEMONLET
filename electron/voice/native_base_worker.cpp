// Default VoxCPM2 voice: no adapter, reference recording, Python or model download.
#define main upstream_voxcpm2_cli_main
#include "voxcpm2_cli.cpp"
#undef main
#include "nlohmann/json.hpp"
#include "base_voice_defaults.h"
#include <iostream>
#include <condition_variable>
#include <mutex>
#include <thread>
#include <deque>
#include <filesystem>
#include <unistd.h>
using J=nlohmann::ordered_json;
namespace fs=std::filesystem;
static void emit(const std::string&type,const std::string&id,J data=J::object()){
 J value={{"protocolVersion",1},{"type",type},{"requestId",id}};value.update(data);std::cout<<value.dump()<<std::endl;
}
static std::string audio_id(){
 static uint64_t count=0;char value[37];snprintf(value,sizeof(value),"%08x-0000-4000-8000-%012llx",unsigned(getpid()),(unsigned long long)++count);return value;
}
int main(){
 const pid_t parent=getppid();std::thread([parent]{while(true){std::this_thread::sleep_for(std::chrono::milliseconds(100));if(getppid()!=parent)std::_Exit(70);}}).detach();
 VoxCPM2Runtime runtime;std::string cache,line,initial;
 try{
  if(!std::getline(std::cin,line)||line.size()>65536)return 2;auto init=J::parse(line);initial=init.at("requestId");
  if(init.at("type")!="init"||init.at("protocolVersion")!=1||init.at("executionProfile")!="gguf-metal-f16")throw std::runtime_error("PROTOCOL_STATE");
  cache=init.at("cache").get<std::string>();const fs::path model=init.at("model").get<std::string>();
  if(!fs::path(cache).is_absolute()||!model.is_absolute())throw std::runtime_error("PATH");fs::create_directories(cache);
  ggml_time_init();if(!runtime.init((model/"VoxCPM2-BaseLM-F16.gguf").string(),(model/"VoxCPM2-Acoustic-F16.gguf").string(),-1,true))throw std::runtime_error("UNSUPPORTED_DEVICE");
  if(std::string(ggml_backend_name(runtime.residual_lm.backend)).find("MTL")!=0)throw std::runtime_error("UNSUPPORTED_DEVICE");
  emit("ready",initial,{{"workerPid",getpid()},{"backend","Metal"},{"mode","base"},{"defaultVoice",{{"description",BASE_VOICE_DESCRIPTION},{"seed",BASE_VOICE_SEED}}},{"adapterRepresentation","none"},{"referenceCacheBuilds",0}});
 }catch(const std::exception&){emit("error",initial,{{"code","VOICE_BASE_RUNTIME"}});return 3;}
 std::mutex mutex;std::condition_variable cv;bool quit=false,cancel=false;J activeTarget=nullptr,cancelRequest=nullptr,lastTarget=nullptr;
 std::string activeRequest;int produced=0,credited=0;std::deque<J> requests;std::map<std::string,std::pair<int,int>> tails;std::map<std::string,std::vector<fs::path>> tailFiles;
 std::thread input([&]{std::string row;while(std::getline(std::cin,row)){
  std::unique_lock<std::mutex> lock(mutex);
  try{
   if(row.size()>65536)throw std::runtime_error("limit");auto j=J::parse(row);if(j.at("protocolVersion")!=1)throw std::runtime_error("version");const auto type=j.at("type").get<std::string>();
   if(type=="shutdown"){quit=true;cancel=true;cv.notify_all();break;}
   if(type=="credit"){
    auto rid=j.at("requestId").get<std::string>();int index=j.at("chunkIndex");
    if(rid==activeRequest){if(index!=credited||credited>=produced)throw std::runtime_error("credit");++credited;}
    else {auto it=tails.find(rid);if(it==tails.end()||index!=it->second.first)throw std::runtime_error("tail");if(++it->second.first==it->second.second){tailFiles.erase(rid);tails.erase(it);}}
   }else if(type=="cancel-stream"){
    if(activeTarget.is_null()){requests.push_back(j);}else{if(j.at("target")!=activeTarget||!cancelRequest.is_null())throw std::runtime_error("cancel");cancelRequest=j;cancel=true;}
   }else if(type=="stream"&&requests.empty()){requests.push_back(j);}
   else throw std::runtime_error("state");
   cv.notify_all();
  }catch(...){quit=true;cancel=true;cv.notify_all();break;}
 }std::lock_guard<std::mutex> lock(mutex);quit=true;cancel=true;cv.notify_all();});
 while(true){
  J request;std::string rid;std::vector<fs::path> files;
  {std::unique_lock<std::mutex>lock(mutex);cv.wait(lock,[&]{return quit||!requests.empty();});if(quit)break;request=requests.front();requests.pop_front();rid=request.at("requestId");
   if(request.at("type")=="cancel-stream"){
    if(lastTarget.is_null()||request.at("target")!=lastTarget){emit("error",rid,{{"code","STREAM_CANCEL_BINDING"}});quit=true;break;}
    const auto targetId=lastTarget.at("requestId").get<std::string>();
    for(const auto&p:tailFiles[targetId]){std::error_code ignored;fs::remove(p,ignored);}tailFiles.erase(targetId);tails.erase(targetId);
    emit("cancelled",rid,{{"target",lastTarget},{"cleanupComplete",true},{"keptWarm",true},{"boundary","terminal"},{"reuseAudit",{{"referenceCacheBuilds",0}}}});continue;
   }
   activeTarget={{"requestId",rid},{"synthesisId",request.at("synthesisId")},{"runtimeSessionId",request.at("binding").at("runtimeSessionId")},{"speechEpoch",request.at("binding").at("speechEpoch")}};
   activeRequest=rid;produced=credited=0;cancel=false;cancelRequest=nullptr;
  }
  const auto start=std::chrono::steady_clock::now();int total=0;double first=0;bool ok=false;std::string error;
  auto milliseconds=[&]{return std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-start).count();};
  try{
   const auto text=request.at("text").get<std::string>();if(text.empty()||text.size()>1600||request.at("streamVersion")!=1||!request.at("style").is_null())throw std::runtime_error("SYNTHESIS_INPUT");
   emit("synthesis-started",rid);VoxCPM2GenerateParams params;params.seed=BASE_VOICE_SEED;params.inference_timesteps=10;params.cfg_value=2;params.temperature=1;params.target_sr=48000;params.max_steps=std::min(600,int(runtime.tokenize_text(text,false,true).size())*6+10);
   std::vector<float> pending;int patches=0;
   auto publish=[&](bool terminal=false){
    if(pending.empty())return true;
    std::unique_lock<std::mutex>lock(mutex);
    if(!cv.wait_for(lock,std::chrono::seconds(30),[&]{return quit||cancel||produced-credited<3;}))throw std::runtime_error("STREAM_CREDIT");
    if(quit||cancel)return false;
    if(total+pending.size()>48000*60||pending.size()>48000)throw std::runtime_error("INVALID_WAVEFORM");
    const std::string aid=audio_id();const fs::path path=fs::path(cache)/(aid+".wav"),part=fs::path(cache)/(aid+".partial");files.push_back(path);files.push_back(part);
    write_wav(part.string(),pending,48000);fs::rename(part,path);if(!produced)first=milliseconds();
    emit("audio-chunk",rid,{{"audioId",aid},{"binding",request.at("binding")},{"synthesisId",request.at("synthesisId")},{"segmentIndex",request.at("segmentIndex")},{"chunkIndex",produced++},{"sampleOffset",total},{"sampleCount",pending.size()},{"sampleRate",48000},{"firstChunkReadyMs",first}});
    total+=pending.size();pending.clear();
    if(!terminal&&produced-credited>=3&&!cv.wait_for(lock,std::chrono::seconds(30),[&]{return quit||cancel||produced-credited<3;}))throw std::runtime_error("STREAM_CREDIT");
    return !quit&&!cancel;
   };
   ok=runtime.generate_streaming(std::string("(")+BASE_VOICE_DESCRIPTION+") "+text,[&](const std::vector<float>&pcm,bool final){
    {std::lock_guard<std::mutex>lock(mutex);if(quit||cancel)return false;}
    for(float x:pcm)if(!std::isfinite(x))throw std::runtime_error("INVALID_WAVEFORM");pending.insert(pending.end(),pcm.begin(),pcm.end());++patches;
    return (patches%3==0||final||patches>=params.max_steps)?publish(final||patches>=params.max_steps):true;
   },params);
   if(ok&&!publish(true))ok=false;
   runtime.reset_state();
  }catch(const std::exception&){error="TTS_FAILED";runtime.reset_state();}
  {std::lock_guard<std::mutex>lock(mutex);
   if(cancel){for(const auto&p:files){std::error_code ignored;fs::remove(p,ignored);}if(!quit&&!cancelRequest.is_null())emit("cancelled",cancelRequest.at("requestId"),{{"target",activeTarget},{"cleanupComplete",true},{"keptWarm",true},{"boundary","chunk-boundary"},{"reuseAudit",{{"referenceCacheBuilds",0},{"nativePid",getpid()}}}});}
   else if(!ok||!error.empty()||!total){emit("error",rid,{{"code","TTS_FAILED"}});quit=true;}
   else {if(credited<produced){tails[rid]={credited,produced};tailFiles[rid]=files;}emit("synthesis-finished",rid,{{"synthesisId",request.at("synthesisId")},{"totalSamples",total},{"totalChunks",produced},{"firstChunkReadyMs",first},{"generationMs",milliseconds()},{"rtf",milliseconds()/(total/48.0)}});}
   lastTarget=activeTarget;activeTarget=nullptr;activeRequest.clear();
  }
 }
 // Parent closes stdin on normal shutdown; terminate fallback handles fatal protocol errors.
 if(input.joinable())input.join();runtime.free();common_log_flush(common_log_main());return 0;
}
