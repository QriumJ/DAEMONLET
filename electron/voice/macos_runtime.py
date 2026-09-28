"""Verify the separate Mac execution receipt, never rewrite voice provenance."""
import hashlib
import importlib.metadata as metadata
import json
from pathlib import Path
import platform
import sys


def sha(path):
    with open(path, 'rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def policy():
    return json.loads(Path(__file__).with_name('runtime-macos.json').read_text())


def verify_runtime(receipt):
    expected = policy()
    if sys.platform != expected['platform'] or platform.machine() != expected['arch'] or platform.python_version() != expected['python']:
        raise ValueError('RUNTIME_VERSION')
    if receipt.get('schemaVersion') != 2 or receipt.get('profile') != expected['id'] or receipt.get('policy_sha256') != sha(Path(__file__).with_name('runtime-macos.json')) or receipt.get('lock_sha256') != expected['lock_sha256']:
        raise ValueError('RUNTIME_RECEIPT')
    if receipt.get('source_commit') != expected['source_commit'] or receipt.get('source_files') != expected['source_files']:
        raise ValueError('RUNTIME_SOURCE')
    executable = Path(sys.executable).resolve()
    if receipt.get('interpreter') != str(executable) or receipt.get('interpreter_sha256') != sha(executable) or receipt.get('prefix') != str(Path(sys.prefix).resolve()):
        raise ValueError('RUNTIME_RECEIPT')
    if receipt.get('dependencies') != expected['dependencies']:
        raise ValueError('RUNTIME_VERSION')
    for name, version in expected['dependencies'].items():
        if metadata.version(name) != version:
            raise ValueError('RUNTIME_VERSION')
    root = Path(sys.prefix) / 'lib/python3.11/site-packages/voxcpm'
    actual = {p.relative_to(root).as_posix() for p in root.rglob('*') if p.is_file() and '__pycache__' not in p.parts and p.suffix != '.pyc'}
    if actual != set(expected['source_files']):
        raise ValueError('RUNTIME_SOURCE_CHANGED')
    for name, digest in expected['source_files'].items():
        path = root / name
        if path.is_symlink() or not path.resolve().is_relative_to(root.resolve()) or sha(path) != digest:
            raise ValueError('RUNTIME_SOURCE_CHANGED')
    return dict(profile=expected['id'], dependencyCount=len(expected['dependencies']), sourceFiles=len(actual))
