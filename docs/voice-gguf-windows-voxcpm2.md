# Windows VoxCPM2 GGUF integration candidate

The Windows native target in `electron/voice/windows-native` is an experimental
port of the admitted Mac VoxCPM2 path. The fixed CUDA and Vulkan targets have
compiled on Windows, with separate sets of seven native file hashes pinned.
GPU inference has not yet passed validation. Keep the existing engine as the default until isolated application
QA and listening checks establish the new path's behavior.

## Public base model and reference voice

The separately selected public base uses the community
[DennisHuang648/VoxCPM2-GGUF F16 pair](https://huggingface.co/DennisHuang648/VoxCPM2-GGUF/tree/169f64d8b98bbaab1761e4ca3a83e6af653456cc)
at revision `169f64d8b98bbaab1761e4ca3a83e6af653456cc`. It contains no selected
trained-voice adapter. The app's explicit model download action verifies the
two files' complete SHA256 and byte counts; it does not install a runtime or
convert a voice pack. The total download is 5,073,076,896 bytes.

A manually selected public directory contains exactly the two pinned files.
An app-managed download additionally contains the catalog-pinned
`model-receipt.json`. The receipt identifies only that public model installation;
it grants no runtime trust and never replaces full model hashing. Extra files,
directories, foreign receipts and learned-voice metadata are rejected by the
public route. The learned derivative directory keeps its separate conversion
manifest and voice-package contract.

The public route sets `ggufModelKind='public-base'`, `baseModel=true` and an
empty package path. The model directory and `gguf.derivativeDir` both identify
the directory directly containing the two GGUF files. No original PyTorch
model directory is required or loaded. `policy.publicModel` pins the public
repository, revision and pair independently of the trained derivative pins.

With a managed WAV, the worker validates the reference contract and creates an
owned immutable snapshot. Each synthesis binding must retain its conditioning
fingerprint. Without a WAV, it uses the admitted default voice description and
seed contract. A reference-only binary cannot emulate this operation: the
native profile must explicitly admit the base operation. Readiness identifies
`mode='wav-reference'` with reference cache count 1, or `mode='base'` with count
0, and reports no adapter or merge for either public mode. Trained voices retain
their original package validation, reference cache count 1 and all 192 merge
audits.

The read-only checker accepts `--model-kind public-base --package ''`, the
public pair path and the same runtime/receipt options. Optional
`--conditioning-json` contains the exact managed reference object, bounded to
8,192 UTF-8 bytes. Reference verification uses a temporary owned copy that is
removed before returning. The checker reports `nativeExecuted=false`, full
GGUF SHA verification and `originalModelVerification='not-applicable-public-gguf'`.

## What carries over from a trained voice pack

A compatible VoxCPM2 LoRA remains a VoxCPM2 learned voice. The existing conversion
merges the selected adapter into the pinned **original FP32 base exactly once**,
then writes `VoxCPM2-BaseLM-F16.gguf` and `VoxCPM2-Acoustic-F16.gguf`. All 192
mapped matrices are checked against the expected FP32 merge followed by an F16
cast. This is F16 conversion, without another training run or low-bit
quantization. The original voice pack, reference WAV, adapter and base model stay
intact.

These GGUF model files contain tensors and tokenizer metadata rather than Mac
machine code. The same audited pair is therefore a candidate for the matching
Windows runtime. The Mac executable itself requires arm64 and Metal and cannot
run on Windows. Windows CUDA/Vulkan operation, numerical behavior, cancellation
and voice quality require their own validation.

The reference WAV alone may also be used with a Qwen Base cloning engine. That
route uses the recording as a reference and does not apply the VoxCPM2 learned
LoRA weights. A VoxCPM2 pack must not silently become a Qwen trained voice, and a
Qwen selection must report that trained weights are unsupported.

## Identity and admission

Keep the selected voice's package/checksums hash, adapter hash, base-model
revision, original base hash, converter commit, conversion recipe, merge count,
dtype and both GGUF file hashes bound together. Verify the existing
`conversion.json` has `PASS_CONVERSION_ONLY`, `mergeCount=1`, `mergeDtype=float32`,
`ggufDtype=f16`, `quantization=false`, 384 adapter keys and 192 completed matrix
cast audits before accepting a prepared derivative.

Recheck the voice package using the existing strict package validator and hash
the GGUF pair and reference WAV. A missing or mismatched derivative should
report an actionable preparation error; it must not substitute another
speaker's files or merge again into a derived model. Mac cache authentication
keys and runtime receipts are local and must not be copied to Windows. Verify
the derivative's public provenance and bytes, and create a separate Windows
runtime admission record.

The original PyTorch model directory is retained for provenance. The native
engine loads only the two GGUF files. GGUF preparation checks the original
directory's presence and declared model/revision/base hash and performs full
SHA256 validation of the inference pair, native files, conversion manifest and
voice pack. It does not hash or load the original PyTorch weights again. The
read-only `voxcpm_windows_gguf_runtime.py --verify` route performs these same
checks without starting a native process. The legacy original-model full check
remains available separately.

The initial Windows admission policy contains only the previously audited
selected regression voice derivative. Other compatible VoxCPM2 packs need
their own verified conversion and policy entry; the app must report an
unsupported derivative rather than selecting the regression speaker.

## Fixed source and external build

The runtime source is the community [tc-mb/llama.cpp-omni commit
873056743b74e1a4ce5dcf7290e2298428e214db](https://github.com/tc-mb/llama.cpp-omni/tree/873056743b74e1a4ce5dcf7290e2298428e214db).
This is separate from the official OpenBMB Python runtime. `source-lock.json`
pins the source archive, complete ordinary-file tree, original runtime and
private reference-cache patch. ggml is bundled in that source tree; there are
no submodules in the archive.

The native target builds only VoxCPM2 and its llama/ggml dependencies. Optional
HTTP/OpenSSL, server, UI, examples, LLGuidance and CCCL download paths are
disabled; FetchContent is fully disconnected. It performs no downloads,
installation, model conversion or playback. Build outputs use a fresh external
directory. The admitted CUDA candidate uses RTX4090 architecture89 and existing
VS2022/CMake/CUDA tools. A Vulkan build requires separately approved, pinned SDK
tools and its own backend verification; AMD and Intel devices have not been
tested.

Example after reviewing the source and approving the new software execution:

```powershell
& '<existing-python.exe>' -B '<checkout>\electron\voice\windows-native\build.py' `
  --source '<fixed-unmodified-source-directory>' `
  --output '<new-private-output-directory>' `
  --cmake '<existing-cmake.exe>' --backend CUDA
```

The driver verifies all source-file bytes before CMake runs, records generated
runtime, wrapper and binary hashes, and retains the upstream MIT license. Keep
the existing model/voice Apache-2.0 notices and voice-use permissions alongside
external model artifacts. Do not bundle private voice packs, models, compiler
outputs or experiment paths into the app or repository.

## Native protocol and ownership

The Windows target accepts two model paths for the default voice, or the model
paths plus a canonical reference WAV and its hash for reference synthesis.
It hashes and decodes the same locked WAV bytes, rejects reparse points, and
requires mono PCM16, supported sample rate, 2–20 seconds and non-silent input.
It then prepares one exact-input reference feature cache on the inference owner
thread. Readiness reports the actual cache build count and model/reference
timings.

The build driver passes CMake source definitions with forward slashes on
Windows so CMake does not parse native drive-path backslashes as escapes. Build
repairs use a fresh output directory and retain earlier diagnostics.
The Vulkan shader build also uses a shorter ordinary output directory to remain
within Windows toolchain path limits; no global long-path or registry setting
is changed.

Every Acoustic component must report the requested GPU backend. BaseLM's
offload report must cover all layers. Admission rejects CPU fallback. This
does not prove every individual operation runs on a GPU; runtime logs and
measurements remain part of platform validation.

`generate`, ordered `credit`, target-bound `cancel` and `quit` use bounded JSON
lines over inherited pipes. Streaming blocks at one uncredited native patch;
the application adapter retains its own bounded credit window. Cancellation
is acknowledged only after upstream VAE stream cleanup and runtime state
reset. Cancellation during prefill or a stuck kernel still needs the owned
process fallback. An OS handle to the actual parent protects against an
orphaned GPU worker. Normal shutdown sends `quit` and frees the runtime before
terminating; fallback cleanup is limited to the recorded owned process tree.

## Required validation before enabling this candidate

Record a fresh-process definition separately from warm requests. Measure model
load, reference preparation, first PCM, application playback readiness, RTF,
sampled RAM/VRAM, cancellation cleanup, re-request and same-PID reuse. Warm
results require at least two requests, identical generation settings and no
overlapping user GPU work. Preserve ComfyUI, games and other user processes.

Use the same approved reference and Korean short/long text to create listening
WAVs without automatic speaker playback. Check repeatability, duration,
clipping and voice quality within and across backends. Engine-specific random
number generators mean equal seeds need not produce equal WAVs across
PyTorch, CUDA and Vulkan. Tests, typecheck and build checks must preserve the
existing PyTorch and Mac paths; application QA must use a separate profile and
leave live settings and training packs unchanged.
