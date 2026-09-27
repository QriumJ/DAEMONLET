# macOS voice (experimental)

The selected Belle package is unchanged: `belle_candidates_6000 /
0.5.0-selected-6000-e2 / step_0002660`. This adds native Apple Silicon MPS FP32
inference to the existing chat, queue, IPC and Web Audio player. It does not
train, substitute a speaker, download models, or enable voice by default.

**Performance limitation:** the measured M5 Max FP32 warm RTF exceeds 1;
streaming can have audible gaps. This is an experimental functional port, not
an accepted real-time release. See [measured boundaries](character-chat-voice-macos-validation.md).

## Selected next backend

Following the user's successful listening and live review, **GGUF / Metal F16**
with the fully merged selected LoRA is adopted for the next Mac app integration.
[Gemma4 12B concurrency measurements](character-chat-voice-gemma12b-concurrency.md)
show that active simultaneous LLM/TTS generation fails the real-time gate;
retain completed-answer → voice sequencing. The instructions below describe the
existing packaged MPS candidate, not a completed GGUF app switch.

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
