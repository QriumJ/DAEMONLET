cmake_minimum_required(VERSION 3.25)
project(daemonlet_voxcpm2_windows C CXX)
if(NOT WIN32 OR NOT CMAKE_SIZEOF_VOID_P EQUAL 8)
    message(FATAL_ERROR "This experimental target requires Windows x64")
endif()
if(NOT DEFINED VOX_SOURCE OR NOT DEFINED VOX_CACHED_RUNTIME)
    message(FATAL_ERROR "Use the reviewed build.py with a pinned source directory")
endif()
if(NOT VOX_BACKEND MATCHES "^(CUDA|Vulkan)$")
    message(FATAL_ERROR "VOX_BACKEND must be CUDA or Vulkan")
endif()
set(BUILD_SHARED_LIBS ON CACHE BOOL "" FORCE)
set(LLAMA_BUILD_COMMON ON CACHE BOOL "" FORCE)
foreach(option LLAMA_BUILD_TESTS LLAMA_BUILD_TOOLS LLAMA_BUILD_EXAMPLES LLAMA_BUILD_SERVER
               LLAMA_BUILD_APP LLAMA_BUILD_UI LLAMA_OPENSSL LLAMA_LLGUIDANCE
               GGML_METAL GGML_RPC GGML_NATIVE GGML_CUDA_NCCL GGML_CUDA_CUB_3DOT2)
    set(${option} OFF CACHE BOOL "" FORCE)
endforeach()
set(FETCHCONTENT_FULLY_DISCONNECTED ON CACHE BOOL "" FORCE)
set(FETCHCONTENT_UPDATES_DISCONNECTED ON CACHE BOOL "" FORCE)
set(GGML_BACKEND_DL OFF CACHE BOOL "" FORCE)
set(GGML_CUDA_GRAPHS ON CACHE BOOL "" FORCE)
if(VOX_BACKEND STREQUAL "CUDA")
    set(GGML_CUDA ON CACHE BOOL "" FORCE)
    set(GGML_VULKAN OFF CACHE BOOL "" FORCE)
    set(CMAKE_CUDA_ARCHITECTURES 89 CACHE STRING "RTX 4090 experiment only" FORCE)
else()
    set(GGML_CUDA OFF CACHE BOOL "" FORCE)
    set(GGML_VULKAN ON CACHE BOOL "" FORCE)
endif()
add_subdirectory("${VOX_SOURCE}" upstream EXCLUDE_FROM_ALL)
set(VOX_DIR "${VOX_SOURCE}/tools/omni/voxcpm2")
add_library(daemonlet-voxcpm2 STATIC
    "${VOX_DIR}/voxcpm2_llm.cpp"
    "${VOX_DIR}/voxcpm2_fsq.cpp"
    "${VOX_DIR}/voxcpm2_transformer.cpp"
    "${VOX_DIR}/voxcpm2_localenc.cpp"
    "${VOX_DIR}/voxcpm2_locdit.cpp"
    "${VOX_DIR}/voxcpm2_audiovae.cpp"
    "${VOX_DIR}/voxcpm2_cfm.cpp"
    "${VOX_DIR}/voxcpm2_components.cpp"
    "${VOX_CACHED_RUNTIME}")
target_include_directories(daemonlet-voxcpm2 PUBLIC "${VOX_DIR}")
target_link_libraries(daemonlet-voxcpm2 PUBLIC llama llama-common ggml)
target_compile_features(daemonlet-voxcpm2 PUBLIC cxx_std_17)
target_compile_definitions(daemonlet-voxcpm2 PRIVATE NOMINMAX _USE_MATH_DEFINES _CRT_SECURE_NO_WARNINGS)
add_executable(daemonlet-voxcpm2-engine native_worker.cpp)
target_compile_features(daemonlet-voxcpm2-engine PRIVATE cxx_std_17)
target_compile_definitions(daemonlet-voxcpm2-engine PRIVATE NOMINMAX VOX_EXPECTED_BACKEND="${VOX_BACKEND}")
target_link_libraries(daemonlet-voxcpm2-engine PRIVATE daemonlet-voxcpm2 bcrypt)
set_target_properties(daemonlet-voxcpm2-engine PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin")
