#pragma once
#include <stdexcept>
// Reject JSON bool/float/string/null and overflow before narrowing to the model's int.
template<class Json> int voice_request_seed(const Json& j){
 if(!j.contains("seed"))throw std::runtime_error("VOICE_SEED_INVALID");
 const auto&v=j.at("seed");
 if(!v.is_number_integer()||v.is_boolean()||v<1||v>2147483647)throw std::runtime_error("VOICE_SEED_INVALID");
 if(j.contains("binding")&&j.at("binding").contains("effectiveSeed")){
  const auto& bound=j.at("binding").at("effectiveSeed");
  if(!bound.is_number_integer()||bound.is_boolean()||bound!=v)throw std::runtime_error("VOICE_SEED_MISMATCH");
 }
 return v.template get<int>();
}
