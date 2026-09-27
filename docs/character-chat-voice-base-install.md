# Default voice installation for Apple Silicon Mac

A user without a trained voice package can choose **기본 음성 · VoxCPM2** and click
**기본 음성 설치** in the character-chat voice controls. No Python, terminal, LoRA,
reference recording or manual model path is required. Opening settings or enabling
voice never downloads a model. The user explicitly starts installation; the control
shows size, license, progress, verification, stop and retry/resume. Voice remains
opt-in. Existing character bindings and external trained packages are preserved.

Mac offers exactly two playback modes:

- **Metal · 청크 재생**: play generated 480ms chunks with the existing bounded queue.
- **Metal · 완성 후 재생**: collect one completed sentence before delivering its WAV.
  The next sentence is synthesized after playback, so this option trades initial
  latency and sentence gaps for complete-sentence playback. Both modes produce the
  same PCM and use the same request/speech ownership and cancellation protocol.

The default model has no character-specific trained speaker or reference audio.
Its voice may vary with the sentence. Import a compatible LoRA voice package for a
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

Current automatic-install target is **darwin-arm64**. Windows CUDA profiles and the
existing external setup are unchanged; no unvalidated Windows default-voice binary
is advertised. Intel Mac is unsupported. The runtime's deployment floor is macOS 13,
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
