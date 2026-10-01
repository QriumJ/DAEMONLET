"""Diagnostic Vox worker only: split cold initialization/prewarm, retain float WAV.
Uses existing Windows worker for model/reference validation and engine synthesis.
No installed package/source mutation and no experimental cancel hooks.
"""
import contextlib
import json
import os
from pathlib import Path
import sys
import time
from control import read_request
from worker import Worker
from windows_base_worker import create_worker
from qwen_memory import process_memory

PROTOCOL=sys.stdout
def emit(value):
    PROTOCOL.write(json.dumps(value)+'\n');PROTOCOL.flush()

Base=create_worker(Worker)
class BenchWorker(Base):
    def initialize(self,r):
        from engine import Engine
        # Scoped to this diagnostic process. Production worker continues to warm normally.
        original=Engine.warmup
        try:
            Engine.warmup=lambda _:None
            audit=super().initialize(r)
        finally:Engine.warmup=original
        return dict(audit,loaded=True,warmed=False,ready=True)
    def prewarm(self,r):
        start=time.perf_counter();self.engine.warmup()
        return dict(loaded=True,warmed=True,ready=True,prewarmMs=(time.perf_counter()-start)*1000)
    def synthesize(self,r):
        original=self.engine.generate;captured=[]
        def capture(*args,**kwargs):
            with contextlib.closing(original(*args,**kwargs)) as items:
                for audio in items:
                    captured.append(audio.copy());yield audio
        try:
            self.engine.generate=capture
            result=super().synthesize(r)
        finally:self.engine.generate=original
        import numpy as np
        import soundfile as sf
        raw=np.concatenate(captured);rate=int(self.model.tts_model.sample_rate)
        sf.write(str(self.cache/(r['audioId']+'.raw.wav')),raw,rate,subtype='FLOAT')
        return dict(result,rawSampleRate=rate,rawDurationMs=raw.size/rate*1000,firstAudioReadyMs=result['generationMs'],synthesisStreaming=False,**process_memory())

def main():
    worker=None
    while True:
        try:r=read_request(sys.stdin)
        except EOFError:return
        try:
            with contextlib.redirect_stdout(sys.stderr):
                if r['type']=='init' and worker is None:worker=BenchWorker();result=worker.initialize(r);kind='ready'
                elif r['type']=='prewarm' and worker:result=worker.prewarm(r);kind='warmed'
                elif r['type']=='synthesize' and worker:result=worker.synthesize(r);kind='audio-ready'
                elif r['type']=='shutdown':return
                else:raise ValueError('AB_PROTOCOL')
            emit(dict(protocolVersion=1,type=kind,requestId=r['requestId'],**result))
        except Exception:
            emit(dict(protocolVersion=1,type='error',requestId=r['requestId'],code='AB_VOX_ERROR'));return

if __name__=='__main__':
    PROTOCOL=os.fdopen(os.dup(1),'w',encoding='utf-8',buffering=1)
    os.dup2(2,1);sys.stdout=sys.stderr
    main()
