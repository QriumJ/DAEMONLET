# Bounded native GGUF / Metal experiment — 2026-09-28

The user accepted the saved comparison and live streaming review, selecting
GGUF/Metal F16 for the next Mac integration. [Gemma4 12B concurrency results](character-chat-voice-gemma12b-concurrency.md)
separately fail the simultaneous real-time gate. This remains an independent
engine review, not an installed application backend.
The selected Belle 6000-e2 / step_0002660 voice, original package, pinned base,
MPS application, Windows runtime and production dependency lock remain unchanged.
No training, download of model weights, upload, release or version change occurred.

## Provenance and conversion

The approved private checkout is llama.cpp-omni commit
`873056743b74e1a4ce5dcf7290e2298428e214db`. A separate native Python 3.11.15 venv
uses the existing 62 hash-locked inference dependencies. CMake/Apple clang and
existing SDK/libraries built an arm64 Metal runtime; no existing installation was
upgraded. Metal shaders compile at runtime with `GGML_METAL_EMBED_LIBRARY=OFF`.

`prepare-voice-gguf.py` checks the original package checksums, selected adapter,
base revision/manifest and source identity. All 384 LoRA keys map to 192 matrices:
112 BaseLM, 32 ResidualLM and 48 LocDiT q/k/v/o projections. Each matrix receives
exactly one FP32 `W + B @ A * (alpha / r)` update (r=alpha=32). Random linear
probes check the folded result against the explicit adapter calculation.
The private manifest records input/output hashes, every mapping/shape/scale,
base/delta/merged matrix hashes and measured numerical error. Original input
hashes are checked again after conversion. License/usage notices accompany the
private derivative. Reference conditioning alone is not counted as LoRA transfer.

For F32 GGUF, all 192 mapped matrices match the merged FP32 bytes exactly.
For F16 GGUF, all 192 match the expected FP32-merge → FP16 cast bytes exactly.
Normalization tensors retain the converter's FP32 policy. These are storage dtype
claims; the native runtime also uses its own intermediate/KV precision, including
F16 KV. This does not establish PyTorch/native numerical or phonetic equivalence.

Two converter details were checked rather than ignored:

- Its lightweight safetensors reader assumes lexical data offsets. The generated
  all-FP32, metadata-free safetensors input is checked against this assumption.
- With an F32 safetensors input, `--dtype f16` casts BaseLM but leaves acoustic
  matrices F32. The first attempt failed the explicit dtype audit and was excluded
  from inference. The supported `weights_only=True` PyTorch input path performs
  the requested cast; a newly generated local FP32 dictionary is used for F16.
  The pinned upstream source was not patched, and validation was not disabled.

The FP32 merged safetensors SHA-256 is
`2016afafedd42923f322999d45ab3b6c21fbf5b8110af171ff399cefb6b8e6a9`
for both conversions. Full GGUF hashes and per-matrix audits stay privately with
weights and experiment outputs.

## Native F32 measurements

Host: Apple M5 Max, 64 GiB, macOS 27.0; no simultaneous LLM workload in this test.
Both custom components and all 29 BaseLM layers use Metal (`MTL0`). CPU token
embedding/output buffers and host orchestration remain; this is not a claim that
every operation occurs on GPU. No implicit whole-component CPU fallback passed.

Reference WAV, CFG 2, 10 CFM timesteps, temperature 1 and seed 42 are fixed.
Two texts use upstream text-derived caps 184 and 322 patches. The runtime's
reference-generation path tokenizes with `add_special=false`; token sequences
match the upstream wrapper. The first diagnostic's separate token logging used
the default `true` and displayed an extra BOS; synthesis itself used `false`.
The diagnostic logging was corrected for subsequent runs. Identical seed values
across runtimes do not imply identical random sequences.

| F32 case | Audio | Generation RTF | First chunk |
|---|---:|---:|---:|
| Question, two whole-WAV passes | 3.04s | 1.062 / 1.058 | N/A |
| Two sentences, two whole-WAV passes | 4.16s | 1.039 / 1.040 | N/A |
| Question, streaming | 3.04s | 1.109 | 583ms |
| Two sentences, streaming | 4.16s | 1.080 | 618ms |

Generation timing includes reference encoding/prefill on each call, excludes
model loading and WAV writing, and waits for actual returned PCM. Initial CLI
process wall time was 12.71s including loading/shader compilation; its generation
RTF was 1.301. The later persistent process initialized in 1.27s with warm shader
cache. These cold and warmed measurements are not interchangeable.

Post-first-chunk production RTF was approximately 0.969, with 160ms audio chunks
arriving approximately every 155ms. Total RTF still exceeded 1, and this small
steady-state margin is not evidence of reliable app playback alongside an LLM.
No max-step runaway occurred in these two F32 texts. Physical listening is pending.

Five synchronous callback cancellations (after one/two chunks) returned without
additional callbacks; each following synthesis used the same PID/runtime and
produced exactly the baseline float PCM. Normal `runtime.free()` and process exit
completed. The callback-return cleanup time is **not** an end-user cancellation
latency measurement: no asynchronous request, credit wait, IPC ownership epoch,
renderer playback or app worker binding was exercised. App F1–F5/R1/R2 therefore
remain untested for this backend. A first harness launch failed because Metal
headers were not beside its executable; placing it in the build's `bin` directory
resolved the resource issue. The failed run is retained and excluded from metrics.

## Native F16 measurements and decision

The audited F16 candidate completed on Metal with initialization 0.797s (warm
shader cache). The two whole-WAV repeat hashes matched within F16. Durations
remained 3.04s and 4.16s, matching native F32 for these two sentences; this is a
bounded length check, not a broad pronunciation or speaker-quality acceptance.

| F16 case | Audio | Generation RTF | First chunk |
|---|---:|---:|---:|
| Question, first / second whole-WAV pass | 3.04s | 1.013 / 0.939 | N/A |
| Two sentences, first / second whole-WAV pass | 4.16s | 0.924 / 0.922 | N/A |
| Question, streaming | 3.04s | 1.022 | 478ms |
| Two sentences, streaming | 4.16s | 1.003 | 528ms |

Post-first-chunk production RTF was 0.911–0.913. Median chunk intervals were
146ms, maximum 148.3ms, for 160ms PCM chunks. The five post-cancel recoveries
returned exactly the baseline float PCM in the same runtime; normal free/exit
completed. The same synchronous-callback limitations above apply. All completed
WAVs are finite 48kHz mono PCM16.

**Decision: promising experimental candidate, not app acceptance.** F16 improves
native whole-WAV and sustained streaming production, but total streaming RTF
is still slightly above one with reference encoding/prefill. Both loading and
first-chunk latency must remain separate from continuous production. A reference
feature cache could reduce repeated fixed cost; it has not been implemented or
measured here. LLM concurrency, memory pressure, arbitrary Korean text, physical
listening, and DAEMONLET's actual ownership/credit/cancel/playback integration are
NOT_TESTED for GGUF. Production stays on the existing MPS FP32 implementation.
No lower timesteps/CFG, alternate voice or base was used to improve these numbers.

A private listening page contains the same question and two-sentence WAVs from
MPS FP32, native F32 streaming and native F16 streaming. It has no automatic
playback, network resources or uploads. Playing these completed files is not a
live streaming performance test. The user previously reported choppy live MPS
app playback; the new native samples have not received user listening approval.

## Regression boundary

The two precision-helper tests and 27 Python worker tests pass on this Mac.
This change adds only offline diagnostics and documentation; it does not alter
the app/Windows engine, guards, F1–F5, R1 or R2. The earlier Windows Python
regression result (27 passed) remains a prior-run result; Windows GPU/app
regression was not re-executed for this independent experiment. Native callback
recovery must not be presented as the application's R2 acceptance.

## Reproduce

After explicit approval, prepare the external pinned checkout and isolated Python
environment. Existing production installations must not be implicitly upgraded.
Build only the diagnostic target:

```sh
cmake -S '<CPP_SOURCE>' -B '<CPP_SOURCE>/build-metal' \
  -DCMAKE_BUILD_TYPE=Release -DGGML_METAL=ON -DGGML_CUDA=OFF \
  -DGGML_VULKAN=OFF -DGGML_METAL_EMBED_LIBRARY=OFF \
  -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_SERVER=OFF \
  -DENABLE_COREML=OFF -DBUILD_SHARED_LIBS=OFF
cmake --build '<CPP_SOURCE>/build-metal' --target voxcpm2-cli -j 8
'<CONVERSION_ENV>/bin/python' -B scripts/prepare-voice-gguf.py \
  --package '<SELECTED_PACKAGE>' --model '<PINNED_MODEL>' \
  --source '<CPP_SOURCE>' --output '<NEW_PRIVATE_DERIVATIVE>' --dtype f32
# Use another new derivative with --dtype f16 for the F16 comparison.
'<CONVERSION_ENV>/bin/python' -B scripts/probe-voice-gguf.py \
  --source '<CPP_SOURCE>' --converted '<PRIVATE_DERIVATIVE>' \
  --reference '<SELECTED_PACKAGE>/reference/reference.wav' \
  --output '<NEW_PRIVATE_RESULTS>'
```

The probe expects CMake's Unix Makefiles build metadata. It builds the independent
C++ harness against existing static libraries and checks runtime Metal logs,
output WAV hashes, process exit and a 240s inference deadline. It never launches
or registers an application worker. Failed diagnostics are not application PASS.

## Live streaming review — 2026-09-28

The user listened to the saved comparison and reported no large perceived voice
quality difference. This is a user observation, not phonetic scoring or live
streaming acceptance.

`scripts/voice-live/server.py` prepares a loopback-only native Metal FP16 worker
and a browser review screen, using the already approved dependencies and model
conversion. Every launch rechecks the full selected package, pinned model
manifest/base, converter source, GGUF hashes and 192 audited LoRA matrix records.
It compiles the independent native transport and bundles the **unchanged** app
`AudioPlaybackController.ts`. No production execution profile is added.

The live worker sends actual newly generated 48kHz PCM chunks, with monotonically
validated index/sample offsets and a three-credit window. Browser credits return
on playback completion. The existing player retains its 240ms initial scheduling
margin. This is not cached WAV playback or simulated chunk delivery. The first
chunk has already reached the player while native synthesis is still active.

Stopping retires the local speech epoch and scheduled audio first, then sends a
request-bound cancel. Late chunks and credits for a retired ID cannot operate on
the next synthesis. The native owner thread returns after the upstream VAE stream
guard, explicitly resets KV/generation state, then acknowledges cleanup. A missing
acknowledgment/worker failure terminates the owned native process. The review
requires manual restart after such a failure; it does not claim the production
supervisor's complete fallback/restart semantics. Hiding/closing the review page
stops audio and cancels that request; the independent model stays loaded until
the review server is stopped. This differs from production app hide/unload policy.

Actual browser playback checks, one worker PID:

| Live text | Received / played chunks | First scheduled playback | Scheduled gaps |
|---|---:|---:|---:|
| Question | 19 / 19 | 737ms | 0 |
| Two sentences | 26 / 26 | 776ms | 0 |
| Longer new Korean paragraph (13.28s audio) | 83 / 83 | 1162ms | 0 |

A later long run was stopped with 54 chunks received / 51 completed playback;
the screen confirmed cleanup, and the next question reused the same worker.
The time above includes browser transport/decoding and the player's 240ms margin.
The screen's live generation/wait RTF includes consumer-credit pacing and cannot
be compared directly with the earlier unthrottled compute RTF. Gap counts measure
scheduling, not microphone/loopback capture. Live physical
listening and LLM concurrency remain separate user/hardware checks.

`check.py` exercised the real transport with five alternating credit-wait and
active-generation cancels. Acknowledgments took 7.6–8.9ms in credit wait and
152–154ms during generation. All five recoveries matched the pre-cancel float PCM
exactly in the same PID. Concurrent generation returned busy, foreign Origin was
rejected, and stale cancel IDs did not affect current speech. No audio files are
needed for this streaming transport. The unchanged player regression has 18
passing tests. Normal server shutdown returned native exit code 0 and both owned
PIDs disappeared; the final user-facing instance was then started separately.
Windows code and app configuration are unchanged; no new Windows
GPU acceptance is claimed.

Run with a **new private result directory**, after the GGUF setup above:

```sh
'<CONVERSION_ENV>/bin/python' -B scripts/voice-live/server.py \
  --source '<CPP_SOURCE>' --converted '<VERIFIED_F16_DERIVATIVE>' \
  --package '<SELECTED_PACKAGE>' --model '<PINNED_MODEL>' \
  --output '<NEW_PRIVATE_RESULTS>'
# Open http://127.0.0.1:47862 on that Mac.
# Optional actual GPU checks (do not run during a user's listening session):
'<CONVERSION_ENV>/bin/python' -B scripts/voice-live/check.py \
  --output '<NEW_PRIVATE_CHECK_JSON>'
```

The server accepts only its loopback Host and same Origin, with a per-run request
token; it serves no model/source directory or arbitrary paths. Input is capped at
400 characters / 1600 UTF-8 bytes. Generation is capped at 600 patches, credit
wait at 10s and a request at 180s. Python/Metal outputs and private launcher paths
remain outside Git. Locally provided start/stop commands let the user reopen the
screen or unload the test model. This remains an independent streaming review,
not full DAEMONLET service/LLM integration or production F1–F5/R1/R2 acceptance.
