# PR #29 F1/F2 follow-up — 2026-09-28

Implementation: `c4d4def4dabe8ec1b7d12a0347fd2d3e48d7072f`, following reviewed
`d04f8a6`. This is a correction to the existing Metal/CUDA integration, not a
new voice/model selection. No original Belle asset, runtime environment, version,
release or training artifact was changed.

## F1: preserve external Windows inference policy

The original Windows lifecycle failures were reproduced in a separate Windows
checkout: both `baseline hide then show=false/true` cases called `start()` with a
`cuda-compiled` fingerprint. This proved an unintended preparation call; it did
not prove hidden-window audio playback.

Managed default voice mode is now stored independently as `baseExecutionProfile`.
Only the selected managed default voice receives the CUDA chunk/complete modes.
External voices keep `baseline`, `cached` and `compiled`, including the UI's allowed
modes, worker configuration and saved settings. Volume changes and switching to the
managed voice do not overwrite that external setting. Restart restores both choices.
The old managed-mode names are migrated without changing valid legacy modes; a
legacy mode already overwritten by an older build cannot be inferred retroactively.

The two original failing tests remain. Additional cases distinguish legitimate
cached/compiled preparation from speech permission. Hide/hide-show and renderer
replacement still reject stale completion, synthesis and audio events. Tests also
cover baseline with an uninstalled default voice manager, cached/compiled routing,
mode switching and volume-save/restart preservation. No failure was hidden by a
new unconditional skip or a relaxed `start()` assertion.

## F2: verification belongs to a loading boundary

Installation and every new worker loading still perform full model/native hashes
and the Windows receipt/source/version/import checks. Installer startup only reads
installation receipts and required-file metadata; `installed` indicates files are
present, not that a voice has already passed loading validation. Opening text chat
with voice OFF does not launch Python or read multi-gigabyte model contents.

A reusable validation record is scoped to the exact runtime object, ready worker
session, profile/mode key, policy/model/runtime identities, canonical paths,
installation generation and metadata inventory. Reuse requires the same ready
worker: a starting, stopping, crashed or busy worker cannot qualify. Changed metadata,
replaced directories, missing files, policy changes and fresh loading invalidate
reuse. Detected corruption is rejected by full verification before a replacement
worker starts. Failure can be repaired through installation and validated loading.

Metadata comparison is change detection, not cryptographic content verification.
It reads file metadata for the managed runtime tree to detect dependency changes
beyond the top-level receipt. It never substitutes for hashes at loading boundaries.
This has a measurable remaining Windows cost, reported below. There is no global
`verified=true` exemption. Platform model/package validation remains enabled.

Stop/hide/OFF/close cancel and drain active full verification while existing
operation/epoch checks prevent late starts. Windows import-verifier cancellation
waits for the child `close` event, including when its abort callback arrives first.
Tests cover cancellation, validation failure/recovery, file/directory replacement,
three successive warm utterances and a fresh worker requiring revalidation.

## Full regression and CI

At implementation commit `c4d4def`, [PR Verify run 36362074312](https://github.com/ddol2ya/DAEMONLET/actions/runs/36362074312)
completed successfully:

| Environment | Whole suite | Additional completed checks |
|---|---|---|
| Windows CI | 2,113 passed, 85 platform skips; 205 passed files | Python 28, typecheck, renderer/Electron production build, release structure verification |
| Ubuntu CI | 2,179 passed, 19 platform skips; 209 passed files | Python 28, creator checks, typecheck, production build, release/creator structure verification |
| Local Mac | 2,193 passed, 5 skips; 209 files | Python 28, typecheck, source check, production packaging, release structure verification |
| Separate local Windows checkout | 2,113 passed, 85 platform skips | Typecheck; original checkout and branch preserved |

Platform skips include two newly added Mac-specific installer checks; the original
Windows lifecycle failures run and pass. CI structure verification is not native
Windows GUI or audio-device acceptance. The local Windows full suite preceded the
final ready-worker predicate; the whole hosted CI above covers the final code.

## Real base-model service measurements

`scripts/probe-voice-base-session.ts` uses the real service, installer and workers,
with synthetic renderer acknowledgements. It reads three different Korean sentences
in each mode. These are service first-delivery times, not native device playback
or concurrent Gemma decoding measurements. Final code was bundled from `c4d4def`.

| Metric | Mac Metal chunk | Mac Metal complete | Windows CUDA chunk | Windows CUDA complete |
|---|---:|---:|---:|---:|
| Voice-OFF initialization | 7 ms | 1 ms | 26 ms | 17 ms |
| Full verification calls across three utterances | 1 | 1 | 1 | 1 |
| Separate verifier Python processes | 0 | 0 | 1 | 1 |
| Initial full `verifyMs` | 1,898 | 1,892 | 9,853 | 9,549 |
| Initial service `loadMs` | 685 | 692 | 38,898 | 38,767 |
| Later metadata checks | 1–2 ms | 1 ms | 1,247–1,253 ms | 1,244–1,263 ms |
| Later first chunk | 476–485 ms | not separately exposed | 93–97 ms | not separately exposed |
| Later first delivery | 479–488 ms | 1,225–2,824 ms | 1,347–1,348 ms | 1,881–2,506 ms |

Both platforms kept one session per mode, then exited all owned workers normally.
Each Windows verification pass hashed all nine pinned model files. Warm utterances
performed zero additional model-hash passes and zero additional verifier imports.
Windows metadata still inventories about 29,000 runtime entries and costs ~1.25 s;
this is not a claim of zero overhead or 93 ms end-to-end latency. Its existing
compiled caches were reused; `loadMs` is not a fresh compiler benchmark. These
measurements concern the default female model, not Belle.

One initial Windows probe correctly rejected a differently serialized lock file
from the checkout (CRLF vs the exact LF lock in the existing installation receipt).
It was rerun with byte-identical trusted resource files in a new private directory.
No receipt, runtime dependency, expected checksum or validation was weakened.

## Native Mac app acceptance at `c4d4def`

The packaged app was exercised through its actual controls using synthetic test
sentences, with playback scheduled/ended acknowledgements in private diagnostics:

- **Belle Metal chunk:** playback passed; active-generation cancellation acknowledged
  in 92 ms and recovered in the same native worker. Reference cache remained at one,
  with unchanged selected adapter/reference hashes and derivative cache identity.
- **Belle Metal complete:** both sentence WAVs played. This is the trained Belle
  path, separate from default-female measurements. Warm first scheduled playback
  was 3,485 ms; one sentence's RTF was about 1.005, so no universal RTF<1 claim.
- **Default female complete:** first loading performed full verification (5,029 ms)
  and native loading (732 ms); first scheduled playback was 7,362 ms. A subsequent
  button test reused that worker, verification 0 ms / metadata 2 ms, with first
  scheduled playback at 1,550 ms.
- **Default female chunk:** new-mode preparation verified and loaded a new worker;
  subsequent test/recovery requests reused it, metadata 2–3 ms, first scheduled
  playback 742–765 ms. Active-generation cancel acknowledged in 126 ms, recovered
  in the same worker and preserved zero reference cache builds.
- Hiding during a test stopped output and unloaded the owned worker. Reopening
  performed new-load verification without automatically reading old replies.
  Pending-verification hide/stop/OFF/close races are additionally covered by the
  deterministic service/lifecycle tests; they are not inferred from a timing race
  in the native UI.
- With voice OFF and the installed default model selected, the app was quit and
  relaunched on the same profile. Text chat opened with no verification or voice
  worker startup in that fresh process. The previous app and owned voice processes
  were confirmed exited. Belle, Metal chunk mode and volume 0.5 were restored, and
  the app was left running.

App loading timings differ from the isolated service timings above; neither is
presented as worker RTF or physical listening. Windows GUI/audio-device playback,
fresh external Belle GPU inference, physical listening and a second independently
trained voice remain unverified in this follow-up. The Windows source and service
proof are ready for separate GUI acceptance; the user's existing Windows app and
runtime were not replaced or stopped.

The PR's final check status covers the documentation follow-up as well; the linked
implementation run above records the code acceptance independently of that later
metadata-only commit. No automatic merge, force-push or public release was performed.
