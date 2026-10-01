# Experimental Windows Qwen3-TTS 0.6B A/B

VoxCPM2 remains the default. Windows settings expose **Qwen3-TTS 0.6B · 실험** only through an explicit engine selection. Connect its separate Python/model directories and select an authorized imported WAV profile. LoRA and Vox default profiles cannot be used as Qwen references. Changing engine, runtime or clone mode stops current speech, retires audio/lip-sync ownership and clears replay scope. Existing profiles and Vox dependencies are preserved.

Qwen uses `Qwen/Qwen3-TTS-12Hz-0.6B-Base` revision `5d83992436eae1d760afd27aff78a71d676296fc`, including its speech tokenizer, total 2,516,106,051 bytes. `qwen-policy.json` pins official LFS SHA-256 and Git blob hashes. The explicit installer creates a receipt with package versions, archive URLs/hashes/bytes, licenses, installed file hashes and model hashes. Production worker performs no downloads. Windows uses official Torch/torchaudio 2.8.0 CUDA 12.8 wheels in an independent venv, qwen-tts 0.1.1, transformers 4.57.3 and accelerate 1.12.0. SDPA/BF16 with an actual CUDA operation probe is required. FlashAttention builds, external SoX executables, driver changes and new credentials are outside this setup.

`qwen_worker.py` is independent of the Vox engine and its KV/VAE cancellation hooks. Only bounded JSONL input and the strict WAV reference snapshot verifier are reused. `generate_voice_clone` returns a complete waveform, including when `non_streaming_mode=False`. This implementation uses `True` and exposes `synthesisStreaming=false`, `transportChunking=false`. Playback remains 48 kHz mono PCM16, at most 60 seconds; returned rates and finite sample shape are validated, resampling and PCM quantization are explicit. There is no denoising, trimming or loudness normalization.

Cancellation during initialization, prewarm or generation terminates the owned process tree and removes its session files before a replacement starts. This does not claim immediate GPU interruption. An idle loaded worker may be reused after normal completion. Active cancellation does not keep it warm. `stopping_criteria` is not used as an unverified cooperative hook. Reference fingerprint, runtime session, epoch, seed and returned binding are checked; stale audio is discarded before delivery. Errors remain private uppercase codes; upstream stdout/stderr text is not persisted by the product.

X-vector mode uses the speaker embedding only. ICL requires the accurate text spoken in the reference WAV. Neither mode is declared better. Prompt identity includes engine, model revision, reference hash, transcript hash and mode. Readiness distinguishes loaded, warmed and ready. Each real synthesis resets its engine's seed; numerical seeds are not equivalent across engines.

## Explicit installation

Use a fresh adjacent experiment root, with `runtime/env`, `cache`, `models`, `evidence` on the large data drive. Create its venv from the approved existing base interpreter; execute `scripts/prepare-qwen-windows.py --root ROOT` with that venv Python. Never execute it with the Vox venv. This development script remains a separate explicit operation. The app also provides an explicit [managed Qwen installation button](character-chat-voice-qwen-managed-install.md) for model/runtime download and apply. Receipts and model artifacts remain outside Git.

## Silent sequential comparison

Run `node scripts/qwen-voice-ab.mjs --config PRIVATE_JSON --cases CASES_JSON --output NEW_EXTERNAL_DIRECTORY`. `--dry-run` plans segmentation without loading models. Config has `referenceAuthorized:true`, `reference`, `transcript` (optional accurate reference transcript), `voxSeed`, `qwenSeed`, and `vox`/`qwen` objects with absolute `python`, `model`, `worker` paths. Vox worker is `electron/voice/ab_vox_worker.py`; Qwen worker is `electron/voice/qwen_worker.py`. The diagnostic Vox wrapper splits existing compiled initialization/prewarm and retains the generated float waveform without changing installed Vox sources. Primary A/B uses complete-waveform delivery for both engines and the same `planSpeech` segments. This does not substitute for measuring Vox's production streaming TTFA.

The runner records GPU utilization/free memory before each engine and aborts on concurrent load or insufficient headroom. Keep ComfyUI alive and document its reserved memory. It runs engine/mode sequentially, repeats fixed seeds, records cold initialization, prewarm, warm first audio, generation time, raw duration/RTF, peak allocated/reserved VRAM, process RAM, active cancellation, reload recovery and cache cleanup. Warm first audio in this complete delivery comparison is time to the completed waveform, not time to an incremental synthesis chunk. Raw FLOAT WAV and app PCM16 WAV are both saved. The blind listening directory copies raw WAV bytes without automatic playback; its mapping stays in a separate key file. Quality remains `PENDING_BLIND_LISTEN` until someone listens. Existing 51-chunk/8.16-second Vox results are historical and do not replace a new A/B.

CPU validation: `scripts/test-qwen-worker.py`, `tests/qwen-voice-runtime.test.ts`, Qwen cases in `tests/reference-voice-service.test.ts`, plus existing runtime, playback, IPC, reference and service suites. Actual packaged GUI, audible listening and hardware lip-sync checks must be reported separately from CPU mocks.

## Reference research and licensing

[Dots Voice at the inspected commit](https://github.com/ParkWonYeop/dots-voice/tree/58b4b3a30e78d4f8d41e0f24a29bf571987da954) informed prompt reuse, explicit prewarm/readiness and measurement design. Its source is MIT, Copyright 2026 ParkWonYeop. No Dots Voice source, bundled voice, browser extension or subtitle interception code is copied. DAEMONLET continues to use its existing MCP text path. Qwen model/package are Apache-2.0; models and dependencies are external, and their original licenses are retained in the separate installation. Mac MLX is a later independent experiment.

## Apple Silicon MLX arm

The separately installed `mlx-audio==0.5.7`, `mlx==0.32.3`,
`mlx-lm==0.32.0` backend loads the community conversion
`mlx-community/Qwen3-TTS-12Hz-0.6B-Base-4bit`, revision
`0d6bb6fe33f92d47a507e23b9148940e8366ab5b` (1,711,328,624 bytes).
This conversion is published by mlx-community; it is not an official Qwen
PyTorch weight distribution. The model card declares Apache-2.0. MLX Audio,
MLX and MLX LM are MIT. Source hashes bind the installed MLX Audio release.
Model loading uses only the local snapshot and installed implementation, with
offline environment flags and `trust_remote_code=False` tokenization.

Explicit setup: run `scripts/prepare-qwen-macos.py --root <NEW external directory>`
with an existing Python 3.12. It creates its own venv/cache/model/receipt, records
wheel URLs, bytes, hashes and licenses, and never modifies an existing runtime.
The app does not run this development installer or download a missing model automatically. The explicit [managed Qwen installation button](character-chat-voice-qwen-managed-install.md) provides model/runtime download and apply in app-managed storage.

`qwen_mlx_worker.py` is separate from Windows `qwen_worker.py`. MLX's pinned
implementation decodes chunks during token generation with
`speech_tokenizer.decoder.streaming_step`; `qwen-mlx` forwards these real
incremental samples. `qwen-mlx-complete` requests complete decoding instead.
The two upstream decode paths can produce different samples, especially in ICL;
we do not claim that concatenated streaming is identical to complete decoding.
App PCM conversion keeps a bounded FIR tail to avoid independently resampling
chunk boundaries. That conversion is verified against the complete conversion
of the same concatenated native waveform. Neither path normalizes loudness,
denoises, removes silence, or stretches audio.

The worker caches the speaker embedding only for its immutable reference and
lets the version-pinned core keep its ICL cache within that same session.
The outer cache identity includes backend, model revision, reference SHA,
transcript SHA and mode. Active cancellation terminates the owned process;
no token or GPU operation is promised an instantaneous cooperative interrupt.

Use `node scripts/qwen-voice-ab-macos.mjs --config <private JSON> --cases
<private JSON> --output <NEW external folder>` for a sequential silent comparison
against the existing verified native Metal Vox base engine. Config has
`referenceAuthorized`, `reference`, optional accurate `transcript`, `voxSeed`,
`qwenSeed`, `vox.runtimeRoot`, `vox.modelRoot`, and `qwen.python/model/worker`.
The same sentence plan and reference are used for both engines. The trained
Belle LoRA and earlier Windows results are distinct conditions. Prewarm is a
matched streaming sentence, then two measured repetitions. Qwen original FLOAT
WAV and both engines' PCM48 mono16 outputs are retained. Vox's earliest exported
waveform is PCM16, so a nonexistent float output is not estimated. Blind listen
files use both engines' app PCM with no further processing. No audio auto-plays.
MLX allocator peak is unified memory, not a dedicated VRAM figure; native metrics
are retained as supplied. Mac and Windows reports remain separate.

Warm `wallFirstAudioMs` starts immediately before `runtime.stream()` and ends
when the supervisor passes its first binding/sequence/WAV-validated PCM chunk
to the accept callback. It excludes the separately measured process init and
prewarm; target-text tokenization/prefill is included. It is not speaker output
or the perceived onset of the first spoken word. A chunk may contain leading
silence. The Mac harness additionally records chunk arrival times, peaks and
first nonzero PCM sample positions. Vox exports three 160ms patches at a time;
MLX's 0.5s interval floors to six codec frames (480ms native audio), with 64 app
samples held for the resampling FIR tail. Prompt/embedding caches are reused,
but each measured call performs fresh inference, without completed-audio replay.
`initWallMs` means a new process load, not a rebooted disk-cache-cold machine.
