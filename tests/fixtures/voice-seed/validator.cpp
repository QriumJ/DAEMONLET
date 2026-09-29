#include "nlohmann/json.hpp"
#include "../../../electron/voice/seed_contract.h"
#include <iostream>
int main(){std::string row;while(std::getline(std::cin,row)){try{std::cout<<voice_request_seed(nlohmann::json::parse(row))<<'\n';}catch(...){std::cout<<"INVALID\n";}}}
