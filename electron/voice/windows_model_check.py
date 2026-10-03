"""Windows model checks. Installed mode skips legacy tensor weight hashes only.

Downloads/installations and explicit full checks still compare every pinned file.
Size/link checks are admission checks, not a claim of complete corruption detection.
Qwen GGUF accepts a manual pair or an exact public-model install receipt. The
receipt never makes weights trusted: both GGUF files are always fully hashed.
No GPU imports, model execution, network requests or persistent trust cache.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import time

WEIGHTS = {'.safetensors', '.pth', '.pt', '.bin'}
RECEIPT_NAME = 'model-receipt.json'

def ordinary(path):
    for p in (path, *path.parents):
        s = p.lstat()
        if p.is_symlink() or getattr(s, 'st_file_attributes', 0) & getattr(stat, 'FILE_ATTRIBUTE_REPARSE_POINT', 0x400):
            raise ValueError('VOICE_MODEL_LINK')

def _json_object(pairs):
    value = {}
    for name, item in pairs:
        if name in value:
            raise ValueError('VOICE_MODEL_RECEIPT')
        value[name] = item
    return value


def _invalid_json_constant(_):
    raise ValueError('VOICE_MODEL_RECEIPT')


def public_receipt(root, expected, files):
    """Optional exact public metadata, with no path or runtime trust granted."""
    keys = {'schemaVersion','owner','scope','id','fingerprint','repository','revision','files'}
    if not isinstance(expected,dict) or set(expected) != keys or type(expected['schemaVersion']) is not int or expected['schemaVersion'] != 1 or expected['owner'] != 'daemonlet-managed-public-gguf-model' or expected['scope'] != 'public-base':
        raise ValueError('VOICE_MODEL_RECEIPT')
    if not isinstance(expected['fingerprint'],str) or not re.fullmatch('[a-f0-9]{64}',expected['fingerprint']) or not isinstance(expected['files'],list):
        raise ValueError('VOICE_MODEL_RECEIPT')
    projected = [{ 'name':name, 'bytes':entry['bytes'], 'sha256':entry['sha256'] } for name,entry in files.items()]
    if expected['files'] != projected:
        raise ValueError('VOICE_MODEL_RECEIPT')
    path = root / RECEIPT_NAME
    try:
        path.lstat()
    except FileNotFoundError:
        return False
    ordinary(path)
    fd = os.open(path,os.O_RDONLY | getattr(os,'O_NOFOLLOW',0) | getattr(os,'O_BINARY',0))
    with os.fdopen(fd,'rb') as stream:
        before = os.fstat(stream.fileno())
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or not 1 <= before.st_size <= 65536:
            raise ValueError('VOICE_MODEL_RECEIPT')
        raw = stream.read(before.st_size+1); after = os.fstat(stream.fileno())
    if len(raw) != before.st_size or any(getattr(before,key) != getattr(after,key) for key in ('st_dev','st_ino','st_size','st_mtime_ns','st_ctime_ns')):
        raise ValueError('VOICE_MODEL_RECEIPT')
    received = json.loads(raw.decode('utf-8'),object_pairs_hook=_json_object,parse_constant=_invalid_json_constant)
    # Canonical JSON comparison also distinguishes true/1 and 1.0/1; Python's
    # ordinary dict equality alone would accept these mismatched JSON types.
    canonical = lambda value:json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=True,allow_nan=False)
    if canonical(received) != canonical(expected):
        raise ValueError('VOICE_MODEL_RECEIPT')
    return True


def check_model(root, files, mode='full', exact=False, error='MODEL_CHANGED', managed_receipt=None):
    if mode not in ('full', 'installed'):
        raise ValueError('VOICE_MODEL_POLICY')
    start = time.perf_counter()
    hashed = skipped = 0
    try:
        if not root.is_absolute():
            raise ValueError(error)
        ordinary(root)
        if not root.is_dir():
            raise ValueError(error)
        receipt_verified = public_receipt(root,managed_receipt,files) if managed_receipt is not None else False
        for name, expected in files.items():
            if '\\' in name or ':' in name or any(p in ('', '.', '..') for p in name.split('/')):
                raise ValueError(error)
            path = root / name
            ordinary(path)
            if not path.is_file() or path.stat().st_size != expected['bytes']:
                raise ValueError(error)
            if mode == 'installed' and path.suffix.lower() in WEIGHTS:
                skipped += expected['bytes']
                continue
            if 'sha256' in expected:
                with path.open('rb') as stream:
                    digest = hashlib.file_digest(stream, 'sha256').hexdigest()
                valid = digest == expected['sha256']
            else:
                data = path.read_bytes()
                valid = hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest() == expected['gitSha1']
            if not valid:
                raise ValueError(error)
            hashed += expected['bytes']
        if exact:
            entries = list(root.rglob('*'))
            for path in entries:
                ordinary(path)
            if managed_receipt is not None and any(path.is_dir() for path in entries):
                raise ValueError(error)
            allowed = set(files) | ({RECEIPT_NAME} if receipt_verified else set())
            if {p.relative_to(root).as_posix() for p in entries if p.is_file()} != allowed:
                raise ValueError(error)
        if receipt_verified and not public_receipt(root,managed_receipt,files):
            raise ValueError(error)
    except (OSError, ValueError, KeyError, TypeError, RecursionError):
        raise ValueError(error) from None
    result = dict(modelVerification=mode, modelCheckMs=(time.perf_counter()-start)*1000,
                modelHashedBytes=hashed, modelSkippedWeightBytes=skipped,
                weightIntegrityChecked=skipped == 0)
    if managed_receipt is not None:
        result['managedModelReceiptVerified'] = receipt_verified
    return result


def check_gguf_model(root, policy, error='QWEN_GGUF_MODEL_CHANGED'):
    try:
        receipt = policy['managedModelReceipt']
        if receipt['id'] != policy['engine'] or receipt['repository'] != policy['modelRepository'] or receipt['revision'] != policy['modelRevision']:
            raise ValueError(error)
        return check_model(root,policy['models'],mode='full',exact=True,error=error,managed_receipt=receipt)
    except (OSError, ValueError, KeyError, TypeError, RecursionError):
        raise ValueError(error) from None

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--engine', choices=['voxcpm2', 'qwen3-tts-06b', 'qwen3-tts-06b-gguf'], required=True)
    parser.add_argument('--model', type=Path, required=True)
    args = parser.parse_args()
    qwen = args.engine == 'qwen3-tts-06b'
    gguf = args.engine == 'qwen3-tts-06b-gguf'
    policy_name = 'runtime-qwen-gguf-windows.json' if gguf else 'qwen-policy.json' if qwen else 'runtime-windows-base.json'
    policy = json.loads(Path(__file__).with_name(policy_name).read_text())
    try:
        files = policy['models'] if gguf else policy['files'] if qwen else policy['model']['files']
        result = check_gguf_model(args.model,policy) if gguf else check_model(args.model, files, mode='full', exact=qwen)
        print(json.dumps(dict(status='PASS', engine=args.engine, **result)))
    except ValueError:
        print(json.dumps(dict(status='FAIL', code='VOICE_MODEL_CHECK_FAILED')))
        raise SystemExit(1)

if __name__ == '__main__':
    main()
