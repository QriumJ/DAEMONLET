# Original managed Windows voice runtime terms

The original files are retained without edits. `.txt` files are formatting-only
copies for systems without an RTF/DOCX viewer; consult the original for document
layout and numbering. The adjacent `managed-runtime-terms.json` identifies the
original/text SHA-256 hashes and the exact Microsoft DLL paths and hashes.

* Visual C++ V14 14.51.36247.0: the original Microsoft redistributable EXE
  (SHA-256 `843068991daaa1f73ad9f6239bce4d0f6a07a51f18c37ea2a867e9beca71295c`)
  names `https://aka.ms/VCRedistLicense` as its license URL. The DOCX was obtained
  from the linked official page on 2026-10-03:
  https://visualstudio.microsoft.com/wp-content/uploads/2025/10/Visual-C-V14-License-Redistributable_and_Runtime_ENU.docx .
  The text copy preserves the original paragraph text; formatting and automatic
  list numbering are provided in the original DOCX. These terms apply to the
  six copies of the four pinned Microsoft DLLs in `vc` and `python`.
* Visual C++ 2015–2022 14.40.33810.0: the original English and Korean RTFs were
  extracted as inert data from the official Microsoft redistributable EXE,
  SHA-256 `3642e3f95d50cc193e4b5a0b0ffbf7fe2c08801517758b4c8aeb7105a091208a`.
  Original URL:
  https://download.visualstudio.microsoft.com/download/pr/1754ea58-11a6-44ab-a262-696e194ce543/3642E3F95D50CC193E4B5A0B0FFBF7FE2C08801517758B4C8AEB7105A091208A/VC_redist.x64.exe .
  These terms concern the pinned DLL supplied inside the NumPy wheel.
* `CUDA-13.0-EULA.txt` is the original NVIDIA CUDA/cuBLAS redistributable
  license text, also included in the pinned CUDA archive. It is provided as a
  separate notice. Official reference:
  https://docs.nvidia.com/cuda/archive/13.0.0/eula/index.html .

The Microsoft acceptance in the application concerns installing and using the
identified Microsoft runtime files. It does not accept the Visual Studio
developer-tool license for the user or create redistribution rights. The
distributor's Microsoft and NVIDIA distribution obligations are separate.
DAEMONLET's MIT license and separate component licenses, including LGPL rights,
remain applicable to their respective source and components.
