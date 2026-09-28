// Local diagnostic transport only; production IPC is not changed.
#define main upstream_voxcpm2_cli_main
#include "voxcpm2_cli.cpp"
#undef main
#include "nlohmann/json.hpp"
#include <iostream>
#include <condition_variable>
#include <mutex>
#include <thread>
#include <unistd.h>
using Json=nlohmann::json;
int main(int argc,char**argv){
 if(argc!=4)return 2;
 ggml_time_init();VoxCPM2Runtime runtime;
 if(!runtime.init(argv[1],argv[2],-1,true))return 3;
 if(std::string(ggml_backend_name(runtime.residual_lm.backend)).find("MTL")!=0)return 4;
 int sr=0;auto ref=load_wav_mono(argv[3],sr);if(ref.empty())return 5;
 std::mutex mutex;std::condition_variable cv;bool quit=false,cancel=false,pending=false;
 std::string id,text;int produced=0,credited=0;
 auto emit=[](const Json&j){std::cout<<j.dump()<<std::endl;};
 std::thread input([&]{
  std::string line;
  while(std::getline(std::cin,line)){
   try{
    if(line.size()>8192)continue;auto j=Json::parse(line);std::unique_lock<std::mutex> lock(mutex);
    auto type=j.value("type","");
    if(type=="quit"){quit=true;cancel=true;cv.notify_all();break;}
    if(type=="generate"&&id.empty()){
     auto next=j.at("id").get<std::string>(),value=j.at("text").get<std::string>();
     if(next.empty()||next.size()>64||value.empty()||value.size()>1600)continue;
     id=next;text=value;produced=credited=0;cancel=false;pending=true;cv.notify_all();
    }else if(j.value("id","")==id&&!id.empty()){
     if(type=="cancel")cancel=true;
     if(type=="credit"){
      int index=j.value("index",-1);
      if(index==credited&&credited<produced)credited++;
      else if(index>=credited)cancel=true;
     }
     cv.notify_all();
    }
   }catch(...){std::lock_guard<std::mutex> lock(mutex);cancel=true;cv.notify_all();}
  }
  std::lock_guard<std::mutex> lock(mutex);quit=true;cancel=true;cv.notify_all();
 });
 emit({{"type","ready"},{"pid",getpid()},{"backend","Metal"}});
 while(true){
  std::string current,utterance;
  {std::unique_lock<std::mutex>lock(mutex);cv.wait(lock,[&]{return pending||quit;});if(quit)break;pending=false;current=id;utterance=text;}
  auto start=std::chrono::steady_clock::now();int offset=0;bool ok=false;std::string error;
  try{
   VoxCPM2GenerateParams p;p.seed=42;p.reference_sample_rate=sr;p.inference_timesteps=10;p.cfg_value=2;p.temperature=1;p.target_sr=48000;
   p.max_steps=std::min(600,int(runtime.tokenize_text(utterance,false,true).size())*6+10);
   ok=runtime.generate_with_clone_streaming(utterance,ref,[&](const std::vector<float>&pcm,bool final){
    std::unique_lock<std::mutex>lock(mutex);
    if(!cv.wait_for(lock,std::chrono::seconds(10),[&]{return cancel||quit||produced-credited<3;})){cancel=true;error="credit timeout";}
    if(cancel||quit)return false;
    if(pcm.empty())return true;
    for(float v:pcm)if(!std::isfinite(v))throw std::runtime_error("nonfinite PCM");
    int index=produced++;lock.unlock();
    emit({{"type","chunk"},{"id",current},{"index",index},{"offset",offset},{"pcm",pcm},{"final",final},{"seconds",std::chrono::duration<double>(std::chrono::steady_clock::now()-start).count()}});
    offset+=int(pcm.size());return true;
   },p);
   if(!ok)error=runtime.last_error();
   // Called after the upstream StreamGuard has restored VAE state.
   runtime.reset_state();
  }catch(const std::exception&e){error=e.what();runtime.reset_state();}
  bool wasCancelled;
  {std::lock_guard<std::mutex>lock(mutex);wasCancelled=cancel;id.clear();}
  emit({{"type","end"},{"id",current},{"pid",getpid()},{"cancelled",wasCancelled},{"cleanupComplete",true},{"error",error},{"samples",offset},{"seconds",std::chrono::duration<double>(std::chrono::steady_clock::now()-start).count()}});
 }
 input.join();runtime.free();emit({{"type","shutdown"},{"pid",getpid()}});common_log_flush(common_log_main());return 0;
}
