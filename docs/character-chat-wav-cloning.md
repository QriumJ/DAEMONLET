# WAV reference voice cloning

WAV cloning adds a local voice without training or a LoRA package. It uses the unmerged managed VoxCPM2 model: Metal/GGUF on Apple Silicon, or the existing managed PyTorch/CUDA compiled runtime on Windows. It is experimental. A reference recording influences new synthesized speech; it does not certify speaker identity or guarantee an identical voice.

## Using a recording

Open **Settings → Chat & Voice**, enter a voice name, confirm that you have permission to use the voice, and choose **Add voice from WAV**. Prefer one clear speaker without music, other voices, or long silence. The resulting speech is AI generated.

Saving a recording preserves the current character's selected voice. Select the saved WAV voice explicitly in **Character voice** to apply it. If the managed base model is missing, use the existing **Install base voice** button. Importing never starts a download. macOS needs no manually configured Python for this path; Windows uses the existing managed Python/PyTorch installation.

Open Character Chat to enable **Test playback**. It synthesizes a new sentence. New completed answers and **Read this answer again** use the same selected voice. Chunk playback starts playing the generated chunks in sequence. Complete playback finishes each planned utterance group before playing it; long answers may contain several groups. Existing `transition-v1` segmentation is unchanged.

Rename changes only the display name. Import another recording to change the reference. Deletion identifies affected character bindings and stops active speech; it deletes only the imported app-owned profile. The original WAV stays untouched. Moving or deleting the original after import does not break a saved profile.

Missing or damaged selected WAV profiles remain selected with an error. The app does not silently speak with a different voice. Text chat remains usable. Select default voice to restore the existing fixed feminine description with the current reply seed policy, or select an existing trained package to use its original pipeline.

## Supported input

These are v1 application limits, not general model limits.

| Property | Accepted |
|---|---|
| Container | Little-endian RIFF/WAVE |
| Encoding | PCM16, PCM24, IEEE float32 |
| Channels | Mono or stereo |
| Sample rate | 16,000 / 22,050 / 24,000 / 32,000 / 44,100 / 48,000 Hz |
| Duration | 2–20 seconds, inclusive |
| Source size | At most 20 MiB |
| Saved profiles | At most 32; store at most 128 MiB |

Compressed WAV, RF64/RIFX, extensible formats, duplicate mandatory chunks, malformed lengths/alignment, non-finite or out-of-range float samples are rejected. AC RMS below 0.0001 is rejected, including digital silence and DC-only input. No denoising, gain normalization or silence trimming is applied.

Stereo downmix averages the two normalized channels. Quantization uses `floor(sample * 32768 + 0.5)`, saturated to signed PCM16. Canonical storage is mono PCM16 at the original supported sample rate. `reference-policy.json` is the shared product policy; the native builder generates its C++ constants from that file.

## Storage and ownership

`voice/reference-profiles` is separate from trained `voice/profiles`. A bounded worker reads an ordinary file chosen by the Main-owned OS picker, checks file identity before/after reading, validates and converts an owned snapshot, and returns metadata. Renderer requests cannot choose a filesystem path. Links and Windows junctions are rejected. Parsing has a deadline and a cancellation owner.

A new opaque ID and content revision identify the saved profile. The manifest records original/canonical hashes and format, preprocessing version, model contract and creation time. It cannot configure executable paths, model URLs, or arbitrary commands. Atomic profile publication precedes the atomic registry commit. Uncommitted staging is cleaned after restart; published orphans are not auto-registered and still count against storage limits. Damaged profiles do not invalidate other voices.

Resolved conditioning fingerprints include the reference, preprocessing version, verified managed model/runtime asset identity and execution mode. Display names are excluded. Same-reference utterances reuse the warm worker and existing reference features. Metadata changes invalidate the lease; installation changes and new worker loading retain full integrity checks. A switch may restart one worker. Old engines lacking the audited reference contract fail at initialization.

Main retains the existing speech epoch/session/profile binding and chat-owned audio capabilities. Settings cannot fetch PCM or send playback credits. Cooperative cancellation waits for cleanup before reuse; initialization cancellation retains the owned-process termination fallback. OFF, hide and exit retain their existing unload behavior.

## Inference and build boundary

Both reference paths keep CFG 2, 10 steps and bounded 48kHz mono PCM16 output.
They use the [reply seed and session replay policy](character-chat-voice-seeds.md),
without changing the reference or model. They add no feminine description, LoRA tensors, merging, or per-recording GGUF conversion. Windows retains the existing four-component compiled graph/execution checks. Mac uses `encode_reference_audio()` and `generate_with_clone_streaming()` in the pinned native runtime, with an owner-thread reference cache.

The managed native build uses `scripts/build-voice-reference-native.py` with a fresh external CMake build and private output, then `scripts/stage-voice-base-runtime.mjs`. The original trained-voice builder and runtime policy are unchanged. Candidate native hashes, source/recipe hashes and license files remain pinned in `runtime-base-macos.json`.

Automated checks are separate from hardware synthesis, GUI playback and listening. See the validation report for the exact tested candidate and outstanding cases. Recordings, generated audio, speaker features, models, private paths and conversations must stay out of source control and public attachments.
