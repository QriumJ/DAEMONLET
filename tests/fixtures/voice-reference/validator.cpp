// GPU-free harness of the exact production native reference parser.
#include "nlohmann/json.hpp"
#include "reference_wav.h"
#include <iostream>
int main(){std::string line;while(std::getline(std::cin,line)){try{auto r=read_managed_reference(nlohmann::ordered_json::parse(line));std::cout<<nlohmann::ordered_json{{"ok",true},{"sampleRate",r.rate},{"samples",r.samples.size()},{"sha256",r.hash}}<<std::endl;}catch(...){std::cout<<"{\"ok\":false}"<<std::endl;}}}
