"""Install an exact offline wheel set into this NEW portable Python only."""
import argparse,hashlib,importlib.metadata as metadata,json,os,re,shutil,sys,zipfile
from pathlib import Path

def sha(p):
    with p.open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()

def lock_hashes(path):
    raw=path.read_bytes();lf=raw.replace(b'\r\n',b'\n')
    canonical=hashlib.sha256(lf).hexdigest()
    # Legacy receipts hashed checkout bytes. Accept their LF/CRLF forms only;
    # do not normalize JSON content, whitespace, or rewrite existing receipts.
    return canonical,{canonical,hashlib.sha256(raw).hexdigest(),hashlib.sha256(lf.replace(b'\n',b'\r\n')).hexdigest()}

def safe(name):
    if not name or name.startswith('/') or '\\' in name or ':' in name or any(p in ('','.','..') or p.endswith((' ','.')) or re.match(r'^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)',p,re.I) for p in name.split('/')):raise ValueError('PATH')
    return name

p=argparse.ArgumentParser();p.add_argument('--downloads',type=Path,required=True);p.add_argument('--policy',type=Path,required=True);p.add_argument('--lock',type=Path,required=True);p.add_argument('--verify',action='store_true');a=p.parse_args()
policy=json.loads(a.policy.read_text(encoding='utf-8'));lock=json.loads(a.lock.read_text(encoding='utf-8'));root=Path(sys.prefix).resolve();site=root/'Lib/site-packages';receipt=root/'voice-runtime.json'
lock_sha,compatible_lock_hashes=lock_hashes(a.lock)
if sys.platform!='win32' or sys.version.split()[0]!=policy['python']:raise ValueError('RUNTIME_VERSION')
if not a.verify:
    if receipt.exists():raise ValueError('REFUSE_EXISTING_RUNTIME')
    for wheel in lock['wheels']:
        source=a.downloads/'wheels'/safe(wheel['filename'])
        if source.stat().st_size!=wheel['bytes'] or sha(source)!=wheel['sha256']:raise ValueError('WHEEL_CHANGED')
        with zipfile.ZipFile(source) as archive:
            if len(archive.infolist())>100000 or sum(f.file_size for f in archive.infolist())>12*1024**3:raise ValueError('WHEEL_LIMIT')
            for info in archive.infolist():
                if info.is_dir():continue
                name=safe(info.filename)
                if (info.external_attr>>16)&0o170000==0o120000:raise ValueError('WHEEL_LINK')
                parts=name.split('/')
                if parts[0].endswith('.data'):
                    if len(parts)<3:raise ValueError('WHEEL_PATH')
                    if parts[1] in ('purelib','platlib'):name='/'.join(parts[2:])
                    elif parts[1] in ('scripts','headers','data'):continue
                    else:raise ValueError('WHEEL_DATA')
                target=site/safe(name);target.parent.mkdir(parents=True,exist_ok=True)
                if not target.resolve().is_relative_to(site):raise ValueError('WHEEL_PATH')
                with archive.open(info) as src,target.open('wb') as out:shutil.copyfileobj(src,out)
    source_files={}
    for name,digest in policy['sourceFiles'].items():
        data=(a.downloads/'source'/safe(name)).read_bytes()
        if hashlib.sha256(data.replace(b'\r\n',b'\n')).hexdigest()!=digest:raise ValueError('RUNTIME_SOURCE_CHANGED')
        target=site/'voxcpm'/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(data);source_files[name]=sha(target)
    receipt.write_text(json.dumps(dict(schemaVersion=1,source_commit=policy['sourceCommit'],python=policy['python'],dependencies=policy['dependencies'],source_files=source_files,installLockSha256=lock_sha),indent=2),encoding='utf-8')
saved=json.loads(receipt.read_text(encoding='utf-8'))
if saved.get('source_commit')!=policy['sourceCommit'] or saved.get('installLockSha256') not in compatible_lock_hashes:raise ValueError('RUNTIME_RECEIPT')
for name,digest in policy['sourceFiles'].items():
    target=site/'voxcpm'/safe(name)
    if target.is_symlink() or not target.resolve().is_relative_to(site) or hashlib.sha256(target.read_bytes().replace(b'\r\n',b'\n')).hexdigest()!=digest:raise ValueError('RUNTIME_SOURCE_CHANGED')
for name,version in policy['dependencies'].items():
    if metadata.version(name)!=version:raise ValueError('RUNTIME_VERSION:'+name)
import torch,torchaudio,voxcpm,triton
if torch.__version__!='2.8.0+cu128' or not triton.__version__.startswith('3.4.'):raise ValueError('RUNTIME_IMPORT')
print(json.dumps(dict(status='PASS',python=sys.version.split()[0],torch=torch.__version__,triton=triton.__version__,dependencies=len(policy['dependencies']))))
