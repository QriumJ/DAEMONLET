# Reply seeds and session replay — validation

Validated 2026-09-29–30 KST. This is local candidate verification, not a release or an online CI result.

## Source and preservation

- Branch: `codex/wav-reference-cloning-v1`.
- Start: `eea6f406397926fe733d87b806cb390e49623dab`, clean implementation worktree.
- Implementation commits: `81bc8cc` and `793609fc05a85a64040713a79a140b20d3e58433`.
- Final Mac candidate was built from clean `793609f`; this report is a later documentation-only addition.
- The separate primary checkout's existing dirty files and experiments were not edited, stashed, reset or cleaned. Windows existing branches, Python environments and installed app were preserved.
- Existing WAV cloning, selected Belle `belle_candidates_6000 / 0.5.0-selected-6000-e2 / step_0002660`, original package manifests/checksums and base models were retained. No retraining, new package installation, model download, voice conversion or upload occurred.
- No remote Git push, PR, merge, version/tag/release, distribution signing/notarization or installed app replacement occurred. Version remains 0.8.2.

## Implemented behavior

See [the user/developer guide](character-chat-voice-seeds.md). Missing seed settings migrate to random-per-reply without enabling voice or changing the selected voice. Malformed settings produce a voice-only repairable error. Main chooses one immutable seed per answer; all transition-v1 groups use it. Fixed, one-time reroll, current-settings synthesis and same-conditions synthesis are separate from exact cached replay.

JS, Python and production C++ enforce integer 1–2147483647, including duplicate binding consistency. Capability and applied-seed checks extend through the Mac Python/native boundary. Seeds do not enter model, reference, GGUF or compile cache keys. The settings IPC retains sender/context checks and has no PCM or credit privileges.

Replay keeps at most 8 completed results, 64 MiB including pending retained copies, 16 MiB/result and 128 metadata entries. It uses fresh playback owners/audio IDs, at most three in-flight chunks, no old worker credits, and PCM hash validation. Cancelled/failed replacement preserves an earlier complete result. Voice stop preserves complete recordings; scope changes, voice OFF, chat hide/close and exit clear them. Ordinary new LLM replies do not clear previous recordings.

## Automated checks

| Check | Mac arm64 | Windows x64 |
|---|---|---|
| Full Vitest suite | 2,504 passed, 5 existing skips; 223 files passed | 2,424 passed, 85 existing platform skips; 219 files passed, 4 skipped |
| TypeScript / source scan | PASS | PASS |
| Renderer / production Electron build | PASS | PASS |
| Release payload structural verification | PASS | PASS |
| Existing Python worker tests | 32 passed | 32 passed |
| WAV reference Python tests | 7 passed | 7 passed |
| Seed Python tests | 5 passed | 5 passed |
| Compiled production C++ JSON validator | PASS | NOT_RUN; Windows production uses Python/CUDA |
| Language UI smoke | PASS | NOT_RUN |
| Isolated packaged candidate | PASS | PASS, portable candidate |
| Current candidate GUI | Executed; scope below | NOT_RUN; remote interactive UI unavailable |
| GitHub Actions / Ubuntu | NOT_RUN | NOT_RUN |

Commands: `npm test`, `npm run typecheck`, `npm run source:check`, `npm run build:renderer`, `npm run build:electron:production`, `npm run release:verify`; approved runtime Python `-B scripts/test-voice-{worker,reference,seed}.py`; on Mac, `test-voice-seed.py --native <compiled-validator>` and `npm run language:smoke`.

No tests were deleted or newly unconditionally skipped. Regression coverage includes strict inputs, migration/persistence, frozen per-answer plans, all supported profile forwarding, old/mismatched worker rejection, bounded cache/LRU, stale ownership and playback credits, failed/cancelled replacement, reply-epoch retention, settings sender/context boundaries, reference isolation and existing F1–F5/R1–R2 suites.

Windows used a separate user-owned checkout at the prior WAV baseline plus a SHA-verified overlay of changed implementation and regression files. The final 40-file overlay SHA-256 is `a743cae3ab270b25561a62cc4b06378840b1a60d5cccbb9e2e45ae72b7d2b4dc`. Four additional regression files and two orchestration scripts were separately approved and verified. It is an overlay build, not a Git commit falsely identified as the final Mac commit. Final checks confirm the actual hardware-tested worker/engine/supervisor files were unchanged by the final overlay. Temporary verification tasks were removed after completion.

## Actual engine matrix

One fixed Korean sentence, same conditions, explicit A=42 → B=17 → A=42, cancel A → recovered A, then complete-delivery A. Each voice kind used one warm session. All six combinations verified actual seed echo before PCM, exact A PCM on repeat/recovery/complete, differing B PCM for this sentence, and clean owned-worker exit. This does not establish cross-platform determinism or voice quality.

| Platform / voice | Worker PID (native if separate) | First PCM ms | First A RTF | Cancel ms | Reference builds |
| mac / trained | 62848 (62858) | 725 | 0.976 | 151 | 1 |
| mac / default | 62902 | 494 | 0.911 | 153 | 0 |
| mac / wav | 62948 | 706 | 0.963 | 148 | 1 |
| windows / trained | 46112 | 132 | 0.522 | 77 | 1 |
| windows / default | 20224 | 120 | 0.494 | 72 | 0 |
| windows / wav | 44348 | 117 | 0.495 | 73 | 1 |

These are small immediate-credit protocol probes, not concurrent-LLM or sustained real-time playback benchmarks. First PCM excludes initial model preparation. Mac initial loads were approximately 6.1 s trained / 0.7 s default / 0.9 s WAV. Windows fresh isolated compiled loads were approximately 270 / 214 / 222 s respectively. Changing seed afterward did not repeat loading or compilation.

Windows used the existing PyTorch 2.8.0+cu128, Triton 3.4.0.post21 CUDA compiled runtime. Base, residual, encoder and estimator each retained **one compiled graph** while actual execution counters increased through A/B/A/recovery. Trained/WAV reference builds stayed one; default stayed zero. No compile-disable workaround was used. Actual baseline/cached GPU matrix runs were NOT_RUN; explicit seed forwarding for those profiles is covered by automated engine tests.

Mac trained mode reused the sealed derivative cache (`hit`), with the existing 384 LoRA keys / 192 matrices, zero missing/skipped keys and no remerge. Reference builds stayed one; default has no reference conditioning. WAV retained no female description/adapter. The native source is pinned to `873056743b74e1a4ce5dcf7290e2298428e214db`.

Native binary SHA-256:

- Managed default/WAV: `867e8652625a0db3234bba00392d46303affa25d850c4d6e5df21404a0d28cad`.
- Trained: `9cdc293365c522f74c2744306d34edf0768a424a13fd7158ca52e9258afa186f`.

Builders, seed-header recipes, receipts, staged files and policy hashes were updated from actual builds. Existing integrity gates remain enabled. Final Mac candidate source-tree SHA-256: `c535f30f73adbe41a5b1e2a895605c3387b3927f1a377a20c32abd853c129b86`.

## Actual Mac GUI

Isolated profile, WAV voice, local Gemma 4 12B, real renderer/audio scheduling; no production conversations were used.

The first candidate (`81bc8cc`) verified random seed 336847776, switch to fixed 17, one-time reroll 706799418 across three groups, unchanged saved fixed setting, cooperative cancel in 8 ms, and the same native PID/reference cache. Replay added no generation or model preparation. Voice-only stop retained recordings. New local LLM output auto-read with fixed 17. Playback events completed with no playback-error entries; this is software playback evidence, not human listening approval.

The final candidate (`793609f`) rechecked the reply-epoch fix: an old answer was synthesized at 17, a new actual LLM reply auto-read at 17, then the old answer remained **Replay** and replayed without a third generation. Final log: two generations, one cache replay, 14 playback-ended events, zero playback-error. Both generations used the same runtime session/native PID 63783. Stop retained Replay; closing/reopening the bubble cleared it to Read. Normal app quit removed the candidate and its workers. The original installed app was restored and reached adapter READY. Before/after SHA-256 matched for original voice settings, conversation store, desktop settings and character registry.

The final GUI's new-answer input was a single punctuation character because native test typing did not enter the intended Korean sentence; the resulting actual reply still exercised a new conversation epoch. This was an automation-input limitation, not a Korean input validation test. Complete-mode equality was verified through the real engine protocol; final GUI testing used chunk playback. Final GUI checks of default/trained profiles, English settings, reference A→B→A and all adversarial races were not repeated; automated/protocol coverage is distinguished above.

## Failures found and fixed

1. The trained native wrapper marked a max-step chunk final before the upstream VAE flush. With short `응.` at seed 17, Python stopped granting credits and cleanup timed out. It now respects the upstream final marker only; normal credit/cancel ownership remains. Added a 40-chunk tail-credit regression. The failed run/wire log was preserved. All 18 identical listening cases subsequently completed.
2. Cache scope included chat epoch, which changes on every new LLM answer. Removed epoch only from completed replay scope; active speech still checks epoch. Added service regression and verified with the final packaged GUI.
3. Windows initial SSH-owned checkout failed Git ownership validation. A separate checkout was created by the existing interactive user; no safe-directory/security bypass. A mock engine fixture needed the new diagnostic counters; fixed its fixture without removing assertions. Earlier sandbox and constant-RNG fixture failures were retained in private logs and superseded by passing final runs.

## Listening and limitations

The `seed-ab` CLI supports trained/default/WAV configs, help, dry-run without model loading, explicit case/seed lists, isolated outputs, cancellation and complete comparison. It does not download/install/train.

Prepared **18 trained Metal clips**: six short/medium texts × 42, 17, 123, with manifest, unmodified PCM WAVs, offline page and blank review CSV. The initial failing set is preserved alongside the successful set. All subjective labels remain **PENDING_REVIEW**; naturalness, similarity, pronunciation and quality improvement are not claimed. Windows hardware WAVs/manifests exist on the isolated Windows host; a dedicated Windows 18-clip listening batch was NOT_RUN.

Remaining: current Windows GUI, online Windows/Ubuntu CI, subjective listening, broader statistical/long-session or concurrent-LLM performance evaluation. These are not marked passed. Private logs, PCM, runtime copies, model/reference paths and candidate artifacts are kept outside Git. The local artifacts inventory identifies final candidates and intermediate experiments; no cleanup deletion was performed.
