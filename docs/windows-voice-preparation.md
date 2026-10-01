# Windows voice preparation

The Windows voice settings offer two preparation policies for VoxCPM2 and Qwen:

- **Full** retains complete model content checks at preparation. Existing settings
  without the new field retain this policy; no user profile is migrated implicitly.
- **Installed** skips SHA reads of `.safetensors`, `.pth`, `.pt`, and `.bin` model
  weights during preparation. Pinned small configuration/tokenizer/code files,
  required-file sizes, ordinary paths, dependency versions, runtime receipts and
  pinned Python package source checks remain. Qwen's installed mode also requires
  the model path/revision to match its explicit installation receipt.

Download and installation still validate all model bytes before publishing an
installation. The lightweight policy is deliberately not a persistent hash-cache
proof: a same-size damaged or modified weight may pass admission, and a normal
loader can fail or accept it. Successful prior inference does not prove that bytes
are unchanged. This tradeoff is visible in the settings; model loading, reference
conditioning and first compilation still take time.

**Model full check** stops the owned voice worker and runs a CPU-only pinned model
check. It does not download, reinstall, synthesize, play audio or initialize CUDA.
It supports cancellation and waits for the verifier process to close. Failure
blocks that model in the current app session until a successful full check or
verified managed reinstallation. Recovery never silently selects another model.

Runtime preparation validates the small installation receipt/source/dependency
metadata before importing Vox. The separate installer probe no longer imports
Torch for every preparation; inference imports and CUDA/model errors still occur
in the owned worker. Explicit installation retains its import smoke check. Mac
model/runtime validation paths and Qwen MLX preparation remain unchanged.

Preparation diagnostics record only an allowlist of numeric timings/byte counters
and policy flags in `voice/preparation-metrics.jsonl`, capped at 100 events per app
process and 1 MiB on disk. No synthesis text, reference transcript, upstream error
or private path is included. Measurements separate model checks, environment
checks, runtime imports, model load, reference conditioning and warmup. Worker
`loadMs` remains the aggregate initializer duration for compatibility; Qwen's
separate `prewarmMs` must be added to obtain readiness after prewarm.

Compiler cache contents and the existing compile implementation are retained.
Fingerprints still partition incompatible model/reference/runtime identities;
new isolated candidates can incur a new fingerprint and initial compilation.
No performance improvement or second-start duration is assumed without measuring
the same preparation conditions. These settings do not add Qwen PCM streaming.
