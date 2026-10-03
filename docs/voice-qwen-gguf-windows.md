# Windows Qwen Base Q8 GGUF

`Qwen3-TTS 0.6B Base Q8 · GGUF CUDA` is an optional, separately configured
Windows x64 engine. It uses the reviewed community qwentts.cpp build below.
The official PyTorch engine and Apple Silicon MLX engine keep their existing
connections, installers, model policies, and playback modes. Selecting GGUF
never downloads, installs, converts, or overwrites either engine's files.

## Reference and trained-pack compatibility

Both Qwen engines accept an authorized WAV reference profile. X-vector uses
its speaker embedding; ICL also requires the exact words spoken in that WAV.
The native reference preparation computes speaker embedding and codec codes
once per worker, caching them only in that process. Changing the reference,
transcript, mode, native build, or model revision requires a new preparation.

VoxCPM2 LoRA training weights are not Qwen weights. A trained Vox package is
therefore disabled as a Qwen voice choice. The user can explicitly import its
authorized reference WAV as a separate WAV profile and supply the transcript,
but that reproduces the reference voice through Qwen, not the trained Vox
adapter. Original packages, weights, and WAVs are preserved; there is no
implicit migration or merge.

## External connection

Use the engine selector, then **Qwen GGUF Python·DLL·모델 연결**. Select an
existing dedicated Python interpreter, the directory containing the reviewed
native DLLs, and a model directory containing exactly the two files below.
Cancelled or obsolete settings dialogs cannot publish a connection. The app
stores a separate `qwenGgufRuntime` connection and execution preference.
The original `qwenRuntime` and Vox `runtime` remain available when switching
engines. Paths below are placeholders, not default or live installation paths.

```text
<dedicated-venv>/Scripts/python.exe
<external-runtime>/qwen.dll + ggml*.dll
<external-models>/qwen-talker-0.6b-base-Q8_0.gguf
<external-models>/qwen-tokenizer-12hz-Q8_0.gguf
```

This version admits Python 3.11.15, numpy 2.4.6, scipy 1.17.1, soundfile 0.14.0,
and the five DLL byte hashes in `electron/voice/runtime-qwen-gguf-windows.json`.
It reuses an existing environment without importing Torch. The reviewed build
uses MSVC 14.35.32215, CUDA Toolkit 13.0.48 and CUDA architecture 89. It has been
independently tested on RTX4090; other GPUs and independently built binary
hashes are not admitted by this policy. This is an experimental fixed artifact
connection, not a general installer or a claim of portable NVIDIA support.
No new runtime installation is attempted when these requirements are absent.

The DLL search directory is set only inside the worker process, including
CUDA 13.0 `bin` and `bin/x64`. Unknown backend DLLs in scanned directories are
rejected. DLL hashes and ABI 5 layout are verified before native entry points.
The runtime's actual `base` model type and Talker `CUDA0` backend are checked;
a whole-backend CPU fallback fails preparation. GGML can still schedule
individual unsupported operations on CPU: CUDA selection does not mean every
operation executes on the GPU.

| External artifact | Pin / bytes / SHA256 |
|---|---|
| qwentts.cpp (MIT) | `ServeurpersoCom/qwentts.cpp` commit `6fae92914045cd83364d2845ceaa0f7969727319` |
| ggml (MIT) | `ServeurpersoCom/ggml` commit `40e16e4a814f7fe851a0c486fb9e8c722e957830` |
| GGUF model revision (Apache-2.0 declared) | `Serveurperso/Qwen3-TTS-GGUF` revision `b7ee2e8c7459c3bea99da23e3d178125a7d1713c` |
| Base Q8 | 992,615,488 bytes; `d54dbaf10591421fa764ed630d764efa717ae40cd959bd48c66d4eb1af226426` |
| Codec Q8 | 291,150,624 bytes; `1883beeed99348fc35e23dd225e9082f93f6f8c109330a33d935baa8acdbfd94` |

Total model download, if separately approved and needed: 1,283,766,112 bytes.
Base and CustomVoice are different model types; the community model-card table
has reversed descriptions, so file pins and native model type are authoritative.
All large-model bytes are hashed on each new worker load even when the original
PyTorch engine's saved policy is `installed`. Warm requests compare asset
metadata, including the bridge's required Python dependencies, rather than
repeatedly inventorying the unused Torch environment. Metadata change detection
is not a replacement for initial content checks or an integrity claim for every
third-party Python package.

## Playback and cleanup

`qwen-gguf` feeds actual native PCM callbacks into ordered, atomic 48 kHz mono
PCM16 WAV chunks. It uses the existing three-credit transport and renderer
playback pipeline. No fabricated silence, normalization, denoise, or trimming
is applied. The bounded output maximum is 60 seconds per segment.
`qwen-gguf-complete` emits the complete segment before playback. Sampling is
fixed to temperature .9, top-k 50, top-p 1, repetition penalty 1.05 and at most
720 tokens; the existing per-reply/fixed seed contract applies. Equal seeds
across Torch and GGUF do not imply equal PRNG output or identical waveforms.

Local character chat can retain the worker and reference cache between speech
requests. A streaming voice-only stop acknowledges reuse only after native
synthesis has returned and native output buffers are freed. Wrong-target
acknowledgements, timeout, protocol failure, and active nonstreaming cancellation
fall back to terminating only the owned process tree. OFF, hidden/closed output,
engine changes and app shutdown unload. Idle GGUF shutdown first requests
normal `qt_free`, then uses a bounded owned-tree fallback. Existing Dots normal
completion still releases its presentation worker; this change adds no retention
TTL or live application setting migration.

## Build and distribution boundary

The app includes the Python bridge, ABI definitions, fixed policy and MIT
notices as ASAR-bound runtime resources. It includes no native DLLs, CUDA,
Python packages, reference WAVs, trained packs, or model weights. Installer
resource validation must include the bridge files and reject authoring/build
sources and extra native/model artifacts. New build artifacts need an explicit
reviewed content pin; an editable external receipt cannot approve an arbitrary
binary. Rebuilding with another compiler is not silently trusted.

A reproduction of the reviewed external CUDA build uses existing approved
tools, exact source snapshots, a separate output directory, and no dependency
fetches:

```text
cmake -S <pinned-qwentts> -B <external-output> -G "Visual Studio 17 2022" -A x64
  -DGGML_SOURCE_DIR=<pinned-ggml> -DGGML_CUDA=ON
  -DCMAKE_CUDA_ARCHITECTURES=89 -DGGML_CUDA_GRAPHS=ON
  -DGGML_CUDA_CUB_3DOT2=OFF -DGGML_CUDA_NCCL=OFF
  -DFETCHCONTENT_FULLY_DISCONNECTED=ON -DQWEN_SHARED=ON
cmake --build <external-output> --config Release
  --target qwen qwen-tts test-abi-c --parallel 4
```

Executing new community source/build scripts or artifacts requires approval
of their exact pin and actions. No downloader, service, firewall, driver, or
security change is introduced by the app. Vulkan requires additional shader
compiler/SDK preparation and distinct build/admission pins; it is not available
through this CUDA policy. Actual AMD/Intel hardware and Vulkan playback have
not been verified. Coordinate GPU tests with other workloads and never stop
unrelated GPU processes.

CPU checks: TypeScript voice/service/IPC/UI regressions, installer ASAR resource
checks, and `python -B scripts/test-qwen-gguf-worker.py --require-pcm -v` with an
existing PCM environment. CPU fake-native tests do not prove native CUDA
playback, ICL quality, speaker similarity or hardware timing. Those require
separate isolated Windows application and GPU evidence, silent WAV samples,
actual backend logs, repeated warm requests and cleanup verification.
