# Character voice performance

This work continues PR #28 from `3575104`, preserving the F1–F5 stabilization.
The adopted voice remains `belle_candidates_6000 / 0.5.0-selected-6000-e2 /
step_0002660`. Original model, adapter, reference, training environment and the
previous independent runtime are read-only. No retraining, merge, weight upload,
version change or release is part of this work.

## Execution profiles

| Profile | Engine | Delivery | Quality settings |
|---|---|---|---|
| baseline | Original eager path, per-call reference processing | Complete WAV, sequential playback | Original CFG 2, 10 steps, seed 42 |
| cached | Public fixed-reference prompt cache, eager, explicit warmup | Incremental audio chunks, at most one sentence ahead | Same |
| compiled | Cached reference, four compiled components with verified execution | Same bounded incremental stream | Same |

Voice identity and execution profiles are separate. No `voice.json` or checksum
is rewritten. A profile switch invalidates speech, unloads the worker and changes
its runtime/cache identity. Voice stays OFF by default; only a configured, enabled,
visible output can prepare a model. The preparation status includes reference
features and a real selected-voice warmup. Preparation moves cost earlier; it
does not eliminate it. Hidden requests never regain automatic speech permission.

Normal completed speech already reused a worker before this change. The new
reference cache avoids repeatedly decoding/encoding the fixed reference. A
voice-only stop can also retain a completely idle GPU worker while dropping all
current and future audio. Loading/generating/credit-blocked cancellation still
terminates the owned tree. OFF, hide, window/app close and reconfiguration retain
the unload policy.

## Windows compilation

The separate approved environment copies the existing independent Python 3.11.15,
torch/torchaudio 2.8.0+cu128 and pinned inference source; only that new copy adds
`triton-windows==3.4.0.post21`. The existing runtime is not upgraded. The
[Triton compatibility table](https://github.com/woct0rdho/triton-windows#3-pytorch)
maps torch 2.8 to Triton 3.4.

The adapter follows the pinned VoxCPM2 targets: base/residual `forward_step`,
single-step feature encoder and decoder estimator. Variable-length prefill keeps
the original feature encoder, as in upstream `optimize()`. All 384 adapter keys
and finite values are audited before compilation. A counting Inductor backend
records successful graph construction **and execution** per component. Full
selected-voice warmup must execute all four components; an option or wrapper alone
does not produce a successful readiness result.

The first diagnostic adapter passed `mode` to the low-level compiler incorrectly;
that attempt failed and was corrected to torch 2.8's actual mode wrapper. The
next attempt reproduced Windows `StaticCudaLauncher` C-long overflow, also
documented in [PyTorch issue 162430](https://github.com/pytorch/pytorch/issues/162430).
The compiled profile sets `use_static_cuda_launcher=False` through compiler
configuration while retaining compiled kernels and reduce-overhead CUDA graphs.
No DLL or installed source file is patched. Failure remains `COMPILE_UNAVAILABLE`,
with no silent eager success or different-voice fallback. Baseline remains selectable.

Compiler caches are separate from transient audio and are keyed by package,
model/source/reference identity, device, dtype, Python/library builds, adapter
implementation and execution profile. Inductor/Triton/Numba caches survive speech
cleanup; audio does not. Normal worker stderr is drained, not published. An empty
warning list is not evidence of no warnings (`compileWarningsCaptured=false`).

## Streaming and limits

The worker uses the pinned public `generate_with_prompt_cache_streaming()` API.
It emits each **new** VAE patch immediately as an independently verified 48kHz mono
PCM16 chunk. It does not concatenate the utterance before playback. The pinned
stateful VAE decodes only the newest patch and restores its convolution state on
generator exit; there is no separate flush API. All yielded patches, including a
small final patch, are consumed. A silent prefix is allowed; total utterance energy
and successful termination are checked separately.

JSONL stream version 1 adds started/chunk/finished messages, synthesis/segment/
chunk identities, contiguous sample offsets/counts and final totals. Three producer
credits bound in-flight chunks; playback consumption returns credit. Tail credits
from the preceding sentence cannot be mistaken for the next request. Main reads
and deletes files, exposes only one-use opaque audio IDs, and rejects duplicate,
reordered, stale or oversized results. GPU generation stays on one owning thread.

Main retains separate current/next sentence consumption promises. It can synthesize
the immediate successor while the prior sentence plays, but cannot start a third
sentence until the first is consumed. The renderer serializes decoding, appends
sources on one AudioContext/GainNode, and schedules against `currentTime`. Initial
buffering is 240ms. At most six one-second chunks/sources can be queued; actual
upstream patches are smaller. Every scheduled source is cancelled on invalidation.
Device-rate resampling preserves duration. A slow eager stream can still underrun;
early first audio alone is not a throughput success.

## Reproduce

Use private local absolute paths; do not commit the output directory or recordings.
The original setup and new optional environment setup are explicit operator tools:

```powershell
& $baselinePython -B scripts/prepare-voice-compile.py --baseline $baselineRuntime --destination $newRuntime --install-triton
& $baselinePython -B scripts/benchmark-voice.py --package $voicePackage --model $model --output $newBaselineOutput --profile baseline
& $baselinePython -B scripts/benchmark-voice.py --package $voicePackage --model $model --output $newCacheOutput --profile cached
& $optimizedPython -B scripts/benchmark-voice.py --package $voicePackage --model $model --output $newCompileOutput --profile compiled --compiler-cache $compilerCache
node scripts/voice.mjs stream --package $voicePackage --python $optimizedPython --model $model --data $streamOutput --profile compiled --compiler-cache $compilerCache --cancel
```

The benchmark uses two fixed Korean texts, first-use samples and two warm repeats
in one PID/session. `stream` uses six small diverse texts twice and immediate
producer credits, followed by optional blocking-cancel/restart verification. This
is worker measurement, not speaker output. Do not run full tests, packaging or
another GPU benchmark concurrently. Report model compute/whole elapsed RTF,
producer blocked time, first chunk, renderer scheduling, user-send latency and
inter-sentence gaps separately. A scheduled Web Audio source is not physical
listening or loopback evidence.

In the chat menu select **음성 실행 모드**, connect the appropriate independent
Python/model, and use **음성 엔진 미리 준비**. Wait for ready, then use **새 문장 시험
재생** or send a new message. **기준 모드** restores the original whole-WAV path.
Compiled preparation can take minutes on a fresh compiler cache.

## Measurements and acceptance

Windows RTX 4090, BF16, fixed adopted adapter/reference, CFG 2, seed 42 and 10
steps. Two fixed sentences, one first-use pair and two warm pairs in one process
per profile. Full tests/packaging were not run alongside these GPU measurements.
These are small diagnostic samples, not a population latency distribution.

| Worker measurement | Baseline B0 | Cached eager B1 | Compiled B2 |
|---|---:|---:|---:|
| Ready, including warmup where enabled | 21.01 s | 44.87 s | 244.76 s, fresh compiler cache |
| Reference cache construction | Per call | 15.72 s once | 15.05 s once |
| Real warmup | None | 7.55 s | 206.38 s, fresh compile |
| First sentence generation | 22.72 s | 7.20 s | 1.63 s |
| First sentence RTF | 5.681 | 1.800 | 0.462 |
| Warm RTF mean / median / max (4 samples) | 1.763 / 1.762 / 1.780 | 1.787 / 1.783 / 1.812 | 0.417 / 0.417 / 0.421 |
| Warm aggregate elapsed / audio duration | 1.763 | 1.788 | 0.416 |

Reference caching alone did **not** improve measured throughput. It moves the
first-use work into explicit preparation. Compilation actually ran all four
components and improved warm throughput about 4.2x in this small comparison.
The compiled first sentence was 3.52 s rather than baseline's 4.00 s; the second
remained 4.64 s. Numerical compilation can change autoregressive output. Waveforms
are not bit-identical and pronunciation/word completeness/voice quality are
**NOT_TESTED by a listener**. Compiled mode is explicitly experimental, selectable,
and not the default. No LoRA merge or 8/6-step experiment was necessary to reach
the throughput target, so neither was performed.

The final incremental worker ran six fixed texts twice (12 samples). With immediate
credits, RTF mean/median/max was **0.509 / 0.502 / 0.545**. First chunk ready was
**116.6 / 114.0 / 128.6 ms**, and parent receipt was **118.5 / 115.7 / 130.4 ms**.
Producer credit waiting was at most 0.70 ms here; these figures exclude intentional
playback pacing. The first signal-bearing chunk was the first chunk in these
samples; this does not measure physical speaker onset. A real credit-blocked
worker cancelled and exited in **222.7 ms**; restart produced 22 new chunks with
first receipt 123.9 ms and RTF 0.504. Persisted compiler-cache warmup still cost
15.72 s after process restart; process reuse is distinct from disk-cache reuse.

Actual app measurements are recorded separately below. Historical stabilization
numbers remain in `character-chat-voice-validation.md`. Physical listening,
loopback capture and Mac execution remain NOT_TESTED. This Windows CUDA worker
does not implement Mac/MPS/MLX support.

### Actual Windows candidate

The unpacked production candidate used an isolated existing profile, real E4B,
the adopted voice, and the new independent runtime selected through the native
Python/model file pickers. Native UI observations were paired with Main/renderer
events; no mock model or scripted renderer response was used for these numbers.

| Measurement | Original app path | Compiled incremental app path |
|---|---:|---:|
| Cold test-button to first scheduled playback | 46.535 s (includes load) | Preparation measured separately |
| Ready preparation with persisted compiler cache | No explicit warmup | 46.113 s (15.999 s real warmup) |
| Warm test-button to first scheduled playback | 6.493 s | 0.397 / 0.380 s |
| Warm automatic reply to first scheduled playback (3 E4B turns) | Not remeasured | 0.382 / 0.404 / 0.412 s |
| User-send to first scheduled playback (same 3 turns) | Not remeasured | 28.737 / 1.026 / 0.907 s |
| Two-sentence playback gap | 7.314 s first, 6.829 s warm | 0 ms scheduled gap in the two trials and two-sentence E4B reply |
| App stream elapsed RTF (includes producer waiting) | Complete-WAV generation | 0.999–1.104 across the 8 completed measured segments |
| App stream active elapsed/audio duration, subtracting credit wait | Not applicable | 0.569–0.594 across those segments |

The first E4B turn included LLM cold startup. Warm first playback across the five
compiled trial/automatic runs had median **397 ms**, max **412 ms**. Each started
before its first sentence synthesis finished. All **146 scheduled chunks ended**
in those five completed runs, with ordered segment indices and **0 measured
intra-stream scheduling underruns**. These are Web Audio timeline/software
observations, not loopback, mouth movement, acoustic silence or subjective quality.
Subtracting producer wait is an active-elapsed estimate, not CUDA-event kernel time.
Peak allocated/reserved TTS bytes were about 5.89 / 6.94 GB; a desktop+E4B+TTS
whole-GPU snapshot was 13,854 MiB, not an exclusive or sustained peak benchmark.

During a longer real eight-sentence reply, native **음성만 중단** interrupted its
third sentence: two scheduled chunks had no completion acknowledgement, stale
audio did not resume, renderer stop acknowledgement was 1 ms and owned worker
shutdown was **347 ms**. Thus this observed worker-stop time **misses 250 ms**;
action-to-audible-stop remains NOT_TESTED. Earlier attempts clicked stop only
after short utterances ended; those are not counted as active cancellation.
Explicit reread recovered via a new session (46.306 s cold first playback).
Closing the chat during that recovery playback invalidated audio, unloaded in
372 ms and left zero transient audio files. Reopening retained the saved text,
prepared again and did not automatically replay the old answer.

An additional native new-question-during-playback case stopped the previous
stream in 394 ms (renderer stop acknowledgement 3 ms). Its replacement answer
completed and all 30 new chunks played after worker reload; send-to-first was
51.488 s (45.108 s from completed reply), demonstrating the remaining restart
cost rather than warm latency. Finally, native pet-menu Exit during the sixth
sentence of a fresh reread stopped the worker in 338 ms. Owned app/worker process
count, app window count and transient audio file count were all zero afterward.

### Verification boundaries

- PASS: actual selected-adapter CUDA loading, compiled execution of all four
  components, incremental synthesis, the measured native software-playback cases.
- PASS: final full TypeScript regression (2,063 passed, 74 skipped, 0 failed), Python
  voice tests (14 passed), typecheck, source check and Windows production package.
  Includes prefetched-stream/hide, old-session rejection and explicit preparation
  stop regressions. Both CI jobs executed the 14 Python tests on source `6c15237`.
- NOT_TESTED: physical listening, loopback capture, phoneme/word completeness,
  long soak, missing-device UI, signed installer/distribution and relocated runtime.
- BLOCKED_MISSING_ASSETS: 12B coexistence and a second external character voice.
- NOT_TESTED / unsupported worker: Mac/MPS/MLX execution. Text chat remains separate.

Private measurement JSON, WAVs, runtime copies, compiler caches, UI conversation
data and paths remain in ignored local outputs. The optional setup script encodes
the approved copy/venv/ensurepip/pinned-Triton sequence; that sequence was executed
for this environment, but a second complete setup-script clone was not performed.

Runtime fingerprint for the final engine was
`d25011ca26e02fd216926a03fb02c8629b6593aa12ad98228335a5232723c137`.
All original adapter/reference/model identities are in the usage document and
worker audit. The final engine/worker bytes were unchanged after the measurements;
two late cancellation guards changed Main only. The full native matrix above
preceded those guards; final candidate smoke is identified separately in the
verification report. No historical result is presented as an unperformed rerun.

Final source `6c15237` native smoke additionally verified preparation cancellation,
fresh recovery and warm reread (389 ms first scheduled playback, 30/30 chunks,
zero scheduling gaps), followed by normal exit with no owned processes/windows
or transient audio files. Details and the successful CI run are in the verification
report. Physical listening remains NOT_TESTED.
