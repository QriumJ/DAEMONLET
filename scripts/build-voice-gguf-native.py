"""Build the pinned engine plus an exact-key, owner-thread reference feature cache.

Only a private runtime.cpp copy is patched. Upstream checkout remains unchanged.
The caller reviews/pins the resulting build receipt before installing it.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shlex
import shutil
import subprocess
ROOT=Path(__file__).resolve().parents[1]
PIN='873056743b74e1a4ce5dcf7290e2298428e214db'


def cached_source(source):
    declaration='''// Daemonlet: one immutable reference cache on the inference owner thread.
struct DaemonletReferenceCache {
    const VoxCPM2Runtime * owner = nullptr;
    int sample_rate = 0;
    std::vector<float> waveform;
    std::vector<float> features;
};
thread_local DaemonletReferenceCache daemonlet_reference;
'''
    assert source.count('namespace {\n')>=1
    source=source.replace('namespace {\n','namespace {\n'+declaration,1)
    start=source.index('std::vector<float> VoxCPM2Runtime::encode_reference_audio(')
    end=source.index('std::vector<int32_t> VoxCPM2Runtime::expand_multichar_cjk_tokens',start)
    function=source[start:end]
    before='    std::vector<float> audio = resample_mono_linear(reference_wav, actual_sample_rate, audio_vae.config.sample_rate);'
    after='''    if (daemonlet_reference.owner == this && daemonlet_reference.sample_rate == actual_sample_rate &&
        daemonlet_reference.waveform == reference_wav && !daemonlet_reference.features.empty()) {
        return daemonlet_reference.features;
    }
'''+before
    assert function.count(before)==1;function=function.replace(before,after)
    before='    ggml_gallocr_free(galloc);\n    return result;'
    after='''    ggml_gallocr_free(galloc);
    if (!result.empty()) {
        daemonlet_reference.owner = this;
        daemonlet_reference.sample_rate = actual_sample_rate;
        daemonlet_reference.waveform = reference_wav;
        daemonlet_reference.features = result;
    }
    return result;'''
    assert function.count(before)==1;function=function.replace(before,after)
    source=source[:start]+function+source[end:]
    before='void VoxCPM2Runtime::free() {\n'
    assert source.count(before)==1
    return source.replace(before,before+'    if (daemonlet_reference.owner == this) daemonlet_reference = {};\n')


def sha(p):
    with p.open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()


def main():
    p=argparse.ArgumentParser(description=__doc__)
    for key in ['source','package','output']:p.add_argument('--'+key,required=True,type=Path)
    p.add_argument('--base',action='store_true')
    p.add_argument('--build-dir',default='build-metal')
    a=p.parse_args();source=a.source.resolve();out=a.output.resolve()
    if out.exists() or out.is_relative_to(ROOT) or out.is_relative_to(source):p.error('Use a new private output')
    assert subprocess.check_output(['git','-C',str(source),'rev-parse','HEAD'],text=True).strip()==PIN
    assert not subprocess.check_output(['git','-C',str(source),'diff','HEAD'],text=True)
    out.mkdir(parents=True);cmake=source/a.build_dir/'tools/omni'
    defaults=ROOT/'electron/voice/base-voice-defaults.json'
    if a.base:
        voice=json.loads(defaults.read_text())
        (out/'base_voice_defaults.h').write_text('static constexpr const char* BASE_VOICE_DESCRIPTION = '+json.dumps(voice['description'])+';\nstatic constexpr int BASE_VOICE_SEED = '+str(voice['seed'])+';\n')
    original=source/'tools/omni/voxcpm2/voxcpm2_runtime.cpp';patched=out/'voxcpm2_runtime.cpp';patched.write_text(cached_source(original.read_text()))
    def compile(source_file,target,obj):
        flags=(cmake/f'CMakeFiles/{target}.dir/flags.make').read_text();includes=next(l.split(' = ',1)[1] for l in flags.splitlines() if l.startswith('CXX_INCLUDES = '))
        subprocess.run(['/usr/bin/c++','-O3','-DNDEBUG','-std=c++17','-arch','arm64','-mmacosx-version-min=13.0',*shlex.split(includes),'-I',str(out),'-c',str(source_file),'-o',str(obj)],check=True)
    compile(patched,'voxcpm2_runtime',out/'runtime.o');worker_source=ROOT/('electron/voice/native_base_worker.cpp' if a.base else 'electron/voice/native_worker.cpp');compile(worker_source,'voxcpm2-cli',out/'worker.o')
    link=shlex.split((cmake/'CMakeFiles/voxcpm2-cli.dir/link.txt').read_text());link[link.index('CMakeFiles/voxcpm2-cli.dir/voxcpm2/voxcpm2_cli.cpp.o')]=str(out/'worker.o');link[link.index('libvoxcpm2_runtime.a')]=str(out/'runtime.o');link[link.index('-o')+1]=str(out/'daemonlet-voice-engine');link=[x for x in link if not ('/openssl@' in x and x.endswith('.dylib'))];link.append('-Wl,-dead_strip_dylibs');subprocess.run(link,cwd=cmake,check=True)
    dependencies=subprocess.check_output(['otool','-L',str(out/'daemonlet-voice-engine')],text=True)
    if any(not line.strip().startswith(('/System/Library/','/usr/lib/')) for line in dependencies.splitlines()[1:] if line.strip()):raise ValueError('Non-system dynamic dependency')
    for name in ['ggml-metal.metal','ggml-common.h','ggml-metal-impl.h']:shutil.copyfile(source/a.build_dir/'bin'/name,out/name)
    (out/'licenses').mkdir();shutil.copyfile(source/'LICENSE',out/'licenses/llama-cpp-MIT.txt');shutil.copyfile(a.package/'VOXCPM-LICENSE',out/'licenses/VoxCPM-LICENSE')
    names=['daemonlet-voice-engine','ggml-metal.metal','ggml-common.h','ggml-metal-impl.h','licenses/llama-cpp-MIT.txt','licenses/VoxCPM-LICENSE']
    receipt=dict(seedContractSha256=sha(ROOT/'electron/voice/seed_contract.h'),sourceCommit=PIN,originalRuntimeSha256=sha(original),cachedRuntimeSha256=sha(patched),nativeSourceSha256=sha(worker_source),cacheRecipeSha256=sha(Path(__file__)),nativeFiles={'native/'+name:sha(out/name) for name in names},dynamicLibraries=dependencies)
    if a.base:receipt['baseVoiceDefaultsSha256']=sha(defaults)
    (out/'native-build.json').write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps({k:v for k,v in receipt.items() if k!='dynamicLibraries'}))

if __name__=='__main__':main()
