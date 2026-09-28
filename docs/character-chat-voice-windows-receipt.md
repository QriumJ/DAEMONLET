# Windows default voice: checkout line endings and existing receipts

The Windows candidate at PR #29 HEAD `0093562` rejected an existing default
voice runtime with `RUNTIME_RECEIPT`. Its receipt recorded the SHA256 of the
LF install lock, while the candidate packaged the same lock with CRLF. The
runtime directory fingerprint already used parsed JSON and remained unchanged;
the Python verifier alone compared raw checkout bytes.

New receipts now record the SHA256 of lock bytes with CRLF converted to LF.
Verification accepts that digest, the current raw digest, or the corresponding
CRLF digest for legacy receipts. It does not parse/reserialize JSON for this
comparison: changes to values, indentation or other whitespace still fail.
Existing receipts are never rewritten. Git also pins the install lock to LF for
future checkouts. Model pins, dependencies, runtime directory identity, CUDA
execution settings, Belle adapters/references and inference steps are unchanged.

## Regression evidence (Windows, 2026-09-28)

Four new tests run the production installer script with temporary runtime files
and mocked native imports. Before the fix, LF receipt/CRLF lock and CRLF
receipt/LF lock both failed at `RUNTIME_RECEIPT`; new CRLF installations also
recorded a noncanonical digest. After the fix:

- All four LF/CRLF receipt/lock combinations pass without receipt rewriting.
- New receipts use the LF digest even with CRLF input.
- Changed lock content, byte counts, indentation and trailing whitespace fail.
- Source tampering and dependency mismatches still fail after legacy matching.
- The full Python suite passes: 32 tests. The existing Ubuntu and Windows CI
  steps execute these tests through `python -B scripts/test-voice-worker.py`.
- Full Windows TypeScript regression: 2,143 passed, 85 skipped, zero failed.
  Typecheck, source check, production build and release verification pass.
- Real portable Python 3.11.15 installations passed `--verify` in both directions:
  old LF receipt with CRLF lock, and recent CRLF receipt with LF lock. Both
  verified 64 dependencies, Torch 2.8.0+cu128 and Triton 3.4.0. Receipt SHA256s
  before/after were identical. No reinstall or download was performed.
- A separately packaged production Windows app reused the previously rejected
  installation copy without changing its receipt. Actual GUI test playback ran
  twice: four sentence WAVs synthesized, four scheduled and four ended, zero
  playback errors. All four CUDA compiled components executed. Warm button-to-
  first-scheduled times were 3.050s and 2.433s; sentence RTFs were 0.558–0.578.
  The candidate's own Windows audio session had nonzero output-meter readings
  (peak 0.431). This establishes digital output, not physical/user listening.
  Cold verification/load took 43.991s/258.631s, including 219.256s compile warmup.

The GUI candidate was built from `0093562` plus this code/test/attributes patch
before this documentation was added (source tree SHA256
`b1314c696cb7ec735932b1c1a5f9c4aa20f33617967016c66946c56779d621fa`).
Its packaged installer was checked against the patched source. The initial
30-second audio-meter window ended before playback; only the second window,
which overlapped the replay, is used as output evidence.

These targeted results do not replace physical listening, Mac validation or
the separate final-candidate acceptance matrix.
