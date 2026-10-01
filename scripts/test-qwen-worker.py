"""CPU-only Qwen contract tests; no model loading, network or GPU operations."""
import json
from pathlib import Path
import sys
import tempfile
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'electron/voice'))
from qwen_worker import QwenWorker,pcm48,prompt_key,verify_model,POLICY,CAPABILITIES

class Contract(unittest.TestCase):
    def test_capability(self):
        self.assertFalse(CAPABILITIES['synthesisStreaming']);self.assertFalse(CAPABILITIES['warmCancellationReuse'])
        self.assertEqual(sum(v['bytes'] for v in POLICY['files'].values()),POLICY['totalBytes'])
    def test_prompt_identity(self):
        keys={prompt_key(ref,text,mode) for ref,text,mode in [('a','one','icl'),('b','one','icl'),('a','two','icl'),('a','one','x-vector')]}
        self.assertEqual(len(keys),4)
    def test_pcm_boundary(self):
        import numpy as np
        raw,pcm=pcm48(np.sin(np.arange(24000)/40)*.1,24000)
        self.assertEqual((raw.size,pcm.size,pcm.dtype.str),(24000,48000,'<i2'))
        self.assertLess(abs(float(raw.max())-float(pcm.max())/32768),.0001)
    def test_invalid_audio(self):
        import numpy as np
        for audio,rate in [(np.zeros((2,4)),24000),(np.array([np.nan]),24000),(np.zeros(1),12345),(np.zeros(1),True),(np.zeros(24000*60+1),24000),(np.zeros(0),24000)]:
            with self.subTest(rate=rate,shape=audio.shape),self.assertRaises(ValueError):pcm48(audio,rate)
    def test_model_missing(self):
        with tempfile.TemporaryDirectory() as path,self.assertRaises(ValueError):verify_model(Path(path))
    def test_session_and_reference_reject_before_inference(self):
        w=QwenWorker();w.session='owned';w.conditioning={'fingerprint':'ref'}
        w.generate=lambda *_:self.fail('inference called')
        for b,code in [({'runtimeSessionId':'old'},'VOICE_SESSION'),({'runtimeSessionId':'owned','conditioningFingerprint':'old'},'VOICE_REFERENCE_BINDING')]:
            with self.assertRaisesRegex(ValueError,code):w.synthesize({'binding':b})

if __name__=='__main__':unittest.main()
