"""GPU-free adapter contract tests. Real Metal/PID tests use the voice CLI."""
import json
from pathlib import Path
import queue
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import wave
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'electron/voice'))
from gguf_worker import GgufWorker
from control import StreamCancelled
from gguf_runtime import validate


class GgufTests(unittest.TestCase):
    def fixture(self):
        directory=tempfile.TemporaryDirectory();self.addCleanup(directory.cleanup)
        events=[];worker=GgufWorker(lambda kind,ident,**data:events.append((kind,ident,data)))
        worker.cache=Path(directory.name)
        worker.native=SimpleNamespace(pid=123,poll=lambda:None)
        commands=[]
        chunk=dict(type='chunk',id='synth',index=0,offset=0,pcm=[0.25]*7680,effectiveSeed=42)
        end=dict(type='end',id='synth',samples=7680,cleanupComplete=True,cancelled=False,error='',effectiveSeed=42)
        def send(value):
            commands.append(value)
            if value['type']=='generate':worker.output.put(chunk.copy())
            elif value['type']=='credit':worker.output.put(end.copy())
            elif value['type']=='cancel':worker.output.put(dict(end,cancelled=True))
        worker._send=send
        request=dict(streamVersion=1,text='시험',seed=42,style=None,synthesisId='synth',requestId='request',binding={'runtimeSessionId':'session','speechEpoch':7,'effectiveSeed':42},segmentIndex=2)
        return worker,request,events,commands,chunk,end

    def test_stream_keeps_binding_samples_and_pcm_contract(self):
        w,r,events,commands,_,_=self.fixture()
        result=w.stream(r,lambda _:None)
        self.assertEqual((result['totalSamples'],result['totalChunks']),(7680,1))
        self.assertEqual(result['effectiveSeed'],r['seed'])
        self.assertEqual(commands[0],dict(type='generate',id='synth',text=r['text'],seed=r['seed']))
        kind,ident,event=events[0]
        self.assertEqual((kind,ident,event['binding']),('audio-chunk','request',r['binding']))
        self.assertEqual(event['effectiveSeed'],r['seed'])
        with wave.open(str(w.cache/(event['audioId']+'.wav'))) as audio:
            self.assertEqual((audio.getframerate(),audio.getnchannels(),audio.getsampwidth(),audio.getnframes()),(48000,1,2,7680))
        self.assertEqual(commands[-1],dict(type='credit',id='synth',index=0))

    def test_terminal_chunk_finishes_without_waiting_for_playback_credit(self):
        w,r,events,commands,chunk,end=self.fixture()
        chunk['final']=True
        def send(value):
            commands.append(value)
            if value['type']=='generate':
                w.output.put(chunk);w.output.put(end)
        w._send=send
        def credit(n):
            if n:raise AssertionError('Terminal response waited for playback')
        self.assertEqual(w.stream(r,credit)['totalChunks'],1)
        self.assertEqual([c['type'] for c in commands],['generate'])

    def test_credit_wait_cancel_waits_for_native_cleanup_and_removes_audio(self):
        w,r,events,commands,chunk,end=self.fixture()
        def send(value):
            commands.append(value)
            if value['type']=='generate':w.output.put(chunk.copy())
            elif value['type']=='credit':w.output.put(dict(chunk,index=value['index']+1,offset=(value['index']+1)*7680))
            elif value['type']=='cancel':w.output.put(dict(end,cancelled=True))
        w._send=send
        def credit(n):
            if n:raise StreamCancelled({'requestId':'cancel'},'credit-wait')
        with self.assertRaises(StreamCancelled):w.stream(r,credit)
        self.assertTrue(list(w.cache.glob('*.wav')))
        w.cancel_stream()
        self.assertIsNone(w.active);self.assertEqual(list(w.cache.iterdir()),[])
        self.assertEqual(commands[-1]['type'],'cancel')

    def test_terminal_race_retains_cleanup_before_cancel_ack(self):
        w,r,_,commands,_,_=self.fixture()
        class Credit:
            def __call__(self,n):pass
            def checkpoint(self,n):
                if w.active is None:raise StreamCancelled({'requestId':'cancel'},'chunk-boundary')
        with self.assertRaises(StreamCancelled):w.stream(r,Credit())
        count=len(commands);w.cancel_stream()
        self.assertEqual(len(commands),count);self.assertEqual(list(w.cache.iterdir()),[])

    def test_three_patch_chunks_preserve_final_short_tail_and_exact_pcm(self):
        w,r,events,commands,chunk,end=self.fixture()
        def send(value):
            commands.append(value)
            index=0 if value['type']=='generate' else value['index']+1
            w.output.put(dict(chunk,index=index,offset=index*7680,final=index==4))
            if index==4:w.output.put(dict(end,samples=5*7680))
        w._send=send
        result=w.stream(r,lambda _:None)
        self.assertEqual([e[2]['sampleCount'] for e in events],[23040,15360])
        self.assertEqual([e[2]['sampleOffset'] for e in events],[0,23040])
        import struct
        payload=b''
        for _,_,e in events:
            with wave.open(str(w.cache/(e['audioId']+'.wav'))) as audio:payload+=audio.readframes(audio.getnframes())
        self.assertEqual(payload,struct.pack('<h',int(.25*32767))*38400)
        self.assertEqual((result['totalSamples'],result['totalChunks']),(38400,2))

    def test_invalid_native_chunks_fail_closed(self):
        for mutation in [dict(id='stale'),dict(index=2),dict(offset=1),dict(pcm=[float('nan')]),dict(pcm=[]),dict(pcm=[True])]:
            w,r,_,_,chunk,_=self.fixture();chunk.update(mutation)
            with self.assertRaises(ValueError):w.stream(r,lambda _:None)

    def test_cleanup_failure_cannot_claim_warm_reuse(self):
        w,_,_,_,_,_=self.fixture();w.active='synth'
        w._send=lambda _:w.output.put(dict(type='end',id='synth',cleanupComplete=False,error=''))
        with self.assertRaisesRegex(ValueError,'STREAM_CLEANUP'):w.cancel_stream()
        self.assertEqual(w.active,'synth')

    def test_wrong_platform_rejected_before_assets_or_execution(self):
        with patch('gguf_runtime.sys.platform','win32'):
            with self.assertRaisesRegex(ValueError,'UNSUPPORTED_DEVICE'):validate(Path('/none'),Path('/none'))

    def test_style_and_oversized_input_rejected(self):
        for change in [dict(text='x'*401),dict(text=''),dict(style='other-voice'),dict(streamVersion=2)]:
            w,r,_,commands,_,_=self.fixture();r.update(change)
            with self.assertRaisesRegex(ValueError,'SYNTHESIS_INPUT'):w.stream(r,lambda _:None)
            self.assertEqual(commands,[])

if __name__=='__main__':unittest.main()
