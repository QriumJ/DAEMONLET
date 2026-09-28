# PR #29 I1 — install admission and cancellation

Based on reviewed HEAD `0f587d76a909b8fd7c340e709fb5ce8b7800f5bf`. This follow-up
preserves F1/F2, the Metal/CUDA engines, selected Belle assets, integrity checks,
and R1/R2. Metadata inventory performance remains a separate follow-up.

## Change

Both real installers now register their AbortController and complete operation
promise synchronously, before verification cleanup or any observer callback.
Overlapping requests receive that same operation promise. The tracked operation
covers preparation, verification drain, download/setup, verification, publication,
status updates and final cleanup. It never waits for its own full `cancel()`.

A preparing snapshot is available immediately. The existing install panel shows
**설치 준비 중** and **설치 중단** while cleanup is pending. Notifications run inside
the tracked task, so an observer exception cannot leave unobserved installation IO.
Main-process admission, not button disabling, prevents duplicate writers.

After draining verification, the operation checks cancellation and its ownership
before invalidating the asset identity or entering download/setup. Completion checks
cancellation again. Success/error notifications and `finally` cleanup are guarded
by operation identity; obsolete work cannot erase another operation/controller or
announce a new installation. `cancel()` drains the operation it captured and does
not invalidate a later operation's asset identity.

The service shares its installation promise and invalidates an installation epoch
on explicit cancellation/close. Thus a cancelled action cannot continue into voice
preparation, even when a previously valid installation is still marked installed.
Close requests cancellation immediately, then drains it alongside voice cleanup.

Publication retains staged, verified content and rollback of the previous target.
Cancellation checks before publication prevent moving a cancelled candidate into
place; a failed rename restores the prior target. Original range/size/SHA checks,
resumable downloads and native runtime validation are retained.

## Reproduction and regression

The attached extracted-method reproduction was read as a reference, not reported
as native app evidence. New expected-safe tests instantiate the actual repository
classes with controlled IO boundaries:

- Before the fix, all 12 initial admission cases failed on reviewed source (including
  lost-cancellation timeouts and stale cleanup overwriting ownership).
- A separate archive of the actual reviewed repository source was tested with the
  same new service/IPC tests. All four selected cancel/close cases failed because
  the installation IO entry point was reached after the verification drain. This
  is not a claim that real external downloads or file damage occurred.
- After the fix, all 30 new regression cases pass with no new skips. They cover
  same-turn and delayed admission, immediate/preflight/active-IO cancellation,
  retry after cleanup, reentrant preparation callbacks, observer failure, obsolete
  completion/finally, actual IPC/service cancellation and close, and publication
  cancellation/failure preserving previous content.
- Two tests use a real loopback HTTP server and actual partial-file IO. Both real
  installer classes create only one download writer, abort the response, preserve
  the received `abc` bytes and never enter extraction/publication. Disk capacity
  and tiny model metadata are synthetic; no external model or Python setup runs.
- IPC tests invoke the actual registered action handler, service and installers.
  Only Electron transport/trust, verifier completion and expensive installation IO
  are controlled. Preparing state is emitted through the normal voice snapshot
  channel. Cancel/close produces no late voice preparation or audio event.

Tests live in `tests/character-voice-install-admission.test.ts` and
`tests/character-voice-install-io.test.ts`. Existing installer, lifecycle, F1/F2,
F1–F5, ownership and cancellation tests remain in the whole suite.

## Validation boundary

Local Mac whole suite: 211 files, **2,223 passed / 5 existing skips**. TypeScript,
28 Python worker tests and source checks passed. Production Mac packaging and
release structure verification are run separately; exact HEAD and final Windows /
Ubuntu whole-CI results are recorded in the PR checks and description.

This I1 follow-up does **not** claim a new native GUI installation race reproduction,
multi-gigabyte model download, Python/CUDA environment installation, GPU synthesis
or physical listening. The existing running Mac app and Windows environments are
preserved. Earlier F1/F2 native-app/service results remain historical evidence and
are not relabeled as this installation-admission acceptance.

No dependency installation, weight upload, version change, force-push, automatic
merge or public release is part of this correction.
