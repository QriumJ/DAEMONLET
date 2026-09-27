# Adopted Mac voice direction and Gemma4 12B concurrency — 2026-09-28

**Decision:** adopt the selected-LoRA GGUF / Metal F16 approach for the Mac voice
integration. The user accepted the saved voice comparison and the live streaming
review. MPS BF16/FP16 are rejected; the original selected 6000-e2 / step_0002660
voice identity remains unchanged. This is a backend selection and listening
acceptance, not a claim that the packaged app has already switched engines.

**Concurrent real-time gate: FAIL at the tested settings.** Actual Gemma4 12B
answer generation and native voice generation can execute together, but TTS cannot
sustain real time. Keep the existing completed-answer → voice ordering for the
app integration. Do not start speaking uncommitted LLM token prefixes, lower CFG
or timesteps, change the speaker, or hide underruns with an unbounded queue.

## What actually ran

- Apple M5 Max / 64 GiB, same Mac and verified GGUF F16 voice as the live review.
- Installed `google/gemma-4-12B-it-qat-q4_0-gguf`, revision
  `29d097773436b69ff9feafd636ab4cf873786537`, 6,975,879,296 bytes, SHA-256
  `93567e57a8fe10b23569b9d9ec38cd005deedf71e29477c421a4b83f418a538b`.
- The actual app `RuntimeSupervisor` verified and launched its pinned Metal
  runtime (`391fac16460f15233a7740550d858ac96df3419d`). Same 8192 context,
  one slot, all layers offloaded, F16 KV, flash attention, 512 output-token limit,
  no thinking, app sampling values, chat template, JSON reply schema and parser.
- The existing Belle persona/chat profile and production system policy were used
  with synthetic requests. No user conversation history was needed. Text/output,
  runtime logs, timestamps and private asset locations remain outside Git.
- The established voice worker stayed loaded throughout; all measured speech used
  the same PID. The script returned credits immediately, so the compute comparison
  did not deliberately pace TTS to browser playback. HTTP/JSON and reference
  conditioning are still included; this is not a kernel-only microbenchmark.
- Decode-overlap cases waited for actual visible LLM token output before starting
  TTS, then continued bounded LLM requests while TTS ran. The prefill-start case
  launched both together with the already warm LLM prompt cache; it is not a cold
  8192-token prefill test. No heavyweight cold-context acceptance is claimed.

LLM active overlap was 5.35s / 7.15s / 7.13s for the three concurrent cases;
visible token-generation spans overlapped 4.95s / 6.72s / 6.35s. This establishes
actual concurrent computation, rather than merely keeping the 12B model resident.
The separate LLM instance was stopped normally after the experiment. Existing
app configuration, model files, Windows runtime and running unrelated services
were preserved. No dependency install, model download, version/release or upload.

## Unpaced streaming measurements

Whole-generation RTF includes reference encoding/prefill and all PCM generation.
Steady RTF excludes the first chunk and divides subsequent generation time by
subsequent audio duration. Report both: a fast first chunk is not sustainable
throughput, and short utterance fixed costs can make total RTF exceed one even
when later chunks arrive faster than playback.

| Condition | Whole-generation RTF | Steady RTF | First chunk | Maximum interval for a 160ms chunk |
|---|---:|---:|---:|---:|
| TTS alone, two warm texts | 1.011–1.028 | 0.917 | 484–535ms | 150ms |
| Gemma4 12B resident, idle | 1.012–1.039 | 0.915–0.917 | 521–540ms | 149ms |
| 12B actively decoding, two texts | **1.718–1.759** | **1.511–1.514** | 984–1100ms | 249ms |
| Both started together, warm prompt cache | **1.713** | **1.526** | 1017ms | 252ms |
| Two segments from a completed actual 12B reply | 1.009–1.036 | 0.920–0.926 | 544–641ms | 152ms |

The fixed question stayed 3.04s and two-sentence case 4.16s. Their float-PCM hashes
were identical between TTS-only, resident-idle and concurrent cases. The observed
failure is throughput, without measured duration/PCM drift in these fixed cases.
The actual completed 12B reply used the app's sentence splitter; its first two
segments were synthesized after the reply passed the app parser. This is an
engine-path integration measurement, not an Electron UI conversation test.

Existing swap use stayed at 2720.44 MiB before/after the run; that is not a peak
memory-pressure measurement. The large slowdown only during active LLM generation
is consistent with shared GPU compute/bandwidth contention. No memory-capacity
or thermal guarantee is inferred from this small run.

## Actual browser playback under overlap

The same user-entered long text (21.92s / 137 chunks) was played with the unchanged
app `AudioPlaybackController` in the live review screen, retaining the 240ms
initial margin and three producer credits.

| Playback condition | First scheduled playback | Scheduling gaps | Largest gap | Generation/wait RTF |
|---|---:|---:|---:|---:|
| Prior user test, no benchmark LLM load | 1312ms | 0 | 0ms | 1.038 |
| During 12B answer generation | **2398ms** | **79** | **106.7ms** | **1.428** |
| After the owned 12B server exited | 1283ms | 0 | 0ms | 1.037 |

The overlap playback's TTS generation ran 31.29s; LLM work overlapped 22.65s,
including 20.68s of visible token-generation spans. The last part ran after LLM
load ended, so 1.428 must not be presented as the full-duration sustained-overlap
RTF. The unpaced short cases above establish that separately. Browser RTF also
includes consumer pacing; it is not directly comparable with an unthrottled
whole-WAV benchmark. The voice worker PID was unchanged after LLM exit.

These are Web Audio scheduling observations, not microphone/loopback measurements
or a new user listening approval under load. The earlier user's satisfactory live
review was without this imposed concurrent 12B workload.

## Reproduce and boundaries

Build the opt-in TypeScript diagnostic using the existing repository esbuild:

```sh
node_modules/.bin/esbuild scripts/voice-live/concurrency.ts --bundle \
  --platform=node --format=esm --outfile='<PRIVATE_DIR>/concurrency.mjs'
node '<PRIVATE_DIR>/concurrency.mjs' --repo '<MAC_WORKTREE>' \
  --binary '<APP_RESOURCES>/local-llm/llama-server' \
  --model '<EXISTING_12B_GGUF>' --character '<EXISTING_BELLE_REVISION>' \
  --output '<NEW_PRIVATE_RESULT_DIR>' --hold 45
```

Start the verified live voice server first. The diagnostic does not install or
fetch anything and refuses a wrong 12B hash. `--hold` is bounded to 90 seconds
and allows actual browser playback during LLM generation; do not run during an
unrelated user's listening/job session. It shuts down only its owned LLM server.

The selected next app backend is GGUF/Metal F16. The currently packaged candidate
still uses the earlier MPS implementation; replacing that app path and verifying
full service F1–F5/R1/R2, hide/unload, real 12B conversations and Windows regression
remain integration work. This measurement does not change those statuses, bypass
runtime checks or declare a release. True overlapping generation needs additional
scheduling/optimization work before it can claim RTF ≤ 1.
