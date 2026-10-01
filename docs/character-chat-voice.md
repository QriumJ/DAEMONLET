# Local character-chat voice (experimental)

This branch adds **completed-reply, bounded utterance-group TTS** to local character
chat. Voice is off by default. Text chat works without a voice package, Python,
GPU, or a successful TTS request. Streaming text is unchanged; old conversations
are never automatically spoken when restored.

## Fixed adopted profile

- `belle_candidates_6000 / 0.5.0-selected-6000-e2 / step_0002660`
- Adapter SHA-256: `e7d8b3b99af702c3df135ef194596c2b13cf99bb00b8e7204f684c435be50eb2`
- Checksums-list SHA-256: `1a7d036f437b611307dbdceca564af75424efa27f77f761a01c015de24005f4f`
- `openbmb/VoxCPM2` revision `32279effe8c19989596f05d353d1447f51d9e915`
- VoxCPM source `f772e498a45fbb5fb8e13fbf9b9c48be9fe33e69`

Use the complete selected package folder, including reference, provenance,
checksums and license notes. Do not use the previous candidate or a standalone
LoRA file. Import copies and verifies the package without altering its source.
Checksums establish integrity, not ownership or redistribution permission.
The original usage notes and licensing are preserved. Nothing is uploaded.

## Independent runtime setup

Windows CUDA/BF16 retains its original runtime contract. Native Apple Silicon
MPS/FP32 is now experimental; see [Mac setup and measured limitations](character-chat-voice-macos.md). MLX is not enabled. No automatic fallback or
model download occurs. The base model must already exist locally with its pinned
`snapshot-provenance.json`; all listed files are hashed at worker initialization.

After approving setup, use the known working Windows Python 3.11 interpreter:

```powershell
& '<VOICE_LAB>\.venv\Scripts\python.exe' -B scripts/prepare-voice-runtime.py `
  --source '<VOICE_LAB>\vendor\VoxCPM' `
  --destination '<NEW_INTEGRATION_DIR>\runtime'
```

The destination must not exist. This offline setup copies the Python distribution
and 63 inference dependencies from the verified environment, installs a local
copy of the pinned inference source and its license, and writes an audit receipt.
It does not retain editable source pointers, copy training runs/data/weights, or
modify the original environment. The copied Python's venv points to the copied
base Python; relocating this entire runtime requires rebuilding its venv paths.
It is a local independent runtime, not a portable runtime distribution channel.

Expected baseline: Python 3.11.15, torch/torchaudio 2.8.0+cu128, transformers 5.3.0.
`voxcpm 2.0.2` is only the original local metadata label; the source commit and
copied source hashes are checked separately. No trainer is invoked.

## Commands

Run from the DAEMONLET checkout:

```powershell
# Package validation only; no GPU use
node scripts/voice.mjs doctor --package '<SELECTED_PACKAGE>'

# Register in a separate app profile; no character binding is guessed
node scripts/voice.mjs import --package '<SELECTED_PACKAGE>' --data '<TEST_PROFILE>'

# Two newly synthesized samples; DOES NOT prove app playback or listening
node scripts/voice.mjs smoke --package '<SELECTED_PACKAGE>' `
  --python '<NEW_INTEGRATION_DIR>\runtime\env\Scripts\python.exe' `
  --model '<LOCAL_VOXCPM2>' --data '<TEST_PROFILE>'

# Add --cancel to also kill an active owned CUDA worker and verify recovery
# (it still does not measure audible-stop latency).

npm run typecheck
npm test
npm run build:renderer
npm run build:electron
node scripts/voice-run.mjs --data '<TEST_PROFILE>'

& '<NEW_INTEGRATION_DIR>\runtime\env\Scripts\python.exe' -B scripts/test-voice-worker.py
```

For text-chat integration, stage the existing pinned llama runtime using
`node scripts/stage-chat-runtime.mjs '<PINNED_LLAMA_RUNTIME>' win32-x64` before
building Electron, and import an existing official GGUF through the chat menu.
See [Windows chat setup](windows-character-chat.md). No LLM is downloaded by voice setup.

## App controls

1. Open **character chat → ···**. Select the actual target character from the
   character selector; its real ID owns the voice binding.
2. Use **음성 패키지 가져오기** to choose the full selected export folder, then
   select **Belle · 0.5.0-selected-6000-e2** under **캐릭터 음성**.
3. Use **TTS 런타임·모델 연결** to select the independent `env/Scripts/python.exe`
   and then the existing VoxCPM2 base-model folder. Reuse this control if either
   folder moves. Paths stay in Main/local settings, never in renderer IPC inputs.
4. Enable **음성 사용**, then **새 문장 시험 재생**. This synthesizes new speech;
   it does not play the preview. Cold startup verifies files and loads the model.
5. **새 답변 자동 읽기** reads subsequent successfully saved assistant messages.
   **다시 읽기** beneath a completed answer synthesizes it without calling the LLM.
6. **음성만 중단** stops only speech; the existing response stop stops both.
   New requests, retries, conversation/character/model changes, voice changes,
   window hide/close, and app shutdown invalidate old speech.

The **음성 실행 모드** selector keeps the original **기준 모드** as default.
**빠른 시작** caches fixed reference features and streams each new audio patch;
**CUDA 가속 (실험)** additionally requires the separate approved torch 2.8 / Triton
3.4 runtime. Connect that Python before selecting the mode. Use **음성 엔진 미리
준비** and wait until ready before speaking; fresh compilation can take minutes.
The new paths start playback within a sentence and prepare at most its immediate
successor. Compiled pronunciation/quality still requires listening acceptance.
Switch back to **기준 모드** to restore complete-WAV synthesis and playback.
See [performance, setup commands and verification boundaries](character-chat-voice-performance.md).

Hiding or closing the chat permanently revokes automatic speech for requests
accepted before that boundary, even if their replies finish after the window is
shown again. Text generation and saving can still finish while hidden. Reopening
does not replay those replies: use **다시 읽기** or send a new question. Main
requires a visible live window and a subscribed renderer before admitting speech;
renderer visibility and decode-generation checks provide additional protection.

Audio is 48kHz mono PCM16. Web Audio performs output-device resampling and gain;
volume does not change synthesis settings. The default neutral reference mode,
CFG 2, 10 steps, normalize/denoise/retry disabled and max_len 600 remain fixed.
Seeds follow the [reply seed policy](character-chat-voice-seeds.md): random per
reply by default, or an explicit fixed value. Package manifests remain unchanged.
No unsupported emotion parameters or fabricated lip sync are used.

## Lifetimes and failures

Main owns one Python worker and one GPU generation at a time. Streaming bounds
in-flight audio to three chunks and prepares at most the immediate next sentence.
An opaque one-use audio ID grants only the current renderer its bound bytes.
Epoch checks cover late synthesis, reads and decode completion.

In cached/compiled streaming modes, **음성만 중단** and **다시 읽기** first revoke
old playback, then cancel at a chunk boundary or credit wait. The generator closes
and VAE/KV state is cleared before an identity-bound acknowledgement permits a new
request on the same warm worker. Reference and compiler caches are retained.
Initialization and baseline synthesis still terminate the owned process tree.
A missing acknowledgement after two seconds, invalid acknowledgement, worker crash
or cleanup failure also falls back to termination before recovery. OFF, hide,
close, app exit and runtime/voice changes explicitly unload the worker.
See [R2 implementation and measured verification](character-chat-voice-cancellation.md).

Worker errors are shown independently from text errors. GPU OOM does not retry
with another speaker or CPU. Logs contain state/IDs/timings/hashes, not dialogue
or reference transcripts. Cache deletion is retried on shutdown/startup; diagnostic
CLI samples are explicitly retained under `<TEST_PROFILE>/diagnostics`.

Settings: `<APP_USER_DATA>/voice/settings.json`; packages: `voice/profiles`;
temporary audio: `voice/cache/session-*`. Models are external read-only references.
The build includes only the Python worker source, not Python dependencies or weights.

Rollback: switch voice OFF, allow the worker to exit, then either select **없음**
to unbind or use **선택 음성 삭제** to remove the selected copy and its bindings.
For manual cleanup, close the app and remove only its own voice cache/runtime/profile
copies. Preserve conversations, original `.petchar` packs, and voice-lab inputs.
Deletion first commits unbinding and a cleanup marker once, then removes the
app-owned package copy. If settings cannot be saved, the registration and package
remain. If file cleanup fails, the profile stays unbound and
`VOICE_CLEANUP_PENDING` is shown; restart retries cleanup without re-registering
the leftover folder. Reimporting a verified package clears its cleanup marker.

Unsupported OS/CUDA/BF16 is reported as `UNSUPPORTED_DEVICE` before model hashing
or loading. No automatic fallback is attempted. Shutdown attempts text, voice,
IPC and window cleanup independently; notification failures cannot skip worker
termination, and worker-stop failures remain errors.

GPU-free Python protocol/device regressions run in both CI jobs with Python 3.11:
`python -B scripts/test-voice-worker.py`. These are separate from creator tests and
do not prove CUDA synthesis, app playback or physical listening.
See [verification boundaries](character-chat-voice-validation.md).
