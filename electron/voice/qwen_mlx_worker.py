"""Pinned local MLX Qwen worker. Native decoder chunks, owned-process cancellation.
No installed-package patch, remote code, playback, or Vox inference hooks.
"""
import contextlib
import hashlib
import importlib.metadata as metadata
import json
import os
from pathlib import Path
import platform
import re
import sys
import time
import uuid
import wave
from control import read_request,Inbox,StreamControl
from reference_condition import verify_reference_condition
from qwen_audio import pcm48,IncrementalPcm
from qwen_worker import ordinary,sha,emit
import qwen_worker as protocol

POLICY=json.loads(Path(__file__).with_name('qwen-mlx-policy.json').read_text())
REVISION=POLICY['revision']
CAPABILITIES=dict(engine=POLICY['engine'],backend='mlx',synthesisStreaming=True,transportChunking=False,cancellation='owned-process-termination',warmCancellationReuse=False,referenceModes=['x-vector','icl'],sampleRate=48000,channels=1,encoding='pcm16',maxSeconds=60)

def verify_assets(root):
    if not root.is_absolute():raise ValueError('VOICE_RUNTIME_CONFIG')
    ordinary(root)
    for name,f in POLICY['files'].items():
        p=root/name;ordinary(p)
        if not p.is_file() or p.stat().st_size!=f['bytes']:raise ValueError('QWEN_MODEL_CHANGED')
        if 'sha256' in f:
            if sha(p)!=f['sha256']:raise ValueError('QWEN_MODEL_CHANGED')
        else:
            data=p.read_bytes()
            if hashlib.sha1(b'blob '+str(len(data)).encode()+b'\0'+data).hexdigest()!=f['gitSha1']:raise ValueError('QWEN_MODEL_CHANGED')
    if {str(p.relative_to(root)) for p in root.rglob('*') if p.is_file()}!=set(POLICY['files']):raise ValueError('QWEN_MODEL_CHANGED')
    if sys.platform!='darwin' or platform.machine()!='arm64' or sys.prefix==sys.base_prefix:raise ValueError('QWEN_RUNTIME_VERSION')
    for name,version in POLICY['dependencies'].items():
        if metadata.version(name)!=version:raise ValueError('QWEN_RUNTIME_VERSION')
    receipt=json.loads((Path(sys.prefix)/'qwen-runtime.json').read_text())
    if receipt.get('engine')!=POLICY['engine'] or receipt.get('backend')!='mlx' or receipt.get('revision')!=REVISION or receipt.get('model')!=POLICY['model'] or Path(receipt['prefix']).resolve()!=Path(sys.prefix).resolve():raise ValueError('QWEN_RUNTIME_RECEIPT')
    if receipt.get('interpreterSha256')!=sha(Path(sys.executable).resolve()):raise ValueError('QWEN_RUNTIME_CHANGED')
    pkg=Path(metadata.distribution('mlx-audio').locate_file('mlx_audio'))
    for name,expected in POLICY['sourceFiles'].items():
        p=pkg/name;ordinary(p)
        if sha(p)!=expected:raise ValueError('QWEN_RUNTIME_CHANGED')
    if {str(p.relative_to(pkg)) for p in pkg.rglob('*.py')}!=set(POLICY['sourceFiles']):raise ValueError('QWEN_RUNTIME_CHANGED')

class MlxWorker:
    def initialize(self,r):
        begin=time.perf_counter()
        self.profile=r.get('executionProfile')
        if r.get('engine')!=POLICY['engine'] or self.profile not in ('qwen-mlx','qwen-mlx-complete'):raise ValueError('QWEN_EXECUTION_PROFILE')
        self.session=str(uuid.UUID(r['runtimeSessionId']));self.cache=Path(r['cache']);ordinary(self.cache)
        self.conditioning=verify_reference_condition(r['conditioning'],self.cache)
        settings=r.get('qwen',{});self.mode=settings.get('mode','x-vector');self.transcript=settings.get('transcript','')
        if self.mode not in ('x-vector','icl') or not isinstance(self.transcript,str) or len(self.transcript)>2000 or any(ord(c)<32 and c not in '\n\t' for c in self.transcript):raise ValueError('QWEN_REFERENCE_MODE')
        if self.mode=='icl' and not self.transcript.strip():raise ValueError('QWEN_TRANSCRIPT_REQUIRED')
        if self.mode=='x-vector':self.transcript=''
        self.promptKey=hashlib.sha256(json.dumps([POLICY['engine'],'mlx',REVISION,self.conditioning['sha256'],hashlib.sha256(self.transcript.encode()).hexdigest(),self.mode],separators=(',',':')).encode()).hexdigest()
        self.raw=r.get('keepRaw') is True
        model=Path(r['model']);verify_assets(model)
        import mlx.core as mx
        if not mx.metal.is_available():raise ValueError('QWEN_METAL_REQUIRED')
        probe=mx.ones((8,8))@mx.ones((8,8));mx.eval(probe)
        if float(mx.sum(probe))!=512:raise ValueError('QWEN_METAL_PROBE')
        from mlx_audio.tts.utils import load_model
        self.model=load_model(model,lazy=False,strict=True)
        from transformers import AutoTokenizer
        self.model.tokenizer=AutoTokenizer.from_pretrained(str(model),local_files_only=True,trust_remote_code=False)
        if self.model.sample_rate!=24000 or self.model.speech_tokenizer is None or not self.model.speech_tokenizer.has_encoder:raise ValueError('QWEN_MODEL_CHANGED')
        loaded=time.perf_counter()
        import numpy as np
        from scipy.signal import resample_poly
        import soundfile as sf
        audio,rate=sf.read(self.conditioning['path'],dtype='float32')
        from math import gcd
        factor=gcd(rate,24000);audio=resample_poly(audio,24000//factor,rate//factor) if rate!=24000 else audio
        self.reference=mx.array(np.asarray(audio,dtype=np.float32));mx.eval(self.reference)
        # Cache only this worker's immutable reference; no cross-reference reuse.
        original=self.model.extract_speaker_embedding
        embedding=original(self.reference,24000);mx.eval(embedding)
        def scoped_embedding(audio,sr=24000):
            if audio is not self.reference or sr!=24000:raise ValueError('VOICE_REFERENCE_BINDING')
            return embedding
        self.model.extract_speaker_embedding=scoped_embedding
        self.warmed=False
        return dict(seedContract=1,referenceContract=1,mode='wav-reference',referenceSha256=self.conditioning['sha256'],conditioningFingerprint=self.conditioning['fingerprint'],referenceCacheBuilds=1,adapterSha256=None,defaultVoice=None,modelRevision=REVISION,sourceCommit=None,runtimeFingerprint=self.promptKey,promptCacheKey=self.promptKey,loadMs=(loaded-begin)*1000,promptMs=(time.perf_counter()-loaded)*1000,loaded=True,warmed=False,ready=True,workerPid=os.getpid(),capabilities=CAPABILITIES)

    def generated(self,text,seed,stream):
        import mlx.core as mx
        import numpy as np
        import random
        if type(seed) is not int or not 1<=seed<=2147483647:raise ValueError('VOICE_SEED_INVALID')
        mx.random.seed(seed);random.seed(seed);np.random.seed(seed);mx.reset_peak_memory()
        return self.model.generate(text=text,ref_audio=self.reference,ref_text=self.transcript or None,lang_code='auto',max_tokens=720,stream=stream,streaming_interval=0.5,verbose=False)

    def validate(self,r):
        b=r.get('binding',{})
        if b.get('runtimeSessionId')!=self.session:raise ValueError('VOICE_SESSION')
        if b.get('conditioningFingerprint')!=self.conditioning['fingerprint']:raise ValueError('VOICE_REFERENCE_BINDING')
        if b.get('engine')!=POLICY['engine'] or b.get('executionProfile')!=self.profile:raise ValueError('QWEN_EXECUTION_PROFILE')
        if type(b.get('speechEpoch')) is not int or b['speechEpoch']<0 or type(r.get('segmentIndex')) is not int or r['segmentIndex']<0:raise ValueError('VOICE_AUDIO_BINDING')
        if b.get('effectiveSeed')!=r.get('seed'):raise ValueError('VOICE_SEED_MISMATCH')
        text=r.get('text')
        if not isinstance(text,str) or not text.strip() or len(text)>600:raise ValueError('VOICE_MESSAGE')
        return text

    def write(self,aid,pcm):
        tmp=self.cache/(aid+'.tmp');path=self.cache/(aid+'.wav')
        with wave.open(str(tmp),'wb') as f:f.setnchannels(1);f.setsampwidth(2);f.setframerate(48000);f.writeframes(pcm.tobytes())
        tmp.replace(path)

    def metrics(self,started,samples,first):
        import mlx.core as mx
        import resource
        elapsed=(time.perf_counter()-started)*1000
        return dict(generationMs=elapsed,firstAudioReadyMs=first,rawDurationMs=samples/24,rawSampleRate=24000,rtf=elapsed/(samples/24),peakAllocatedBytes=mx.get_peak_memory(),ramPeakWorkingSetBytes=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss)

    def complete(self,text,seed):
        import numpy as np
        started=time.perf_counter();parts=[]
        for result in self.generated(text,seed,False):
            if result.sample_rate!=24000:raise ValueError('QWEN_SAMPLE_RATE')
            parts.append(np.asarray(result.audio,dtype=np.float32))
        raw,pcm=pcm48(np.concatenate(parts),24000)
        return raw,pcm,self.metrics(started,len(raw),(time.perf_counter()-started)*1000)

    def prewarm(self,r):
        begin=time.perf_counter();self.complete('응, 듣고 있어.',42);self.warmed=True
        return dict(loaded=True,warmed=True,ready=True,prewarmMs=(time.perf_counter()-begin)*1000,promptCacheKey=self.promptKey)

    def synthesize(self,r):
        text=self.validate(r);aid=str(uuid.UUID(r['audioId']))
        if aid!=r['audioId']:raise ValueError('VOICE_AUDIO_BINDING')
        raw,pcm,metrics=self.complete(text,r['seed']);self.write(aid,pcm)
        if self.raw:
            import soundfile as sf
            sf.write(self.cache/(aid+'.raw.wav'),raw,24000,subtype='FLOAT')
        return dict(audioId=aid,binding=r['binding'],segmentIndex=r['segmentIndex'],effectiveSeed=r['seed'],durationMs=len(pcm)/48,**metrics)

    def stream(self,r,credit):
        import numpy as np
        text=self.validate(r)
        if r.get('streamVersion')!=1 or self.profile!='qwen-mlx' or not isinstance(r.get('synthesisId'),str):raise ValueError('QWEN_EXECUTION_PROFILE')
        begin=time.perf_counter();resampler=IncrementalPcm(24000);chunks=total=native=0;first=None;raw=None
        def publish(pcm):
            nonlocal chunks,total,first
            for offset in range(0,len(pcm),48000):
                credit(chunks);part=pcm[offset:offset+48000];aid=str(uuid.uuid4());self.write(aid,part)
                if first is None:first=(time.perf_counter()-begin)*1000
                emit('audio-chunk',r['requestId'],audioId=aid,binding=r['binding'],segmentIndex=r['segmentIndex'],effectiveSeed=r['seed'],synthesisId=r['synthesisId'],chunkIndex=chunks,sampleOffset=total,sampleCount=len(part),sampleRate=48000,firstChunkReadyMs=first)
                chunks+=1;total+=len(part)
        with contextlib.closing(self.generated(text,r['seed'],True)) as generated:
            for result in generated:
                credit.checkpoint(chunks)
                if result.sample_rate!=24000 or not result.is_streaming_chunk:raise ValueError('QWEN_NATIVE_STREAM')
                native+=1;raw,pcm=resampler.push(np.asarray(result.audio),False);publish(pcm)
            raw,pcm=resampler.push(np.zeros(0,dtype=np.float32),True);publish(pcm)
        if not chunks:raise ValueError('VOICE_INVALID_WAV')
        if self.raw:
            import soundfile as sf
            sf.write(self.cache/(r['synthesisId']+'.raw.wav'),raw,24000,subtype='FLOAT')
        return dict(effectiveSeed=r['seed'],synthesisId=r['synthesisId'],totalSamples=total,totalChunks=chunks,firstChunkReadyMs=first,nativeChunks=native,synthesisStreaming=True,**self.metrics(begin,len(raw),first))

def main():
    worker=None;inbox=None;tails={}
    def tail(r):
        key=r.get('requestId')
        if key not in tails:return False
        index,total=tails[key]
        if r!=dict(protocolVersion=1,type='credit',requestId=key,chunkIndex=index):raise ValueError('STREAM_CREDIT')
        if index+1==total:del tails[key]
        else:tails[key]=(index+1,total)
        return True
    try:
        while True:
            r=inbox.take() if inbox else read_request(sys.stdin);rid=r['requestId']
            try:
                with contextlib.redirect_stdout(sys.stderr):
                    if r['type']=='credit' and tail(r):continue
                    if r['type']=='init' and worker is None:
                        worker=MlxWorker();result=worker.initialize(r);kind='ready';inbox=Inbox(sys.stdin)
                    elif r['type']=='synthesize' and worker:result=worker.synthesize(r);kind='audio-ready'
                    elif r['type']=='prewarm' and worker:result=worker.prewarm(r);kind='warmed'
                    elif r['type']=='stream' and worker:
                        control=StreamControl(inbox,r,tail);result=worker.stream(r,control);kind='synthesis-finished'
                        if control.received<result['totalChunks']:
                            if len(tails)>=2:raise ValueError('STREAM_CREDIT')
                            tails[rid]=(control.received,result['totalChunks'])
                    elif r['type']=='shutdown':return
                    else:raise ValueError('QWEN_PROTOCOL')
                emit(kind,rid,**result)
            except Exception as e:
                code=str(e) if isinstance(e,ValueError) and re.fullmatch('[A-Z_]{1,60}',str(e)) else 'QWEN_WORKER_ERROR'
                emit('error',rid,code=code);return
    except EOFError:return
    finally:
        if inbox:inbox.close()

if __name__=='__main__':
    protocol.PROTOCOL=os.fdopen(os.dup(1),'w',encoding='utf-8',buffering=1)
    os.dup2(2,1);sys.stdout=sys.stderr
    main()
