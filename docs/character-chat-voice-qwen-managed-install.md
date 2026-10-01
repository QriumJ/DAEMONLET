# Managed Qwen installation

The explicit **Download, install and apply Qwen** button installs both the model and its Python/runtime dependencies in the app's `voice/qwen-managed` directory. It does not use global Python/pip/PATH or invoke the development setup scripts. Version remains 0.8.3. Vox stays the default until the user selects/applies Qwen.

| Platform | Pinned model | Model bytes | Python + packages bytes | Total download bytes | Minimum free space |
| --- | --- | ---: | ---: | ---: | ---: |
| Apple Silicon | mlx-community/Qwen3-TTS-12Hz-0.6B-Base-4bit, 0d6bb6fe33f92d47a507e23b9148940e8366ab5b | 1,711,328,624 | 150,911,760 | 1,862,240,384 | 8 GiB |
| Windows x64 | Qwen/Qwen3-TTS-12Hz-0.6B-Base, 5d83992436eae1d760afd27aff78a71d676296fc | 2,516,106,051 | 3,695,031,909 | 6,211,137,960 | 30 GiB |

Mac uses the community MLX 4-bit conversion, not official Qwen PyTorch weights. The pinned model cards declare Apache-2.0. MLX packages are MIT; Windows uses official Qwen/PyTorch packages. Python is the pinned [Astral python-build-standalone 20260610](https://github.com/astral-sh/python-build-standalone/releases/tag/20260610) distribution: 3.12.13 ARM64 Mac / 3.11.15 x64 Windows. Original Python and wheel license files are retained. Package URL/size/hash/version/license metadata is in `install-qwen-<platform>.json`; model and core source contracts remain in the existing Qwen policies.

## Install/apply behavior

The UI reports download, environment preparation, verification and registration. Cancellation waits for the owned installer process to close before cleaning its unique stage. Verified downloads and partial files are reusable on explicit retry. A healthy existing managed bundle can be applied without downloading; a damaged bundle offers repair. Previously connected regular local model files can be reused only after their full pinned hashes match. External experiment environments/models are never moved, rewritten or removed.

Successful registration selects Qwen and saves its Python/model paths. Existing authorized compatible WAV bindings remain selected. Missing/incompatible references require explicit user selection; the installer neither supplies another speaker nor assumes permission. Installation never loads a model, prewarms, synthesizes, opens a chat, or changes account/keys. Current volume/enabled/automatic-read settings are preserved. Future user-requested speech follows the existing voice settings.

Failure/cancellation preserves existing engine, runtime and references. An obsolete settings owner or a newer engine/runtime choice defers registration while retaining the finished managed install. Reopening settings exposes **Apply installed Qwen**. App shutdown cancels its installation. Qwen selection hides Vox-only installation and generic Vox connection controls.

## Boundaries and verification

A single bundle containing portable Python, copied venv and exact model files is staged and atomically renamed. The former managed bundle remains a recovery copy; publication failure/cancellation restores it. No package install hooks, pip resolver, external SoX executable, driver or credential setup runs. The package set is installed offline from pinned PyPI/PyTorch wheels and checked against package versions/core source hashes.

Model hashes are mandatory at installation. All portable-Python archive paths, checksums, expansion/count bounds, duplicate names and file types are checked. Only pinned vendor-relative internal bootstrap links are allowed, created after files; wheels/models/pre-existing managed roots reject links/junctions/escapes. Before executing an existing environment, portable Python/stdlib is compared with the SHA-verified vendor archive, the venv configuration/interpreter are verified, and `-S` bootstrap Python compares every installed package byte with its pinned wheel without running target site initialization. The normal receipt/source/dependency verifier then runs. Daily inference retains the existing full/installed model preparation policy.

Regression tests cover Mac/Windows filesystem/download mocks, cancellation admission and child drain, corruption/disk failures, rollback, reference preservation, obsolete settings owners and engine switches, UI progress/cancellation, installed/repair/retry states and production settings IPC. Native Windows execution and full production packaging must be reported separately from platform mocks. Models/runtime/test evidence stay out of Git; public release/push and user app replacement are separate actions.
