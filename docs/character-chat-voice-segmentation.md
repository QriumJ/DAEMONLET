# Bounded voice utterance groups

The baseline is main `08cc14a77776f4a0a626cc907841856815fc93e6` (merged PR #29).
The app now plans one completed assistant answer with `transition-v1`, once per
read, before choosing chunk or complete delivery. Automatic reading, rereading
and test playback share this service path. A group is an independent synthesis
input, not a PCM chunk and not necessarily a grammatical sentence.

`planSpeech(text, policy, preferredLength)` is pure and shared by the application
and diagnostics. It returns contiguous UTF-16 source spans with an index, cut
reason, readable grapheme count, and a reason for unavoidable tiny inputs.
`legacy-sentence-v1` retains the exact previous splitter for controlled comparison
and rollback. `utterance-v1` preserves the initial 180-unit grouped experiment. The normal
default is `transition-v1`, revised after the user listened to both examples.

## Listening-driven revision

The initial work order requested one call for the 137-unit answer. After listening,
the user accepted the continuity of the short hesitation but found that the first
sentence's emotional delivery persisted unnaturally through the longer answer.
The user explicitly authorized a compromise and retesting. This supersedes that
one-call acceptance criterion; it is not evidence of a training defect or a
universal emotion detector.

`transition-v1` uses a preferred length of 96 units. For remaining input longer
than 48 units, an explicit discourse turn can end a group after at least 24 units
and 12 readable graphemes, with at least 12 readable graphemes remaining. Only a
sentence ending followed by a limited marker list qualifies: `아, 그래도`,
`아, 하지만`, `그래도`, `하지만`, `그런데`, `그럼`, `그러면`, `대신`,
`반대로`, `한편`. A word in the middle of a sentence never qualifies.
These are structural hints, not emotion labels or generation instructions.

The rainy-day answer now has spans `[0,46)`, `[46,84)`, `[84,137)`: the suggestion,
reconsideration, then offer of care. The 20-unit hesitation stays whole. Natural
prosody and boundaries require renewed listening approval. The marker heuristic
can miss unmarked turns or split a continuous thought; its effect is intentionally
bounded by minimum lengths. No emotional controls or prompts are changed.

## Shared policy mechanics

- Preferred length is 96 for `transition-v1`, 180 for `utterance-v1`. Total input remains 6,000 units;
  each group remains at most 400 units and 1,600 UTF-8 bytes. Graphemes are never
  split. An oversized indivisible unit produces `VOICE_TEXT_LIMIT`.
- Absent a qualifying discourse turn, an answer within the preferred length is one unchanged group, even
  with multiple sentences, ellipses, interjections, or newlines.
- For longer answers, substantial sentence/paragraph boundaries are preferred,
  followed by whitespace and finally grapheme boundaries. A boundary needs at
  least half the preferred length and 12 readable graphemes to receive structural
  preference; this avoids a tiny opening sentence forcing an early call.
- Punctuation runs and following closing quotes/brackets are protected. Ellipses
  are not sentence triggers. Decimal, version, URL and filename internal dots
  do not trigger sentence cuts; common titles/initials are not period endings.
  This is a bounded heuristic, not a multilingual grammar parser.
- A final fragment below 12 readable graphemes can merge if the result is within
  preferred length + 32 and the hard limits. Otherwise the last pair is
  rebalanced within preferred length where possible. The threshold is a warning,
  never a deletion rule. `응.`, `왜?`, and `알았어.` remain valid single inputs.
- Spans reconstruct the original byte-for-byte as a JS string, including CRLF,
  whitespace, combining characters and emoji. There are no whitespace-only
  grouped synthesis requests. Inputs whose whitespace or protected indivisible
  run makes these bounds impossible fail explicitly rather than dropping text.

Required fixtures: the 137-unit rainy-day answer changes from 5 legacy calls to
1 in `utterance-v1`, then 3 in the final `transition-v1`;
`아... 하, 안 돼... 그만...` changes from 3 to 1. The Unicode ellipsis variant
remains 1. Both chunk and complete profiles use exactly the same text plan.

## Preserved boundaries

The worker, native runtime, models, LoRA, fixed reference, receipts and checksums
are unchanged. No rolling prompt, retraining, new normalization, fallback
resynthesis, or simultaneous LLM/TTS is introduced. A failed partially played
group is not repeated automatically. Settings/profile IDs are unchanged.

The supervisor retains 48 kHz mono PCM16, 60 seconds per synthesis input,
5,800,000 WAV bytes, 48,000 samples per chunk, three producer credits, and
monotonic sample offsets. Main still allows at most six queued chunks / six
seconds and only the immediately following group to synthesize ahead. Mac
still combines three 160 ms patches and preserves the last tail. Default
180-second requests and 900-second selected initialization limits are unchanged.

The pinned Belle native implementation uses seed 42, CFG 2, 10 steps,
temperature 1, and `min(600, text_token_count * 6 + 10)` audio patches. The Python
package sets `max_len=600` and seed 42; reference-cache settings remain those of
the verified package. Characters, text tokens, patches, and output seconds are
different limits. Successful termination alone does not prove every syllable
was spoken. Fixed seed does not guarantee identical timbre across different text.

Complete mode now means **the bounded group completes before its WAV is played**;
a long answer may still contain several groups. Chunk mode emits audio before
that group completes. `segmentIndex` is the synthesis-input group index.

## Reproducible diagnostics

These commands need the existing Node dependencies but no model or Python:

```sh
node scripts/voice.mjs --help
node scripts/voice.mjs segmentation-ab --help
node scripts/voice.mjs segmentation-ab --dry-run
node scripts/voice.mjs segmentation-ab --dry-run --cases cases.json --data NEW_DIRECTORY
```

`cases.json` is an array of `{ "id": "safe-id", "text": "original text" }`.
The built-in nine cases include both required texts, the Unicode variant, three
independent short replies, UI test text, mixed punctuation, and a long reply.

```sh
node scripts/voice.mjs segmentation-ab \
  --package EXISTING_PACKAGE --python APPROVED_PYTHON --model PINNED_MODEL \
  --profile gguf-metal-f16 --data NEW_DIRECTORY --repeats 3
```

Windows trained voices use `compiled` (the CLI also accepts `cuda-compiled`).
Other accepted modes are `cached`, `baseline`, `gguf-metal-f16-complete`, and
`cuda-compiled-complete`. The app's package-free default path is tested separately;
the A/B command never invents a package/reference for it.

Use `--compiler-cache` for an approved compile cache and `--cache-root` for an
isolated cache whose adjacent `gguf-cache` contains an already verified derivative.
Do not point diagnostics at an active app cache. No downloads occur. The output
directory must be new; existing outputs are never overwritten. Arms run in
legacy/transition order on one worker, three repetitions by default. These are
repetitions with the same effective seed, not three seeds. Loading is reported
separately from synthesis. Use `--policies utterance-v1,transition-v1` to compare the first grouped
experiment with the final compromise. Both plans are reported explicitly; no
unsafe whole-input arm is added.

The synthesis report records the dirty-worktree state/commit (dry-run needs no Git invocation), voice manifest, adapter and
reference identity, backend audit, order/session, policy/spans, actual calls,
per-input metrics and errors. Each group and each complete arm has a WAV.
Comparison WAVs concatenate verified PCM with one header; there is no silence
insertion, crossfade or normalization. A comparison file spanning multiple groups
may be longer than a worker's per-input output limit.

`listening.csv` leaves quality fields blank and marks `PENDING_REVIEW`. Check text
completeness, short-phrase naturalness, within-answer voice consistency, boundaries,
ending and preference. Do not infer voice quality from waveform differences.
Worker timing returns credit immediately; it is not actual playback latency or
GPU-only compute time. `producerBlockedMs`, first chunk arrival and app scheduling
are different measurements. Ordinary app diagnostics contain only structural
plan data, never source text. Full text and audio belong only in private outputs.

## Rollback and validation

To roll back grouping, change the `CharacterVoiceService` constructor's default
policy to `legacy-sentence-v1`. Both audio modes then use the old splitter; no
model, cache, conversation or voice-package migration is involved.

Tests cover the pure planner, seeded Unicode corpus, service profile/default-voice
matrix, auto/reread/test entry points, a genuinely three-group successor test, and
R1/R2 races with both legacy fixtures and large grouped inputs. Earlier race
fixtures explicitly select legacy rather than silently becoming single-call tests.
See `character-chat-voice-segmentation-validation.md` for measured scope and
remaining listening/device validation.
