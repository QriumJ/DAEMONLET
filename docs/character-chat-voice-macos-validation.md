# Mac voice validation — 2026-09-28

Status: **EXPERIMENTAL; real-time performance acceptance FAIL**. Functional MPS
synthesis and the actual packaged app were exercised. This is not a release or
Mac listening approval.

## Basis and identity

PR #28 was MERGED, head `32b133f10db2c386c0a062ffe7feea190f776774`;
latest main `e4ba350` includes it. Mac work uses the separate
`codex/character-chat-voice-macos` worktree. The dirty original main and Windows
branch were preserved. No version bump, merge, tag, release or weight upload.

Host: Apple M5 Max, 64GiB, native arm64, macOS 27.0 build 26A428;
Python 3.11.15, torch/torchaudio 2.8.0, transformers 5.3.0.
Profile `macos-arm64-mps-fp32-v1`; 62 dependency versions and hashes are fixed in
`scripts/voice-macos.lock` and checked against the installation receipt.
Lock SHA-256: `4f6eb1024649c394d8753f4a8d8d284bcf7b94be475f63e540368b8103b13ccb`.

All 13 package files and all 22 model-folder files (including original hidden
metadata) matched independently rehashed Windows originals. Neither original
`voice.json` nor checksums were rewritten. Adapter, checksums and reference hashes
match the handoff. All manifest-listed model files were verified before loading.
Pinned source: `f772e498a45fbb5fb8e13fbf9b9c48be9fe33e69`; model revision:
`32279effe8c19989596f05d353d1447f51d9e915`.

## Actual engine measurements

- PASS: all 384 adapter keys, exact expected key set, shapes and finite values;
  loaded 384, skipped 0, missing 0.
- PASS: all 1,272 model parameters audited on MPS, floating parameters FP32.
  No CPU fallback or low-precision environment override, optimize disabled.
- PASS: short fresh sentences; one cold and two warm passes. Initial load 12.76s.
  First cold synthesis 35.70s for 6.40s audio; warm RTF 1.172–1.176.
- FAIL real-time gate: streaming six fixed texts twice had median RTF 1.386,
  median first received chunk 217ms. Fast first chunks do not compensate for
  slower-than-real-time sustained throughput.
- Current MPS allocation approximately 10.74GB; driver allocation approximately
  11.77GB. These are instantaneous MPS metrics, not CUDA peak or sampled peak.
- `응.` produced 6.4s, versus 3.2s for the longer question. This requires listening
  inspection; file validity is not evidence of pronunciation completeness.
- PASS: five alternating credit-wait/generation cancellation cycles, same
  PID/session, reference cache build count 1, zero cancelled WAV remnants,
  identical recovery WAV hash/sample count. Credit-wait acknowledgements 4ms;
  generation boundaries 198–200ms. No compile graphs on MPS.

## Actual arm64 packaged app

An unsigned local candidate `.app` was built and launched with an isolated profile,
the existing Belle pack (`belle`, unchanged artwork) and existing official
Gemma 4 E4B Q4_0 GGUF. The original installed app/profile was not replaced.

- PASS: native Python/model dialogs, package selection and Mac-only profile UI.
  Testing caught native file-picker symlink resolution to the base Python;
  `noResolveAliases` plus pre-save receipt validation fixed it. A real venv
  `bin/python3.11` selection was confirmed in saved settings.
- PASS: actual new-sentence synthesis, incremental PCM delivery, Web Audio
  scheduling and playback-ended events; no preview substitution.
- PASS: three actual E4B questions, saved completed replies, automatic voice
  reading. This does not establish 12B behavior.
- PASS: five **active** synthesis cancellations in the app acknowledged cleanup
  while keeping the same PID/session and one reference cache. Acknowledgements
  26–147ms; subsequent rereads used that same worker. Other stop/reread actions
  after synthesis had completed are not counted as active cancellation evidence.
- First scheduled playback of measured prepared replies/rereads: approximately
  475–1,202ms (includes the player's 240ms scheduling lead). First LLM interaction
  included cold text-model startup; its user-send-to-scheduled-audio was about
  23.97s, subsequent two were 1.26s and 1.43s.
- FAIL uninterrupted audio target: software scheduling shows repeated gaps,
  typically around 75–80ms in the observed streamed passage. MPS FP32 is exposed
  as experimental and must not be described as accepted real-time conversation.
- PASS: chat-window close removed the observed owned worker PID; reopening
  restored saved conversation without automatically replaying it and prepared
  a new worker. Close/unload took about 575ms in the sampled case.
- PASS: normal app quit returned exit code 0 and the prepared worker PID was
  absent afterward (sample unload 531ms). Late `bubble:report` handler warnings
  occurred during teardown; these did not prevent app or worker exit.
- Physical listening: NOT_TESTED. User explicitly reported being away and unable
  to listen. No acoustic output/stop-latency or pronunciation approval is inferred.

During native picker testing, macOS killed the existing interpreter path with
`Code Signature Invalid`, despite identical receipt hash and a passing on-disk
signature check. A new copy of the same distribution inside the approved isolated
runtime executed successfully. The user's original interpreter was not changed
or re-signed. Setup now copies the interpreter distribution, as well as keeping
inference dependencies independent.

## Regressions and remaining boundaries

- PASS: full common suite 2,154 passed / 5 skipped (207 files) on the final code, including
  platform, picker, 48kHz decoding, R1/R2 and stop changes. Focused voice tests
  also passed 57/57. Typecheck and production renderer/Electron builds pass.
- PASS: Python protocol/device/cleanup tests 27/27 on native Mac and on the actual
  Windows host using its existing Python 3.11.15, in an isolated temporary folder.
  Windows lab venv/junction could not launch over SSH; the real interpreter path
  worked, without changing that environment.
- Historical baseline only: PR #28 Ubuntu/Windows CI was green at its reviewed
  head. Windows CUDA/BF16/compiled GPU synthesis, listening and native app have
  NOT been rerun with this Mac patch. The new Python tests do not prove those.
- CODE_REVIEWED: bounded MLX feasibility at commit
  `4ab7e6f7dedd69a136cfaa318c5dc8aed5119446`; 384 source LoRA keys paired to 192
  original base matrices with matching shapes. MLX tensor loading, conversion,
  synthesis, lazy-completion timing and cancellation: NOT_TESTED. No MLX success
  or reference-only LoRA claim. See the setup document for concrete contract gaps.
- NOT_TESTED: native hide/re-show and deliberate worker-crash recovery (covered
  by logical tests only here), physical 44.1/48kHz output switching, suspended AudioContext on real
  hardware, system suspend/resume, long soak, second-character/12B combinations,
  signing/notarization/installer. Hardware swap was 2.72GiB in one late snapshot;
  no before/after baseline exists, so no swap-growth claim is made.

Private raw logs, WAVs, results, source inspection and runtime receipts remain
outside Git. The app package contains Python helper sources/policy only, never
weights, reference audio, venv, compiler caches or private paths.
