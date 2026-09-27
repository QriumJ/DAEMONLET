# Voice integration verification — 2026-09-27

This report separates synthetic tests, real CUDA synthesis, software audio
playback, physical listening and packaged-app execution. It is not a release sign-off.

## Identity and preservation

- Branch: `codex/character-chat-voice-v1`; DAEMONLET base:
  `b44fa3c752673b83d19f0721b80dd8d995c2f923` (version remains 0.8.1).
- Read-only voice-lab base: `479115f159cb35793a63710a50e92bbb4739c99b`.
- Adopted package: `belle_candidates_6000 / 0.5.0-selected-6000-e2 / step_0002660`.
- Actual adapter SHA-256:
  `e7d8b3b99af702c3df135ef194596c2b13cf99bb00b8e7204f684c435be50eb2`.
- Actual checksums-list SHA-256:
  `1a7d036f437b611307dbdceca564af75424efa27f77f761a01c015de24005f4f`.
- Actual reference SHA-256:
  `171296e4a9138fc118c4d858ce350fccff530477ef3d3ef1fc85e8c22d9ccb40`.

The original selection, reference, LoRA, model and training environment were read
only. No retraining, candidate replacement, voice/weight publication or upload,
merge or version bump occurred. The original lab Git tree remained clean. Setup used user-approved
copies under the ignored integration output directory. No global package/driver
changes were made. Node dependencies were restored from the existing lockfile
with explicit approval; package.json and package-lock.json remained unchanged.

## Executed verification

| Scope | Result | Evidence / boundary |
|---|---|---|
| Complete selected package, checksums, provenance and import | PASS | CLI doctor/import and copied-package validation; original hash unchanged |
| Independent offline runtime | PASS | Copied Python 3.11.15, 63 inference dependencies, pinned source receipt; no editable lab source link |
| Model and adapter loading on RTX 4090 | PASS | Base snapshot files hashed; 384 LoRA keys loaded; exact key set, finite tensors, no skipped/missing keys |
| New 48kHz mono PCM16 synthesis | PASS | Fixed new Korean sentence synthesized twice; output headers checked in worker and Main |
| Actual synthesis cancellation and restart | PASS | CLI `smoke ... --cancel`; owned process tree exited in 238.6 ms in this run; subsequent new synthesis succeeded |
| Typecheck | PASS | `npm run typecheck` |
| Full TypeScript regression suite | PASS | 2,015 passed, 0 failed, 74 skipped under normal user permissions |
| Final importer/startup-race changes | PASS | 26 targeted tests, including one additional immediate-restart regression |
| Python JSONL protocol | PASS | `python -B scripts/test-voice-worker.py`: 4 tests; no GPU assertions |
| Renderer and Electron build | PASS | `npm run build:renderer`, `npm run build:electron` |
| Actual development app + E4B + adopted TTS | PASS (software playback) | Real UI prompt → durable completed reply → two ordered audio-ready/playback-ended pairs |
| Actual replay / playback cancellation / recovery | PASS (observed cases) | Reread from UI; cancellation during second audio prevented its end ack; no Python remained; replacement session played both sentences |
| Actual restart / no history autoplay | PASS | Saved text restored with no worker launch; reread remained explicit |
| Actual normal app exit | PASS | Exit from pet menu; app PID and owned TTS processes absent |
| Local Windows package build | PASS | `npm run electron:package`; packaged worker SHA-256 equals source |
| Actual packaged app start / adopted synthesis / playback | PASS (software playback) | Unpacked Windows candidate; persisted settings; two verified audio-ready/playback-ended pairs from explicit reread; no weights or Python dependencies in app.asar |
| Packaged normal exit / cleanup | PASS | Candidate PID 0, owned voice workers 0, both test profiles' voice cache file counts 0 |
| Physical speaker output / user listening / voice quality scoring | NOT_TESTED | Web Audio completion is not physical listening evidence |
| 12B + TTS | NOT_TESTED | No 12B installed in the isolated test profile; no additional model download |
| Mac/MPS/MLX | NOT_TESTED / unsupported worker | CUDA-only v1 explicitly rejects unsupported devices; no Mac execution |
| Fully disconnected network environment | NOT_TESTED | Offline flags and local model loading used; host network was not disabled |
| Native runtime-picker completion | NOT_TESTED | UI tool could inspect dialog but rejected its returned editable element; runtime configured in isolated local settings for subsequent tests |
| Installer / signed distribution / relocated Python runtime | NOT_TESTED | Local unpacked candidate only; copied venv still uses its own copied base path |
| Lip sync | NOT_SUPPORTED | Character artwork/rigs and pose ownership remain unchanged |

The initial restricted-sandbox full run had 18 `realpath` permission failures in
the existing project-read tests. Those passed outside the sandbox. Process-tree
termination tests also needed normal user permissions. The first packaging attempt
failed with EBUSY while the test app held its LLM runtime open; packaging passed
after normal app exit. These failures are retained in ignored local logs.

## Measured performance (small diagnostic samples)

The first independent smoke run loaded in 48.7 s; its new four-second utterance
took 33.8 s on first synthesis and 7.6 s warm (RTF 8.46 / 1.89).
A later cancellation run loaded in 23.1 s, synthesized the same four-second
utterance in 24.2 s / 7.2 s (RTF 6.06 / 1.81), and recovered after real cancellation.
This includes cold initialization/compilation effects; it is not real-time TTS.

The actual E4B answer's two segments were 1.76 s / 3.68 s long. Initial synthesis
took 20.4 s / 7.2 s; warm replay took 3.5 s / 6.9 s. Peak TTS allocated memory was
approximately 5.55 GiB, reserved 6.01 GiB. Whole-GPU snapshots (including desktop
and other activity) were approximately 10,355 MiB TTS warm and 13,759 MiB E4B+TTS.
These are snapshots, not a full simultaneous-memory or soak benchmark.

The 238.6 ms CLI measurement is owned-worker shutdown latency. The UI
action-to-audible-stop target of 250 ms was **not measured**. Decoder latency,
speaker onset, audio-device absence, long soak, a full character/revision-switch
matrix, every rapid retry boundary, and 12B coexistence still need real acceptance
coverage. Synthetic tests cover late completion, cancellation during decode,
ordered backpressure, duplicate events, storage failures and stale bindings.

## Local evidence

Detailed results are intentionally ignored by Git under `outputs/voice-integration`:
`vitest-final.json`, `vitest-final-boundaries.json`, `profile/diagnostics`,
`cancel-profile/diagnostics/worker-result.json`, `app-3.stdout.log`, build/package
logs and the local handoff. These may contain personal paths or synthetic test
conversation data and must not be committed or uploaded.

See [commands, app controls and rollback](character-chat-voice.md).
