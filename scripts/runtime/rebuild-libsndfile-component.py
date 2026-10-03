"""Offline source-build utility. Produces new data; never executes a DLL or installs."""
import argparse
import copy
import hashlib
import json
from pathlib import Path, PurePosixPath
import stat
import zipfile

LIBRARY = 'python/Lib/site-packages/_soundfile_data/libsndfile_x64.dll'
POLICIES = ('runtime-qwen-gguf-windows.json', 'runtime-gguf-windows-voxcpm2.json')


def pin(data):
    return dict(bytes=len(data), sha256=hashlib.sha256(data).hexdigest())


def rebuild(source_root, shared_archive, dll, output):
    voice = source_root / 'electron/voice'
    catalog_bytes = (voice / 'managed-gguf-runtime-catalog.json').read_bytes()
    catalog = json.loads(catalog_bytes)
    expected_catalog = dict(filename='managed-gguf-runtime-catalog.json', **pin(catalog_bytes))
    policies = {}
    for name in POLICIES:
        policies[name] = json.loads((voice / name).read_bytes())
        if policies[name]['managedRuntimeCatalog'] != expected_catalog:
            raise ValueError('Source catalog and worker policy pins differ')
    component = catalog['components']['shared']
    if pin(shared_archive.read_bytes()) != {k: component['archive'][k] for k in ('bytes', 'sha256')}:
        raise ValueError('Original shared archive pin differs')
    files = {}
    seen = set()
    with zipfile.ZipFile(shared_archive) as archive:
        for entry in archive.infolist():
            if entry.is_dir():
                continue
            name = entry.filename
            parts = PurePosixPath(name)
            mode = entry.external_attr >> 16
            if (parts.is_absolute() or '..' in parts.parts or '\\' in name or ':' in name
                    or name.casefold() in seen or stat.S_ISLNK(mode)):
                raise ValueError('Archive path is unsafe or duplicated')
            seen.add(name.casefold())
            data = archive.read(entry)
            if name not in component['files'] or pin(data) != component['files'][name]:
                raise ValueError('Original component file pin differs')
            files[name] = data
    if set(files) != set(component['files']) or LIBRARY not in files:
        raise ValueError('Original component file set differs')
    replacement = dll.read_bytes()
    if not replacement or replacement[:2] != b'MZ':
        raise ValueError('Expected a nonempty Windows DLL file')
    original_dll = component['files'][LIBRARY]
    if pin(replacement) == original_dll:
        raise ValueError('Replacement library is unchanged')
    files[LIBRARY] = replacement
    derived = copy.deepcopy(component)
    derived['provenance']['userModifiedLibrary'] = dict(
        originalDll=original_dll, replacementDll=pin(replacement),
        replacementBuildProvenanceVerified=False,
    )
    output.mkdir(parents=True, exist_ok=False)
    archive_name = 'shared-win32-x64-user-' + pin(replacement)['sha256'][:12] + '.zip'
    destination = output / archive_name
    with zipfile.ZipFile(destination, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, data in sorted(files.items()):
            entry = zipfile.ZipInfo(name, (2000, 1, 1, 0, 0, 0))
            entry.compress_type = zipfile.ZIP_DEFLATED
            entry.external_attr = 0o100644 << 16
            archive.writestr(entry, data)
    derived['files'] = {name: pin(data) for name, data in sorted(files.items())}
    derived['archive'] = dict(name=archive_name, **pin(destination.read_bytes()),
                              format='zip', bundledPath=archive_name)
    catalog['components']['shared'] = derived
    new_catalog = (json.dumps(catalog, indent=2, ensure_ascii=True) + '\n').encode()
    (output / 'managed-gguf-runtime-catalog.json').write_bytes(new_catalog)
    catalog_pin = dict(filename='managed-gguf-runtime-catalog.json', **pin(new_catalog))
    for name, policy in policies.items():
        policy['managedRuntimeCatalog'] = catalog_pin
        (output / name).write_text(json.dumps(policy, indent=2, ensure_ascii=True) + '\n', encoding='utf-8')
    result = dict(sharedArchive=derived['archive'], catalog=catalog_pin,
                  originalDll=original_dll, replacementDll=pin(replacement),
                  dllExecuted=False, installedAppChanged=False)
    (output / 'rebuild-result.json').write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-root', required=True, type=Path)
    parser.add_argument('--shared-archive', required=True, type=Path)
    parser.add_argument('--dll', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    print(json.dumps(rebuild(args.source_root, args.shared_archive, args.dll, args.output), indent=2))
