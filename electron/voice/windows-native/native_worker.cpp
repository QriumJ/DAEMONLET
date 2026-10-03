// Experimental Windows x64 adapter for one reviewed VoxCPM2 GGUF build.
// No downloads, playback, model conversion or app settings writes occur here.
#include "voxcpm2_runtime.h"
#include "llama.h"
#include "ggml-backend.h"
#include "nlohmann/json.hpp"
#include "../seed_contract.h"
#include <windows.h>
#include <tlhelp32.h>
#include <bcrypt.h>
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <iostream>
#include <mutex>
#include <stdexcept>
#include <thread>
#include <vector>

using Json = nlohmann::json;
extern "C" size_t daemonlet_reference_cache_builds(const VoxCPM2Runtime*);
static constexpr const char* BASE_VOICE_DESCRIPTION = "An adult female voice, warm and gentle, clear and natural, with a calm conversational pace.";
static std::mutex output_mutex;
static void emit(const Json& value) {
    std::lock_guard<std::mutex> lock(output_mutex);
    std::cout << value.dump() << std::endl;
}
struct Handle {
    HANDLE value = INVALID_HANDLE_VALUE;
    ~Handle() { if (value != INVALID_HANDLE_VALUE && value) CloseHandle(value); }
};
static HANDLE parent_handle() {
    Handle snapshot{CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)};
    if (snapshot.value == INVALID_HANDLE_VALUE) return nullptr;
    PROCESSENTRY32W row{}; row.dwSize = sizeof(row);
    if (!Process32FirstW(snapshot.value, &row)) return nullptr;
    do {
        if (row.th32ProcessID == GetCurrentProcessId()) {
            return OpenProcess(SYNCHRONIZE, FALSE, row.th32ParentProcessID);
        }
    } while (Process32NextW(snapshot.value, &row));
    return nullptr;
}
static std::string utf8(const wchar_t* value) {
    const int size = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value, -1, nullptr, 0, nullptr, nullptr);
    if (size <= 1) throw std::runtime_error("VOICE_PATH");
    std::string result(size, '\0');
    if (!WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value, -1, result.data(), size, nullptr, nullptr))
        throw std::runtime_error("VOICE_PATH");
    result.pop_back(); return result;
}
struct Reference { std::vector<float> samples; int rate = 0; };
static Reference reference(const wchar_t* name, const std::string& expected) {
    const std::filesystem::path path(name);
    if (!path.is_absolute() || path.lexically_normal() != path || expected.size() != 64)
        throw std::runtime_error("VOICE_REFERENCE_CHANGED");
    for (auto part = path; !part.empty(); part = part.parent_path()) {
        const DWORD attrs = GetFileAttributesW(part.c_str());
        if (attrs == INVALID_FILE_ATTRIBUTES || attrs & FILE_ATTRIBUTE_REPARSE_POINT)
            throw std::runtime_error("VOICE_REFERENCE_CHANGED");
        if (part == part.parent_path()) break;
    }
    // Block concurrent writes and replacement while verifying and decoding bytes.
    Handle file{CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING,
                            FILE_ATTRIBUTE_NORMAL | FILE_FLAG_SEQUENTIAL_SCAN, nullptr)};
    LARGE_INTEGER size{};
    if (file.value == INVALID_HANDLE_VALUE || !GetFileSizeEx(file.value, &size) ||
        size.QuadPart < 44 || size.QuadPart > 44 + 20 * 48000 * 2)
        throw std::runtime_error("VOICE_REFERENCE_CHANGED");
    std::vector<unsigned char> bytes(static_cast<size_t>(size.QuadPart));
    DWORD count = 0;
    if (!ReadFile(file.value, bytes.data(), static_cast<DWORD>(bytes.size()), &count, nullptr) || count != bytes.size())
        throw std::runtime_error("VOICE_REFERENCE_CHANGED");
    unsigned char digest[32];
    BCRYPT_ALG_HANDLE algorithm = nullptr;
    if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) < 0)
        throw std::runtime_error("VOICE_REFERENCE_CHANGED");
    const auto status = BCryptHash(algorithm, nullptr, 0, bytes.data(), static_cast<ULONG>(bytes.size()), digest, sizeof(digest));
    BCryptCloseAlgorithmProvider(algorithm, 0);
    if (status < 0) throw std::runtime_error("VOICE_REFERENCE_CHANGED");
    std::string hash; const char* hex = "0123456789abcdef";
    for (auto byte : digest) { hash += hex[byte >> 4]; hash += hex[byte & 15]; }
    if (hash != expected) throw std::runtime_error("VOICE_REFERENCE_CHANGED");
    auto u16 = [&](size_t i) { return uint32_t(bytes[i]) | uint32_t(bytes[i + 1]) << 8; };
    auto u32 = [&](size_t i) { return u16(i) | u16(i + 2) << 16; };
    if (memcmp(bytes.data(), "RIFF", 4) || u32(4) + 8 != bytes.size() ||
        memcmp(bytes.data() + 8, "WAVEfmt ", 8) || u32(16) != 16 || u16(20) != 1 ||
        u16(22) != 1 || u16(32) != 2 || u16(34) != 16 || memcmp(bytes.data() + 36, "data", 4) ||
        u32(40) != bytes.size() - 44 || u32(40) % 2)
        throw std::runtime_error("VOICE_REFERENCE_CHANGED");
    Reference ref; ref.rate = static_cast<int>(u32(24)); const int samples = static_cast<int>(u32(40) / 2);
    const std::vector<int> rates{16000, 22050, 24000, 32000, 44100, 48000};
    if (std::find(rates.begin(), rates.end(), ref.rate) == rates.end() ||
        u32(28) != uint32_t(ref.rate * 2) || samples < ref.rate * 2 || samples > ref.rate * 20)
        throw std::runtime_error("VOICE_REFERENCE_CHANGED");
    double sum = 0, squared = 0; ref.samples.reserve(samples);
    for (int i = 0; i < samples; ++i) {
        const float sample = int16_t(u16(44 + size_t(i) * 2)) / 32768.0f;
        ref.samples.push_back(sample); sum += sample; squared += double(sample) * sample;
    }
    if (std::sqrt(std::max(0.0, squared / samples - (sum / samples) * (sum / samples))) < 0.0001)
        throw std::runtime_error("VOICE_REFERENCE_CHANGED");
    return ref;
}
static Json backends(const VoxCPM2Runtime& runtime) {
    Json result = Json::object();
    const std::pair<const char*, ggml_backend_t> components[]{
        {"ResidualLM", runtime.residual_lm.backend}, {"LocEnc", runtime.loc_enc.backend},
        {"LocDiT", runtime.loc_dit.backend}, {"FSQ", runtime.fsq.backend},
        {"AudioVAE", runtime.audio_vae.backend}, {"Projections", runtime.projections.backend},
        {"StopPredictor", runtime.stop_predictor.backend}};
    for (const auto& component : components) {
        if (!component.second) throw std::runtime_error("UNSUPPORTED_DEVICE");
        const std::string name = ggml_backend_name(component.second);
        if (name.rfind(VOX_EXPECTED_BACKEND, 0) != 0) throw std::runtime_error("UNSUPPORTED_DEVICE");
        result[component.first] = name;
    }
    return result;
}
// Bound the input line before allocating JSON; the parent adapter also validates it.
static bool line(std::string& result) {
    result.clear(); bool oversize = false; char byte;
    while (std::cin.get(byte)) {
        if (byte == '\n') { if (oversize) throw std::runtime_error("PROTOCOL_LIMIT"); return true; }
        if (result.size() < 8192) result += byte; else oversize = true;
    }
    return false;
}
int wmain(int argc, wchar_t** argv) {
    if (argc != 3 && argc != 5) return 2;
    const bool default_voice = argc == 3;
    Handle parent{parent_handle()}; if (!parent.value) return 70;
    // The OS releases this process's GPU allocations if its owning adapter dies.
    std::thread([handle = parent.value] {
        if (WaitForSingleObject(handle, INFINITE) == WAIT_OBJECT_0) std::_Exit(70);
    }).detach();
    try {
        std::atomic<int> offloaded{0}, layers{0};
        std::pair<std::atomic<int>*, std::atomic<int>*> log_values{&offloaded, &layers};
        // Install the callback with a live owner for the whole runtime lifetime.
        llama_log_set([](ggml_log_level, const char* text, void* data) {
            auto& values = *static_cast<std::pair<std::atomic<int>*, std::atomic<int>*>*>(data);
            if (const char* start = strstr(text, "offloaded ")) {
                int a = 0, b = 0;
                if (sscanf(start, "offloaded %d/%d layers to GPU", &a, &b) == 2) {
                    values.first->store(a); values.second->store(b);
                }
            }
            fputs(text, stderr); fflush(stderr);
        }, &log_values);
        const auto initialized = std::chrono::steady_clock::now();
        ggml_time_init(); VoxCPM2Runtime runtime;
        if (!runtime.init(utf8(argv[1]), utf8(argv[2]), -1, true)) throw std::runtime_error("MODEL_LOAD");
        const auto component_backends = backends(runtime);
        if (offloaded != runtime.base_lm.n_layer + 1 || layers != offloaded)
            throw std::runtime_error("UNSUPPORTED_DEVICE");
        const auto loaded = std::chrono::steady_clock::now();
        Reference ref;
        if (!default_voice) {
            ref = reference(argv[3], utf8(argv[4]));
            if (runtime.encode_reference_audio(ref.samples, ref.rate).empty()) throw std::runtime_error("VOICE_REFERENCE_RUNTIME");
            runtime.reset_state();
        }
        const size_t expected_reference_builds = default_voice ? 0 : 1;
        if (daemonlet_reference_cache_builds(&runtime) != expected_reference_builds) throw std::runtime_error("VOICE_REFERENCE_RUNTIME");
        const auto ready = std::chrono::steady_clock::now();
        std::mutex mutex; std::condition_variable cv; bool quit = false, cancel = false, pending = false;
        std::string id, text; int seed = 42, produced = 0, credited = 0;
        std::thread input([&] {
            std::string next_line;
            try {
                while (line(next_line)) {
                    const auto request = Json::parse(next_line);
                    std::unique_lock<std::mutex> lock(mutex); const auto type = request.value("type", "");
                    if (type == "quit") { quit = true; cancel = true; cv.notify_all(); break; }
                    if (type == "generate" && id.empty()) {
                        const auto next = request.at("id").get<std::string>();
                        const auto utterance = request.at("text").get<std::string>();
                        if (next.empty() || next.size() > 64 || utterance.empty() || utterance.size() > 1600)
                            throw std::runtime_error("SYNTHESIS_INPUT");
                        seed = voice_request_seed(request); id = next; text = utterance;
                        produced = credited = 0; cancel = false; pending = true; cv.notify_all();
                    } else if (!id.empty() && request.value("id", "") == id) {
                        if (type == "cancel") cancel = true;
                        else if (type == "credit") {
                            const int index = request.value("index", -1);
                            if (index == credited && credited < produced) ++credited;
                            else if (index >= credited) cancel = true;
                        }
                        cv.notify_all();
                    }
                }
            } catch (...) {}
            std::lock_guard<std::mutex> lock(mutex); quit = true; cancel = true; cv.notify_all();
        });
        emit({{"seedContract", 1}, {"type", "ready"}, {"pid", GetCurrentProcessId()},
              {"backend", VOX_EXPECTED_BACKEND}, {"componentBackends", component_backends},
              {"referenceMode", default_voice ? "base" : "reference"},
              {"offloadedLayers", offloaded.load()}, {"totalLayers", layers.load()},
              {"referenceCacheBuilds", daemonlet_reference_cache_builds(&runtime)},
              {"modelLoadMs", std::chrono::duration<double, std::milli>(loaded - initialized).count()},
              {"referenceMs", std::chrono::duration<double, std::milli>(ready - loaded).count()}});
        while (true) {
            std::string current, utterance; int current_seed;
            {
                std::unique_lock<std::mutex> lock(mutex); cv.wait(lock, [&] { return pending || quit; });
                if (quit) break; pending = false; current = id; utterance = text; current_seed = seed;
            }
            const auto start = std::chrono::steady_clock::now(); int offset = 0; std::string error;
            try {
                VoxCPM2GenerateParams params; params.seed = current_seed; params.reference_sample_rate = ref.rate;
                params.inference_timesteps = 10; params.cfg_value = 2; params.temperature = 1; params.target_sr = 48000;
                params.max_steps = std::min(600, int(runtime.tokenize_text(utterance, false, true).size()) * 6 + 10);
                const auto callback = [&](const std::vector<float>& pcm, bool final) {
                        std::unique_lock<std::mutex> lock(mutex);
                        if (!cv.wait_for(lock, std::chrono::seconds(10), [&] { return cancel || quit || produced - credited < 1; })) {
                            cancel = true; error = "STREAM_CREDIT_TIMEOUT";
                        }
                        if (cancel || quit) return false;
                        if (pcm.empty()) return true;
                        if (pcm.size() > 48000 || offset + int(pcm.size()) > 48000 * 60 ||
                            !std::all_of(pcm.begin(), pcm.end(), [](float value) { return std::isfinite(value); }))
                            throw std::runtime_error("AUDIO_LIMIT");
                        const int index = produced++; lock.unlock();
                        emit({{"effectiveSeed", current_seed}, {"type", "chunk"}, {"id", current},
                              {"index", index}, {"offset", offset}, {"pcm", pcm}, {"final", final},
                              {"seconds", std::chrono::duration<double>(std::chrono::steady_clock::now() - start).count()}});
                        offset += int(pcm.size()); if (final) return true;
                        lock.lock();
                        if (!cv.wait_for(lock, std::chrono::seconds(10), [&] { return cancel || quit || credited > index; })) {
                            cancel = true; error = "STREAM_CREDIT_TIMEOUT";
                        }
                        return !cancel && !quit;
                    };
                const bool ok = default_voice
                    ? runtime.generate_streaming(std::string("(") + BASE_VOICE_DESCRIPTION + ")" + utterance, callback, params)
                    : runtime.generate_with_clone_streaming(utterance, ref.samples, callback, params);
                if (!ok) error = "SYNTHESIS_FAILED";
                // Upstream's StreamGuard has restored VAE state before returning.
                runtime.reset_state();
            } catch (...) { error = "SYNTHESIS_FAILED"; runtime.reset_state(); }
            bool cancelled;
            { std::lock_guard<std::mutex> lock(mutex); cancelled = cancel; id.clear(); }
            emit({{"effectiveSeed", current_seed}, {"type", "end"}, {"id", current},
                  {"pid", GetCurrentProcessId()}, {"cancelled", cancelled}, {"cleanupComplete", true},
                  {"referenceCacheBuilds", daemonlet_reference_cache_builds(&runtime)},
                  {"error", error}, {"samples", offset},
                  {"seconds", std::chrono::duration<double>(std::chrono::steady_clock::now() - start).count()}});
        }
        input.join(); runtime.free(); llama_log_set(nullptr, nullptr);
        emit({{"type", "shutdown"}, {"pid", GetCurrentProcessId()}}); return 0;
    } catch (...) {
        llama_log_set(nullptr, nullptr); emit({{"type", "error"}, {"code", "VOX_WINDOWS_NATIVE_INIT"}}); return 3;
    }
}
