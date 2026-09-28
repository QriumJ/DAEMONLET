"""Strict standalone Mac GGUF runtime/derivative validation; original inputs intact."""
import json
import platform
import sys
from pathlib import Path
from worker import sha, inside, read_json, ADAPTER, CHECKSUMS, MODEL, REVISION, SOURCE


def verify_assets(package, base):
    from voice_package import verify_package
    selected=verify_package(package)
    snapshot=read_json(base/'snapshot-provenance.json')
    if snapshot['model_id']!=MODEL or snapshot['revision']!=REVISION:raise ValueError('MODEL_REVISION')
    required={'config.json','audiovae.pth','model.safetensors','tokenizer.json','tokenizer_config.json','special_tokens_map.json','tokenization_voxcpm2.py'}
    if not required.issubset(snapshot['files']):raise ValueError('MODEL_MANIFEST')
    for name,expected in snapshot['files'].items():
        if sha(inside(base,name))!=expected:raise ValueError('MODEL_CHANGED')
    return selected


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
    selected = verify_assets(package, base)
    voice = selected['voice']
    for name, expected in policy['nativeFiles'].items():
        if sha(inside(root, name)) != expected:
            raise ValueError('RUNTIME_SOURCE_CHANGED')
    if receipt.get('sourceCommit') != policy['sourceCommit']:
        raise ValueError('RUNTIME_SOURCE')
    if sha(base/'model.safetensors')!=policy['originalBaseSha256']:raise ValueError('MODEL_CHANGED')
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
