"""Explicit offline Windows setup; run with the known working inference Python -B.

Copies the Python distribution and the inference dependency closure to a NEW destination.
Does not install into, write into, or launch jobs in the source training environment.
No network, weights, training data, editable links, or source-root dependency is retained.
"""
import argparse
import hashlib
import importlib.metadata as metadata
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True, type=Path, help="Pinned VoxCPM source checkout")
    parser.add_argument("--destination", required=True, type=Path, help="New independent runtime folder")
    args = parser.parse_args()
    if sys.platform != "win32" or sys.version_info[:2] != (3, 11):
        raise RuntimeError("This setup is for verified Windows Python 3.11 only")
    source = args.source.resolve()
    destination = args.destination.resolve()
    if destination.exists() or destination.is_relative_to(source) or source.is_relative_to(destination):
        raise RuntimeError("Destination must be new and separate from source")
    commit = subprocess.check_output(["git", "-c", f"safe.directory={source.as_posix()}", "-C", str(source), "rev-parse", "HEAD"], text=True).strip()
    if commit != "f772e498a45fbb5fb8e13fbf9b9c48be9fe33e69":
        raise RuntimeError("Pinned source mismatch")
    dirty = subprocess.check_output(["git", "-c", f"safe.directory={source.as_posix()}", "-C", str(source), "diff", "HEAD", "--", "src/voxcpm"], text=True)
    if dirty.strip():
        raise RuntimeError("Inference source differs from pinned commit")
    from packaging.requirements import Requirement
    from packaging.utils import canonicalize_name
    roots = ["torch", "torchaudio", "transformers", "einops", "librosa", "pydantic", "tqdm", "safetensors", "soundfile", "sentencepiece", "packaging"]
    pending, distributions = list(roots), {}
    while pending:
        name = canonicalize_name(pending.pop())
        if name in distributions:
            continue
        dist = metadata.distribution(name)
        distributions[name] = dist
        for value in dist.requires or []:
            req = Requirement(value)
            if req.marker is None or req.marker.evaluate({"extra": ""}):
                dependency = metadata.distribution(req.name)
                if req.specifier and not req.specifier.contains(dependency.version):
                    raise RuntimeError(f"Incompatible dependency: {req.name}")
                pending.append(req.name)
    for name, version in {"torch":"2.8.0+cu128", "torchaudio":"2.8.0+cu128", "transformers":"5.3.0"}.items():
        if distributions[name].version != version:
            raise RuntimeError("Runtime version mismatch")
    destination.mkdir(parents=True)
    python_root = destination / "python"
    print(f"Copying Python and {len(distributions)} inference distributions", flush=True)
    shutil.copytree(Path(sys.base_prefix), python_root, ignore=shutil.ignore_patterns("site-packages", "__pycache__", "*.pyc"))
    env_root = destination / "env"
    subprocess.run([str(python_root / "python.exe"), "-B", "-m", "venv", "--without-pip", str(env_root)], check=True)
    site = env_root / "Lib/site-packages"
    for name, dist in sorted(distributions.items()):
        for item in dist.files or []:
            parts = item.parts
            if ".." in parts or item.suffix in (".pyc", ".pth") or "__pycache__" in parts or item.name == "direct_url.json":
                continue
            origin = Path(dist.locate_file(item))
            if not origin.is_file():
                raise RuntimeError(f"Dependency file missing: {name}")
            target = site / item
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(origin, target)
        print(f"Copied {name}=={dist.version}", flush=True)
    package = source / "src/voxcpm"
    target = site / "voxcpm"
    shutil.copytree(package, target, ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "training"))
    # Preserve upstream metadata/license, without editable installation pointers.
    dist = metadata.distribution("voxcpm")
    for item in dist.files or []:
        if not item.parts[0].endswith(".dist-info") or item.name in ("direct_url.json", "RECORD"):
            continue
        origin = Path(dist.locate_file(item))
        output = site / item
        output.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(origin, output)
    receipt = dict(schemaVersion=1, source_commit=commit, python=sys.version.split()[0],
                   dependencies={name: dist.version for name, dist in sorted(distributions.items())},
                   source_files={str(p.relative_to(target)).replace("\\", "/"): hashlib.sha256(p.read_bytes()).hexdigest() for p in target.rglob("*") if p.is_file()})
    (env_root / "voice-runtime.json").write_text(json.dumps(receipt, indent=2)+"\n", encoding="utf-8")
    shutil.copy2(source / "LICENSE", destination / "VOXCPM-LICENSE")
    print("PASS: independent offline runtime copied. GPU synthesis must be verified separately.")


if __name__ == "__main__":
    main()
