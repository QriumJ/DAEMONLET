"""Exact offline Qwen wheels, receipt verification and managed venv relocation.
No pip, package hooks, network, model load, synthesis, or global environment edits.
"""
import argparse,hashlib,importlib.metadata as metadata,json,os,re,shutil,stat,sys,sysconfig,zipfile
from pathlib import Path

def sha(p):
    with p.open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()

def safe(name):
    if not name or len(name)>240 or '\\' in name or ':' in name or name.startswith('/') or any(ord(c)<32 for c in name) or any(x in ('','.','..') or x.endswith((' ','.')) or re.match(r'^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)',x,re.I) for x in name.split('/')):raise ValueError('QWEN_ARCHIVE_PATH')
    return name

def ordinary(p):
    for parent in (p,*p.parents):
        s=parent.lstat()
        if stat.S_ISLNK(s.st_mode) or getattr(s,'st_file_attributes',0)&0x400:raise ValueError('QWEN_INSTALL_CHANGED')

def validate_packages(policy,lock):
    from packaging.requirements import Requirement
    for name,version in {**{f['name']:f['version'] for f in lock['wheels']},**policy['dependencies']}.items():
        if metadata.version(name)!=version:raise ValueError('QWEN_RUNTIME_VERSION')
    for wheel in lock['wheels']:
        for spec in metadata.requires(wheel['name']) or []:
            req=Requirement(spec)
            if req.marker and not req.marker.evaluate({'extra':''}):continue
            if not req.specifier.contains(metadata.version(req.name),prereleases=True):raise ValueError('QWEN_RUNTIME_VERSION')
    package=Path(metadata.distribution('mlx-audio' if sys.platform=='darwin' else 'qwen-tts').locate_file('mlx_audio' if sys.platform=='darwin' else 'qwen_tts'))
    for name,digest in policy['sourceFiles'].items():
        p=package/safe(name);ordinary(p)
        if sha(p)!=digest:raise ValueError('QWEN_RUNTIME_CHANGED')
    if {str(p.relative_to(package)).replace('\\','/') for p in package.rglob('*.py')}!=set(policy['sourceFiles']):raise ValueError('QWEN_RUNTIME_CHANGED')

def install(env,downloads,lock,verify=False):
    site=(env/('lib/python'+lock['python']['version'].rsplit('.',1)[0]+'/site-packages' if sys.platform=='darwin' else 'Lib/site-packages')) if verify else Path(sysconfig.get_path('purelib'));ordinary(site)
    targets=set();expanded=0;entries=0
    for wheel in lock['wheels']:
        source=downloads/'wheels'/safe(wheel['filename']);ordinary(source)
        if source.stat().st_size!=wheel['bytes'] or sha(source)!=wheel['sha256']:raise ValueError('QWEN_INSTALL_CHANGED')
        with zipfile.ZipFile(source) as archive:
            for item in archive.infolist():
                entries+=1;expanded+=item.file_size
                if entries>350000 or expanded>20*1024**3 or item.file_size>12*1024**3:raise ValueError('QWEN_ARCHIVE_LIMIT')
                name=safe(item.filename.rstrip('/'))
                if (item.external_attr>>16)&0o170000==stat.S_IFLNK:raise ValueError('QWEN_ARCHIVE_PATH')
                if item.is_dir():continue
                parts=name.split('/')
                if parts[0].endswith('.data'):
                    if len(parts)<3:raise ValueError('QWEN_ARCHIVE_PATH')
                    if parts[1] in ('purelib','platlib'):name=safe('/'.join(parts[2:]))
                    elif parts[1] in ('scripts','headers','data'):continue
                    else:raise ValueError('QWEN_ARCHIVE_PATH')
                if name.casefold() in targets:raise ValueError('QWEN_ARCHIVE_PATH')
                targets.add(name.casefold());target=site/name
                if verify:
                    ordinary(target)
                    with archive.open(item) as src:expected=hashlib.file_digest(src,'sha256').hexdigest()
                    if target.stat().st_size!=item.file_size or sha(target)!=expected:raise ValueError('QWEN_RUNTIME_CHANGED')
                else:
                    target.parent.mkdir(parents=True,exist_ok=True);ordinary(target.parent)
                    with archive.open(item) as src,target.open('xb') as out:shutil.copyfileobj(src,out,1024*1024)
    if verify:
        for p in site.rglob('*'):
            ordinary(p)
            if p.is_file() and str(p.relative_to(site)).replace('\\','/').casefold() not in targets:raise ValueError('QWEN_RUNTIME_CHANGED')

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--policy',type=Path,required=True);parser.add_argument('--lock',type=Path,required=True);parser.add_argument('--downloads',type=Path);parser.add_argument('--final-env',type=Path);parser.add_argument('--final-python',type=Path);parser.add_argument('--model',type=Path);parser.add_argument('--verify',action='store_true');parser.add_argument('--audit-env',type=Path);args=parser.parse_args()
    env=Path(sys.prefix);ordinary(env);policy=json.loads(args.policy.read_text());lock=json.loads(args.lock.read_text());receipt=env/'qwen-runtime.json'
    if args.audit_env:
        # Called with verified portable Python -S. No target .pth/sitecustomize
        # executes until every installed package byte matches its pinned wheel.
        if sys.version.split()[0]!=lock['python']['version'] or not args.downloads:raise ValueError('QWEN_RUNTIME_VERSION')
        install(args.audit_env,args.downloads,lock,verify=True)
        print(json.dumps({'status':'PASS','audit':'pinned-wheel-bytes','targetCodeExecuted':False}));return
    if sys.prefix==sys.base_prefix or sys.version.split()[0]!=lock['python']['version'] or lock['platform']!=('darwin-arm64' if sys.platform=='darwin' else 'win32-x64'):raise ValueError('QWEN_RUNTIME_VERSION')
    lock_hash=sha(args.lock);policy_hash=sha(args.policy)
    if args.verify:
        ordinary(receipt);saved=json.loads(receipt.read_text())
        if saved.get('installLockSha256')!=lock_hash or saved.get('sourcePolicySha256')!=policy_hash or Path(saved['prefix'])!=env or saved.get('interpreterSha256')!=sha(Path(sys.executable)):raise ValueError('QWEN_RUNTIME_RECEIPT')
        for name,digest in saved['installedFiles'].items():
            p=env/safe(name);ordinary(p)
            if sha(p)!=digest:raise ValueError('QWEN_RUNTIME_CHANGED')
        actual={str(p.relative_to(env)).replace('\\','/') for p in env.rglob('*') if p.is_file() and p.name!='qwen-runtime.json'}
        if actual!=set(saved['installedFiles']):raise ValueError('QWEN_RUNTIME_CHANGED')
        validate_packages(policy,lock)
    else:
        if receipt.exists() or not args.downloads or not args.final_env or not args.final_python or not args.model:raise ValueError('QWEN_INSTALL_CHANGED')
        install(env,args.downloads,lock);validate_packages(policy,lock)
        # Import checks do not allocate a model or probe GPU inference. They catch
        # missing portable-Python DLLs and binary wheel compatibility before commit.
        if sys.platform=='darwin':
            import mlx.core,mlx_audio,mlx_lm
        else:
            import torch,torchaudio,qwen_tts
        import soundfile,scipy
        cfg=env/'pyvenv.cfg';text=cfg.read_text()
        text=re.sub(r'^home = .*$', 'home = '+str(args.final_python.parent),text,flags=re.M)
        text=re.sub(r'^executable = .*$', 'executable = '+str(args.final_python),text,flags=re.M)
        text=re.sub(r'^command = .*$', 'command = managed Qwen offline installation',text,flags=re.M);cfg.write_text(text)
        inventory={str(p.relative_to(env)).replace('\\','/'):sha(p) for p in env.rglob('*') if p.is_file()}
        saved=dict(schemaVersion=1,engine=policy['engine'],backend='mlx' if sys.platform=='darwin' else 'torch-cuda',revision=policy['revision'],prefix=str(args.final_env),model=policy['model'] if sys.platform=='darwin' else str(args.model),interpreterSha256=sha(Path(sys.executable)),sourcePolicySha256=policy_hash,installLockSha256=lock_hash,installedFiles=inventory,wheels=lock['wheels'],licenses={'model':policy['license'],'python':lock['python']['license']})
        receipt.write_text(json.dumps(saved,indent=2)+'\n')
    print(json.dumps({'status':'PASS','platform':lock['platform'],'packages':len(lock['wheels']),'modelLoaded':False}))

if __name__=='__main__':main()
