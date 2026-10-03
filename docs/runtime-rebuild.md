# Windows libsndfile source rebuilding

The Windows GGUF shared component dynamically loads libsndfile 1.2.2 through
SoundFile. Ogg, Vorbis, FLAC, Opus, mpg123 and LAME are statically linked into this
DLL. Their source licenses, copyright notices and the libsndfile ALAC/GSM notices
are included in the shared archive under `licenses/codecs`. The matching source
companion is named `daemonlet-0.8.4-runtime-rebuild-source.zip`; it must accompany
the distributed runtime. The app source alone is not that complete companion.

The companion includes the exact library/codec source archives, vcpkg source and
port patches, build-tool pins, overlays, triplet and rebuild instructions. The
baseline build uses vcpkg `b322364f06308bdd24823f9d8f03fe0cc86fd46f`, VS2022
17.5.33424.131, MSVC14.35.32215, Windows SDK10.0.22000.0, CMake3.30.1 and
Ninja1.11.1. libsndfile and the CRT are dynamic; the codecs are static. Features
are `core,external-libs,mpeg`, with programs/testing/regtest disabled. The mpg123
overlay only selects the pinned standalone YASM tool. Compiler/SDK/tool use and
Microsoft/NVIDIA contracts remain the user's responsibility.

To use your modified library, build `sndfile.dll` using that recipe, then run the
offline utility against your private copy of the matching app source:

```powershell
python scripts/runtime/rebuild-libsndfile-component.py `
  --source-root <private-app-source> `
  --shared-archive <original-shared-win32-x64-v4.zip> `
  --dll <your-sndfile.dll> --output <new-empty-output-directory>
```

This utility checks the original archive and every file, replaces only the DLL,
and creates a new shared archive, catalog and two synchronized worker policies.
It never runs the replacement DLL or installs an app. Copy the three JSON files
to `electron/voice` in your private source copy. Put the new shared archive and
the five other unchanged pinned archives in
`.generated/voice-gguf-runtime/win32-x64/archives`. Remove the old shared archive
from that staging directory so its archive allowlist contains exactly six files.
Commit your private source, build the renderer and production Electron payload,
then package an unsigned private Windows app with `npm run electron:package`.
Existing pinned local-LLM resources and the matching Electron build dependency
are also required by the normal packaging workflow.

Test with a new profile and model/runtime state directory. Preserve installed
apps and existing profiles. A publisher signing key is not required for your
private unsigned Windows build. Original app builds reject changed DLL bytes;
the rebuilt app explicitly pins its modified library and retains full runtime
SHA admission. Editable external receipts do not grant trust to arbitrary DLLs.

Private library modification, source rebuilding and reverse engineering for
debugging those modifications are not restricted by additional app terms. This
does not grant access to anyone else's signing keys or waive dependency terms.
Component I/O proves loading and codec behavior. An application-path test must
separately establish that the rebuilt app's worker admission and reference/audio
paths use the modified DLL. Neither test establishes interactive desktop QA,
clean-host support, listening quality or blanket legal compliance.
