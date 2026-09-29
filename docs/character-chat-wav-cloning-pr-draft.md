# PR draft — Add local WAV reference voice cloning

Users can import one supported WAV in Settings → Chat & voice, save a named local reference profile, and explicitly apply it to a character. New speech uses the managed unmerged VoxCPM2 model: native Metal on Mac and existing compiled PyTorch/CUDA on Windows. Trained Belle packages and the default feminine-description voice retain their separate paths.

The implementation adds a bounded cancellable import worker, strict WAV conversion, an app-owned reference registry and atomic publication. Missing/corrupt selected profiles remain bound with a voice-only error. Conditioning is verified again by the worker and tied to the model/runtime/reference execution binding. Warm utterances and rename reuse the reference features; old workers that ignore reference input fail during startup. Existing output ownership, cooperative cancellation, segmentation and PCM/credit limits remain in place.

Validation includes the full Mac automated suite, strict parser/native parity tests, actual Metal synthesis and isolated app playback, and partial real Windows CUDA/app verification. The Windows portability failure and execution-context blockage are retained in the validation report, along with unrun listening, second-speaker and remaining exact-source Windows cases. This draft is not a release-readiness claim.

See `docs/character-chat-wav-cloning.md` for input limits and usage, and `docs/character-chat-wav-cloning-validation.md` for the exact source boundaries and measurements. No models, recordings, trained weights, private profiles, runtime installations or generated audio are included. Version is unchanged. No PR has been created or pushed.
