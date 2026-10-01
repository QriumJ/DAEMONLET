"""Verify incremental FIR boundaries against the complete app conversion."""
import sys,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'electron/voice'))
from qwen_audio import pcm48,IncrementalPcm
import numpy as np
class AudioTest(unittest.TestCase):
 def test_incremental_has_no_chunk_boundary_resampling_difference(self):
  for rate in (16000,22050,24000,44100,48000):
   rng=np.random.default_rng(9);raw=rng.normal(0,.15,rate*2+31).astype(np.float32);step=IncrementalPcm(rate);out=[]
   for start in range(0,len(raw),997):out.append(step.push(raw[start:start+997])[1])
   out.append(step.push(np.zeros(0,dtype=np.float32),True)[1])
   np.testing.assert_array_equal(np.concatenate(out),pcm48(raw,rate)[1])
 def test_invalid_or_overlong_waveform_is_rejected(self):
  for value in (np.zeros(0),np.array([np.nan]),np.zeros((3,2)),np.zeros(24000*60+1)):
   with self.assertRaises(ValueError):pcm48(value,24000)
  with self.assertRaises(ValueError):pcm48(np.zeros(5),12345)
 def test_pcm_clamps_without_loudness_normalization(self):
  raw=np.array([-2,-.5,0,.5,2],dtype=np.float32)
  np.testing.assert_array_equal(pcm48(raw,48000)[1],[-32768,-16384,0,16384,32767])
if __name__=='__main__':unittest.main()
