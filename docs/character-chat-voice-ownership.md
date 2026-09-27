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

## Scope and remaining work

R2 cooperative cancellation during active generation/credit waiting is **not
implemented** here. Active cancellation still terminates the owned worker and
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
