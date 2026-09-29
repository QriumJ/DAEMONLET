# WAV reference cloning validation — 2026-09-29

Status: **implemented; Mac acceptance substantially verified; Windows acceptance partial**. This is an isolated experimental candidate, not a release or a claim of complete cross-platform acceptance. No listening-based speaker-similarity conclusion is made.

## Source and preservation

- Fetched `origin/main` matched the work-order baseline exactly: `53aa55fa623bd113db863981f3a2cb1bf3ec5aa4`.
- Work is on local branch `codex/wav-reference-cloning-v1`. Core implementation: `526de91`; localization follow-ups: `f6e9812`, `12f3d93`. The final Mac executable candidate is built from clean `12f3d93`; subsequent test/report changes do not change its runtime code.
- Version remains **0.8.2**. No remote push, PR, main merge, tag, release, notarization submission, trained weight upload, or installed-app replacement was performed.
- The dirty primary Mac checkout and original Windows checkout were preserved. The trained Belle manifest/checksum policy, original trained native builder, installed Python environments, original weights and selected adapter were not changed.
- The selected package was verified before Mac inference. The unmerged managed Mac GGUF pair passed its pinned size/hash and runtime checks. Windows preflight checked all 9 managed model files, 30 upstream source hashes, 64 dependency metadata versions and the installation receipt; its source model had no LoRA tensor names.
- Mac live voice settings, conversations, desktop settings and character registry hashes matched before relaunching the installed app. After relaunch, voice settings, conversations and the character registry still matched exactly; desktop-settings.json had been rewritten. Current selection remains Belle, Korean, scale 1 and visible; no forced rollback of that preferences file was attempted. Windows live voice settings, conversations and desktop settings hashes matched during restoration.

## Automated validation

| Check | Result and scope |
|---|---|
| Mac TypeScript | PASS |
| Mac complete Vitest suite | 2,448 passed, 5 existing platform skips; 221 files passed |
| Existing Python worker protocol suite | 32 passed; no GPU used by this suite |
| New Python reference suite | 7 passed, including real parser and mocked Windows routing |
| Compiled production native reference parser parity | PASS; combined Python/native runner reports 8 tests, with rates/boundaries/corrupt-input subcases |
| Source policy / private-data scan | PASS |
| Renderer and production Electron builds | PASS |
| Release payload verification | PASS; missing/empty/altered payload and QA-code negative fixtures rejected |
| Language UI smoke | PASS after restoring missing read-only fixture IPC handlers; existing zero-console-error assertion retained |
| Windows v1 full Vitest suite | 2,363 passed, 1 failed, 85 platform skips; see W1 below |
| Windows v1 Python suites | 32 existing + 7 reference tests passed |
| Windows v1 typecheck / source check / renderer / production / release verification | PASS |
| Windows v1 + portable fixture full-suite rerun | PASS: 2,365 passed, 85 existing platform skips; 217 files passed, 4 skipped. Executed in the existing interactive user session |
| Windows exact final Mac-source suite/build | NOT_RUN; final source transfer awaits approval |
| GitHub Actions / Ubuntu execution | NOT_RUN; no remote source publication was authorized |

W1 was a test-fixture portability failure: the missing-reference restart fixture saved a Mac execution mode while running on Windows. The final test explicitly scopes both `process.platform` and `process.arch` to each supported backend and restores them afterwards, with canonical temporary paths. Both Mac and Windows cases pass locally, including the unchanged assertions that the missing profile remains bound and no default worker loads. Production platform validation was not relaxed. The initial failure remains recorded. SSH reruns could not traverse the QA dependency junction even though the existing packages were present; restoring the original QA link and executing the same test command in the existing interactive user session passed. No package installation, security-policy change or assertion removal was used. This rerun covers v1 plus the portable fixture, not the final Mac source.

Coverage includes strict RIFF/chunk/alignment validation, all supported encodings/rates/channels, duration and quota boundaries, NaN/Infinity/silence, links/junctions, owned snapshots, source removal, staging cancellation/recovery, atomic publication failure, damaged registry/profile isolation, name/fingerprint stability, worker compatibility rejection, settings/dialog context revocation and warm lease reuse. Existing F1–F5 and R1/R2 tests remain in the full suite.

## Mac actual execution

Host: Apple M5 Max, 64 GiB unified memory, macOS 27.0 (26A428). Backend: pinned native Metal/F16 engine, source `873056743b74e1a4ce5dcf7290e2298428e214db`; unmerged model revision `169f64d8b98bbaab1761e4ca3a83e6af653456cc`.

The rebuilt executable SHA256 is `9ed9241d11f270711295f7dbb193c988edb57ce7ad8b3fad82378450bc666284`. Its catalog includes native source, reference validator, policy and recipe hashes. The original trained-voice binary/catalog were preserved. No Python process is used by managed Mac reference synthesis.

| Actual test | Result |
|---|---|
| Real OS picker → bounded import → separate explicit apply | PASS; importing preserved the previous Belle selection |
| New speech from base + selected Belle reference WAV only | PASS; audit showed `wav-reference`, no adapter, no default description, seed 42 |
| Three new Korean native inputs / warm reuse / rename | PASS; one worker/session, reference features built once |
| App chunk and complete-group playback | PASS; real Web Audio scheduling and completion acknowledgements |
| Local Gemma 4 12B completed answer → auto-read → reread | PASS for complete-group and chunk modes |
| Long actual answer segmentation | PASS; existing planner produced 3 groups; all 53 scheduled chunks ended |
| Cooperative stop → same-worker recovery | PASS; 30 ms in complete-group synthesis and 83 ms in chunk mode; native direct credit-blocked cancellation 7 ms |
| Hide/close chat → reopen | PASS; output revoked, worker unloaded, explicit reread recovered |
| Default → WAV → trained Belle → WAV | PASS; reference/default audits changed correctly; Belle used its existing verified derivative cache, all 384 adapter keys / 192 matrices, no missing/skipped keys |
| Import-source copy removed → app restart → reread | PASS; saved canonical reference and name/binding survived |
| Delete selected test profile | PASS; affected binding count shown, profile/binding removed, unrelated trained package retained |
| Missing managed TTS model | PASS; setup-needed state, no silent voice fallback/download, new text answer still completed |
| Voice OFF with models present | PASS; new text answer completed without speech |
| Korean/English UI | PASS; final candidate verified English WAV dialog buttons and chat-owned voice status |
| Candidate normal exit | PASS on Mac; owned workers exited |
| Existing installed app restoration | PASS; original app relaunched, pet UI/adapter ready; voice/conversation/registry hashes preserved, desktop preferences rewrite noted above |

Native direct, immediate-credit samples produced 5.60 / 4.32 / 19.68 seconds of speech at RTF 0.925 / 0.938 / 0.916. First delivered chunks were 651 / 660 / 1,004 ms. Reference encoding was 176 ms; initial native initialization was 6.82 s, including model/backend preparation. Main's separate model/runtime verification in that run was 1.93 s. Recorded peak process RSS grew to about 7.22 GB; this is not a Metal allocated/reserved GPU-memory measurement.

In the actual app, initial verification/loading cost more than a warm utterance. Warm metadata checks were about 4–6 ms with full verification reused. The long 3-group answer measured RTF 1.045 / 1.001 / 0.990 **including producer pacing**, and measured producer waits of 783 / 334 / 27 ms. Its first scheduled audio was 1.556 s after speech admission; all recorded scheduling gaps were 0 ms. This does not mean raw generation is always below RTF 1 on every device. Complete-group playback was separately observed after full group synthesis.

## Windows actual execution

Host: Windows 11 Pro, version 10.0.26200 (build 26200); NVIDIA RTX 4090, 24 GiB. Runtime: managed Python 3.11.15, torch/torchaudio 2.8.0+cu128, Triton 3.4.0.post21; original VoxCPM2 revision `32279effe8c19989596f05d353d1447f51d9e915`, upstream `f772e498a45fbb5fb8e13fbf9b9c48be9fe33e69`.

**Source boundary:** Windows testing used baseline plus the verified v1 source overlay (ZIP SHA256 `021d20bb4629d786a067b2170ba993023fc1f879345285d63d60f9785f6d77e7`). It is not claimed to have tested the final Mac commit. A final Git source synchronization was blocked by automatic approval review and remains pending user approval. Already copied later archives are not counted as applied/tested.

| Actual test | Result |
|---|---|
| Managed unmerged CUDA model + WAV-only reference | PASS in production service/worker harness |
| All four compile targets | PASS; base/residual/encoder/estimator each built and actually executed a graph |
| No adapter/default prefix, seed 42, reference cache once | PASS, audited |
| Three new inputs, long text split into 3 groups, rename | PASS; same worker/session |
| Cooperative cancellation → same worker recovery | PASS; harness 83 ms |
| Complete-group synthesis/delivery | PASS in service harness; its renderer acknowledgements were synthetic |
| App import / new answer auto-read / reread / rename | PASS on v1 candidate, observed by Windows verification task |
| Actual app audio activity | PASS for Web Audio completion plus nonzero candidate CoreAudio session peaks; not speaker listening |
| App stop / same worker recovery / hide unload | PASS in recorded v1 app tests; renderer stop 2 ms, cooperative cancel 92 ms |
| Remaining final-candidate GUI matrix | NOT_RUN / incomplete: complete-group GUI, full default/WAV/Belle/WAV sequence, source-deletion restart and profile deletion were not fully attested |
| Candidate normal app exit | NOT_RUN; coordination connection failed. OS soft termination failed; only the verified candidate process tree was forcibly cleaned up |
| Installed app restoration | Existing 0.8.2 process restored in interactive session 1; original profile hashes matched. Post-restoration frontend interaction was not observed |

Initial managed reference worker initialization took 274.4 s, including 25.2 s conditioning and 212.5 s compiled warmup. Pure compilation was not separately timed. Warm harness first chunks were 102–135 ms and generation RTF was about 0.55–0.59 with immediate synthetic credits. Peak torch allocated/reserved memory was about 5.86 / 7.04 GB. Actual warm app first playback was about 2.8–3.0 s; approximately 2.4–2.6 s was metadata change checking, separate from first-chunk inference. Metadata traversal optimization remains a follow-up.

Mac and Windows benchmark texts/runners were not a matched comparative corpus; these numbers describe each executed case and must not be presented as a controlled speed or voice-quality comparison.

## Remaining acceptance boundaries

- User listening and speaker-similarity judgement: **NOT_RUN** on both platforms. Different output hashes do not prove voice similarity.
- A clean authorized second speaker and A → B → A cache-contamination listening: **BLOCKED_MISSING_ASSETS**. No substitute speaker or retraining was introduced.
- A matched three-sentence comparison across default/reference/trained voices: **NOT_RUN** as a complete matrix; the executed synthesis/regression cases above are narrower.
- Final exact-source Windows full tests/build: **pending source-transfer approval**. The remaining GUI matrix and normal app exit also need a functioning Windows UI validation connection.
- Init/reference-encode/compile cancellation at every real GPU subphase: not comprehensively exercised; protocol/unit cancellation and the measured generation/credit cases are reported separately.
- Distribution signing/notarization and release: **not requested, not performed**.

Private raw recordings, generated WAVs, paths, compile caches, speaker conditioning and test conversations are kept only in external experiment storage. Public source/report files contain no such assets. Candidate launch must use the isolated `DAEMONLET_DATA_HOME` launcher; the installed application was not replaced.
