"""Windows model checks. Installed mode deliberately skips weight content hashes.

Downloads/installations and explicit full checks still compare every pinned file.
Size/link checks are admission checks, not a claim of complete corruption detection.
No GPU imports, model execution, network requests or persistent trust cache.
"""
import argparse
import hashlib
import json
from pathlib import Path
import stat
import time

WEIGHTS = {'.safetensors', '.pth', '.pt', '.bin'}

def ordinary(path):
    for p in (path, *path.parents):
        s = p.lstat()
        if p.is_symlink() or getattr(s, 'st_file_attributes', 0) & getattr(stat, 'FILE_ATTRIBUTE_REPARSE_POINT', 0x400):
            raise ValueError('VOICE_MODEL_LINK')

def check_model(root, files, mode='full', exact=False, error='MODEL_CHANGED'):
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
            if {p.relative_to(root).as_posix() for p in entries if p.is_file()} != set(files):
                raise ValueError(error)
    except (OSError, ValueError):
        raise ValueError(error) from None
    return dict(modelVerification=mode, modelCheckMs=(time.perf_counter()-start)*1000,
                modelHashedBytes=hashed, modelSkippedWeightBytes=skipped,
                weightIntegrityChecked=skipped == 0)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--engine', choices=['voxcpm2', 'qwen3-tts-06b'], required=True)
    parser.add_argument('--model', type=Path, required=True)
    args = parser.parse_args()
    qwen = args.engine == 'qwen3-tts-06b'
    policy = json.loads(Path(__file__).with_name('qwen-policy.json' if qwen else 'runtime-windows-base.json').read_text())
    try:
        result = check_model(args.model, policy['files'] if qwen else policy['model']['files'], exact=qwen)
        print(json.dumps(dict(status='PASS', engine=args.engine, **result)))
    except ValueError:
        print(json.dumps(dict(status='FAIL', code='VOICE_MODEL_CHECK_FAILED')))
        raise SystemExit(1)

if __name__ == '__main__':
    main()
