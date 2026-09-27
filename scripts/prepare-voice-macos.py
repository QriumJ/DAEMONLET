"""Explicit approved setup only. Installs locked wheels into a NEW Mac environment.

install creates the env; seal supports an already installed exact lock. Neither
operation updates an existing source or replaces an existing receipt/source copy.
"""
import argparse
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'electron/voice'))
from macos_runtime import policy, sha, verify_runtime


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('command', choices=['install', 'seal', 'doctor'])
    parser.add_argument('--source', type=Path)
    parser.add_argument('--destination', type=Path)
    args = parser.parse_args()
    expected = policy()
    if sys.platform != 'darwin' or platform.machine() != 'arm64' or platform.python_version() != expected['python']:
        raise RuntimeError('Native macOS arm64 Python 3.11.15 required')
    if args.command == 'doctor':
        receipt = json.loads((Path(sys.prefix) / 'voice-runtime.json').read_text())
        audit = verify_runtime(receipt)
        import torch
        from backend import MpsDevice
        MpsDevice.require(torch)
        print(json.dumps(dict(status='PASS', scope='environment-only', **audit, **MpsDevice.identity(torch))))
        return
    if args.source is None or args.destination is None:
        parser.error('--source and --destination required')
    source, destination = args.source.resolve(), args.destination.resolve()
    if destination.is_relative_to(source) or source.is_relative_to(destination):
        raise RuntimeError('Source and destination must be separate')
    for name, digest in expected['source_files'].items():
        path = source / 'src/voxcpm' / name
        if path.is_symlink() or sha(path) != digest:
            raise RuntimeError('Pinned upstream source mismatch')
    if sha(source / 'LICENSE') != expected['license_sha256'] or sha(ROOT / 'scripts/voice-macos.lock') != expected['lock_sha256']:
        raise RuntimeError('Lock/license mismatch')
    env = destination / 'env'
    if args.command == 'install':
        if destination.exists():
            raise RuntimeError('Destination must be new')
        # Own the interpreter distribution too; never repair/sign the user's Python.
        native = destination/'python'
        shutil.copytree(Path(sys.base_prefix), native, ignore=shutil.ignore_patterns('site-packages','__pycache__','*.pyc'))
        subprocess.run(['uv', 'venv', '--python', str(native/'bin/python3.11'), str(env)], check=True)
        subprocess.run(['uv', 'pip', 'sync', '--python', str(env/'bin/python'), '--require-hashes', '--only-binary', ':all:', str(ROOT/'scripts/voice-macos.lock')], check=True)
        subprocess.run([str(env/'bin/python'), '-B', __file__, 'seal', '--source', str(source), '--destination', str(destination)], check=True)
        return
    if Path(sys.prefix).resolve() != env:
        raise RuntimeError('Seal must run with the new env/bin/python')
    import importlib.metadata as metadata
    for name, version in expected['dependencies'].items():
        if metadata.version(name) != version:
            raise RuntimeError('Dependency version mismatch')
    target = env/'lib/python3.11/site-packages/voxcpm'
    receipt_path = env/'voice-runtime.json'
    if target.exists() or receipt_path.exists():
        raise RuntimeError('Refusing to overwrite an existing runtime')
    for name in expected['source_files']:
        output = target/name
        output.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source/'src/voxcpm'/name, output)
    shutil.copyfile(source/'LICENSE', destination/'VOXCPM-LICENSE')
    shutil.copyfile(ROOT/'scripts/voice-macos.lock', destination/'requirements.lock')
    executable = Path(sys.executable).resolve()
    receipt = dict(schemaVersion=2, profile=expected['id'], policy_sha256=sha(ROOT/'electron/voice/runtime-macos.json'), lock_sha256=expected['lock_sha256'], source_commit=expected['source_commit'], source_files=expected['source_files'], dependencies=expected['dependencies'], interpreter=str(executable), interpreter_sha256=sha(executable), prefix=str(env))
    receipt_path.write_text(json.dumps(receipt, indent=2)+'\n')
    print(json.dumps(dict(status='PASS', scope='installation-only', **verify_runtime(receipt))))


if __name__ == '__main__':
    main()
