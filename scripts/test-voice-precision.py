"""Precision diagnostic contract tests, no real GPU or weights."""
from pathlib import Path
from types import SimpleNamespace as NS
import runpy
import unittest

retype = runpy.run_path(str(Path(__file__).with_name('probe-voice-macos-precision.py')))['retype_model']

class RetypeTests(unittest.TestCase):
    def fixture(self):
        calls=[]
        params={name:NS(dtype='float32',device=NS(type='mps')) for name in ['base_lm.weight','residual_lm.weight','audio_vae.weight']}
        def layer(name):
            def cast(*,dtype):calls.append(name);params[name+'.weight'].dtype=dtype
            def cache(batch,length,device,dtype):
                obj.kv_cache=NS(kv_cache=NS(device=NS(type=device),dtype=dtype),current_length=0)
            obj=NS(to=cast,setup_cache=cache)
            return obj
        children={name:layer(name) for name in ['base_lm','residual_lm','audio_vae']}
        tts=NS(**children,config=NS(dtype='float32',max_length=2048),named_children=lambda:children.items(),named_parameters=lambda:params.items())
        torch=NS(float32='float32',bfloat16='bfloat16',float16='float16',isfinite=lambda _:NS(all=lambda:NS(item=lambda:True)),mps=NS(synchronize=lambda:None))
        return tts,torch,calls,params

    def test_keeps_vae_untouched_and_rebuilds_both_kv_caches(self):
        for dtype in ['bfloat16','float16']:
            tts,torch,calls,params=self.fixture()
            audit=retype(tts,dtype,torch)
            self.assertEqual(calls,['base_lm','residual_lm'])
            self.assertEqual(params['audio_vae.weight'].dtype,'float32')
            self.assertEqual(audit['parameters'],{dtype:2,'audioVaeFp32':1})
            self.assertEqual(tts.config.dtype,dtype)
            self.assertEqual(tts.base_lm.kv_cache.kv_cache.dtype,dtype)
            self.assertEqual(tts.residual_lm.kv_cache.kv_cache.dtype,dtype)

    def test_rejects_cpu_and_nonfinite_tensors(self):
        tts,torch,_,params=self.fixture()
        params['base_lm.weight'].device.type='cpu'
        with self.assertRaisesRegex(ValueError,'EXPERIMENT_TENSOR_AUDIT'):retype(tts,'float16',torch)
        params['base_lm.weight'].device.type='mps'
        torch.isfinite=lambda _:NS(all=lambda:NS(item=lambda:False))
        with self.assertRaisesRegex(ValueError,'EXPERIMENT_TENSOR_AUDIT'):retype(tts,'bfloat16',torch)

if __name__=='__main__':unittest.main()
