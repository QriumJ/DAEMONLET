# Reply seeds and session audio replay

New speech defaults to **random per reply**. Main chooses a positive integer from
1 through 2,147,483,647 with OS randomness, once per admitted answer generation.
Every `transition-v1` group of that reply receives the same immutable seed. The
model applies it once at the beginning of each group's inference, never per PCM
chunk. Randomization offers different samples; it is not a quality improvement
claim or an automatic best-result selector.

Settings → Chat & voice → **Seed for new speech** also offers **Fixed** (initial
editable value 42). Changing this setting affects the next synthesis without
restarting the worker or changing an active generation. Valid persisted settings
are retained; older settings without this field use random-per-reply while
preserving voice selection, enablement, volume, runtime and conversation data.
An existing malformed seed field raises a voice-only error until valid settings
are applied. Failed persistence restores the previous settings.

## Message actions

- **Read aloud** creates new speech using the current policy.
- **Replay saved audio** plays the completed session result without TTS, warmup or
  reference encoding. It creates fresh playback ownership, epoch and one-use audio
  capabilities; it does not pretend an old worker session is live.
- **Read with a different seed** creates a new random result distinct from the
  last successful result's seed. This one-time override also works in Fixed mode
  and does not change that mode. It changes TTS only, never the LLM reply.
- **Synthesize with current settings** explicitly creates a new result.
- If PCM was evicted but matching generation metadata remains, **Synthesize with
  the same conditions** reuses its seed. This is inference, not playback of an
  identical recording. Changed text, model, runtime, profile or speech plan
  prevents that action from silently using different conditions.

The last applied seed is selectable/copyable in the advanced generation details.
A worker's preparation seed is not reported as a user's applied seed. Native and
Python workers must advertise `seedContract: 1`; every audio response and terminal
result is checked against the requested seed. Older or ignoring engines fail
closed. The Mac trained wrapper also verifies its internal native engine.

## Lifetime and limits

Main keeps an independent memory-only replay cache: at most **8 completed
results**, **64 MiB including pending retained copies**, **16 MiB per result** and
**128 lightweight metadata entries** in the active character/conversation scope.
Audio uses LRU eviction. Exceeding a retention limit abandons caching while normal
speech delivery continues; the UI reports that the newest result was not kept.
Only fully verified, completed answers are published. A failed/cancelled reroll
cannot overwrite an earlier completed result. Pending copies are discarded on
stop. PCM is copied without normalization, silence insertion or crossfade and
checked by hash when replayed. Groups/chunks retain their boundaries and existing
per-input limits; playback stays bounded to three in-flight replay chunks.

Voice-only stop retains completed results. Voice OFF, profile/runtime changes,
character/conversation changes, deletion, actual chat hide/close and application
exit clear the relevant cache. Names, volume and seed policy do not alter saved
PCM. No permanent recordings, message base64, database, cloud sync or favorites
are added. App restart does not preserve an identical recording. Re-synthesis
with a seed is not a cross-device, cross-version or cross-backend PCM guarantee.

## Runtime and diagnostics

The request seed overrides the package's inference seed without modifying its
manifest/checksums. CFG, steps, reference, description and segmentation remain
unchanged. Seeds are result identity, not model-load, reference-feature, LoRA
merge, GGUF conversion or compile-cache keys. Runtime source upgrades may incur
one-time new verification/compilation; changing only the requested seed must not.

The existing private CLI now supports:

```sh
node scripts/voice.mjs seed-ab --help
node scripts/voice.mjs seed-ab --config CONFIG.json --cases CASES.json \
  --seeds 42,17,42 --output NEW_PRIVATE_DIRECTORY --dry-run
```

Config selects one trained/default/WAV voice and backend, existing absolute
runtime/model/worker/cache paths and applicable package or managed installation
and reference paths. Cases are a JSON array of strings. Dry-run does not load a
model or write output. Actual runs verify the configured assets, never download
or install anything, and require a new output directory outside the repository
and live application profile. Explicit seeds are experiment values, not quality
recommendations. `--cancel` exercises streaming cancellation and recovery;
`--compare-complete` collects the same streaming PCM through the complete path.
The complete flag is intended for the supported streaming backends, not the true
non-streaming baseline.

Outputs are a private manifest linking text/seed/generation/profile/backend,
original PCM WAVs, an offline listening page and a blank listening CSV. Cancelled
or failed runs are retained in the manifest; human review stays `PENDING_REVIEW`.
Ordinary app diagnostics contain identifiers/seeds/timings, not dialogue or audio.
