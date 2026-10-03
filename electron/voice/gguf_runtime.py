"""Strict standalone Mac GGUF runtime/derivative validation; original inputs intact."""
import json
import hashlib
import os
import platform
import stat
import sys
from dataclasses import dataclass
from pathlib import Path
from worker import sha, inside, read_json, ADAPTER, CHECKSUMS, MODEL, REVISION, SOURCE


def _stamp(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def _model_identity(path):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode):raise ValueError('MODEL_CHANGED')
    return (path.resolve(strict=True), _stamp(info))


@dataclass(frozen=True)
class _VerifiedModel:
    identity: tuple
    digest: str


def _verify_model(path):
    # Keep the content check bound to the file opened for this request. A writer
    # or path replacement during hashing must not publish a reusable digest.
    identity = _model_identity(path)
    fd = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
    with os.fdopen(fd, 'rb') as stream:
        if _stamp(os.fstat(stream.fileno())) != identity[1]:raise ValueError('MODEL_CHANGED')
        digest = hashlib.file_digest(stream, 'sha256').hexdigest()
        if _stamp(os.fstat(stream.fileno())) != identity[1]:raise ValueError('MODEL_CHANGED')
    if _model_identity(path) != identity:raise ValueError('MODEL_CHANGED')
    return _VerifiedModel(identity, digest)


def _verify_assets(package, base):
    from voice_package import verify_package
    selected=verify_package(package)
    snapshot=read_json(base/'snapshot-provenance.json')
    if snapshot['model_id']!=MODEL or snapshot['revision']!=REVISION:raise ValueError('MODEL_REVISION')
    required={'config.json','audiovae.pth','model.safetensors','tokenizer.json','tokenizer_config.json','special_tokens_map.json','tokenization_voxcpm2.py'}
    if not required.issubset(snapshot['files']):raise ValueError('MODEL_MANIFEST')
    verified = None
    for name,expected in snapshot['files'].items():
        path = inside(base,name)
        if name == 'model.safetensors':
            verified = _verify_model(path)
            digest = verified.digest
        else:
            digest = sha(path)
        if digest!=expected:raise ValueError('MODEL_CHANGED')
    return selected, verified


def verify_assets(package, base):
    return _verify_assets(package, base)[0]


def validate(package, base, cache_root=None, owner=None, prefix=None):
    if sys.platform != 'darwin' or platform.machine() != 'arm64':
        raise ValueError('UNSUPPORTED_DEVICE')
    root = Path(prefix or sys.prefix).resolve()
    policy = read_json(Path(__file__).with_name('runtime-gguf-macos.json'))
    receipt = read_json(root/'voice-runtime.json')
    executable = Path(sys.executable).resolve()
    if (receipt.get('schemaVersion') != 2 or receipt.get('profile') != 'macos-arm64-gguf-f16-v1'
        or receipt.get('prefix') != str(root) or receipt.get('interpreter') != str(executable)
        or receipt.get('interpreter_sha256') != sha(executable)
        or receipt.get('policySha256') != sha(Path(__file__).with_name('runtime-gguf-macos.json'))):
        raise ValueError('RUNTIME_RECEIPT')
    selected, verified_model = _verify_assets(package, base)
    voice = selected['voice']
    for name, expected in policy['nativeFiles'].items():
        if sha(inside(root, name)) != expected:
            raise ValueError('RUNTIME_SOURCE_CHANGED')
    if receipt.get('sourceCommit') != policy['sourceCommit']:
        raise ValueError('RUNTIME_SOURCE')
    # Snapshot provenance and the independent runtime pin both still apply.
    # Reuse only this invocation's full hash, after repeating path/link/stamp
    # checks. No digest survives an error, cancellation or another cold spawn.
    if (verified_model.digest != policy['originalBaseSha256']
        or _model_identity(inside(base,'model.safetensors')) != verified_model.identity):
        raise ValueError('MODEL_CHANGED')
    converter_python=Path(receipt['converterPython'])
    if str(converter_python.resolve())!=receipt['converterInterpreter'] or sha(converter_python.resolve())!=receipt['converterInterpreterSha256']:
        raise ValueError('RUNTIME_RECEIPT')
    for name,expected in policy['converterFiles'].items():
        if sha(inside(root/'converter',name))!=expected:raise ValueError('RUNTIME_SOURCE_CHANGED')
    from gguf_cache import prepare
    if cache_root is None or owner is None:raise ValueError('RUNTIME_RECEIPT')
    converted,cache_audit=prepare(Path(cache_root),selected,policy,root,converter_python,package,base,owner)
    return dict(voice=voice, binary=inside(root,'native/daemonlet-voice-engine'),
                base=inside(converted/'gguf','VoxCPM2-BaseLM-F16.gguf'),
                acoustic=inside(converted/'gguf','VoxCPM2-Acoustic-F16.gguf'),
                reference=inside(package,voice['reference']), policy=policy, selected=selected, cacheAudit=cache_audit)
