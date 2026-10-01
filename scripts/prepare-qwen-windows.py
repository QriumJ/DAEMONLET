"""Explicit opt-in installer. Only a fresh, isolated Windows venv; never touches Vox.
Run with the new venv Python and --root pointing to its adjacent experiment folder.
"""
import argparse
import hashlib
import importlib.metadata as metadata
import json
import os
from pathlib import Path
import subprocess
import sys
import urllib.request

SOURCE = Path(__file__).resolve().parents[1]
POLICY = json.loads((SOURCE/'electron/voice/qwen-policy.json').read_text())

def digest(path):
    h=hashlib.sha256()
    with path.open('rb') as f:
        for chunk in iter(lambda:f.read(8*1024*1024),b''):h.update(chunk)
    return h.hexdigest()

def main():
    p=argparse.ArgumentParser();p.add_argument('--root',required=True);args=p.parse_args()
    root=Path(args.root).resolve();env=root/'runtime/env'
    if sys.platform!='win32' or Path(sys.prefix).resolve()!=env or sys.prefix==sys.base_prefix:
        raise ValueError('ISOLATED_VENV_REQUIRED')
    evidence=root/'evidence';evidence.mkdir(exist_ok=True)
    os.environ.update(PIP_CACHE_DIR=str(root/'cache/pip'),HF_HOME=str(root/'cache/hf'),TEMP=str(root/'cache'),TMP=str(root/'cache'),PYTHONUTF8='1')
    def pip(*args):
        subprocess.run([sys.executable,'-m','pip',*args],check=True,stdout=sys.stdout,stderr=sys.stderr)
    # Official Windows CUDA wheel pair; do not change the installed Vox runtime.
    try: torch_ready=all(metadata.version(k)==POLICY['dependencies'][k] for k in ('torch','torchaudio'))
    except metadata.PackageNotFoundError: torch_ready=False
    if not torch_ready: pip('install','torch==2.8.0','torchaudio==2.8.0','--index-url','https://download.pytorch.org/whl/cu128','--only-binary=:all:','--report',str(evidence/'pip-torch.json'))
    constraints=root/'runtime/constraints.txt'
    constraints.write_text('\n'.join(f'{k}=={v}' for k,v in POLICY['dependencies'].items())+'\n')
    pip('install','qwen-tts==0.1.1','--index-url','https://pypi.org/simple','--prefer-binary','--constraint',str(constraints),'--report',str(evidence/'pip-qwen.json'))
    pip('check')
    model=root/'models/Qwen3-TTS-12Hz-0.6B-Base';model.mkdir(exist_ok=True)
    records=[]
    assert sum(f['bytes'] for f in POLICY['files'].values())==POLICY['totalBytes']
    for name,expected in POLICY['files'].items():
        path=model/name;path.parent.mkdir(parents=True,exist_ok=True)
        url=f"https://huggingface.co/{POLICY['model']}/resolve/{POLICY['revision']}/{name}"
        if not path.exists():
            part=path.with_suffix(path.suffix+'.part')
            print('download',name,expected['bytes'],flush=True)
            with urllib.request.urlopen(url,timeout=90) as response,part.open('wb') as out:
                while chunk:=response.read(8*1024*1024):out.write(chunk)
            part.replace(path)
        if path.stat().st_size!=expected['bytes']:raise ValueError('MODEL_SIZE')
        sha=digest(path)
        if 'sha256' in expected:
            if sha!=expected['sha256']:raise ValueError('MODEL_HASH')
        else:
            b=path.read_bytes()
            if hashlib.sha1(b'blob '+str(len(b)).encode()+b'\0'+b).hexdigest()!=expected['gitSha1']:raise ValueError('MODEL_HASH')
        records.append(dict(name=name,bytes=path.stat().st_size,sha256=sha,url=url,license=POLICY['license']))
    packages=[]
    for dist in metadata.distributions():
        m=dist.metadata
        packages.append(dict(name=m['Name'],version=dist.version,license=m.get('License-Expression') or m.get('License'),classifiers=m.get_all('Classifier',[]),files=len(dist.files or [])))
    sources=[]
    qwen_root=Path(metadata.distribution('qwen-tts').locate_file('qwen_tts'))
    for name,expected in POLICY['sourceFiles'].items():
        path=qwen_root/name
        if digest(path)!=expected:raise ValueError('QWEN_SOURCE_HASH')
        sources.append(dict(name=name,sha256=expected))
    receipt=dict(schemaVersion=1,engine=POLICY['engine'],revision=POLICY['revision'],python=sys.version,prefix=str(env),model=str(model),modelFiles=records,packages=packages,sourceFiles=sources,downloads=[])
    for report in ('pip-torch.json','pip-qwen.json'):
        data=json.loads((evidence/report).read_text())
        for item in data['install']:
            receipt['downloads'].append(dict(name=item['metadata']['name'],version=item['metadata']['version'],url=item['download_info']['url'],hashes=item['download_info']['archive_info'].get('hashes',{}),license=item['metadata'].get('license'),bytes=int(urllib.request.urlopen(urllib.request.Request(item['download_info']['url'],method='HEAD'),timeout=60).headers.get('Content-Length',0))))
    # Both archive URL/hash records and installed file manifests are evidence, not telemetry.
    receipt['installedFiles']=[dict(path=str(x.relative_to(env)).replace('\\','/'),bytes=x.stat().st_size,sha256=digest(x)) for x in env.rglob('*') if x.is_file() and x.suffix!='.pyc' and x.name!='qwen-runtime.json']
    (env/'qwen-runtime.json').write_text(json.dumps(receipt,indent=2),encoding='utf-8')
    (evidence/'installation-manifest.json').write_text(json.dumps(receipt,indent=2),encoding='utf-8')
    print('INSTALL_COMPLETE',flush=True)

if __name__=='__main__':main()
