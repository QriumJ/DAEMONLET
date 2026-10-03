"""CPU protocol checks. No native source, binary, model or GPU is executed."""
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
import uuid
import wave

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from control import StreamCancelled
from voxcpm_windows_gguf_worker import WindowsGgufWorker
import voxcpm_windows_gguf_runtime as admission
from voxcpm_windows_gguf_runtime import validate
from worker import MODEL, REVISION, SOURCE, read_json


class Native:
    pid = 4321

    def poll(self):
        return None


class Credits:
    def __init__(self, cancel_after=None):
        self.calls = []
        self.cancel_after = cancel_after

    def checkpoint(self, produced):
        if self.cancel_after is not None and produced >= self.cancel_after:
            raise StreamCancelled({'requestId': 'cancel'}, 'chunk-boundary')

    def __call__(self, produced):
        self.calls.append(produced)
        self.checkpoint(produced)


def request(ident='stream-one'):
    return dict(requestId='request-one', synthesisId=ident, segmentIndex=0, streamVersion=1,
                seed=42, text='안녕하세요.', binding=dict(runtimeSessionId='session', effectiveSeed=42))


def pcm(ident='stream-one', index=0, offset=0, samples=None):
    return dict(type='chunk', id=ident, index=index, offset=offset,
                effectiveSeed=42, final=False, pcm=samples or [.1, -.2])


def end(ident='stream-one', samples=2, cancelled=False):
    return dict(type='end', id=ident, samples=samples, effectiveSeed=42, cancelled=cancelled,
                cleanupComplete=True, referenceCacheBuilds=1, error='', pid=Native.pid)


class AdapterTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.events = []
        self.worker = WindowsGgufWorker(lambda *args, **kw: self.events.append((args, kw)))
        self.worker.cache = Path(self.directory.name)
        self.worker.session = 'session'
        self.worker.profile = 'gguf-cuda-f16'
        self.worker.native = Native()
        self.sent = []
        self.worker._send = self.sent.append

    def tearDown(self):
        self.directory.cleanup()

    def rows(self, *values):
        for value in values:
            self.worker.output.put(value)

    def test_ordered_real_pcm_wav_and_same_native_reuse(self):
        self.rows(pcm(), pcm(index=1, offset=2), end(samples=4))
        result = self.worker.stream(request(), Credits())
        self.assertEqual(result['totalSamples'], 4)
        self.assertEqual(result['totalChunks'], 2)
        self.assertEqual(result['nativePid'], Native.pid)
        self.assertEqual(result['referenceCacheBuilds'], 1)
        self.assertEqual([event[1]['sampleOffset'] for event in self.events], [0, 2])
        for event in self.events:
            with wave.open(str(self.worker.cache / (event[1]['audioId'] + '.wav')), 'rb') as wav:
                self.assertEqual((wav.getframerate(), wav.getnchannels(), wav.getsampwidth()), (48000, 1, 2))
                self.assertEqual(wav.getnframes(), 2)
        self.rows(pcm('stream-two'), end('stream-two'))
        repeated = self.worker.stream(request('stream-two'), Credits())
        self.assertEqual(repeated['nativePid'], Native.pid)
        self.assertIsNone(self.worker.active)

    def test_cancel_terminal_race_cleans_generated_wavs_and_recovers(self):
        self.rows(pcm(), end(cancelled=False))
        with self.assertRaises(StreamCancelled):
            self.worker.stream(request(), Credits(cancel_after=1))
        self.assertTrue(list(self.worker.cache.glob('*.wav')))
        self.worker.cancel_stream()
        self.assertEqual(self.sent[-1], dict(type='cancel', id='stream-one'))
        self.assertEqual(list(self.worker.cache.iterdir()), [])
        self.assertEqual(self.worker.reuse_audit()['nativePid'], Native.pid)
        self.rows(pcm('recovered'), end('recovered'))
        self.assertEqual(self.worker.stream(request('recovered'), Credits())['totalSamples'], 2)

    def test_cancel_requires_native_cleanup_and_preserved_reference(self):
        for field, value in [('cleanupComplete', False), ('referenceCacheBuilds', 2), ('pid', 99)]:
            with self.subTest(field=field):
                self.worker.active = 'stream-one'
                terminal = end(cancelled=True); terminal[field] = value
                self.rows(terminal)
                with self.assertRaisesRegex(ValueError, 'STREAM_CLEANUP'):
                    self.worker.cancel_stream()

    def test_foreign_chunk_bool_index_and_nonfinite_pcm_are_rejected(self):
        bad_values = [pcm('foreign'), {**pcm(), 'index': False}, pcm(samples=[float('nan')]),
                      {**pcm(), 'offset': 10}, {**pcm(), 'effectiveSeed': 99}]
        for value in bad_values:
            with self.subTest(value=value):
                self.rows(value)
                with self.assertRaises(ValueError):
                    self.worker.stream(request(), Credits())
        self.assertEqual(self.events, [])

    def test_complete_output_and_session_seed_binding(self):
        complete = request(); complete['audioId'] = str(uuid.uuid4())
        # Complete uses a fresh native synthesis id; deterministically bind it here.
        with patch('voxcpm_windows_gguf_worker.uuid.uuid4', return_value=uuid.UUID(int=1)):
            ident = str(uuid.UUID(int=1)); self.rows(pcm(ident), end(ident))
            result = self.worker.synthesize(complete)
        self.assertEqual(result['audioId'], complete['audioId'])
        self.assertEqual(result['nativePid'], Native.pid)
        for changes in [{'seed': True}, {'binding': {'runtimeSessionId': 'foreign', 'effectiveSeed': 42}},
                        {'binding': {'runtimeSessionId': 'session', 'effectiveSeed': 99}}]:
            with self.assertRaises(ValueError):
                self.worker.synthesize({**complete, **changes})

    def test_incomplete_cleanup_cannot_acknowledge_success(self):
        self.rows(pcm(), {**end(), 'cleanupComplete': False})
        with self.assertRaisesRegex(ValueError, 'STREAM_CLEANUP'):
            self.worker.stream(request(), Credits())
        self.assertIsNotNone(self.worker.active)

    def test_public_default_uses_zero_reference_cache_and_same_native(self):
        self.worker.model_kind = 'public-base'
        self.worker.reference_builds = 0
        self.rows(pcm(), {**end(), 'referenceCacheBuilds': 0})
        result = self.worker.stream(request(), Credits())
        self.assertEqual(result['referenceCacheBuilds'], 0)
        self.assertEqual(result['nativePid'], Native.pid)
        self.worker.last_end['referenceCacheBuilds'] = 1
        with self.assertRaisesRegex(ValueError, 'VOICE_REFERENCE_RUNTIME'):
            self.worker.reuse_audit()

    def test_public_wav_binding_cannot_switch_reference_within_session(self):
        self.worker.model_kind = 'public-base'
        self.worker.conditioning_fingerprint = 'a' * 64
        value = request()
        with self.assertRaisesRegex(ValueError, 'VOICE_REFERENCE_BINDING'):
            self.worker._input(value)
        value['binding']['conditioningFingerprint'] = 'a' * 64
        self.assertEqual(self.worker._input(value), ('안녕하세요.', 42))
        value['binding']['conditioningFingerprint'] = 'b' * 64
        with self.assertRaisesRegex(ValueError, 'VOICE_REFERENCE_BINDING'):
            self.worker._input(value)


class AdmissionTests(unittest.TestCase):
    def test_no_unreviewed_binary_can_be_admitted_by_external_receipt(self):
        configured = dict(executionProfile='gguf-cuda-f16', gguf=dict(runtimeDir='C:/unreviewed',
                           derivativeDir='C:/unreviewed-models', receipt='C:/self-written-receipt.json'))
        with patch('voxcpm_windows_gguf_runtime.sys.platform', 'win32'), \
                patch('voxcpm_windows_gguf_runtime.platform.machine', return_value='AMD64'), \
                patch('voxcpm_windows_gguf_runtime.read_json', return_value={'schemaVersion': 1,
                      'platform': 'win32-x64', 'nativeProfiles': {}}):
            with self.assertRaisesRegex(ValueError, 'VOX_GGUF_BUILD_PENDING'):
                validate(configured)

    def test_mac_cannot_load_windows_runtime(self):
        with patch('voxcpm_windows_gguf_runtime.sys.platform', 'darwin'):
            with self.assertRaisesRegex(ValueError, 'UNSUPPORTED_DEVICE'):
                validate(dict(executionProfile='gguf-cuda-f16'))


class ProvenanceTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name).resolve()
        for name in ['runtime', 'package', 'original', 'derivative/gguf']:
            (self.root / name).mkdir(parents=True)
        (self.root / 'runtime/daemonlet-voxcpm2-engine.exe').write_bytes(b'CPU test fixture, never executed')
        (self.root / 'package/reference.wav').write_bytes(b'approved reference test fixture')
        (self.root / 'original/model.safetensors').write_bytes(b'original model test fixture')
        for name in ['VoxCPM2-BaseLM-F16.gguf', 'VoxCPM2-Acoustic-F16.gguf']:
            (self.root / 'derivative/gguf' / name).write_bytes(name.encode())
        digest = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
        record = lambda p: dict(bytes=p.stat().st_size, sha256=digest(p))
        self.selected = dict(packageSha256='a' * 64, adapterSha256='b' * 64,
                             referenceSha256=digest(self.root / 'package/reference.wav'),
                             voice=dict(voice_id='fixture', version='1', checkpoint='step_1', reference='reference.wav'))
        self.conversion = dict(status='PASS_CONVERSION_ONLY', sourceCommit='c' * 40,
                               upstreamSourceCommit=SOURCE, modelRevision=REVISION, originalBaseSha256='d' * 64,
                               adapterSha256=self.selected['adapterSha256'], packageSha256=self.selected['packageSha256'],
                               mergeCount=1, mergeDtype='float32', ggufDtype='f16', quantization=False,
                               adapterKeys=384, mergedMatrices=192, voiceId='fixture', voiceVersion='1', checkpoint='step_1',
                               records=[{'ggufExactExpectedCastBytes': True} for _ in range(192)],
                               ggufFiles={p.name: digest(p) for p in (self.root / 'derivative/gguf').iterdir()})
        self.write('derivative/conversion.json', self.conversion)
        self.write('original/snapshot-provenance.json', dict(model_id=MODEL, revision=REVISION,
                   files={'model.safetensors': self.conversion['originalBaseSha256']}))
        self.policy = dict(schemaVersion=1, platform='win32-x64', sourceCommit=self.conversion['sourceCommit'],
                           nativeProfiles={'gguf-cuda-f16': {'nativeFiles': {
                               'daemonlet-voxcpm2-engine.exe': record(self.root / 'runtime/daemonlet-voxcpm2-engine.exe')}}},
                           derivatives={self.selected['packageSha256']: dict(
                               adapterSha256=self.selected['adapterSha256'], originalBaseSha256='d' * 64,
                               conversionSha256=digest(self.root / 'derivative/conversion.json'),
                               ggufFiles={p.name: record(p) for p in (self.root / 'derivative/gguf').iterdir()})})
        for key in ['originalRuntimeSha256', 'cachedRuntimeSha256', 'nativeSourceSha256',
                    'buildDriverSha256', 'cmakeSourceSha256', 'seedContractSha256']:
            self.policy[key] = 'e' * 64
        self.receipt = {k: self.policy[k] for k in ['sourceCommit', 'originalRuntimeSha256', 'cachedRuntimeSha256',
                        'nativeSourceSha256', 'buildDriverSha256', 'cmakeSourceSha256', 'seedContractSha256']}
        self.receipt.update(schemaVersion=1, backend='CUDA', nativeFiles=self.policy['nativeProfiles']['gguf-cuda-f16']['nativeFiles'])
        self.write('receipt.json', self.receipt)
        self.request = dict(package=str(self.root / 'package'), model=str(self.root / 'original'),
                            executionProfile='gguf-cuda-f16', gguf=dict(runtimeDir=str(self.root / 'runtime'),
                            derivativeDir=str(self.root / 'derivative'), receipt=str(self.root / 'receipt.json')))

    def tearDown(self):
        self.directory.cleanup()

    def write(self, name, value):
        (self.root / name).write_text(json.dumps(value), encoding='utf-8')

    def validate(self):
        with patch.object(admission.sys, 'platform', 'win32'), \
                patch.object(admission.platform, 'machine', return_value='AMD64'), \
                patch.object(admission, 'verify_package', return_value=self.selected), \
                patch.object(admission, 'read_json', side_effect=lambda p: self.policy if p == admission.POLICY else read_json(p)):
            return admission.validate(self.request)

    def test_matching_provenance_pair_and_native_policy_pass_without_execution(self):
        result = self.validate()
        self.assertEqual(result['originalModelVerification'], 'provenance-and-presence')
        self.assertEqual(result['ggufVerification'], 'full-sha256')
        self.assertEqual(result['selected']['adapterSha256'], 'b' * 64)

    def test_modified_native_binary_and_self_written_receipt_are_rejected(self):
        (self.root / 'runtime/daemonlet-voxcpm2-engine.exe').write_bytes(b'foreign engine')
        # A local receipt rehash must not change the immutable app admission policy.
        self.receipt['nativeFiles'] = {'daemonlet-voxcpm2-engine.exe': dict(bytes=14, sha256='f' * 64)}
        self.write('receipt.json', self.receipt)
        with self.assertRaisesRegex(ValueError, 'RUNTIME_RECEIPT'):
            self.validate()

    def test_changed_gguf_bytes_cannot_use_the_previous_conversion_receipt(self):
        (self.root / 'derivative/gguf/VoxCPM2-Acoustic-F16.gguf').write_bytes(b'changed model')
        with self.assertRaisesRegex(ValueError, 'GGUF_CACHE_CHANGED'):
            self.validate()

    def test_cross_voice_and_incomplete_audit_are_rejected(self):
        self.selected['adapterSha256'] = 'f' * 64
        with self.assertRaisesRegex(ValueError, 'VOX_GGUF_DERIVATIVE_UNSUPPORTED'):
            self.validate()
        self.selected['adapterSha256'] = 'b' * 64
        self.conversion['records'][0]['ggufExactExpectedCastBytes'] = False
        self.write('derivative/conversion.json', self.conversion)
        # Even with a trusted new manifest hash, the semantic audit must fail.
        self.policy['derivatives']['a' * 64]['conversionSha256'] = hashlib.sha256(
            (self.root / 'derivative/conversion.json').read_bytes()).hexdigest()
        with self.assertRaisesRegex(ValueError, 'LORA_INCOMPLETE'):
            self.validate()

    def test_different_original_revision_and_extra_native_files_are_rejected(self):
        self.write('original/snapshot-provenance.json', dict(model_id=MODEL, revision='foreign',
                   files={'model.safetensors': self.conversion['originalBaseSha256']}))
        with self.assertRaisesRegex(ValueError, 'MODEL_REVISION'):
            self.validate()
        (self.root / 'runtime/foreign.dll').write_bytes(b'never executed')
        with self.assertRaisesRegex(ValueError, 'RUNTIME_SOURCE_CHANGED'):
            self.validate()


class PublicAdmissionTests(unittest.TestCase):
    validate = ProvenanceTests.validate
    tearDown = ProvenanceTests.tearDown
    write = ProvenanceTests.write

    def setUp(self):
        ProvenanceTests.setUp(self)
        derivative = self.root / 'public-model'
        derivative.mkdir()
        for source in (self.root / 'derivative/gguf').iterdir():
            (derivative / source.name).write_bytes(source.read_bytes())
        self.policy['publicModel'] = dict(repo='DennisHuang648/VoxCPM2-GGUF', revision='f' * 40,
                license='Apache-2.0', files={p.name: dict(bytes=p.stat().st_size,
                sha256=hashlib.sha256(p.read_bytes()).hexdigest()) for p in derivative.glob('*.gguf')})
        self.policy['managedModelReceipt'] = dict(schemaVersion=1, owner='daemonlet-managed-public-gguf-model',
               scope='public-base', id='voxcpm2-gguf-f16', fingerprint='a' * 64,
               repository=self.policy['publicModel']['repo'], revision=self.policy['publicModel']['revision'],
               files=[dict(name=name,**record) for name,record in self.policy['publicModel']['files'].items()])
        self.policy['baseVoiceDefaultsSha256'] = hashlib.sha256(admission.DEFAULTS.read_bytes()).hexdigest()
        self.policy['nativeProfiles']['gguf-cuda-f16']['allowedModes'] = ['reference', 'base']
        self.request.update(package='', baseModel=True, ggufModelKind='public-base', model=str(derivative))
        self.request['gguf']['derivativeDir'] = str(derivative)

    def test_public_exact_pair_needs_no_original_model_or_adapter(self):
        (self.root / 'original/model.safetensors').unlink()
        result = self.validate()
        self.assertEqual(result['modelKind'], 'public-base')
        self.assertEqual(result['mode'], 'base')
        self.assertEqual(result['referenceCacheBuilds'], 0)
        self.assertEqual(result['defaultVoice'], admission.DEFAULT_VOICE)
        self.assertIsNone(result['selected']['packageSha256'])
        self.assertIsNone(result['selected']['adapterSha256'])
        self.assertIsNone(result['derivativeManifestSha256'])
        self.assertEqual(result['originalModelVerification'], 'not-applicable-public-gguf')

    def test_reference_only_native_cannot_fake_default_voice(self):
        del self.policy['nativeProfiles']['gguf-cuda-f16']['allowedModes']
        with self.assertRaisesRegex(ValueError, 'VOX_GGUF_BASE_NATIVE_PENDING'):
            self.validate()

    def test_public_trained_route_discriminators_are_strict(self):
        for changes in [dict(package=str(self.root / 'package')), dict(baseModel=False),
                        dict(ggufModelKind='unknown'), dict(model=str(self.root / 'original'))]:
            with self.subTest(changes=changes):
                saved = self.request.copy(); self.request.update(changes)
                with self.assertRaisesRegex(ValueError, 'VOX_GGUF_MODEL_KIND'):
                    self.validate()
                self.request = saved

    def test_public_pair_changed_bytes_and_defaults_are_rejected(self):
        pair = self.root / 'public-model/VoxCPM2-BaseLM-F16.gguf'
        pair.write_bytes(b'changed community model')
        with self.assertRaisesRegex(ValueError, 'VOX_GGUF_PUBLIC_MODEL_CHANGED'):
            self.validate()
        pair.write_bytes((self.root / 'derivative/gguf' / pair.name).read_bytes())
        self.policy['baseVoiceDefaultsSha256'] = '0' * 64
        with self.assertRaisesRegex(ValueError, 'RUNTIME_SOURCE_CHANGED'):
            self.validate()

    def managed_reference(self):
        import array
        reference = self.root / 'reference.wav'
        data = array.array('h', [6000, -6000] * 16000)
        if sys.byteorder != 'little':
            data.byteswap()
        with wave.open(str(reference), 'wb') as output:
            output.setnchannels(1); output.setsampwidth(2); output.setframerate(16000)
            output.writeframes(data.tobytes())
        condition = dict(kind='wav-reference', path=str(reference),
                         sha256=hashlib.sha256(reference.read_bytes()).hexdigest(),
                         fingerprint='a' * 64, preprocessingVersion='mono-pcm16-round-v1', sampleRate=16000, samples=32000)
        self.request['conditioning'] = condition
        return condition, reference

    def test_public_managed_wav_full_validation_is_read_only(self):
        condition, reference = self.managed_reference()
        before = sorted(str(p.relative_to(self.root)) for p in self.root.rglob('*'))
        result = self.validate()
        self.assertEqual(result['mode'], 'wav-reference')
        self.assertEqual(result['referenceCacheBuilds'], 1)
        self.assertEqual(result['conditioningFingerprint'], condition['fingerprint'])
        self.assertIsNone(result['defaultVoice'])
        self.assertEqual(sorted(str(p.relative_to(self.root)) for p in self.root.rglob('*')), before)
        reference.write_bytes(b'changed reference')
        with self.assertRaisesRegex(ValueError, 'VOICE_REFERENCE_CHANGED'):
            self.validate()

    def test_public_initialize_protocol_argv_and_readiness_are_mode_bound(self):
        import io
        import voxcpm_windows_gguf_worker as adapter
        for cloning in (False, True):
            with self.subTest(cloning=cloning):
                if cloning:
                    self.managed_reference()
                assets = self.validate(); assets['backend'] = 'Vulkan'
                ready = dict(type='ready', seedContract=1, backend='Vulkan', pid=Native.pid,
                             referenceMode='reference' if cloning else 'base', referenceCacheBuilds=int(cloning),
                             componentBackends={name:'Vulkan0' for name in
                               ['ResidualLM','LocEnc','LocDiT','FSQ','AudioVAE','Projections','StopPredictor']},
                             offloadedLayers=29, totalLayers=29, modelLoadMs=1, referenceMs=int(cloning))
                fake = Native(); fake.poll = lambda: 0
                fake.stdin = io.StringIO(); fake.stdout = io.StringIO(json.dumps(ready)+'\n'); fake.stderr = io.StringIO()
                worker = adapter.WindowsGgufWorker()
                cache = self.root / ('owned-cache-' + str(cloning))
                request = dict(self.request, cache=str(cache), runtimeSessionId='session', executionProfile='gguf-vulkan-f16')
                with patch.object(adapter, 'validate', return_value=assets), \
                     patch.object(adapter.subprocess, 'Popen', return_value=fake) as spawn, \
                     patch.object(adapter.subprocess, 'CREATE_NO_WINDOW', 0, create=True):
                    audit = worker.initialize(request)
                self.assertEqual(len(spawn.call_args.args[0]), 5 if cloning else 3)
                self.assertEqual(audit['ggufModelKind'], 'public-base')
                self.assertEqual(audit['mode'], 'wav-reference' if cloning else 'base')
                self.assertEqual(audit['referenceCacheBuilds'], int(cloning))
                self.assertEqual(audit['adapterRepresentation'], 'none')
                self.assertEqual(audit['mergedMatrices'], 0)
                self.assertIsNone(audit['packageSha256'])
                self.assertEqual(audit['modelFiles'], self.policy['publicModel']['files'])
                if cloning:
                    self.assertNotEqual(Path(spawn.call_args.args[0][3]), self.root / 'reference.wav')
                    self.assertTrue(worker.reference_snapshot.is_dir())
                worker.close()
                if cloning:
                    self.assertEqual(list(cache.iterdir()), [])

    def test_exact_public_install_receipt_is_metadata_only_weights_always_hashed(self):
        self.assertFalse(self.validate()['managedModelReceiptVerified'])
        self.write('public-model/model-receipt.json', self.policy['managedModelReceipt'])
        self.assertTrue(self.validate()['managedModelReceiptVerified'])
        (self.root / 'public-model/VoxCPM2-Acoustic-F16.gguf').write_bytes(b'foreign weights')
        with self.assertRaisesRegex(ValueError, 'VOX_GGUF_PUBLIC_MODEL_CHANGED'):
            self.validate()

    def test_public_foreign_private_and_malformed_receipts_cannot_grant_trust(self):
        receipt = self.policy['managedModelReceipt']
        for field,value in [('scope','trained-voice'),('id','belle-private'),('fingerprint','b'*64),
                            ('schemaVersion',True),('revision','b'*40),('owner','other')]:
            with self.subTest(field=field):
                self.write('public-model/model-receipt.json', dict(receipt,**{field:value}))
                with self.assertRaisesRegex(ValueError, 'VOX_GGUF_PUBLIC_MODEL_CHANGED'):
                    self.validate()
        path = self.root / 'public-model/model-receipt.json'
        path.write_text('{"schemaVersion":1,"schemaVersion":1}')
        with self.assertRaisesRegex(ValueError, 'VOX_GGUF_PUBLIC_MODEL_CHANGED'):
            self.validate()

    def test_public_directory_has_only_pair_and_optional_exact_receipt(self):
        for extra in ['conversion.json','ownership.json','foreign.dll']:
            with self.subTest(extra=extra):
                path = self.root / 'public-model' / extra; path.write_bytes(b'foreign metadata')
                with self.assertRaisesRegex(ValueError, 'VOX_GGUF_PUBLIC_MODEL_CHANGED'):
                    self.validate()
                path.unlink()
        (self.root / 'public-model/unexpected-folder').mkdir()
        with self.assertRaisesRegex(ValueError, 'VOX_GGUF_PUBLIC_MODEL_CHANGED'):
            self.validate()


if __name__ == '__main__':
    unittest.main()
