// Diagnostic only: build against the pinned llama.cpp-omni source and libraries.
// Reuse that source's WAV I/O; its license remains with the external checkout.
#define main upstream_voxcpm2_cli_main
#include "voxcpm2_cli.cpp"
#undef main
#include <filesystem>
#include <unistd.h>

int main(int argc, char **argv) {
    if (argc != 5) { std::fprintf(stderr,"Usage: probe BaseLM.gguf Acoustic.gguf reference.wav NEW_OUTPUT_DIR\n"); return 2; }
    namespace fs = std::filesystem;
    if (fs::exists(argv[4])) return 2;
    fs::create_directories(argv[4]);
    std::ofstream metrics(fs::path(argv[4])/"metrics.jsonl");
    auto now=[](){return std::chrono::steady_clock::now();};
    auto elapsed=[&](auto t){return std::chrono::duration<double>(now()-t).count();};
    ggml_time_init();
    VoxCPM2Runtime runtime;
    auto start=now();
    if (!runtime.init(argv[1],argv[2],-1,true)) return 3;
    if (std::string(ggml_backend_name(runtime.residual_lm.backend)).find("MTL") != 0) return 6;
    metrics << "{\"event\":\"init\",\"pid\":" << getpid() << ",\"seconds\":" << elapsed(start) << "}" << std::endl;
    int sr=0;auto ref=load_wav_mono(argv[3],sr);if(ref.empty())return 4;
    VoxCPM2GenerateParams p;p.seed=42;p.reference_sample_rate=sr;p.inference_timesteps=10;p.cfg_value=2;p.temperature=1;p.target_sr=48000;
    const std::string texts[]={"오빠, 오늘은 어떤 이야기를 할까?","먼저 파일을 확인할게. 문제가 없으면 다음 작업으로 넘어가자."};
    const int caps[]={184,322};
    for(int i=0;i<2;i++) {
        auto ids=runtime.tokenize_text(texts[i],false,true);
        metrics << "{\"event\":\"tokens\",\"textIndex\":"<<i<<",\"ids\":[";
        for(size_t j=0;j<ids.size();j++){if(j)metrics<<",";metrics<<ids[j];}metrics<<"]}"<<std::endl;
    }
    auto record=[&](const std::string& name,int idx,auto t,const std::vector<float>& wav,double first,int chunks,bool cancelled,double cancelReturn){
        bool finite=!wav.empty();double peak=0,ss=0;for(float v:wav){finite &= std::isfinite(v);peak=std::max(peak,double(std::abs(v)));ss+=double(v)*v;}
        double wall=elapsed(t),dur=double(wav.size())/48000;
        metrics<<"{\"event\":\"generation\",\"name\":\""<<name<<"\",\"textIndex\":"<<idx<<",\"seconds\":"<<wall<<",\"audioSeconds\":"<<dur<<",\"rtf\":"<<(dur?wall/dur:0)<<",\"firstChunkSeconds\":"<<first<<",\"chunks\":"<<chunks<<",\"cancelled\":"<<(cancelled?"true":"false")<<",\"cancelReturnSeconds\":"<<cancelReturn<<",\"finite\":"<<(finite?"true":"false")<<",\"peak\":"<<peak<<",\"rms\":"<<std::sqrt(ss/std::max(size_t(1),wav.size()))<<"}"<<std::endl;
        if(!finite)throw std::runtime_error("Non-finite/empty audio");
        write_wav((fs::path(argv[4])/(name+".wav")).string(),wav,48000);
    };
    for(int pass=0;pass<2;pass++)for(int i=0;i<2;i++){
        p.max_steps=caps[i];auto t=now();auto wav=runtime.generate_with_clone(texts[i],ref,p);
        record("whole-"+std::to_string(pass)+"-"+std::to_string(i),i,t,wav,-1,0,false,0);
    }
    auto stream=[&](std::string name,int idx,int cancelAt){
        p.max_steps=caps[idx];auto t=now(),cancelTime=t;std::vector<float>wav;int chunks=0;double first=-1;
        bool ok=runtime.generate_with_clone_streaming(texts[idx],ref,[&](const std::vector<float>&chunk,bool final){
            if(!chunk.empty()){if(first<0)first=elapsed(t);chunks++;wav.insert(wav.end(),chunk.begin(),chunk.end());}
            metrics<<"{\"event\":\"chunk\",\"name\":\""<<name<<"\",\"seconds\":"<<elapsed(t)<<",\"samples\":"<<chunk.size()<<",\"final\":"<<(final?"true":"false")<<"}"<<std::endl;
            if(cancelAt && chunks>=cancelAt){cancelTime=now();return false;}return true;
        },p);
        if(!ok)throw std::runtime_error(runtime.last_error());
        record(name,idx,t,wav,first,chunks,cancelAt!=0,cancelAt?elapsed(cancelTime):0);
        if(cancelAt && chunks!=cancelAt)throw std::runtime_error("Unexpected post-cancel chunk");
        return wav;
    };
    auto expected=stream("stream-baseline",0,0);stream("stream-long",1,0);
    for(int cycle=0;cycle<5;cycle++){
        stream("cancel-"+std::to_string(cycle),1,cycle%2+1);
        auto recovered=stream("recover-"+std::to_string(cycle),0,0);
        bool equal=expected==recovered;
        metrics<<"{\"event\":\"recovery\",\"cycle\":"<<cycle<<",\"samePcm\":"<<(equal?"true":"false")<<"}"<<std::endl;
        if(!equal)return 5;
    }
    runtime.free();
    metrics<<"{\"event\":\"freed\",\"pid\":"<<getpid()<<"}"<<std::endl;
    common_log_flush(common_log_main());
    return 0;
}
