# PR #28 stream ownership (R1)

The terminal `synthesis-finished` response releases the GPU/protocol request before
the final WAV read or renderer consumption necessarily finishes. Previously, a
late rejection could terminate any request on the same child, including a new
speech epoch. A different-child guard alone did not protect warm reuse.

## Reproduction and ownership boundary

`tests/character-voice-ownership.test.ts` imports the production supervisor and
service. Only the process/inference is synthetic. A controlled final-WAV read
barrier establishes this ordering without relying on a timed race:

1. The old stream receives its terminal response; `busy` is false but delivery
   remains outstanding. One old audio capability has reached the service.
2. The real service stop/reread path invalidates that speech epoch.
3. A replacement request is pending on the same child and runtime session.
4. Releasing old IO cannot kill or reject the replacement; the late file is
   removed, its audio capability cannot be claimed, and no model reload occurs.

Before the fix, both baseline and streaming replacement cases failed: the old
callback killed the shared worker. The supplied ZIP was used as a reference;
its copied supervisor is not the implementation under test. The baseline case
calls the actual baseline supervisor API after real service cancellation; the
streaming case uses real service reread end to end. Direct reread without a
preceding stop is covered separately.

`CharacterVoiceService.stop()` now explicitly retires outstanding stream owners
before resolving old consumers. Every stream retains its owner through delivery
and playback. A retired callback can clean up only its own work; it cannot fail
the current worker request. A non-retired predecessor's playback error still
fails the same answer's successor and revokes all answer audio.

`busy` continues to mean protocol/GPU activity. `deliveryPending` separately
describes ordered filesystem/delivery work. Retirement does not wait for renderer
consumption or pretend that GPU generation has stopped. A short late file read
may overlap a new request, but it cannot publish audio after retirement.

Discarded and consumed chunks return each credit exactly once, in index order.
Retirement settles outstanding tail credits without waiting for old playback;
late acknowledgement cannot duplicate them. Python's actual main/credit parser
is tested with three repeated old-tail/new-generation interleavings. Existing
bounded producer flow and one-sentence lookahead remain unchanged.

## Automated verification

- New tests cover same-child baseline/stream replacement, direct service reread,
  no-cancel control, current corrupt-WAV/sequence errors, predecessor playback
  failure during successor generation, and repeated late playback rejection.
- Existing different-child late rejection, F1–F5, incremental playback and
  cancellation tests remain in the full suite.
- Windows full regression: **2,071 passed, 74 skipped, 0 failed**. Typecheck and
  source check passed. A first full run exposed two old lifecycle mocks missing
  the new method; those mocks were updated before the clean full run.
- Python voice suite: **15 passed**, including real protocol parsing with fake
  inference. Both CI jobs already execute this suite; GPU/native execution is
  not implied by CI.

## Fresh Windows/CUDA verification

The clean source candidate was built from `f33643b`; renderer and Main source
stamps match. Production builds, packaging and release structure verification
passed. [PR CI 36319997661](https://github.com/ddol2ya/DAEMONLET/actions/runs/36319997661)
passed Windows and Ubuntu, and both logs explicitly show the 15 Python tests.

A later documentation-only PR CI attempt (`36320434634`) hit `VOICE_TIMEOUT`
in the existing process cancellation/restart fixture with its 500 ms deadline;
the same HEAD's push CI passed. The fixture deadline was raised to 2 s for hosted
Windows process startup. Production timeouts and cancellation semantics are
unchanged; the bounded hang/partial-protocol rejection checks remain enabled.

The same RTX 4090, selected adapter/reference and existing compiled runtime were
used. Six fixed worker texts, twice each, produced median RTF **0.501** and median
first-chunk receipt **117 ms** (historical comparator: 0.502 and 114 ms). All four
compiled components built and executed; the runtime fingerprint remained
`d25011ca26e02fd216926a03fb02c8629b6593aa12ad98228335a5232723c137`.
The original whole-WAV baseline benchmark was not repeated in this R1 run.

Native UI actions on the packaged candidate used the isolated existing test
profile and actual GPU synthesis. The fresh screenshots were paired with Main
and renderer playback events, not treated as acoustic measurements.

| Case | Fresh result |
|---|---|
| Preparation with persisted compiler cache | 44.608 s; compiled execution confirmed |
| First prepared two-sentence trial | First scheduled playback 1,089 ms; 32/32 chunks ended |
| Subsequent long-answer warm reread | First playback 391 ms; interrupted during sentence 3 |
| Active stop | Renderer acknowledgement 0 ms; owned worker exit 338 ms |
| Explicit recovery reread | First playback 45.593 s including reload; 30/30 chunks ended |
| Stop after completion, then reread | Same runtime session, no reload; first playback 388 ms, 30/30 chunks ended |
| Scheduling gaps | 0 ms in these observed runs, including the two-sentence trial |
| Normal pet-menu Exit | Worker exit 288 ms; zero owned candidate/worker processes, windows and transient files |

The first trial's 1,089 ms is retained rather than hidden by reporting only later
warm reads. This small native sample does not establish a latency percentile.
Completed app segments had elapsed RTF 1.000–1.271 including producer wait, or
active-elapsed/audio-duration estimates 0.569–0.588 after subtracting that wait;
these are not CUDA kernel timings. Three scheduled chunks intentionally lacked
end acknowledgements in the active-cancel case; they did not resume afterward.

The deterministic late-file-read race itself is established by the production
service/supervisor regression with synthetic inference, not by claiming a native
UI click happened inside that narrow IO window. Native warm reuse and active
cancel/reload are separately observed above. After exit verification the candidate
is reopened and prepared for user listening; its intentionally running handoff
state is not a shutdown leak.

## Scope and remaining work

This R1 report predates [R2 cooperative cancellation](character-chat-voice-cancellation.md).
R2 was **not implemented in the R1 candidate measured above**. Active cancellation still terminates the owned worker and
subsequent use reloads it. R1 prevents stale work from destroying an idle warm
worker; it does not remove the approximately 45-second historical reload cost
after active cancellation.

Model, LoRA, reference, adopted `0.5.0-selected-6000-e2 / step_0002660`, 10-step
settings, engine/worker code and training environment are unchanged. Baseline
remains the default; compiled mode is experimental. Prior performance numbers
and native measurements in the performance report are historical, not reruns.
Physical listening, word completeness/quality acceptance, loopback and Mac
compatibility remain unverified. No merge, release, version change or weights
upload is part of this work.
