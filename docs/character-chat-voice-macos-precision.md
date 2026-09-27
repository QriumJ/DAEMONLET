# Bounded MPS BF16 / FP16 experiment — 2026-09-28

Decision: **neither candidate is accepted for the app**. Both still exceed real
time and produce substantially different output lengths. No production profile,
voice package, base weights, installed dependency or source lock was modified.

The existing Mac runtime (torch/torchaudio 2.8.0, native Python 3.11.15) loaded and
verified the selected 6000-e2/step_0002660 package, pinned base and all 384 LoRA
keys in FP32 first. Only in-memory non-VAE modules were then converted. Actual
parameters: 961 in BF16 or FP16, 311 AudioVAE parameters retained in FP32. Both
non-module KV caches were rebuilt on MPS in the selected precision. Parameters
were checked for device, dtype and finite values. No CPU fallback, compile,
retry, denoise, normalization, retraining or alternate voice was used. CFG 2,
10 timesteps, seed 42 and the original text-derived max_len cap were retained.

| Same input | FP32 control duration | BF16 duration | FP16 duration |
|---|---:|---:|---:|
| 응. | 6.40s | 6.40s | 6.40s |
| 오빠, 오늘은 어떤 이야기를 할까? | 3.20s | 2.56s | 29.44s |
| 내일 오후 세 시에 다시 확인해 줘. | 2.40s | 4.32s | 3.68s |
| RTX 4090으로 음성을 만들고 있어. | 4.00s | 12.96s | 21.76s |
| 먼저 파일을 확인할게. 문제가 없으면 다음 작업으로 넘어가자. | 4.00s | 30.08s | 51.52s |

BF16 completed five sentences twice and two streaming cases. Warm whole-WAV RTF
was 1.085–1.107 (median approximately 1.104). Streaming RTF was 1.370 and 1.325.
All five repeated WAV hashes matched within BF16; this demonstrates repeatability,
not correct pronunciation or equivalence to FP32.

FP16 completed the five first-pass cases and two repeats before an intentional
SIGINT stopped the owned diagnostic. Non-cold first-pass RTF was 1.085–1.133.
The question and two-sentence case reached their text-derived generation caps
(184 and 322 patches). Further repeats and streaming were not completed because
the throughput/length gate had already failed. This was an operator stop, not a
native inference crash. The raw pre-annotation result is retained privately.

A fresh one-pass FP32 control reproduced the previous five output lengths.
Its non-first-case RTF was 1.243–1.288; the earlier warmed FP32 baseline was
1.172–1.176. These small sequential samples are not a statistical speed guarantee.
RTF alone is particularly misleading when low precision lengthens the audio.

All completed outputs were finite 48kHz mono PCM16 WAVs. Listening/phonetic
acceptance remains NOT_TESTED; length drift suggests a generation/stop-behavior
problem but does not by itself prove which words were repeated or corrupted.
The fixed upstream dtype policy explicitly warns about MPS low-precision drift.
This result applies to the tested runtime, not all future PyTorch/Metal versions.

## Reproduce (diagnostic only)

```sh
'<RUNTIME>/env/bin/python' -B scripts/probe-voice-macos-precision.py \
  --package '<SELECTED_PACKAGE>' --model '<PINNED_MODEL>' \
  --output '<NEW_PRIVATE_DIRECTORY>' --dtype bfloat16
# --dtype float16 or float32; --passes 1 --skip-stream makes a single control pass.
'<RUNTIME>/env/bin/python' -B scripts/test-voice-precision.py
```

Each diagnostic has a 240s alarm; the executed comparison also used a parent
260s process deadline. Source output stays outside the checkout. The first BF16
attempt hit a result-logging duplicate-field bug after its first synthesis; it
was repaired and excluded from the reported timings. It was not a model failure.

Two precision-helper contract tests pass (AudioVAE is never rounded down/up;
KV dtype/device is rebuilt; wrong device/nonfinite parameters fail). The existing
27 worker tests also pass. Production still rejects low-precision overrides.
The subsequent [isolated GGUF/Metal experiment](character-chat-voice-macos-gguf.md)
is recorded separately; these MPS low-precision candidates were not promoted.
