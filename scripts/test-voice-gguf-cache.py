"""GPU-free tests of derivative isolation, integrity and interrupted publication."""
import copy
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'electron/voice'))
from gguf_cache import cache_identity, seal, verify_cache, prepare
from worker import sha

class CacheTests(unittest.TestCase):
    def setUp(self):
        temp=tempfile.TemporaryDirectory();self.addCleanup(temp.cleanup)
        self.root=Path(temp.name).resolve()
        self.selected=dict(packageSha256='p',adapterSha256='a',voice=dict(voice_id='synthetic',version='1',engine=dict(model_revision='r')))
        self.policy=dict(originalBaseSha256='b',sourceCommit='c',converterFiles={'tool':'hash'})
        self.identity=cache_identity(self.selected,self.policy,'recipe')
        self.secret=b'x'*32

    def derivative(self,directory):
        directory.mkdir(parents=True);(directory/'gguf').mkdir()
        outputs={}
        for name in ['VoxCPM2-BaseLM-F16.gguf','VoxCPM2-Acoustic-F16.gguf']:
            path=directory/'gguf'/name;path.write_bytes(b'synthetic-not-real-gguf');outputs[name]=sha(path)
        value=dict(status='PASS_CONVERSION_ONLY',adapterKeys=384,mergedMatrices=192,adapterSha256='a',packageSha256='p',originalBaseSha256='b',mergeCount=1,ggufDtype='f16',records=[{'ggufExactExpectedCastBytes':True}]*192,ggufFiles=outputs)
        (directory/'conversion.json').write_text(json.dumps(value));return value

    def test_identity_changes_for_adapter_package_base_revision_and_recipe(self):
        for key in ['adapterSha256','packageSha256']:
            value=copy.deepcopy(self.selected);value[key]='new'
            self.assertNotEqual(self.identity,cache_identity(value,self.policy,'recipe'))
        for key in ['originalBaseSha256','sourceCommit','converterFiles']:
            value=copy.deepcopy(self.policy);value[key]='new'
            self.assertNotEqual(self.identity,cache_identity(self.selected,value,'recipe'))
        value=copy.deepcopy(self.selected);value['voice']['engine']['model_revision']='new'
        self.assertNotEqual(self.identity,cache_identity(value,self.policy,'recipe'))
        self.assertNotEqual(self.identity,cache_identity(self.selected,self.policy,'new-recipe'))

    def test_signed_cache_rejects_manifest_output_identity_or_receipt_tampering(self):
        d=self.root/'cache';self.derivative(d);seal(d,self.identity,self.secret)
        verify_cache(d,self.identity,self.secret)
        with self.assertRaises(ValueError):verify_cache(d,{**self.identity,'adapterSha256':'other'},self.secret)
        receipt=d/'cache-receipt.json';original=receipt.read_bytes()
        modified=json.loads(original);modified['value']['ggufFiles']['VoxCPM2-BaseLM-F16.gguf']='0'*64;receipt.write_text(json.dumps(modified))
        with self.assertRaises(ValueError):verify_cache(d,self.identity,self.secret)
        receipt.write_bytes(original)
        output=d/'gguf/VoxCPM2-Acoustic-F16.gguf';output.write_bytes(b'changed')
        with self.assertRaises(ValueError):verify_cache(d,self.identity,self.secret)
        output.write_bytes(b'synthetic-not-real-gguf');(d/'conversion.json').write_text('{}')
        with self.assertRaises(ValueError):verify_cache(d,self.identity,self.secret)

    def test_incomplete_lora_cannot_be_sealed(self):
        d=self.root/'cache';value=self.derivative(d);value['records'][0]={'ggufExactExpectedCastBytes':False};(d/'conversion.json').write_text(json.dumps(value))
        with self.assertRaisesRegex(ValueError,'LORA_INCOMPLETE'):seal(d,self.identity,self.secret)

    @unittest.skipIf(sys.platform=='win32','Mac filesystem lock implementation')
    def test_prepare_publishes_atomically_reuses_cache_and_cleans_failed_conversion(self):
        owner=SimpleNamespace(converter=None);calls=[]
        def convert(args,**kwargs):
            d=Path(args[args.index('--output')+1]);calls.append(d)
            self.assertFalse(any(d.parent.glob('[0-9a-f]'*64)))
            self.derivative(d)
            for name in ['model.safetensors','merged-fp32.bin']:(d/name).write_bytes(b'scratch')
            return SimpleNamespace(wait=lambda **kw:0,poll=lambda:0)
        args=(self.root/'storage',self.selected,self.policy,self.root/'runtime',Path(sys.executable),self.root/'package',self.root/'base',owner)
        with patch('gguf_cache.shutil.disk_usage',return_value=SimpleNamespace(free=100*1024**3)),patch('gguf_cache.subprocess.Popen',side_effect=convert):
            destination,audit=prepare(*args);self.assertEqual(audit['derivativeCache'],'created')
            self.assertFalse((destination/'model.safetensors').exists());self.assertIsNone(owner.converter)
            again,audit=prepare(*args);self.assertEqual(again,destination);self.assertEqual(audit['derivativeCache'],'hit');self.assertEqual(len(calls),1)
        other=copy.deepcopy(self.selected);other['packageSha256']='other'
        def fail(args,**kwargs):
            d=Path(args[args.index('--output')+1]);d.mkdir();(d/'partial').write_text('incomplete')
            return SimpleNamespace(wait=lambda **kw:1,poll=lambda:1)
        with patch('gguf_cache.shutil.disk_usage',return_value=SimpleNamespace(free=100*1024**3)),patch('gguf_cache.subprocess.Popen',side_effect=fail),self.assertRaisesRegex(ValueError,'GGUF_CONVERSION_FAILED'):
            prepare(args[0],other,*args[2:])
        self.assertEqual(list((args[0]/'synthetic@1').glob('.prepare-*')),[])
        self.assertTrue(destination.exists());self.assertIsNone(owner.converter)

if __name__=='__main__':unittest.main()
