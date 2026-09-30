# Belle mouth-only audio animation: all-pose candidate

This expands the historical [one-pose pilot](belle-audio-lipsync-pilot.md). Candidate pack revision 1.2.3 opts in all 37 existing Belle poses. The candidate is a separate output; installing or selecting it is a user action. Installed artwork, persona, voice bindings, settings and credentials are not migrated by the authoring or QA scripts.

## Rendering contract

The output analyser still measures actual post-gain PCM. Text, synthesis progress and the microphone do not drive animation. Streaming chunks, complete files and replay use the existing playback controller. Audio overrides only incoming, current independent pose mouth layers in ACTIVE_LOOP. Base/outgoing layers and pose crossfades retain authored behavior. Global face, jaw, head and idle parameters are unchanged.

Speech needs genuinely closed artwork and its matching contour. Most poses use their existing neutral stroke. `bored`, `chat-cute-pout`, `chat-surprised` and `head-tap` instead use their own existing smile as the speech closed target: their neutral expression is already open. Normal neutral emotion and its global morph are preserved. The closed layer's opacity and the open layer's geometry use the same target. Identical neutral/smile artwork in `chat-shy`, `chat-shy-flustered` and `head-tap-smile` selects neutral only.

`waiting` and `writing` retain their old non-audio rendering. Their optional `anchorOverrides.mouth.speechMorph` contains geometry derived from their own supplied mouth alpha silhouettes and anchors; no artwork is created. It is read only by the audio mouth override. This field has the same finite, bounded validation as a normal morph. Candidate packs declare `audio-lipsync-closed-target-v1` plus `mouth-morph`; older apps reject the new capability safely. Old packs remain supported.

A meter heartbeat grants a 250 ms mouth lease. Silence, mute and pause while output is still owned renew level zero at a bounded 100 ms heartbeat, without reading PCM when muted or paused. Stop, mute, pause, end, cancellation and loss of ownership emit zero immediately; without another heartbeat the lease expires and restores the authored expression. Changing pose clears the previous nonzero level without extending its lifetime. A fresh heartbeat can drive the new current pose. Model unload/change releases the lease immediately.

## Reproduce without touching an installed pack

Use a reviewed existing pack directory, including visually confirmed closed strokes. The authoring tool writes a NEW output directory and verifies every input payload hash. It changes pose metadata and only derives speech contours where no morph exists; supplied PNG/PSD/persona payloads remain byte-identical.

```sh
node scripts/characters/audio-lipsync-pack.mjs /path/to/reviewed/Belle /path/to/new/candidate 1.2.3
node scripts/all-pose-lipsync-ui-smoke.mjs /path/to/new/candidate/payload /path/to/existing/Belle-voice-capture /path/to/new/evidence
```

QA uses an isolated Electron profile and the actual renderer. At a fixed pose it checks closed/small/wide geometry, all non-mouth vertices and alpha, finite coordinates, triangle orientation, no duplicate closed layer, and original rendering after audio release. It writes a visual contact sheet and checks pose change without a fresh heartbeat. Representative exception poses play an already captured real Belle waveform through the normal playback controller. The output is routed only to a MediaStreamAudioDestination, never speakers; fresh contexts have no silent prewarm. This proves PCM-driven animation, not fresh TTS generation or subjective listening quality. No account/tunnel credentials are used.

Windows GUI, real personal-dot messages on the new revision and the user's subjective visual/audio acceptance remain separate checks. Local app packaging requires consistent renderer/main/preload outputs and ASAR/signature verification. Candidate pack 1.2.3 requires the matching new app, not the older pilot app.
