# macOS voice (experimental)

The selected Belle package is unchanged: `belle_candidates_6000 /
0.5.0-selected-6000-e2 / step_0002660`. The adopted Mac profile is now
**`gguf-metal-f16`**, connected to the existing character chat, completed-answer
policy, queue, IPC and Web Audio player. Windows keeps its CUDA profiles. Mac exposes only **Metal chunk playback** and **Metal complete-group playback**.
Old MPS settings are rejected and require selecting a supported Metal profile.

No model weights or Python installation are bundled in the app. The default-voice
Metal engine and its license notices are included; advanced LoRA conversion still
uses the separately approved environment.
A separately approved, hash-pinned arm64 runtime and the original base snapshot
are required. Compatible voice packages are prepared locally on first use.
For package-free default voice, use the [one-button base installer](character-chat-voice-base-install.md). The app does not download, train, replace the speaker or enable voice
by default. [Gemma4 12B concurrency measurements](character-chat-voice-gemma12b-concurrency.md)
failed the simultaneous real-time gate; keep completed-answer → voice sequencing.

## Adopted GGUF runtime setup

The setup uses the existing approved native Python 3.11.15 and pinned C++ checkout
with its already-built static libraries. No pip installation is needed in this
new stdlib-only application adapter environment. Do not update an existing runtime
in place. Build/install into new private destinations:

```sh
python3 -B scripts/build-voice-gguf-native.py \
  --source '<PINNED_CPP_SOURCE>' --package '<SELECTED_PACKAGE>' \
  --output '<NEW_PRIVATE_NATIVE_BUILD>'
python3 -B scripts/prepare-voice-gguf-runtime.py \
  --python '<APPROVED_NATIVE_PYTHON_3_11_15>' \
  --native '<REVIEWED_NATIVE_BUILD>' \
  --converter-source '<PINNED_CPP_SOURCE>' \
  --converter-python '<APPROVED_MPS_ENV>/bin/python' \
  --destination '<NEW_PRIVATE_GGUF_RUNTIME>'
```

`runtime-gguf-macos.json` pins the reviewed native binary, shader resources,
licenses and the exact offline converter sources. The existing approved full Python
environment is validated against its separate MPS dependency/source receipt before
CPU conversion; the live adapter remains stdlib-only. The installer refuses a
build that differs from that policy; do not rewrite receipts/hashes to bypass it.
A different compiler/toolchain build requires explicit review and a policy update.
The C++ checkout is not edited. A private copy adds a bounded owner-thread reference
feature cache keyed by runtime instance, full reference samples and sample rate;
`free()` invalidates it. The build receipt records original/cached source hashes.
Only system dynamic libraries are linked; no Homebrew runtime dependency is needed.

In the actual app, select **Mac Metal FP16 · 청크 재생**, choose the new runtime's
`bin/python` and the **original pinned VoxCPM2 snapshot** as model folder. The
runtime receipt separately locates the approved converter Python and copied converter
sources. Original
`voice.json`, package checksums, LoRA and snapshot checks remain mandatory.

### Selecting a trained LoRA

Import the entire voice package folder, then choose it in **캐릭터 음성** for the
current character. The existing **음성 엔진 미리 준비** button starts preparation;
otherwise the next reading prepares it automatically. A bare safetensors file is
insufficient: the package must include its unchanged `voice.json`, complete checksums,
LoRA configuration/weights, reference/preview, provenance and license notes.

This is a bounded compatibility path: the pinned VoxCPM2 revision, rank/alpha 32,
BaseLM + ResidualLM + LocDiT q/k/v/o adapters (384 keys, 192 matrices), and the existing
inference settings. Training on a 4090 does not require retraining for Mac. Other base
revisions, projection adapters or arbitrary LoRA architectures are rejected. The
original Belle ID/version additionally retains its exact adopted checksum/step pins.
Selectable packages apply to the Mac Metal profile; the MPS diagnostics and Windows
CUDA path retain the original selected-package policy.

For each package, start from the original full-precision base, apply every LoRA matrix
once in FP32, then export F16 and compare every adapted matrix against the expected
cast bytes. Never merge another adapter into a previous speaker's derivative. This is
cached preparation, not native hot-loading of the original LoRA into a common GGUF.
It uses more disk per voice, but subsequent starts reuse the generated GGUF.

Persistent `voice/gguf-cache/<voice-id>@<version>/<identity>` entries bind the complete
package, adapter, base/revision, converter and merge recipe. A local signed receipt
and full file hashes are checked on every cache hit. Preparation is locked per key,
published by atomic rename only after validation, and removes intermediate full-size
weights. It requires 30 GiB free temporary space and has a bounded initialization
budget. Stop/close also terminates an in-progress converter; its parent watchdog
handles abrupt parent death, and the inherited lock protects abandoned-stage cleanup.
Removing a voice removes its derived cache under the same persisted removal tombstone.
Shared base files and user import sources are preserved. No download/upload is involved.

The existing supervisor controls the Python adapter and exact request-bound R2
acknowledgments. The adapter owns one Metal child; it polls cancellation while
waiting for each native patch, waits for VAE/KV cleanup, removes cancelled WAVs and
only then reports warm reuse. EOF/shutdown/SIGTERM closes the child; an orphan
watcher exits the child when its adapter disappears. Native startup/cleanup failures
retain the existing supervisor's process termination fallback.

Three native 160ms patches are delivered as one 480ms application chunk, with
the final smaller tail preserved. The original three producer credits, one successor
sentence, sample/byte/duration limits and renderer ownership checks remain. The producer
window is at most 1.44 seconds of generated audio. This
provides more queued audio for successor sentence prefill without collecting the
whole utterance or changing its PCM. Initial playback margin remains 240ms.

```sh
node scripts/voice.mjs stream --package '<SELECTED_PACKAGE>' \
  --python '<GGUF_RUNTIME>/bin/python' --model '<PINNED_MODEL>' \
  --data '<PRIVATE_RESULTS>' --profile gguf-metal-f16 --quick --repeats 1 \
  --cooperative-cancel
python3 -B scripts/test-voice-gguf.py
```

## MPS fallback setup (historical functional port)

The measured MPS FP32 warm RTF exceeds one, so audible gaps are possible. These
profiles are not the adopted real-time path. Their setup and verification remain
below for diagnosis and rollback; see [measured boundaries](character-chat-voice-macos-validation.md).

## Assets and approved installation

Transfer the entire selected package and pinned VoxCPM2 snapshot outside Git.
Preserve `voice.json`, checksums, reference, provenance and license notes.
Snapshot revision is `32279effe8c19989596f05d353d1447f51d9e915`; source commit is
`f772e498a45fbb5fb8e13fbf9b9c48be9fe33e69`. The full source export must match
`electron/voice/runtime-macos.json`, including its upstream license hash.

Obtain dependency installation approval under AGENTS.md first. With an existing
native Python 3.11.15 and `uv`, and a NEW destination:

```sh
python3.11 -B scripts/prepare-voice-macos.py install \
  --source '<PINNED_VOXCPM_SOURCE>' --destination '<NEW_RUNTIME>'
'<NEW_RUNTIME>/env/bin/python' -B scripts/prepare-voice-macos.py doctor
node scripts/voice.mjs doctor --package '<SELECTED_PACKAGE>'
```

The installer copies the interpreter distribution, installs only the 62 locked
inference dependencies with required hashes and binary wheels, copies the pinned
inference source (no trainer), and creates an installation receipt. Existing
Python installations are not modified. Torch/torchaudio are 2.8.0 and transformers
is 5.3.0. The original package's CUDA version strings remain Windows provenance;
Windows still uses its exact original version checks. Mac validates a separate
fixed policy, dependency versions, source hashes, interpreter hash and prefix.
`seal` is available only for an already provisioned exact dependency environment;
it refuses to overwrite an existing source copy or receipt.

`VOXCPM_MPS_DTYPE` other than FP32 and `PYTORCH_ENABLE_MPS_FALLBACK=1` are refused.
No CPU fallback, CUDA compiler, Triton, automatic model download or MLX model
replacement is enabled. Intel/Rosetta is unsupported by these profiles.

## Profiles and verification

- `mps-fp32-baseline`: eager whole-WAV synthesis, optimize off.
- `mps-fp32`: eager fixed-reference cache and sentence-internal chunks.
- Windows retains `baseline`, `cached`, `compiled` and its existing CUDA behavior.

```sh
'<NEW_RUNTIME>/env/bin/python' -B scripts/probe-voice-macos.py \
  --package '<SELECTED_PACKAGE>' --model '<PINNED_MODEL>' --output '<NEW_PRIVATE_RESULTS>'
node scripts/voice.mjs stream --package '<SELECTED_PACKAGE>' \
  --python '<NEW_RUNTIME>/env/bin/python' --model '<PINNED_MODEL>' \
  --data '<PRIVATE_STREAM_RESULTS>' --profile mps-fp32 --quick --repeats 1 --cooperative-cancel
```

The baseline does two short sentences, one cold and two warm passes. The stream
probe checks five same-worker cancellation/recovery cycles and separate sample
hashes, not listening acceptance. Do not run unbounded parameter sweeps when RTF
exceeds 1. The model's 384 adapter keys must exactly match expected keys, shapes
and finite values, with zero skipped or missing keys. Actual model parameters
must be MPS FP32. Memory fields are MPS current/driver allocation, not CUDA peak
or sampled-peak metrics.

In the actual app, import the complete voice folder, bind it to the installed
character's real ID, and select `env/bin/python` (or `python3.11`) and the local
model folder. The macOS picker preserves interpreter links with `noResolveAliases`;
Main verifies the canonical executable against the receipt before saving it.
Choosing the base Python outside the venv fails. Imported Windows execution
settings disable voice and request platform reconfiguration.

Choose **Mac MPS FP32 (실험) · 청크 재생**, enable voice and prepare the engine.
**새 문장 시험 재생**, completed-answer automatic reading, reread and voice-only
stop use the existing controls. AudioContext requests 48kHz so decoded stream
sample offsets remain in source units; output-device resampling is left to Web
Audio. 44.1kHz physical hardware acceptance remains a separate check.

Cancellation retains three credits, one owner thread, one sentence lookahead,
R1 retire-before-consumer-release, and R2 identity-bound cleanup acknowledgement.
MPS cleanup closes the generator, checks VAE restoration, clears KV state,
synchronizes MPS and removes cancelled WAVs. Timeout or cleanup failure unloads
only the owned worker. OFF/hide/close/exit unload intentionally. On macOS an idle
worker receives shutdown plus EOF; termination escalates through bounded SIGTERM
and SIGKILL waits, and cache cleanup follows confirmed exit.

Rollback: voice OFF, wait for owned worker exit, disconnect the Mac runtime and
remove only the new test profile/runtime if desired. Preserve original packs,
conversations, Windows environments and input assets. Never re-sign or upgrade
the user's existing Python implicitly to repair an OS launch failure.

## Limited MLX feasibility

Reviewed MLX-Audio commit `4ab7e6f7dedd69a136cfaa318c5dc8aed5119446` after the
MPS throughput gate failed. All 384 source adapter keys pair with 192 original
base linear matrices, with rank 32 and scale alpha/r = 1. This establishes source
pairing only, not an instantiated MLX key/shape or numerical parity audit.

The pinned VoxCPM2 implementation has no direct adapter loading and yields once
after complete VAE decoding. `seed` is not applied by its `**kwargs`, its reported
RTF is the inverse convention, and its timing precedes guaranteed completion of
lazy audio evaluation. Upstream uses `min(text_token_count * 6 + 10, 600)` as the
patch budget; blindly using MLX `max_tokens=600` is not equivalent. Enabling MLX
would require complete nonquantized LoRA conversion, numerical checks and a new
chunk/cancellation adapter. That exceeds this bounded first-port experiment.
No MLX runtime is exposed or declared successful; no reference-only cloning,
community quantized model, merged weights or replacement speaker was used.

Source: [pinned MLX generator](https://github.com/Blaizzy/mlx-audio/blob/4ab7e6f7dedd69a136cfaa318c5dc8aed5119446/mlx_audio/tts/models/voxcpm2/voxcpm2.py),
[pinned upstream dtype policy](https://github.com/OpenBMB/VoxCPM/blob/f772e498a45fbb5fb8e13fbf9b9c48be9fe33e69/src/voxcpm/model/utils.py).
