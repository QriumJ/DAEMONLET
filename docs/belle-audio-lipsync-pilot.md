# Belle audio mouth pilot

Historical one-pose evidence. The current expansion is documented in [all-pose candidate](belle-audio-lipsync-all-poses.md).

The UX checkpoint is `c378a033ca30d95c9044b17166997a2ddd12fdcc`. The pilot continues on `codex/belle-audio-lipsync-v1`; the candidate is opt-in and does not update an installed Belle pack implicitly.

## Contract and rendering

`pose.json` can opt an independently authored pose into `"audioLipSync": "amplitude-3"`. This version requires existing neutral/open mouth artwork and a valid mouth morph. Old packs, base art, partial swaps, transitions, outgoing poses, and unsupported rigs keep their original rendering. Only the reviewed Belle `waiting-open` pose is opted in in the separate preview copy. The installed pack is never modified.

`AudioPlaybackController` connects output gain → AnalyserNode → output. A 1024-sample time-domain window measures actual rendered PCM (DC removed), samples at most about 33 Hz, and emits a bounded 0/1/2 level. Unchanged-level heartbeats are sent no more often than every 100 ms; changes are bounded by the sample rate. Attack/release smoothing and threshold hysteresis reduce chatter. The same output graph handles streaming WAV/PCM chunks, complete output, and cached replay; no generation timing, text length, or microphone input drives the mouth. This is amplitude animation, not phoneme recognition. Device output latency can differ from browser render time.

Three forms use the existing artwork/morph with apertures 0, 0.30, 0.70. The voice override is applied only inside the current authored mouth layers. Global parameters remain unchanged: audio does not stretch the jaw, translate the head, or reshape the face outline. Normal pose/idle/head motion remains active. Muting closes the mouth rather than animating inaudible output.

Stop/cancel/expiry/visibility/disposal close immediately; AudioContext suspension closes and resumes from actual samples. Sampling frames/listeners are retired on teardown. Local chat forwards only validated epoch/level plus main-derived character/revision to the pet. It requires a trusted current renderer with an owned audio claim; synthesis status does not revoke an earlier playing PCM chunk. A 250 ms heartbeat watchdog checks ownership and is revoked when dot takes over. Existing dot-vs-local-chat exclusion is preserved.

## Local proof and preview

Run with an existing reviewed pose directory (no installation or model download):

```sh
node scripts/audio-lipsync-ui-smoke.mjs /path/to/Belle/poses/waiting-open /path/to/evidence
```

This opens and closes only an isolated QA window/profile. It copies the supplied source/PSD/overrides and opts in only that copy. Source hashes are checked afterward. The generated QA tone is played at gain 0.15; it is not model voice. A short silent output warms the audio graph before stream measurements. `preview-pose/` contains the opt-in metadata and unchanged original artwork; it is not an installable replacement character pack.

Evidence covers closed/small/wide, identical face mesh under different voice mouth values, changed mouth mesh, scheduled-future silence, actual streaming/complete/cached PCM, mute/unmute, suspend/resume, cancel, real service expiry, 320/460/1280 rendering and unsupported base fallback. Unit/IPC tests additionally cover stale decode/epochs, unknown input fields, unsupported poses, renderer ownership, next-segment synthesis during earlier PCM playback, and local→dot watchdog handover.

## Actual Belle voice and cold-start evidence

An isolated native generation used the existing verified Belle selected-6000-e2 adapter, Metal GGUF engine and fixed seed 17. It generated 291,840 samples (6.08 s), with peak 0.5672 and RMS 0.1027; model load took 955 ms, first native chunk 756 ms, generation 6,094 ms. No model download, cache rebuild, user pack or settings change was needed.

The real waveform was then supplied to the same `AudioPlaybackController` and reviewed PSD renderer. A fresh AudioContext was created on first input, with no silent graph warmup or autoplay-policy override. The measurements distinguish valid nonzero input, scheduled source starts, advancing AudioContext/output timestamps, post-gain analyser RMS and mouth events. In the initial output-device run the first nonzero rendered audio was 382 ms and first mouth event 416 ms (34 ms later); 13/13 streaming chunks completed and the mouth closed at end. Warm replay measured 273 ms; complete-waveform playback in a second fresh context measured 43 ms. These timings start at captured-waveform delivery to the renderer, not at text submission or model loading, and do not measure acoustic speaker latency.

The subsequent night-time run routed output exclusively to `MediaStreamAudioDestinationNode`, with no connection to the device destination. Cold stream measured 374 ms output / 408 ms mouth, warm 274 ms, fresh complete 14 ms output / 47 ms mouth. Actual PCM, source scheduling, context progression and nonzero RMS were observed in all three cases. A 5.16 s VP9/Opus recording captured the real renderer and post-gain voice, including mute/unmute and stop; it was converted to MP4. No sound was played on speakers in this run. This capture validates rendered audio rather than physical speaker output.

The earlier short, fixed-wait synthetic-tone silence did not reproduce with the measured real voice. Its exact cause remains unproven; warming the graph is not a production fix or a cold-start pass criterion. A live user-profile dot→voice→pet run and subjective voice review remain user acceptance checks.

## Limits and next gate

The pilot has not enabled all Belle poses. Metadata review found 37 three-mouth mappings, but only 35 morph profiles; waiting/writing have no morph. Independent artwork review also found several nonclosed neutral shapes and identical neutral/smile artwork, so shared layer names alone are not sufficient approval.

No live user profile, Keychain, tunnel key, character selection, voice selection or account grants are changed. Windows native GUI is not verified. The real captured-waveform proof does not assess subjective VoxCPM2 voice quality or a live dot→model→speaker lip-sync run. Before updating an installed Belle pack, review the mouth-only MP4 and validate the opt-in revision with the user. Only `waiting-open` is supported in this pilot. The external pack candidate changes only `pack.json` and that pose manifest; all 154 other payload files, including artwork, persona and chat semantics, remain byte-identical.
