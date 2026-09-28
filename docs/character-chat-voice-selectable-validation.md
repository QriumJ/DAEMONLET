# Mac selectable LoRA application validation — 2026-09-28

Scope: local Mac application integration; no release, version change, weight upload,
training or replacement of the adopted Belle package. Windows CUDA execution remains
separate. The default shipped character is unchanged.

## Preparation and identity

- Selected package: `belle_candidates_6000 / 0.5.0-selected-6000-e2 / step_0002660`.
- Fresh automatic conversion applied 384 adapter keys / 192 matrices to the original
  pinned base once in FP32, then audited all corresponding F16 GGUF bytes.
- Both output GGUF SHA-256 hashes equal the earlier manually prepared, auditioned
  derivative. The protocol reference WAV hash also equals the previous 480ms adapter.
- Fresh preparation plus Metal load: 48.86s in the isolated protocol test, 40.56s in
  the packaged app. Reopening the chat: verified cache hit, 6.30s including hashes/load.
- A real converter interrupted during first preparation exited with its adapter and
  left no partial directory (9.2ms observed termination after SIGTERM).
- Cached outputs remain external. Original package JSON/checksums/base stay unchanged.

## Application and protocol

- Actual packaged Mac app: imported the selected package through the folder dialog,
  kept Belle binding, Gemma 4 12B, auto-read and Metal F16 selected.
- New completed 12B reply: 3 sentences, 29 scheduled chunks, 0ms maximum recorded
  playback gap, first scheduled audio 1.066s after voice request. This is software
  scheduling evidence; no new physical listening claim is made.
- Actual UI stop: cooperative acknowledgement 121ms, same native PID, reference
  feature cache built once. Explicit reread recovered; closing chat unloaded its
  worker, reopening loaded from cache without automatically speaking old messages.
- Five isolated cancellation/recovery cycles: 11–130ms, same PID/session, no leftover
  WAVs and byte-identical recovered reference audio.
- Normal application quit: app, adapter and native worker all exited. The final
  package was reopened and left ready for remote use.
- F1–F5 and R1/R2 ownership/credit/backpressure remain exercised by automated tests.
  Actual window close/reopen was exercised; this is not a new Windows GPU test.

## Regression and limits

- TypeScript typecheck passed. Full suite: 207 files, 2157 tests passed, 5 skipped;
  the subsequent added per-profile derivative deletion test passed in the 43-test
  package/service subset (one additional passing test).
- Mac Python: 27 existing worker + 9 Metal adapter + 4 cache tests passed.
- Windows CPU-only, fresh temporary directory: 27 + 9 + 3 passed; the Mac-only
  filesystem-lock preparation test skipped. Existing Windows checkout/environment
  was not modified. CUDA synthesis/performance was not rerun.
- Actual distinct second-speaker LoRA synthesis/listening: NOT_TESTED, no second
  trained package supplied. Synthetic fixtures verify package acceptance, selected
  Belle pin preservation, cache separation, tamper rejection and failure cleanup.
- Supported import is a complete compatible VoxCPM2 voice package, not arbitrary
  safetensors. See [setup and compatibility](character-chat-voice-macos.md).
- Simultaneous 12B decoding + TTS did not pass the earlier real-time gate. Keep
  completed-answer → sentence streaming. RTF is not guaranteed below one for every
  sentence; observed buffered playback continuity is reported separately.
