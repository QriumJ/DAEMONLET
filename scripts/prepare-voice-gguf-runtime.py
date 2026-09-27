"""Install an already approved native build into a NEW isolated stdlib-only venv.

No pip, network, model conversion, source modification or existing-env update.
The shipped runtime policy pins native resources and offline conversion sources.
"""
import argparse
import json
from pathlib import Path
import shutil
import subprocess
import sys
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'electron/voice'))
from worker import sha, read_json, inside


def main():
    p=argparse.ArgumentParser(description=__doc__)
    for key in ['python','native','converter-source','converter-python','destination']:p.add_argument('--'+key,required=True,type=Path)
    a=p.parse_args();dst=a.destination.resolve();native=a.native.resolve();source=a.converter_source.resolve()
    if dst.exists() or dst.is_relative_to(ROOT) or any(dst.is_relative_to(x) or x.is_relative_to(dst) for x in [native,source,a.converter_python.resolve()]):p.error('Use a new private directory outside inputs/Git')
    policy_path=ROOT/'electron/voice/runtime-gguf-macos.json';policy=read_json(policy_path)
    if sha(ROOT/'electron/voice/native_worker.cpp')!=policy['nativeSourceSha256']:raise ValueError('NATIVE_SOURCE')
    for name,digest in policy['converterFiles'].items():
        if sha(inside(source,name))!=digest:raise ValueError('CONVERTER_CHANGED')
    # Read-only validation of the previously approved full inference environment.
    check="import json,sys;from pathlib import Path;sys.path.insert(0,sys.argv[1]);from macos_runtime import verify_runtime;verify_runtime(json.loads((Path(sys.prefix)/'voice-runtime.json').read_text()));print(Path(sys.executable).resolve())"
    converter_interpreter=Path(subprocess.check_output([str(a.converter_python),'-B','-c',check,str(ROOT/'electron/voice')],text=True).strip())
    for name,digest in policy['nativeFiles'].items():
        if not name.startswith('native/') or sha(inside(native,name[7:]))!=digest:raise ValueError('NATIVE_CHANGED')
    info=json.loads(subprocess.check_output([str(a.python),'-B','-c','import json,sys,platform;print(json.dumps([sys.version_info[:3],sys.platform,platform.machine()]))'],text=True))
    if info!=[[3,11,15],'darwin','arm64']:raise ValueError('PYTHON_PLATFORM')
    subprocess.run([str(a.python),'-B','-m','venv','--without-pip','--copies',str(dst)],check=True)
    for name in policy['nativeFiles']:
        target=dst/name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(native/name[7:],target)
    for name in policy['converterFiles']:
        target=dst/'converter'/name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(source/name,target)
    (dst/'native/daemonlet-voice-engine').chmod(0o755)
    python=dst/'bin/python';interpreter=Path(subprocess.check_output([str(python),'-B','-c','import pathlib,sys;print(pathlib.Path(sys.executable).resolve())'],text=True).strip())
    receipt=dict(schemaVersion=2,profile=policy['profile'],prefix=str(dst),interpreter=str(interpreter),interpreter_sha256=sha(interpreter),sourceCommit=policy['sourceCommit'],policySha256=sha(policy_path),converterPython=str(a.converter_python.absolute()),converterInterpreter=str(converter_interpreter),converterInterpreterSha256=sha(converter_interpreter))
    (dst/'voice-runtime.json').write_text(json.dumps(receipt,indent=2)+'\n')
    print(json.dumps(dict(status='INSTALLED_NOT_INFERENCE_TESTED',profile=policy['profile'],python=str(python))))

if __name__=='__main__':main()
