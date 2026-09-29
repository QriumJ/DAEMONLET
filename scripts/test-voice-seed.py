"""Seed contract and call-boundary tests; no model, GPU, download or dependency install."""
import argparse,json,subprocess,sys,unittest
from pathlib import Path
from types import SimpleNamespace
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'electron/voice'))
from seed_contract import valid_seed, request_seed
from engine import Engine
INVALID=[None,False,True,0,-1,2147483648,1.0,1.5,'42',[],{},float('nan'),float('inf')]
class SeedTests(unittest.TestCase):
 def test_bounds_and_types(self):
  for x in [1,42,2147483647]:self.assertEqual(valid_seed(x),x)
  for x in INVALID:
   with self.subTest(x=x),self.assertRaisesRegex(ValueError,'VOICE_SEED_INVALID'):valid_seed(x)
 def test_request_binding_cannot_disagree(self):
  self.assertEqual(request_seed({'seed':17,'binding':{'effectiveSeed':17}}),17)
  for x in [42,True,17.0,'17',None]:
   with self.subTest(x=x),self.assertRaises(ValueError):request_seed({'seed':17,'binding':{'effectiveSeed':x}})
 def test_all_profiles_override_without_mutating_shared_settings(self):
  for profile in ['baseline','cached','compiled','mps-fp32-baseline','mps-fp32']:
   with self.subTest(profile=profile):
    calls=[];tensor=SimpleNamespace(squeeze=lambda _:tensor,cpu=lambda:tensor,numpy=lambda:[.1])
    def generate(**kwargs):calls.append(kwargs);return tensor,None,None
    def stream(**kwargs):yield generate(**kwargs)
    tts=SimpleNamespace(generate_with_prompt_cache=generate,generate_with_prompt_cache_streaming=stream)
    model=SimpleNamespace(tts_model=tts,generate=lambda **kwargs:generate(**kwargs)[0])
    settings=dict(seed=42,cfg_value=2,inference_timesteps=10,retry_badcase=False,max_len=600,normalize=False,denoise=False)
    engine=Engine(model,'reference',settings,profile);engine.cache={'mode':'reference'}
    for seed in [42,17,42]:
     list(engine.generate('case',seed=seed));self.assertEqual(engine.effective_seed,seed)
     if profile not in ['baseline','mps-fp32-baseline']:list(engine.generate('case',True,seed=seed))
    self.assertEqual(settings['seed'],42);self.assertEqual([c['seed'] for c in calls], [42,17,42] if profile in ['baseline','mps-fp32-baseline'] else [42,42,17,17,42,42])
    for value in INVALID:
     with self.assertRaises(ValueError):list(engine.generate('case',seed=value))
 def test_native_max_step_tail_requires_credit_before_end(self):
  import tempfile
  from collections import deque
  from gguf_worker import GgufWorker
  emitted=[];sent=[]
  worker=GgufWorker(lambda kind,rid,**row:emitted.append(row))
  rows=deque([dict(type='chunk',id='tail',effectiveSeed=17,index=i,offset=i*7680,pcm=[.1]*7680,final=False) for i in range(40)]+[dict(type='end',id='tail',effectiveSeed=17,samples=40*7680,cancelled=False,cleanupComplete=True,error='')])
  def receive(**kwargs):
   row=rows.popleft()
   if row['type']=='end':self.assertIn(dict(type='credit',id='tail',index=39),sent)
   return row
  worker._receive=receive;worker._send=sent.append
  with tempfile.TemporaryDirectory() as temp:
   worker.cache=Path(temp)
   result=worker.stream(dict(text='응.',seed=17,style=None,streamVersion=1,requestId='request',synthesisId='tail',binding={'effectiveSeed':17},segmentIndex=0),lambda _:None)
   self.assertEqual(result['totalSamples'],40*7680);self.assertEqual(result['effectiveSeed'],17)
   self.assertEqual(sum(r['sampleCount'] for r in emitted),40*7680)
   worker.cancel_stream();self.assertFalse(list(Path(temp).iterdir()))
 def test_workers_reject_invalid_seed_before_loading_dependencies(self):
  from worker import Worker
  for x in INVALID:
   for method in ['synthesize','stream']:
    with self.subTest(x=x,method=method),self.assertRaisesRegex(ValueError,'VOICE_SEED_INVALID'):
     getattr(Worker(),method)({'seed':x},*([] if method=='synthesize' else [None]))
  with self.assertRaisesRegex(ValueError,'VOICE_SEED_INVALID'):Worker().synthesize({})
if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('--native');args,rest=parser.parse_known_args()
 suite=unittest.defaultTestLoader.loadTestsFromTestCase(SeedTests);result=unittest.TextTestRunner(verbosity=2).run(suite)
 if args.native:
  values=[{'seed':17,'binding':{'effectiveSeed':42}},{'seed':17,'binding':{'effectiveSeed':17.0}},{},*[{'seed':v} for v in [None,False,True,0,-1,1.0,1.5,'42',2147483648,18446744073709551615]],*[{'seed':v} for v in [1,42,2147483647]]]
  proc=subprocess.run([args.native],input='\n'.join(json.dumps(v) for v in values)+'\n',text=True,capture_output=True,check=True)
  expected=['INVALID']*(len(values)-3)+['1','42','2147483647'];assert proc.stdout.splitlines()==expected,(proc.stdout,expected);print('Production C++ seed validator: PASS')
 sys.exit(0 if result.wasSuccessful() else 1)
