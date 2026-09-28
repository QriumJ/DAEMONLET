# Voice grouping validation — 2026-09-28

## Source and scope

Work-order baseline and fetched main are both
`08cc14a77776f4a0a626cc907841856815fc93e6`. Branch:
`codex/voice-utterance-grouping`. The previous Mac worktree was clean and reused;
its old branch, dirty primary checkout, Windows branch, original app profiles and
voice/model assets were preserved. No package installation or model download
was required. Models and derivative caches were reused/copied into private
experiment locations; no weights, WAVs or runtime receipts are committed.

The user revised the initial one-call criterion after listening: the short
hesitation's continuity was acceptable, but the rainy-day answer carried its
opening emotional delivery too far. The user explicitly approved the compromise
and retest. Final policy: `transition-v1`; initial `utterance-v1` remains a separate
comparison arm. New-policy listening acceptance remains **PENDING_REVIEW**.

## Automatic verification

Final local Mac tests: **2,312 passed, 5 existing skips, 213 files passed**.
Final local Windows tests: **2,232 passed, 85 existing skips; 209 files passed,
4 platform-specific files skipped**. Both hosts passed typecheck, source check,
renderer/production Electron builds and release structure verification.
The full suite includes the actual service, supervisor and IPC regressions;
none of the existing tests were deleted or unconditionally skipped.

Existing skips remain platform/tool prerequisites, not new unconditional skips.
Both hosts also ran Python worker contract tests (32 passed) and GGUF adapter
contract tests (9 passed). The latter are GPU-free mocks, not Metal proof.
Typecheck, source check, renderer build, production Electron build and
`release:verify` were run locally. Release verification checks artifact structure,
not installation, signing, notarization or publication.

One new Windows dry-run test initially exceeded 5 seconds while invoking Git
under full-suite load. The dry-run was changed to need neither Git nor voice
assets. The full suite then passed; this was not hidden with a skip or a raised
timeout. Later closing-punctuation and policy-matrix additions were retested.

GitHub Windows/Ubuntu CI on the final local branch: **NOT_RUN**. No push was
requested for this task. Local Windows results and previously merged PR #29 CI
must not be presented as a new Ubuntu/GitHub run.

## Device measurements

The initial legacy/180-unit comparison used nine fixed cases, three repeats,
54 arms per OS. Mac used selected Belle Metal F16; Windows used the same selected
Belle with the existing compiled PyTorch CUDA runtime. All 108 arms succeeded.
The required answer really invoked the worker 5 versus 1 times; the hesitation
3 versus 1. Each OS used one worker sequentially, with one reference-cache build.
No arm loaded an additional model alongside its baseline.

Mean worker RTF (sum of generation time / sum of audio duration per arm, then
mean of three repeats):

| Case | Mac legacy | Mac 180 grouping | Windows legacy | Windows 180 grouping |
|---|---:|---:|---:|---:|
| Rainy-day answer | 1.010 | 0.981 | 0.499 | 0.494 |
| Short hesitation | 1.029 | 0.993 | 0.504 | 0.499 |
| Long answer | 0.991 | 0.982 | 0.501 | 0.494 |

These are immediate-credit worker diagnostics, not physical listening latency or
GPU-only time. Loading and compilation are outside those RTF figures. Fixed seed
42 repetitions are not three different seeds. The native seed/CFG/steps/token
budget implementation and the selected adapter/reference hashes were verified
through the unchanged runtime audit. Text/PCM completeness still needs listening.

## Final compromise comparison

`utterance-v1` versus `transition-v1` completed 24 Mac arms (four cases × two
policies × three repetitions) and 54 Windows arms (nine cases × two × three).
All succeeded. They used the same voice/runtime conditions within each OS;
loading was about 6.5 seconds on Mac and 42.5 seconds on Windows with the already
prepared compilation cache. The earlier fresh CUDA cache preparation took about
236 seconds; it is not included in warm RTF.

| Case | Calls: 180 → transition | Mac RTF: 180 → transition | Windows RTF: 180 → transition |
|---|---:|---:|---:|
| Rainy-day answer | 1 → 3 | 0.977 → 0.983 | 0.495 → 0.497 |
| Short hesitation | 1 → 1 | 0.986 → 0.982 | 0.501 → 0.500 |
| Long answer | 2 → 4 | 0.968 → 0.967 | 0.495 → 0.496 |

Mean first chunk arrival for the rainy-day answer changed from 1,094 to 738 ms
on Mac and 132 to 113 ms on Windows. These are worker arrival times, not hearing
onset. The compromise has no demonstrated large throughput penalty in these
samples, but quality acceptance is **PENDING_REVIEW** and RTF below one is not a
universal real-time guarantee. No comparison WAV was normalized or crossfaded.

## Application and default voice

Tests used an isolated Mac development executable running the production bundle,
real renderer/IPC/service/supervisor/Metal runtime and Web Audio. The installed app
was not replaced. Only synthetic work-order messages were put in the new profile.
The user closed their original Mac and Windows apps before the GPU experiments.

For the initial grouping, Mac Belle chunk playback of the 137-unit answer began
before synthesis finished; complete mode produced one 17.28-second WAV and began
playback about 17.025 seconds after the read request. Both used one input. Complete
mode cancellation during a long input acknowledged at a patch boundary in 53 ms,
kept the same native PID/session and reference cache, and successfully read the
short hesitation afterward. These are software playback/ownership observations.

Mac package-free default voice played the same 25-unit test input in chunk and
complete modes (6.4 seconds of PCM), with no adapter/reference cache and the
unchanged female description/seed. Windows package-free CUDA supervisor testing
passed streaming, credit-wait cancellation (2 ms), same-session recovery and
complete mode (6.08 seconds; RTF 0.469). Windows GUI/audio-device playback is
**NOT_TESTED**; this supervisor result is not a GUI pass.

## Final-policy Mac app proof

The final `transition-v1` app reread the required answer as three groups and
scheduled/consumed all 42 PCM chunks. First playback including the fresh model
load was 7,455 ms; each group began playback before its synthesis terminal.
Maximum observed scheduling gap was 0 ms. A real E4B reply to a synthetic prompt
then automatically read as one 35-unit group: all 10 chunks played, first
playback from completed reply was 969 ms, and maximum gap was 0 ms. The test did
not introduce simultaneous LLM/TTS generation or reuse user conversation text.

A four-group long input was stopped during the first group. Cancellation was
acknowledged in 73 ms at a chunk boundary, preserving native PID/session and
one reference cache. The short hesitation immediately recovered in the same
worker and consumed all nine chunks (first scheduled playback 908 ms).

Final complete mode produced and played all three WAVs for the required answer,
with first playback after 6,509 ms. As in the existing sequential complete-mode
contract, subsequent groups waited for generation: observed gaps were 5,531 and
7,663 ms. These gaps must not be reported as a zero-gap complete-mode result.
The listening app is left in **chunk** mode. Improving complete-mode prefetch
would be a separate delivery change, not hidden inside text segmentation.

Normal app quit removed the owned workers and left zero WAVs in its session
cache. The same isolated profile was reopened for user listening; the original
installed apps and original data were not replaced or restarted.

| Host / voice | Chunk scope | Complete scope |
|---|---|---|
| Mac selected Belle | PASS: final app, automatic/reread, cancel/recover, A/B | PASS: final app, three-group playback; measured generation gaps |
| Mac package-free default | PASS: real app, unchanged 25-unit test plan | PASS: real app, unchanged 25-unit test plan |
| Windows selected Belle | PASS: compiled CUDA A/B; GUI NOT_TESTED | PASS: real compiled CUDA complete wrapper, four arms; GUI NOT_TESTED |
| Windows package-free default | PASS: real CUDA supervisor and cooperative cancel; GUI NOT_TESTED | PASS: real CUDA supervisor, same session; GUI NOT_TESTED |

Default-voice device probes preceded the listening-driven policy revision; the
final policy yields the exact same single 25-unit span and the final service
matrix covers its default-voice selection. Exhaustive default-voice long-text
quality was not measured. App memory trends and exact prefill/tail timing remain
outside the measured claims.

Windows selected Belle complete-wrapper verification also passed both required
texts with legacy/transition plans (one repeat, four arms; actual calls 5/3 and
3/1 respectively). Its WAVs are complete input groups, not proof of Windows
physical playback. It ran after the other worker exited, with the same pinned
package and existing compile cache.

## Limits and remaining checks

No training, prompt/reference replacement, engine change, larger queue, hidden
retry of played audio or LLM/TTS parallel execution was introduced. F1/F2 and I1
installer/verification behavior and R1/R2 ownership/cancellation remain covered.

Prefill-exact, inter-group-exact, tail-exact cancellation at every real-device
boundary, exhaustive long default-voice listening, Windows GUI playback and
per-OS memory profiling are not fully characterized. Unit/protocol coverage is
not a substitute for those measurements. The source safety limits are unchanged.

Private output folders contain both policy runs, per-group and single-header
comparison WAVs, JSON timing/audit reports, source hashes, and `listening.csv`.
The old-policy user feedback is recorded separately. No quality score is invented.
The final report links local listening materials; private paths are omitted here.

Rollback: set the service's default to `legacy-sentence-v1`, or use
`utterance-v1` to reproduce the first grouping experiment. No asset/profile/data
migration is necessary. See the local PR draft and policy document for usage.
