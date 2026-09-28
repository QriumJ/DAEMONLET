"""Build/run a bounded diagnostic against the approved external Metal checkout.

Requires the native runtime already built with CMake's Unix Makefiles generator.
Never installs dependencies, downloads weights, or changes an application profile.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
CPP_SOURCE = '873056743b74e1a4ce5dcf7290e2298428e214db'
REFERENCE = '171296e4a9138fc118c4d858ce350fccff530477ef3d3ef1fc85e8c22d9ccb40'
ADAPTER = 'e7d8b3b99af702c3df135ef194596c2b13cf99bb00b8e7204f684c435be50eb2'


def sha(path):
    with path.open('rb') as f:
        return hashlib.file_digest(f, 'sha256').hexdigest()


def main():
    if sys.flags.optimize:
        raise RuntimeError("Run without -O: diagnostic validation must remain enabled")
    parser = argparse.ArgumentParser(description=__doc__)
    for key in ['source', 'converted', 'reference', 'output']:
        parser.add_argument('--'+key, required=True, type=Path)
    args = parser.parse_args()
    source, converted, reference, output = [getattr(args, k).resolve() for k in ['source', 'converted', 'reference', 'output']]
    if output.exists() or output.is_relative_to(ROOT) or any(output.is_relative_to(p) or p.is_relative_to(output) for p in [source, converted, reference.parent]):
        parser.error('Use a new private output outside the repository and inputs')
    assert subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip() == CPP_SOURCE
    assert not subprocess.check_output(['git', '-C', str(source), 'diff', 'HEAD'], text=True)
    manifest = json.loads((converted/'conversion.json').read_text())
    assert manifest['status'] == 'PASS_CONVERSION_ONLY' and manifest['sourceCommit'] == CPP_SOURCE
    assert manifest['adapterSha256'] == ADAPTER and manifest['adapterKeys'] == 384 and manifest['mergedMatrices'] == 192 and manifest['mergeCount'] == 1
    for name, digest in manifest['ggufFiles'].items():
        assert Path(name).name == name and sha(converted/'gguf'/name) == digest
    assert sha(reference) == REFERENCE
    build = source/'build-metal'
    cmake = build/'tools/omni'
    flags = (cmake/'CMakeFiles/voxcpm2-cli.dir/flags.make').read_text()
    includes = next(line.split(' = ', 1)[1] for line in flags.splitlines() if line.startswith('CXX_INCLUDES = '))
    output.mkdir(parents=True)
    obj = output/'probe.o'
    # Metal's runtime compiler resolves headers beside the executable.
    binary = build/'bin/daemonlet-voice-probe'
    with (output/'build.log').open('w') as log:
        subprocess.run(['/usr/bin/c++', '-O3', '-DNDEBUG', '-std=c++17', '-arch', 'arm64', *shlex.split(includes), '-c', str(ROOT/'scripts/probe-voice-gguf.cpp'), '-o', str(obj)], check=True, stdout=log, stderr=subprocess.STDOUT)
        link = shlex.split((cmake/'CMakeFiles/voxcpm2-cli.dir/link.txt').read_text())
        link[link.index('CMakeFiles/voxcpm2-cli.dir/voxcpm2/voxcpm2_cli.cpp.o')] = str(obj)
        link[link.index('-o')+1] = str(binary)
        subprocess.run(link, cwd=cmake, check=True, stdout=log, stderr=subprocess.STDOUT)
    dtype = manifest.get('ggufDtype', 'f32').upper()
    command = [str(binary), str(converted/'gguf'/f'VoxCPM2-BaseLM-{dtype}.gguf'), str(converted/'gguf'/f'VoxCPM2-Acoustic-{dtype}.gguf'), str(reference), str(output/'samples')]
    environment = os.environ.copy()
    environment.pop('GGML_METAL_PATH_RESOURCES', None)
    start = time.monotonic()
    with (output/'runtime.log').open('w') as log:
        try:
            code = subprocess.run(command, env=environment, stdout=log, stderr=subprocess.STDOUT, timeout=240).returncode
        except subprocess.TimeoutExpired:
            code = 'TIMEOUT'
    runtime_log = (output/'runtime.log').read_text(errors='replace')
    metal = 'custom component backend=MTL0' in runtime_log and 'offloaded 29/29 layers to GPU' in runtime_log and 'falling back to CPU' not in runtime_log
    result = dict(returncode=code, wallSeconds=time.monotonic()-start, metalVerified=metal, binarySha256=sha(binary), probeSourceSha256=sha(ROOT/'scripts/probe-voice-gguf.cpp'), converterManifestSha256=sha(converted/'conversion.json'), referenceSha256=REFERENCE, sourceCommit=CPP_SOURCE, appIntegration='NOT_TESTED', listening='NOT_TESTED')
    result['wavSha256'] = {p.name:sha(p) for p in (output/'samples').glob('*.wav')}
    (output/'result.json').write_text(json.dumps(result, indent=2)+'\n')
    print(json.dumps(result))
    if code != 0 or not metal:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
