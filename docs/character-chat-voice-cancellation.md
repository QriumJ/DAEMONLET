# R2: cooperative streaming cancellation

This continues PR #28 from `13b0ea7`, retaining the R1 ownership fix and F1–F5.
The selected Belle package, model/LoRA/reference, CFG 2, 10 steps, seed 42,
independent runtimes and training environment are unchanged. No retraining,
version change, release, merge or weight upload is included.

## Cancellation boundary

Voice-only stop and explicit reread first invalidate Main/renderer speech epochs,
stop scheduled Web Audio sources and retire old callbacks. Active-stream credits
are discarded so retirement does not unblock another unnecessary GPU chunk.
Terminal predecessor credits still drain exactly once, preserving R1 warm reuse.

After initialization/warmup, a bounded reader queues at most 32 JSONL commands
(each at most 64 KiB). The owner thread alone advances/closes the generator and
uses CUDA. Cancellation is observed during credit waits or immediately after
`next()` before its result is written/published. Closing the pinned upstream
streaming generator exits its VAE context; original decoder forwards are checked,
both static KV buffers are zeroed in place and lengths reset, CUDA is synchronized,
and cancelled-stream WAVs are removed. Prompt and compiled caches survive.

The worker acknowledges the exact request/synthesis/session/speech epoch only
AFTER cleanup. Main waits for that acknowledgement before admitting a successor.
A terminal-response/cancel race uses the same cleanup and acknowledgement gate.
A two-second deadline, wrong acknowledgement, cleanup error or crash falls back
to the existing owned-process-tree termination. Initialization/compile and baseline
whole-WAV synthesis also retain kill fallback. OFF, hide, close, app exit and
voice/runtime changes always unload. Text chat remains independent.

An initial real-runtime attempt hung in NumPy's native import when the reader
started before native initialization. A small stack-dump reproduction confirmed
the ordering dependency. The reader now starts only after native load/warmup;
this ordering has a regression test. That failed attempt is not counted as a pass.

## Regression evidence

Before the fix, the real Python protocol emitted an error instead of cancellation
and recovery at a credit wait; the supervisor had no cooperative cancellation
operation. Tests now cover those boundaries, real service stop/reread with a held
cleanup acknowledgement, delayed old IO, repeated warm ownership, no-cancel
controls, current-stream errors, terminal races, timeout/wrong-ack/crash fallback,
unload during pending cancellation, generator-thread ownership, discarded
post-next audio, bounded input, VAE/KV cleanup, cleanup failure and startup order.

The Windows full suite passed 2,079 tests (74 skipped, zero failed). Targeted
runtime/service ownership tests passed 32; typecheck and 22 standard-library
Python voice tests passed. Both Windows and Ubuntu CI run the Python suite;
these synthetic regressions do not establish CUDA or physical playback.

## Real CUDA and Windows app evidence

On the RTX 4090 / Windows optimized runtime, the final probe passed all four
cancel/recovery cycles. Credit-wait acknowledgements took **1 / 2 ms**; generation
cancellation at the next chunk boundary took **53 / 60 ms**. Recovery first chunks
arrived in **117–120 ms**, on the same Python PID and runtime session. All four
recovery outputs matched the reference hash and 168,960 samples exactly; cancelled
WAV count was zero. Reference-cache builds stayed at one, each compiled component
kept one graph, and execution counters increased across recoveries. The runtime
fingerprint stayed `d25011ca26e02fd216926a03fb02c8629b6593aa12ad98228335a5232723c137`.

The six-text/two-repeat worker benchmark measured median RTF
**0.546** and first chunk
**119 ms**.
R1's historical comparator was 0.501 / 117 ms; this is a small sequential sample,
not a controlled latency distribution. Compiled execution and streaming remain
active; no claim of improved synthesis RTF is made by this cancellation change.
The whole-WAV baseline was not rerun. Cold preparation still costs about
43.1 seconds; R2 avoids that cost only for successful active-stream
cooperative cancellation.

Packaged native app verification is pending at this implementation checkpoint.

## Reproduction

Use the existing approved optimized Python and selected local package/model:

```powershell
node scripts/voice.mjs stream --package <SELECTED_PACKAGE> --python <OPTIMIZED_PYTHON> --model <LOCAL_VOXCPM2> --data <ISOLATED_RESULT_DIR> --compiler-cache <EXISTING_COMPILER_CACHE> --profile compiled --cooperative-cancel
npm test
npm run typecheck
python -B scripts/test-voice-worker.py
npm run source:check
npm run build:renderer
npm run build:electron:production
npm run release:verify
```

The probe runs six fixed texts twice, then alternates credit-wait/generation
cancellation four times. It requires the same PID/session, zero cancelled WAVs,
one reference-cache build, unchanged compiled graph counts and a recovery WAV
hash/sample count identical to the pre-cancel reference. Its report separates
worker synthesis from app playback and physical listening.

In the packaged app, choose the existing compiled profile, prepare the voice,
use **다시 읽기**, press **음성만 중단** while speaking, then reread. Stop should
silence old playback immediately and the next read should use the warm worker.
Hiding/closing the chat deliberately unloads; reopening may need preparation.

Physical listening of this R2 candidate, loopback acoustic stop latency,
long-duration soak and Mac compatibility are not established by software events.
The user's confirmation of the prior R1 handoff is not new R2 listening evidence.
