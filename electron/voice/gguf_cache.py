"""Per-package immutable GGUF derivatives. Atomic publication, sealed manifests."""
import hashlib
import hmac
import json
import os
from pathlib import Path
import shutil
import subprocess
import time
import uuid
from worker import sha, inside, read_json


def canonical(value):return json.dumps(value,sort_keys=True,separators=(',',':')).encode()


def cache_identity(selected, policy, recipe):
    return dict(schemaVersion=1,packageSha256=selected['packageSha256'],adapterSha256=selected['adapterSha256'],baseSha256=policy['originalBaseSha256'],modelRevision=selected['voice']['engine']['model_revision'],converterSource=policy['sourceCommit'],converterFiles=policy['converterFiles'],recipeSha256=recipe,dtype='f16',mergeDtype='float32',mergeCount=1)


def seal(directory, identity, secret):
    manifest=read_json(directory/'conversion.json')
    if manifest.get('status')!='PASS_CONVERSION_ONLY' or manifest.get('adapterKeys')!=384 or manifest.get('mergedMatrices')!=192 or manifest.get('adapterSha256')!=identity['adapterSha256'] or manifest.get('packageSha256')!=identity['packageSha256'] or manifest.get('originalBaseSha256')!=identity['baseSha256'] or manifest.get('mergeCount')!=1 or manifest.get('ggufDtype')!='f16' or len(manifest.get('records',[]))!=192 or not all(r.get('ggufExactExpectedCastBytes') for r in manifest['records']):
        raise ValueError('LORA_INCOMPLETE')
    expected={'VoxCPM2-BaseLM-F16.gguf','VoxCPM2-Acoustic-F16.gguf'}
    if set(manifest['ggufFiles'])!=expected:raise ValueError('GGUF_CACHE_CHANGED')
    for name,digest in manifest['ggufFiles'].items():
        if sha(inside(directory/'gguf',name))!=digest:raise ValueError('GGUF_CACHE_CHANGED')
    value=dict(identity=identity,manifestSha256=sha(directory/'conversion.json'),ggufFiles=manifest['ggufFiles'])
    signed=dict(value=value,hmacSha256=hmac.new(secret,canonical(value),'sha256').hexdigest())
    (directory/'cache-receipt.json').write_text(json.dumps(signed,indent=2)+'\n')
    return value


def verify_cache(directory, identity, secret):
    if directory.is_symlink():raise ValueError('LINK')
    signed=read_json(inside(directory,'cache-receipt.json'));value=signed['value']
    if value.get('identity')!=identity or not hmac.compare_digest(signed.get('hmacSha256',''),hmac.new(secret,canonical(value),'sha256').hexdigest()):raise ValueError('GGUF_CACHE_CHANGED')
    if sha(inside(directory,'conversion.json'))!=value['manifestSha256']:raise ValueError('GGUF_CACHE_CHANGED')
    if set(value['ggufFiles'])!={'VoxCPM2-BaseLM-F16.gguf','VoxCPM2-Acoustic-F16.gguf'}:raise ValueError('GGUF_CACHE_CHANGED')
    for name,digest in value['ggufFiles'].items():
        if sha(inside(directory/'gguf',name))!=digest:raise ValueError('GGUF_CACHE_CHANGED')
    return value


def prepare(cache_root, selected, policy, runtime_root, converter_python, package, base, owner):
    # This module is only called on Mac after platform/runtime/assets validation.
    import fcntl
    cache_root.mkdir(parents=True,exist_ok=True)
    if cache_root.is_symlink():raise ValueError('LINK')
    cache_root=cache_root.resolve();key_path=cache_root/'.seal-key'
    try:
        fd=os.open(key_path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
        with os.fdopen(fd,'wb') as f:f.write(os.urandom(32))
    except FileExistsError:pass
    if key_path.is_symlink() or len(secret:=key_path.read_bytes())!=32:raise ValueError('GGUF_CACHE_CHANGED')
    identity=cache_identity(selected,policy,sha(Path(__file__).with_name('gguf_prepare.py')))
    key=hashlib.sha256(canonical(identity)).hexdigest()
    profile=selected['voice']['voice_id']+'@'+selected['voice']['version']
    profile_root=inside(cache_root,profile);profile_root.mkdir(exist_ok=True)
    destination=inside(profile_root,key)
    lock_path=inside(profile_root,key+'.lock')
    with lock_path.open('a+') as lock:
        deadline=time.monotonic()+840
        while True:
            try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB);break
            except BlockingIOError:
                if time.monotonic()>deadline:raise ValueError('GGUF_CONVERSION_FAILED')
                time.sleep(.1)
        for abandoned in profile_root.glob('.prepare-'+key+'-*'):
            if abandoned.is_symlink():raise ValueError('LINK')
            if abandoned.is_dir():shutil.rmtree(abandoned)
        if destination.exists():
            verify_cache(destination,identity,secret)
            return destination,dict(derivativeCache='hit',derivativeKey=key)
        if shutil.disk_usage(cache_root).free<30*1024**3:raise ValueError('GGUF_DISK_SPACE')
        staging=profile_root/('.prepare-'+key+'-'+uuid.uuid4().hex)
        process=None
        try:
            with (profile_root/(key+'.prepare.log')).open('w') as log:
                environment={**os.environ,'HF_HUB_OFFLINE':'1','TRANSFORMERS_OFFLINE':'1','PYTHONDONTWRITEBYTECODE':'1','PYTHONNOUSERSITE':'1','PYTHONPATH':''}
                process=owner.converter=subprocess.Popen([str(converter_python),'-B',str(Path(__file__).with_name('gguf_prepare.py')),'--package',str(package),'--model',str(base),'--source',str(runtime_root/'converter'),'--output',str(staging),'--dtype','f16'],stdout=log,stderr=subprocess.STDOUT,env=environment,pass_fds=(lock.fileno(),))
                if process.wait(timeout=720)!=0:raise ValueError('GGUF_CONVERSION_FAILED')
            seal(staging,identity,secret)
            # These are generated scratch weights, never the original inputs.
            for name in ['model.safetensors','merged-fp32.bin']:(staging/name).unlink(missing_ok=True)
            verify_cache(staging,identity,secret)
            staging.rename(destination)
            return destination,dict(derivativeCache='created',derivativeKey=key)
        except BaseException:
            if process and process.poll() is None:
                process.terminate()
                try:process.wait(timeout=.7)
                except subprocess.TimeoutExpired:process.kill();process.wait(timeout=.3)
            raise
        finally:
            owner.converter=None
            if staging.exists():shutil.rmtree(staging)
