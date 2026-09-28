# Default voice installation on Windows and Apple Silicon Mac

On both platforms, a user without a trained voice package can choose **기본 음성 · VoxCPM2** and click
**기본 음성 설치** in the character-chat voice controls. No manually configured Python,
terminal, LoRA, reference recording or manual model path is required. Opening settings or enabling
voice never downloads a model. The user explicitly starts installation; the control
shows size, license, progress, verification, stop and retry/resume. Voice remains
opt-in. Existing character bindings and external trained packages are preserved.

Managed default voice exposes two playback modes; Mac labels them Metal and Windows CUDA.
External Windows packages preserve their existing baseline/cached/compiled choices:

- **Metal · 청크 재생**: play generated 480ms chunks with the existing bounded queue.
- **Metal · 완성 후 재생**: collect one completed sentence before delivering its WAV.
  The next sentence is synthesized after playback, so this option trades initial
  latency and sentence gaps for complete-sentence playback. Both modes produce the
  same PCM and use the same request/speech ownership and cancellation protocol.

The default model uses the same built-in female voice description and seed 42 on
both platforms, from `electron/voice/base-voice-defaults.json`. The model receives
a parenthesized description prefix: “An adult female voice, warm and gentle, clear
and natural, with a calm conversational pace.” No extra recording or adapter is
needed. The description is applied to base-only synthesis, including warmup, and
is compiled into the pinned native Mac engine. It never changes trained packages.
This provides a female default, not a trained speaker identity: voices may still
vary across sentences and numerical backends. Import a compatible LoRA voice package for a
specific trained voice. The UI no longer names a particular training GPU. MPS is no
longer a selectable Mac mode; historical diagnostic tooling is kept separately.

## Pinned sources and installation

[GGUF publisher](https://huggingface.co/DennisHuang648/VoxCPM2-GGUF/tree/169f64d8b98bbaab1761e4ca3a83e6af653456cc)
is a community conversion of [OpenBMB VoxCPM2](https://huggingface.co/openbmb/VoxCPM2),
Apache-2.0. `electron/voice/base-model.json` pins revision, both sizes and SHA-256s.
The two files total 5,073,076,896 bytes. The installer does not follow a moving main
revision, execute downloaded code, train, merge or upload weights.

Installation stages under `voice/base-model/<revision>.download`, verifies both files,
and renames the directory only after success. Interrupted bytes can be resumed;
range, size and hash mismatches fail closed. A damaged prior installation is preserved
under a recovery name during replacement. Runtime and model hashes are verified
before use. An independent default-voice native worker uses no user Python environment.
The native worker has no model download code and never loads the Belle reference/LoRA.

Automatic installation targets **darwin-arm64** and **win32-x64**. Windows keeps
Python/PyTorch CUDA BF16 with all four compiled components; it does not switch to
a GGUF engine. Windows external LoRA environments remain supported and unchanged.
Intel Mac is unsupported. The runtime's deployment floor is macOS 13,
with host-specific CPU instruction generation disabled; actual testing used the
current Apple Silicon/macOS 27 host, not every older OS/hardware combination.

## Packaging

Build the pinned C++ source in a separate build directory with `BUILD_SHARED_LIBS=OFF`,
`GGML_NATIVE=OFF`, `CMAKE_OSX_ARCHITECTURES=arm64`,
`CMAKE_OSX_DEPLOYMENT_TARGET=13.0`, `GGML_METAL=ON`,
`GGML_METAL_EMBED_LIBRARY=OFF`, `LLAMA_OPENSSL=OFF`. Build target `voxcpm2-cli`, then:

```sh
python3 -B scripts/build-voice-gguf-native.py --base \
  --source '<PINNED_SOURCE>' --build-dir '<SEPARATE_CMAKE_BUILD>' \
  --package '<VERIFIED_PACKAGE_FOR_LICENSE>' --output '<NEW_PRIVATE_BUILD>'
node scripts/stage-voice-base-runtime.mjs '<REVIEWED_PRIVATE_BUILD>'
npm run electron:package
```

`runtime-base-macos.json` separately pins the reviewed default engine, resources and
notices. Staging and Forge verify the allowlist and hashes. Only engine/resources go
into `Resources/voice/base-native`; no weights or training package are bundled.
Do not replace the existing LoRA engine receipt when preparing this engine.

For a signed distribution, sign the native engine **before** reviewing/pinning its
final bytes, matching the existing chat runtime workflow. Generic app signing skips
both pinned engines; final signed-app verification checks their hashes and signer.
The current local candidate is unsigned. No signing identity, release, version or
upload was changed as part of this work.

## Validation

- Real 5.1GB download using the installation manager, exact hashes passed.
- Clean actual app profile, Gpichan, no trained voice packages or configured Python:
  install button → cancel → resume → verify → installed; default voice synthesized.
- Actual UI exposes only the two Metal options. Both chunk audio and complete WAV
  playback succeeded. Physical listening/voice quality is not claimed by automation.
- Native protocol tests cover both modes, repeated same-worker cooperative cancellation
  and identical PCM recovery; the trained Belle path also produces identical PCM in
  both playback modes. R1/R2, F1–F5 and bounded queue behavior remain in the test suite.
- Full suite: 208 files / 2164 passing tests, 5 skipped; TypeScript passed. Two subsequently
  added packaging/signing cases passed in a 57-test targeted run. Installer
  tests cover no automatic network, resume/range integrity, invalid hashes, cancellation,
  retry and later model modification. Windows CUDA inference was not rerun.

## Windows installation and verification (2026-09-28)

The explicit install button downloads the original pinned VoxCPM2 model, portable
Python 3.11.15, 64 exact wheel artifacts (including torch/torchaudio 2.8.0+cu128 and
Triton 3.4.0.post21), the pinned VoxCPM source and its license. Download size is
8,636,115,387 bytes; setup requires 30 GiB free space and a BF16-capable NVIDIA GPU.
The lock contains exact URLs, byte counts and SHA-256s. No pip resolver, system
Python changes, automatic download on launch, training or weight upload is used.

Setup stages and verifies the complete new environment before publishing it under
application data; interrupted downloads resume with exact range and full-hash
checks. Wheel paths and archive members are checked before extraction. Verification
checks receipt, dependency versions, imports, source hashes and every model file.
A changed default voice description invalidates the voice identity but does not
force downloading or reinstalling the unchanged Python environment.

The base worker uses no LoRA layers and `prompt_cache=None`, with zero reference
cache builds. Both Windows playback modes keep the previously selected compiled
path. Complete-sentence mode collects the same streaming PCM before playback.
The initial compile is slow: the new isolated environment took about 212 seconds
to verify/load/compile/warm. Subsequent speech is measured separately below.

Fresh Windows automatic installation and female base synthesis passed on the real
CUDA host. Five warm utterances measured RTF 0.480–0.485, first chunks 92–106 ms;
three credit-wait cancellations completed in 1.5–1.9 ms, reused the same worker and
recovered identical PCM. All four compiled components executed; adapter/reference
hashes were absent and the owned worker exited. The production supervisor also
passed both playback paths, cooperative cancellation and identical PCM recovery.

Mac's production supervisor with the newly pinned female base engine passed both
playback paths at RTF about 0.93, cancellation in 6 ms, same-worker identical PCM
recovery and normal exit. This is a small standalone TTS test, not a concurrent
Gemma 12B benchmark. Physical listening and Windows native GUI playback were not
performed for this revision; prior UI evidence above predates the female prefix.

Current Mac full regression: 208 files, 2170 passed, 5 skipped; TypeScript, 28 Python
worker tests, source check and production Mac packaging passed. The synthetic
suite retains F1–F5 and R1/R2 checks. No existing Windows branch, environment,
running app or ComfyUI job was modified.

Windows focused regression from the current code: 8 files / 104 passed, 9
platform-specific skips; all 28 Python worker tests passed after including the Mac
receipt-policy fixture in the transfer. Windows production-supervisor measurements
were chunk RTF 0.484, complete RTF 0.481 and warm cancellation 2 ms. This establishes
software synthesis/ownership behavior, not Windows audio-device playback.

Final Mac app follow-up (code commit `1e0df5d`): the production package was applied
with the original profile preserved. Actual UI selected default voice and completed
chunk playback plus two complete-sentence WAV playbacks. The native audit contained
the fixed female description/seed 42 and no adapter/reference. Complete-sentence
RTFs were 0.954–0.963; software playback-ended acknowledgements were observed.
The prior Belle binding, Metal chunk mode and volume 0.5 were restored, and the app
was left running. This adds native Mac GUI evidence; physical listening and Windows
GUI deployment/playback remain unverified for this revision.

See [PR #29 F1/F2 follow-up](character-chat-voice-pr29-fixes.md) for mode preservation,
loading-boundary validation, full CI and measured warm-session verification costs.
