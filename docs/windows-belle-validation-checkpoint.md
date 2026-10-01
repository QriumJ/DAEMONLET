# Windows Belle validation checkpoint — 2026-10-01

The reviewed application build is commit `559566f6a8e814b532cf341d8ab29a040f0d675e`, with source-tree digest `92cc4e3387a608387e0393de2173723f27e0f651a030b988bef54ef7494b7e47`. This checkpoint adds QA utilities, regressions, and documentation only; it does not replace the running review build or change production runtime behavior.

## Verified

- Windows Credential Manager uses a native fixed target and fails closed. Interactive synthetic QA completed save/read, replacement, invalid-input rejection, delete, and idempotent delete. Final cleanup was confirmed and the credential process exited with code 0. Production keys were not part of this test.
- Owned tunnel shutdown and failed/cancelled startup preserve the cleanup handle until termination is confirmed. The native host uses an owned Windows Job Object. Stale opacity-wheel writes are discarded after an external setting change.
- The application commit's full Windows suite recorded 2,714 passes, zero failures, and 89 skips. These counts predate the QA-only checkpoint.
- Existing CUDA/VoxCPM2 inference on the existing GPU runtime produced 51 chunks / 8,160 ms. Stream and complete PCM matched. Cancellation completed in 83 ms while retaining the warm session; owned worker exit passed. This was not an audible acceptance test.
- The owner reported completing the separate packaged application's manual visual checks without issues. This report is preserved separately from automated QA results.

## QA corrections

`scripts/qa/credential-check.mjs` records final cleanup failure as FAIL and requires both `cleaned === true` and a successful credential process with exit code 0 before a full QA PASS. The caller must use a helper compiled for the synthetic QA target. Cleanup exceptions, remaining items, failed processes, and existing-item preservation have failure-injection regressions.

`scripts/qa/rig-worker-bundle.mjs` bundles the browser rig decoder separately and rewrites its QA URL to JavaScript. A raw esbuild QA bundle previously retained the TypeScript worker URL without shipping the worker. Prepared single-pose loads completed, but the subsequent cold `bored` transition failed before voice-pose testing. The production Vite package already contained its compiled decoder worker.

Run the portable QA regressions with `npm run qa:regression`. Additional isolated Windows checks used the real compiled worker with the production pose loader and an in-process Worker transport: cold transition and voice-pose decoding, missing-worker recovery, error replies, and cancellation passed. This CLI transport does not prove Electron GUI or CSP behavior.

## Incomplete acceptance

- The saved owner QA run remains INCOMPLETE. Its automatic renderer result remains FAIL for the original missing QA worker; 37 pose records exist and voice-pose records are absent. The repaired QA artifacts have not been rerun interactively.
- Manual Alt/other-wheel/size observations were checked by the owner. Native Alt reveal was observed, but the QA's physical-wheel and tray-restore counters did not record acceptance. The packaged-app checkbox was not selected even though the owner separately reported completing that app's review. These distinctions are retained.
- Audible voice acceptance and real Codex/Belle connection acceptance remain unverified. The review launcher uses a separate profile, isolated Codex home, disabled adapter autostart, and no production credential connection. Windows Desktop named-pipe support exists; an isolated Codex home does not create a private named pipe.
- Five original hardware-rendered poses had one or two pixels outside the authored mouth bounds differing by one color-channel level: `chat-shy`, `disconnected-shrug`, `torso-tap`, `waiting-greet`, and `waiting-listen`. Non-mouth mesh vertices and alpha were unchanged. No tolerance was increased and no failed images were converted to PASS.
- An isolated Windows WARP offscreen experiment completed five poses × dithering enabled/disabled × eight mouth/repeated-frame states. Every comparison had zero non-mouth raw-RGBA and PNG differences; all actual non-mouth draw inputs also matched. This narrows the remaining discrepancy to a hardware/context-dependent rendering or capture effect, but does not prove which effect produced the original NVIDIA desktop pixels. A controlled interactive hardware comparison remains necessary.

Machine-specific launchers, profiles, model paths, generated images, hashes, task identifiers, and detailed evidence remain outside Git. The owner-approved muted review app is maintained separately from experimental voice-engine work. No public push, merge, release, new model download, or dependency installation was performed for this checkpoint.
