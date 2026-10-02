# Windows GGUF model downloads

The voice controls expose two explicitly selected public **community conversions**:

| Entry | Publisher | Revision | Model bytes |
|---|---|---|---:|
| Qwen 0.6B Base Q8 + codec Q8 | [Serveurperso](https://huggingface.co/Serveurperso/Qwen3-TTS-GGUF) | `b7ee2e8c7459c3bea99da23e3d178125a7d1713c` | 1,283,766,112 |
| VoxCPM2 BaseLM F16 + Acoustic F16 | [DennisHuang648](https://huggingface.co/DennisHuang648/VoxCPM2-GGUF) | `169f64d8b98bbaab1761e4ca3a83e6af653456cc` | 5,073,076,896 |

These are derived from Qwen/OpenBMB models under Apache-2.0 terms. The GGUF files are distributed by community publishers, not directly by the model authors. Each catalog entry records its publisher, upstream model, revision, exact filenames, byte lengths, SHA256 hashes and compatible runtime source pin. The Vox public F16 pair uses the same pins as the existing Mac base-model catalog. This does not make it equivalent to a private LoRA-merged character model.

Downloading is an explicit user action. Preparing speech, starting the app or selecting an engine never starts a production model download. The downloader contains no Python installation, native runtime installation, package execution or GPU initialization. Models can be downloaded before a runtime is connected; speaking still requires the separately verified native runtime and any required interpreter. The Qwen installer returns only a model path for the separate GGUF configuration. It cannot overwrite the existing PyTorch configuration or silently install a runtime.

Downloads use fixed revision URLs and require enough space for remaining bytes plus a 256 MiB reserve. Cancel drains the writer while retaining the partial file. An explicit retry sends the exact remaining HTTP Range; an ignored Range response replaces the partial stream from byte zero. Access errors and invalid ranges fail visibly. Every complete file must match its pinned size and full SHA256 and have a GGUF header. Only the verified whole directory is atomically published. Initialization detects receipts and sizes without network requests; full SHA256 verification remains required before use. An existing altered installation is preserved and rejected, rather than silently replaced.

App-owned public models have a fingerprinted ownership receipt and a model receipt. Managed removal previews only that catalog's model directory and interrupted download directory, requires a fresh unchanged plan token, rejects links and unknown files, and uses the OS trash callback. Runtime/Python folders, imported WAV references, character packs, private merged derivatives and externally selected models are outside this removal scope. Cancelled or failed downloads can be retried or explicitly removed through this same guarded model-management flow.

Qwen uses a separately imported reference WAV (and its transcript for ICL); it cannot apply VoxCPM2 LoRA weights. Downloading the public Vox base model also does not apply a character's trained adapter. Keeping a trained Vox voice requires its separately admitted merged model pair. Original packs and training weights are never migrated or overwritten by these downloads.

The catalog is source code and ships with the app; model weights remain external. Preserve upstream model licenses and runtime notices when distributing runtimes separately. CUDA/Vulkan and actual voice quality are independent runtime validation results, not claims established by successful model download.
