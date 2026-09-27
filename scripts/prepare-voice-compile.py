"""Explicit opt-in setup of a NEW Windows compile runtime, never an in-place update.

Invoke with the existing independent runtime Python. No weights are copied.
The --install-triton flag authorizes the one pinned package download in this tool;
repository/environment approval rules still apply before running it.
"""
import argparse
import json
from pathlib import Path
import shutil
import subprocess
import sys


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--baseline', required=True, type=Path)
    parser.add_argument('--destination', required=True, type=Path)
    parser.add_argument('--install-triton', action='store_true')
    args = parser.parse_args()
    source, destination = args.baseline.resolve(), args.destination.resolve()
    if sys.platform != 'win32' or sys.version_info[:2] != (3, 11) or not args.install_triton:
        raise ValueError('Windows Python 3.11 and explicit --install-triton required')
    if destination.exists() or destination.is_relative_to(source) or source.is_relative_to(destination):
        raise ValueError('Use a new, separate destination')
    if Path(sys.prefix).resolve() != source / 'env':
        raise ValueError('Invoke with the baseline independent environment Python')
    receipt = json.loads((source / 'env/voice-runtime.json').read_text())
    if receipt['source_commit'] != 'f772e498a45fbb5fb8e13fbf9b9c48be9fe33e69' or receipt['dependencies']['torch'] != '2.8.0+cu128':
        raise ValueError('Unverified baseline runtime')
    for path in source.rglob('*'):
        if path.is_symlink() or getattr(path, 'is_junction', lambda: False)():
            raise ValueError('Linked runtimes cannot be cloned')
    shutil.copytree(source, destination, ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
    python = destination / 'python/python.exe'
    env = destination / 'env'
    subprocess.run([str(python), '-B', '-m', 'venv', '--without-pip', str(env)], check=True)
    python = env / 'Scripts/python.exe'
    subprocess.run([str(python), '-B', '-m', 'ensurepip'], check=True)
    subprocess.run([str(python), '-B', '-m', 'pip', 'install', '--disable-pip-version-check', '--no-deps', 'triton-windows==3.4.0.post21'], check=True)
    subprocess.run([str(python), '-B', '-c', 'import sys,torch,triton; print(sys.executable,torch.__version__,triton.__version__)'], check=True)
    (env / 'voice-compile-runtime.json').write_text(json.dumps(dict(schemaVersion=1, tritonWindows='3.4.0.post21', torch='2.8.0+cu128', sourceCommit=receipt['source_commit'], compileVerified=False), indent=2))
    print('Environment copied. Actual VoxCPM compilation still requires GPU verification.')


if __name__ == '__main__':
    main()
