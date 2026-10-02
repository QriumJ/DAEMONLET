"""Reviewed Windows VoxCPM2 build driver. Execute only after action-time approval.

No downloads or installation. The source tree and runtime are immutable inputs.
All generated files live in a new caller-selected private output directory.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parent


def sha(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(4 * 1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def tree_identity(root):
    digest = hashlib.sha256()
    count = total = 0
    for path in sorted(root.rglob('*'), key=lambda p: p.relative_to(root).as_posix()):
        if path.is_symlink():
            raise ValueError('SOURCE_LINK')
        if not path.is_file():
            continue
        name = path.relative_to(root).as_posix()
        size = path.stat().st_size
        digest.update((name + '\0' + str(size) + '\0' + sha(path) + '\n').encode())
        count += 1
        total += size
    return digest.hexdigest(), count, total


def cached_source(source):
    # Same exact-key owner-thread cache recipe as the admitted Mac reference path;
    # Windows compilation uses a private copy and reports the actual build count.
    declaration = '''// Daemonlet: one immutable reference cache on the inference owner thread.
struct DaemonletReferenceCache {
    const VoxCPM2Runtime * owner = nullptr;
    int sample_rate = 0;
    std::vector<float> waveform;
    std::vector<float> features;
    size_t builds = 0;
};
thread_local DaemonletReferenceCache daemonlet_reference;
'''
    if 'daemonlet_reference' in source or source.count('namespace {\n') < 1:
        raise ValueError('RUNTIME_SOURCE_CHANGED')
    source = source.replace('namespace {\n', 'namespace {\n' + declaration, 1)
    start = source.index('std::vector<float> VoxCPM2Runtime::encode_reference_audio(')
    end = source.index('std::vector<int32_t> VoxCPM2Runtime::expand_multichar_cjk_tokens', start)
    function = source[start:end]
    before = '    std::vector<float> audio = resample_mono_linear(reference_wav, actual_sample_rate, audio_vae.config.sample_rate);'
    after = '''    if (daemonlet_reference.owner == this && daemonlet_reference.sample_rate == actual_sample_rate &&
        daemonlet_reference.waveform == reference_wav && !daemonlet_reference.features.empty()) {
        return daemonlet_reference.features;
    }
''' + before
    if function.count(before) != 1:
        raise ValueError('RUNTIME_SOURCE_CHANGED')
    function = function.replace(before, after)
    before = '    ggml_gallocr_free(galloc);\n    return result;'
    after = '''    ggml_gallocr_free(galloc);
    if (!result.empty()) {
        daemonlet_reference.owner = this;
        daemonlet_reference.sample_rate = actual_sample_rate;
        daemonlet_reference.waveform = reference_wav;
        daemonlet_reference.features = result;
        ++daemonlet_reference.builds;
    }
    return result;'''
    if function.count(before) != 1:
        raise ValueError('RUNTIME_SOURCE_CHANGED')
    source = source[:start] + function.replace(before, after) + source[end:]
    before = 'void VoxCPM2Runtime::free() {\n'
    if source.count(before) != 1:
        raise ValueError('RUNTIME_SOURCE_CHANGED')
    return source.replace(before, before + '    if (daemonlet_reference.owner == this) daemonlet_reference = {};\n') + '\nextern "C" size_t daemonlet_reference_cache_builds(const VoxCPM2Runtime* owner) { return daemonlet_reference.owner == owner ? daemonlet_reference.builds : 0; }\n'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--cmake', type=Path, required=True)
    parser.add_argument('--backend', choices=['CUDA', 'Vulkan'], default='CUDA')
    args = parser.parse_args()
    if sys.platform != 'win32' or sys.maxsize <= 2**32:
        parser.error('Windows x64 is required')
    source, output, cmake = (p.resolve() for p in (args.source, args.output, args.cmake))
    if output.exists() or not source.is_dir() or not cmake.is_file():
        parser.error('Use an existing pinned source and CMake, and a new private output')
    checkout = ROOT.parents[2]
    if output == source or source in output.parents or output in source.parents or output == checkout or checkout in output.parents:
        parser.error('Output must be separate from source and product files')
    lock = json.loads((ROOT / 'source-lock.json').read_text(encoding='utf-8'))
    if tree_identity(source) != (lock['sourceTreeSha256'], lock['sourceFileCount'], lock['sourceExpandedBytes']):
        raise ValueError('SOURCE_CHANGED')
    original = source / 'tools/omni/voxcpm2/voxcpm2_runtime.cpp'
    if sha(original) != lock['originalRuntimeSha256']:
        raise ValueError('RUNTIME_SOURCE_CHANGED')
    output.mkdir()
    patched = output / 'voxcpm2_runtime.cpp'
    patched.write_text(cached_source(original.read_text(encoding='utf-8')), encoding='utf-8', newline='\n')
    if sha(patched) != lock['cachedRuntimeSha256']:
        raise ValueError('CACHE_RECIPE_CHANGED')
    build = output / 'build'
    configure = [str(cmake), '-S', str(ROOT), '-B', str(build), '-G', 'Visual Studio 17 2022', '-A', 'x64',
                 '-DVOX_SOURCE=' + source.as_posix(), '-DVOX_CACHED_RUNTIME=' + patched.as_posix(), '-DVOX_BACKEND=' + args.backend]
    compile_command = [str(cmake), '--build', str(build), '--config', 'Release',
                       '--target', 'daemonlet-voxcpm2-engine', '--parallel', '4']
    environment = {**os.environ, 'HF_HUB_OFFLINE': '1', 'TRANSFORMERS_OFFLINE': '1'}
    with (output / 'build.log').open('w', encoding='utf-8') as log:
        subprocess.run(configure, check=True, stdout=log, stderr=subprocess.STDOUT, env=environment)
        subprocess.run(compile_command, check=True, stdout=log, stderr=subprocess.STDOUT, env=environment)
    binaries = sorted((build / 'bin' / 'Release').glob('*'))
    if not any(path.name == 'daemonlet-voxcpm2-engine.exe' for path in binaries):
        raise ValueError('BUILD_OUTPUT')
    (output / 'licenses').mkdir()
    shutil.copyfile(source / 'LICENSE', output / 'licenses' / 'llama-cpp-MIT.txt')
    receipt = dict(schemaVersion=1, experimental=True, sourceCommit=lock['sourceCommit'],
                   sourceTreeSha256=lock['sourceTreeSha256'], backend=args.backend,
                   originalRuntimeSha256=sha(original), cachedRuntimeSha256=sha(patched),
                   nativeSourceSha256=sha(ROOT / 'native_worker.cpp'),
                   buildDriverSha256=sha(Path(__file__)), cmakeSourceSha256=sha(ROOT / 'CMakeLists.txt'),
                   seedContractSha256=sha(ROOT.parent / 'seed_contract.h'),
                   configureCommand=configure, buildCommand=compile_command,
                   nativeFiles={p.name: dict(bytes=p.stat().st_size, sha256=sha(p)) for p in binaries if p.is_file()})
    (output / 'native-build.json').write_text(json.dumps(receipt, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'status': 'BUILT_NOT_EXECUTED', 'backend': args.backend, 'sourceCommit': lock['sourceCommit']}))


if __name__ == '__main__':
    main()
