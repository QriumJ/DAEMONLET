"""Pinned Windows native build, public base and trained-voice derivative admission.

No conversion, download, cache-seal key import, model fallback or execution.
An editable external build receipt cannot admit binaries absent from app policy.
"""
import argparse
import json
import os
from pathlib import Path
import platform
import re
import sys
import tempfile
# The read-only checker is launched with Python -I. Admit only its own bundled
# portable validator directory, without user site packages or PYTHONPATH.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from voice_package import verify_package
from reference_condition import verify_reference_condition
from windows_model_check import check_model
from managed_gguf_runtime import admit as admit_managed_runtime, audit as managed_audit
from worker import inside, read_json, sha, MODEL, REVISION, SOURCE


POLICY = Path(__file__).with_name('runtime-gguf-windows-voxcpm2.json')
PROFILES = {'gguf-cuda-f16': 'CUDA', 'gguf-vulkan-f16': 'Vulkan'}
DEFAULTS = Path(__file__).with_name('base-voice-defaults.json')
DEFAULT_VOICE = dict(description='An adult female voice, warm and gentle, clear and natural, with a calm conversational pace.', seed=42)


def ordinary(path, directory=False):
    path = Path(path)
    if not path.is_absolute() or path != Path(os.path.normpath(path)):
        raise ValueError('PATH')
    for parent in [path, *path.parents]:
        info = parent.lstat()
        if parent.is_symlink() or getattr(info, 'st_file_attributes', 0) & 0x400:
            raise ValueError('LINK')
    if directory and not path.is_dir() or not directory and not path.is_file():
        raise ValueError('PATH')
    return path.resolve()


def validate(request):
    if sys.platform != 'win32' or platform.machine().lower() not in ('amd64', 'x86_64'):
        raise ValueError('UNSUPPORTED_DEVICE')
    profile = request.get('executionProfile')
    if profile not in PROFILES:
        raise ValueError('EXECUTION_PROFILE')
    public = request.get('ggufModelKind') == 'public-base'
    if request.get('ggufModelKind') not in (None, 'public-base'):
        raise ValueError('VOX_GGUF_MODEL_KIND')
    if public:
        if request.get('baseModel') is not True or request.get('package') != '':
            raise ValueError('VOX_GGUF_MODEL_KIND')
    elif request.get('baseModel') is True or request.get('conditioning') is not None:
        raise ValueError('VOX_GGUF_MODEL_KIND')
    configured = request.get('gguf')
    if not isinstance(configured, dict) or set(configured) != {'runtimeDir', 'derivativeDir', 'receipt'}:
        raise ValueError('VOX_GGUF_RUNTIME_MISSING')
    policy = read_json(POLICY)
    expected = policy.get('nativeProfiles', {}).get(profile)
    if policy.get('schemaVersion') != 1 or policy.get('platform') != 'win32-x64' or not expected:
        raise ValueError('VOX_GGUF_BUILD_PENDING')
    runtime = ordinary(configured['runtimeDir'], True)
    receipt_path = ordinary(configured['receipt'])
    receipt = read_json(receipt_path)
    managed = admit_managed_runtime(request.get('managedRuntime'), policy,
                                   'vox-' + PROFILES[profile].lower(), runtime, receipt_path)
    for key in ['sourceCommit', 'originalRuntimeSha256', 'cachedRuntimeSha256', 'nativeSourceSha256',
                'buildDriverSha256', 'cmakeSourceSha256', 'seedContractSha256']:
        if receipt.get(key) != policy.get(key):
            raise ValueError('RUNTIME_SOURCE_CHANGED')
    if receipt.get('schemaVersion') != 1 or receipt.get('backend') != PROFILES[profile]:
        raise ValueError('RUNTIME_RECEIPT')
    native_files = expected.get('nativeFiles')
    if not isinstance(native_files, dict) or not native_files or receipt.get('nativeFiles') != native_files:
        raise ValueError('RUNTIME_RECEIPT')
    if {p.name for p in runtime.iterdir()} != set(native_files):
        raise ValueError('RUNTIME_SOURCE_CHANGED')
    for name, record in native_files.items():
        path = ordinary(inside(runtime, name))
        if path.stat().st_size != record.get('bytes') or sha(path) != record.get('sha256'):
            raise ValueError('RUNTIME_SOURCE_CHANGED')
    executable = ordinary(inside(runtime, 'daemonlet-voxcpm2-engine.exe'))
    if public:
        return dict(validate_public(request, configured, policy, expected, executable, runtime, profile),
                    managedRuntime=managed)
    selected = verify_package(ordinary(request['package'], True))
    derivative_policy = policy.get('derivatives', {}).get(selected['packageSha256'])
    if not derivative_policy or derivative_policy.get('adapterSha256') != selected['adapterSha256']:
        raise ValueError('VOX_GGUF_DERIVATIVE_UNSUPPORTED')
    # The original base remains a provenance input, not the inference model.
    # Its full verification is available through the existing app model check.
    # Inference admission below always hashes the hard-pinned GGUF pair in full.
    original = ordinary(request['model'], True)
    snapshot = read_json(ordinary(inside(original, 'snapshot-provenance.json')))
    if snapshot.get('model_id') != MODEL or snapshot.get('revision') != REVISION:
        raise ValueError('MODEL_REVISION')
    if (not isinstance(snapshot.get('files'), dict)
            or snapshot['files'].get('model.safetensors') != derivative_policy['originalBaseSha256']):
        raise ValueError('MODEL_MANIFEST')
    ordinary(inside(original, 'model.safetensors'))
    derivative = ordinary(configured['derivativeDir'], True)
    conversion_path = ordinary(inside(derivative, 'conversion.json'))
    if sha(conversion_path) != derivative_policy.get('conversionSha256'):
        raise ValueError('GGUF_CACHE_CHANGED')
    conversion = read_json(conversion_path)
    voice = selected['voice']
    for key, value in dict(status='PASS_CONVERSION_ONLY', sourceCommit=policy['sourceCommit'],
                           upstreamSourceCommit=SOURCE, modelRevision=REVISION,
                           originalBaseSha256=derivative_policy['originalBaseSha256'],
                           adapterSha256=selected['adapterSha256'], packageSha256=selected['packageSha256'],
                           mergeCount=1, mergeDtype='float32', ggufDtype='f16', quantization=False,
                           adapterKeys=384, mergedMatrices=192, voiceId=voice['voice_id'],
                           voiceVersion=voice['version'], checkpoint=voice['checkpoint']).items():
        if conversion.get(key) != value or type(conversion.get(key)) is not type(value):
            raise ValueError('LORA_INCOMPLETE')
    records = conversion.get('records')
    if not isinstance(records, list) or len(records) != 192 or not all(
            isinstance(row, dict) and row.get('ggufExactExpectedCastBytes') is True for row in records):
        raise ValueError('LORA_INCOMPLETE')
    models = derivative_policy['ggufFiles']
    if conversion.get('ggufFiles') != {name: value['sha256'] for name, value in models.items()}:
        raise ValueError('GGUF_CACHE_CHANGED')
    for name, record in models.items():
        path = ordinary(inside(derivative / 'gguf', name))
        if path.stat().st_size != record['bytes'] or sha(path) != record['sha256']:
            raise ValueError('GGUF_CACHE_CHANGED')
    reference = ordinary(inside(Path(request['package']), voice['reference']))
    if sha(reference) != selected['referenceSha256']:
        raise ValueError('VOICE_REFERENCE_CHANGED')
    return dict(binary=executable, runtime=runtime, base=derivative / 'gguf/VoxCPM2-BaseLM-F16.gguf',
                acoustic=derivative / 'gguf/VoxCPM2-Acoustic-F16.gguf', reference=reference,
                selected=selected, policy=policy, backend=PROFILES[profile], runtimeFingerprint=sha(POLICY),
                derivativeManifestSha256=sha(conversion_path),
                modelKind='trained', mode='reference', referenceCacheBuilds=1,
                conditioningFingerprint=None, defaultVoice=None,
                managedRuntime=managed,
                originalModelVerification='provenance-and-presence', ggufVerification='full-sha256')


def validate_public(request, configured, policy, expected, executable, runtime, profile):
    public = policy.get('publicModel')
    if not isinstance(public, dict) or set(public) != {'repo', 'revision', 'license', 'files'}:
        raise ValueError('VOX_GGUF_PUBLIC_MODEL_CHANGED')
    derivative = ordinary(configured['derivativeDir'], True)
    if ordinary(request['model'], True) != derivative:
        raise ValueError('VOX_GGUF_MODEL_KIND')
    condition = request.get('conditioning')
    mode = 'wav-reference' if condition is not None else 'base'
    # Old reference-only executables cannot silently substitute a clone or blank
    # WAV for the default-voice operation.
    if mode == 'base' and 'base' not in expected.get('allowedModes', []):
        raise ValueError('VOX_GGUF_BASE_NATIVE_PENDING')
    models = public['files']
    if not isinstance(models, dict) or set(models) != {'VoxCPM2-BaseLM-F16.gguf', 'VoxCPM2-Acoustic-F16.gguf'}:
        raise ValueError('VOX_GGUF_PUBLIC_MODEL_CHANGED')
    receipt = policy.get('managedModelReceipt')
    if (not isinstance(receipt, dict) or receipt.get('id') != 'voxcpm2-gguf-f16'
            or receipt.get('repository') != public['repo'] or receipt.get('revision') != public['revision']):
        raise ValueError('VOX_GGUF_PUBLIC_MODEL_CHANGED')
    # A manual pair has no receipt. An app-managed public download may have only
    # the catalog-pinned model receipt alongside those same fully hashed files.
    # No receipt grants runtime trust or applies to a learned-voice derivative.
    checked = check_model(derivative, models, mode='full', exact=True,
                          error='VOX_GGUF_PUBLIC_MODEL_CHANGED', managed_receipt=receipt)
    reference = None
    if condition is not None:
        # The read-only helper writes only a short-lived owned verification copy.
        # The worker independently snapshots the same verified managed WAV for
        # native use after this CPU-only admission pass.
        with tempfile.TemporaryDirectory(prefix='daemonlet-vox-verify-') as scratch:
            verify_reference_condition(condition, scratch)
        reference = ordinary(condition['path'])
    elif (sha(DEFAULTS) != policy.get('baseVoiceDefaultsSha256')
          or read_json(DEFAULTS) != DEFAULT_VOICE):
        raise ValueError('RUNTIME_SOURCE_CHANGED')
    return dict(binary=executable, runtime=runtime, base=derivative / 'VoxCPM2-BaseLM-F16.gguf',
                acoustic=derivative / 'VoxCPM2-Acoustic-F16.gguf', reference=reference,
                selected=dict(packageSha256=None, adapterSha256=None,
                              referenceSha256=condition['sha256'] if condition else None),
                policy=policy, backend=PROFILES[profile], runtimeFingerprint=sha(POLICY),
                derivativeManifestSha256=None, modelKind='public-base', mode=mode,
                referenceCacheBuilds=1 if condition else 0,
                conditioningFingerprint=condition['fingerprint'] if condition else None,
                defaultVoice=None if condition else DEFAULT_VOICE,
                modelRepository=public['repo'], modelRevision=public['revision'], modelFiles=models,
                publisher=public['repo'].split('/')[0],
                managedModelReceiptVerified=checked['managedModelReceiptVerified'],
                originalModelVerification='not-applicable-public-gguf', ggufVerification='full-sha256')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--verify', action='store_true', required=True)
    parser.add_argument('--package', default='')
    parser.add_argument('--model-kind', choices=['trained', 'public-base'], default='trained')
    parser.add_argument('--conditioning-json')
    parser.add_argument('--managed-runtime-json')
    parser.add_argument('--model', required=True, type=Path)
    parser.add_argument('--runtime-dir', required=True, type=Path)
    parser.add_argument('--derivative-dir', required=True, type=Path)
    parser.add_argument('--receipt', required=True, type=Path)
    parser.add_argument('--execution-profile', choices=sorted(PROFILES), default='gguf-cuda-f16')
    args = parser.parse_args()
    try:
        request = dict(package=args.package, model=str(args.model),
                               executionProfile=args.execution_profile,
                               gguf=dict(runtimeDir=str(args.runtime_dir), derivativeDir=str(args.derivative_dir),
                                         receipt=str(args.receipt)))
        if args.model_kind == 'public-base':
            request.update(ggufModelKind='public-base', baseModel=True)
        if args.managed_runtime_json is not None:
            if len(args.managed_runtime_json.encode('utf-8')) > 8192:
                raise ValueError('GGUF_MANAGED_RUNTIME_CHANGED')
            request['managedRuntime'] = json.loads(args.managed_runtime_json)
        if args.conditioning_json is not None:
            if len(args.conditioning_json.encode('utf-8')) > 8192:
                raise ValueError('VOICE_REFERENCE_CHANGED')
            request['conditioning'] = json.loads(args.conditioning_json)
        assets = validate(request)
        selected = assets['selected']
        print(json.dumps(dict(status='PASS', engine='voxcpm2', executionProfile=args.execution_profile,
                              sourceCommit=assets['policy']['sourceCommit'],
                              packageSha256=selected['packageSha256'], adapterSha256=selected['adapterSha256'],
                              referenceSha256=selected['referenceSha256'], ggufVerification='full-sha256',
                              originalModelVerification=assets['originalModelVerification'],
                              ggufModelKind=assets['modelKind'], mode=assets['mode'],
                              referenceContract=1, referenceCacheBuilds=assets['referenceCacheBuilds'],
                              conditioningFingerprint=assets['conditioningFingerprint'], defaultVoice=assets['defaultVoice'],
                              modelRepository=assets.get('modelRepository'), modelRevision=assets.get('modelRevision', REVISION),
                              modelFiles=assets.get('modelFiles'), publisher=assets.get('publisher'),
                              managedModelReceiptVerified=assets.get('managedModelReceiptVerified', False),
                              **managed_audit(assets.get('managedRuntime')), nativeExecuted=False)))
        return 0
    except Exception as error:
        code = str(error) if isinstance(error, ValueError) and re.fullmatch('[A-Z_]{1,60}', str(error)) else 'VOX_GGUF_VERIFY_FAILED'
        print(json.dumps(dict(status='FAIL', code=code, nativeExecuted=False)))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
