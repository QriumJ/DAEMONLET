"""GPU-free tests of the production Python and optional compiled native reference parsers.

Set DAEMONLET_REFERENCE_VALIDATOR to a build of tests/fixtures/voice-reference/validator.cpp
for native parity tests. Neither parser test loads a model or proves voice quality.
"""
import hashlib
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'electron/voice'))
from reference_condition import verify_reference_condition,POLICY


def wav(rate=16000,seconds=2,silent=False):
    count=int(rate*seconds);samples=[0,8192,16384,-8192,-16384]
    pcm=b''.join(struct.pack('<h',0 if silent else samples[i%5]) for i in range(count))
    return b'RIFF'+struct.pack('<I',len(pcm)+36)+b'WAVEfmt '+struct.pack('<IHHIIHH',16,1,1,rate,rate*2,2,16)+b'data'+struct.pack('<I',len(pcm))+pcm


class ReferenceTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name).resolve();self.path=self.root/'reference.wav';self.cache=self.root/'cache';self.cache.mkdir();self.path.write_bytes(wav())
        self.condition=dict(kind='wav-reference',path=str(self.path),sha256=hashlib.sha256(self.path.read_bytes()).hexdigest(),preprocessingVersion=POLICY['preprocessingVersion'],fingerprint='b'*64,sampleRate=16000,samples=32000)
    def tearDown(self):self.temp.cleanup()
    def check(self,c):return verify_reference_condition(c,self.cache)
    def test_valid_owned_snapshot(self):
        out=self.check(self.condition);self.assertEqual(out['sampleRate'],16000);self.assertEqual(Path(out['path']).read_bytes(),self.path.read_bytes());self.path.unlink();self.assertTrue(Path(out['path']).exists())
    def test_sample_rates_and_boundary_lengths(self):
        for rate in POLICY['sampleRates']:
            for seconds in [2,20]:
                with self.subTest(rate=rate,seconds=seconds):
                    data=wav(rate,seconds);self.path.write_bytes(data);c=dict(self.condition,sampleRate=rate,samples=int(rate*seconds),sha256=hashlib.sha256(data).hexdigest());self.check(c);(self.cache/'reference.wav').unlink()
    def test_invalid_contract_and_changed_hash(self):
        for changes in [dict(kind='trained-lora'),dict(sha256='a'*64),dict(fingerprint='bad'),dict(preprocessingVersion='unknown'),dict(sampleRate=16000.0),dict(samples=32000.0),dict(sampleRate=True),dict(command='arbitrary'),dict(path=str(self.path.parent/'..'/'reference.wav'))]:
            with self.subTest(changes=changes),self.assertRaises(ValueError):self.check(dict(self.condition,**changes))
        self.assertEqual(list(self.cache.iterdir()),[])
    def test_rehashed_corrupt_or_silent_wav(self):
        original=wav();cases=[b'bad',wav(silent=True),wav(seconds=1),wav(seconds=21),original+b'extra',b'RIFX'+original[4:],original[:20]+struct.pack('<H',3)+original[22:]]
        for data in cases:
            with self.subTest(size=len(data)),self.assertRaises(ValueError):
                self.path.write_bytes(data);self.check(dict(self.condition,sha256=hashlib.sha256(data).hexdigest()))
        self.assertEqual(list(self.cache.iterdir()),[])
    def test_existing_owned_file_cannot_be_overwritten(self):
        (self.cache/'reference.wav').write_bytes(b'preserved')
        with self.assertRaises(ValueError):self.check(self.condition)
        self.assertEqual((self.cache/'reference.wav').read_bytes(),b'preserved')
    def test_symlink_refused(self):
        original=self.root/'source.wav';self.path.rename(original)
        try:self.path.symlink_to(original)
        except OSError:
            # Windows without symlink rights exercises the production junction guard in the TS suite.
            self.path.write_bytes(original.read_bytes())
            with patch('pathlib.Path.is_symlink',return_value=True),self.assertRaises(ValueError):self.check(self.condition)
        else:
            with self.assertRaises(ValueError):self.check(self.condition)


class WindowsRoutingTests(unittest.TestCase):
    def test_reference_and_default_routing_without_weights(self):
        import windows_base_worker as module
        class Parent:
            def stream(self,request,credit):return 'stream'
            def synthesize(self,request):return 'complete'
        settings=module.policy();condition=dict(fingerprint='b'*64,sha256='a'*64,preprocessingVersion=POLICY['preprocessingVersion'],path=Path('owned-reference.wav'))
        engines=[]
        class Engine:
            def __init__(self,model,reference,settings,profile,backend,voice_description=None):self.reference=reference;self.description=voice_description;self.cache=None;self.cache_builds=0;self.audit={};engines.append(self)
            def prepare(self):
                if self.reference:self.cache={'mode':'reference'};self.cache_builds=1
            def warmup(self):pass
        model=SimpleNamespace(tts_model=SimpleNamespace(named_parameters=lambda:[],eval=lambda:None,audio_vae=SimpleNamespace(decoder=SimpleNamespace(modules=lambda:[]))))
        voxcpm=SimpleNamespace(VoxCPM=SimpleNamespace(from_pretrained=lambda *a,**kw:model))
        with tempfile.TemporaryDirectory() as tmp,patch.dict(sys.modules,{'torch':SimpleNamespace(),'voxcpm':voxcpm}),patch.object(module.CudaDevice,'require_platform'),patch.object(module.CudaDevice,'require'),patch.object(module.CudaDevice,'identity',return_value={}),patch.object(module.CudaDevice,'synchronize'),patch.object(module,'verify_model'),patch.object(module,'verify_environment'),patch('reference_condition.verify_reference_condition',return_value=condition),patch('engine.Engine',Engine):
            for cloning in [True,False]:
                worker=module.create_worker(Parent)();request=dict(baseModel=True,executionProfile='compiled',cache=str(Path(tmp)/str(cloning)),model=tmp,compilerCache=tmp)
                if cloning:request['conditioning']={'fixture':True}
                audit=worker.initialize(request);self.assertIsNone(audit['adapterSha256']);self.assertEqual(audit['effectiveSeed'],42)
                self.assertEqual(audit['mode'],'wav-reference' if cloning else 'base');self.assertEqual(engines[-1].reference,condition['path'] if cloning else None)
                if cloning:
                    self.assertIsNone(engines[-1].description);self.assertEqual(audit['referenceCacheBuilds'],1)
                    with self.assertRaisesRegex(ValueError,'VOICE_REFERENCE_BINDING'):worker.stream({'binding':{}},lambda _:None)
                    self.assertEqual(worker.stream({'binding':{'conditioningFingerprint':condition['fingerprint']}},lambda _:None),'stream')
                else:self.assertTrue(engines[-1].description)


if os.environ.get('DAEMONLET_REFERENCE_VALIDATOR'):
    class NativeReferenceTests(unittest.TestCase):
        def test_production_native_parser_parity(self):
            with tempfile.TemporaryDirectory() as tmp:
                path=Path(tmp).resolve()/'reference.wav'
                def check(data,**overrides):
                    path.write_bytes(data);c=dict(kind='wav-reference',path=str(path),sha256=hashlib.sha256(data).hexdigest(),preprocessingVersion=POLICY['preprocessingVersion'],fingerprint='b'*64,sampleRate=16000,samples=32000);c.update(overrides)
                    result=subprocess.run([os.environ['DAEMONLET_REFERENCE_VALIDATOR']],input=json.dumps(c)+'\n',text=True,capture_output=True,check=True,timeout=10)
                    return json.loads(result.stdout)
                for rate in POLICY['sampleRates']:
                    for seconds in [2,20]:
                        with self.subTest(rate=rate,seconds=seconds):
                            out=check(wav(rate,seconds),sampleRate=rate,samples=rate*seconds);self.assertTrue(out['ok']);self.assertEqual(out['samples'],rate*seconds)
                for changes in [dict(kind='trained-lora'),dict(sha256='a'*64),dict(fingerprint='bad'),dict(preprocessingVersion='unknown'),dict(sampleRate=16000.0),dict(samples=32000.0),dict(sampleRate=True),dict(command='arbitrary')]:
                    with self.subTest(changes=changes):self.assertFalse(check(wav(),**changes)['ok'])
                for data in [b'bad',wav(silent=True),wav(seconds=1),wav(seconds=21),wav()+b'extra',b'RIFX'+wav()[4:]]:
                    with self.subTest(length=len(data)):self.assertFalse(check(data)['ok'])

if __name__=='__main__':unittest.main()
