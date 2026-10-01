"""Qwen complete-waveform worker. No Vox KV/VAE hooks and no PCM streaming claim.
Cancellation is owned-process termination by the supervisor, including prewarm.
"""
import contextlib
import hashlib
import importlib.metadata as metadata
import json
import os
from pathlib import Path
import re
import stat
import sys
import time
import uuid
import wave
from control import read_request
from qwen_memory import process_memory
from reference_condition import verify_reference_condition

POLICY=json.loads(Path(__file__).with_name('qwen-policy.json').read_text())
REVISION=POLICY['revision']
CAPABILITIES=dict(engine=POLICY['engine'],synthesisStreaming=False,transportChunking=False,cancellation='owned-process-termination',warmCancellationReuse=False,referenceModes=['x-vector','icl'],sampleRate=48000,channels=1,encoding='pcm16',maxSeconds=60)

def sha(path):
    h=hashlib.sha256()
    with Path(path).open('rb') as f:
        for chunk in iter(lambda:f.read(8*1024*1024),b''):h.update(chunk)
    return h.hexdigest()

def ordinary(path):
    for p in (path,*path.parents):
        try:s=p.lstat()
        except OSError:raise ValueError('QWEN_ASSET_CHANGED') from None
        if p.is_symlink() or getattr(s,'st_file_attributes',0)&getattr(stat,'FILE_ATTRIBUTE_REPARSE_POINT',0x400):raise ValueError('QWEN_ASSET_CHANGED')

def verify_model(root,mode='full'):
    from windows_model_check import check_model
    return check_model(root,POLICY['files'],mode,exact=True,error='QWEN_MODEL_CHANGED')

def verify_environment():
    if sys.platform!='win32' or sys.prefix==sys.base_prefix:raise ValueError('QWEN_RUNTIME_VERSION')
    for name,version in POLICY['dependencies'].items():
        if metadata.version(name)!=version:raise ValueError('QWEN_RUNTIME_VERSION')
    receipt=json.loads((Path(sys.prefix)/'qwen-runtime.json').read_text(encoding='utf-8'))
    if receipt.get('engine')!=POLICY['engine'] or receipt.get('revision')!=REVISION or Path(receipt['prefix']).resolve()!=Path(sys.prefix).resolve():raise ValueError('QWEN_RUNTIME_RECEIPT')
    root=Path(metadata.distribution('qwen-tts').locate_file('qwen_tts'))
    for name,expected in POLICY['sourceFiles'].items():
        p=root/name;ordinary(p)
        if sha(p)!=expected:raise ValueError('QWEN_RUNTIME_CHANGED')
    if {str(p.relative_to(root)).replace('\\','/') for p in root.rglob('*.py')}!=set(POLICY['sourceFiles']):raise ValueError('QWEN_RUNTIME_CHANGED')

def prompt_key(reference_sha,transcript,mode):
    return hashlib.sha256(json.dumps([POLICY['engine'],REVISION,reference_sha,hashlib.sha256(transcript.encode()).hexdigest(),mode],separators=(',',':')).encode()).hexdigest()

from qwen_audio import pcm48

PROTOCOL=sys.stdout
def emit(kind,rid,**fields):
    PROTOCOL.write(json.dumps(dict(protocolVersion=1,type=kind,requestId=rid,**fields),ensure_ascii=True)+'\n');PROTOCOL.flush()

class QwenWorker:
    def initialize(self,r):
        started=time.perf_counter()
        if r.get('engine')!=POLICY['engine'] or r.get('executionProfile')!='qwen-complete':raise ValueError('QWEN_EXECUTION_PROFILE')
        self.session=str(uuid.UUID(r['runtimeSessionId']))
        self.cache=Path(r['cache']);ordinary(self.cache)
        self.conditioning=verify_reference_condition(r['conditioning'],self.cache)
        settings=r.get('qwen',{});self.mode=settings.get('mode','x-vector');transcript=settings.get('transcript','')
        if self.mode not in ('x-vector','icl') or not isinstance(transcript,str) or len(transcript)>2000 or any(ord(c)<32 and c not in '\n\t' for c in transcript):raise ValueError('QWEN_REFERENCE_MODE')
        if self.mode=='icl' and not transcript.strip():raise ValueError('QWEN_TRANSCRIPT_REQUIRED')
        if self.mode=='x-vector':transcript=''
        self.promptKey=prompt_key(self.conditioning['sha256'],transcript,self.mode)
        self.raw=r.get('keepRaw') is True
        root=Path(r['model'])
        if r.get('modelVerification')=='installed':
            receipt=json.loads((Path(sys.prefix)/'qwen-runtime.json').read_text(encoding='utf-8'))
            if Path(receipt.get('model','')).resolve()!=root.resolve() or receipt.get('revision')!=REVISION:raise ValueError('QWEN_RUNTIME_RECEIPT')
        model_audit=verify_model(root,r.get('modelVerification','full'));verified=time.perf_counter();verify_environment();environment_done=time.perf_counter()
        import torch
        if not torch.cuda.is_available() or not torch.cuda.is_bf16_supported():raise ValueError('QWEN_CUDA_REQUIRED')
        # Probe actual CUDA operation; availability flags alone do not establish support.
        x=torch.ones((8,8),device='cuda',dtype=torch.bfloat16);y=x@x
        if y.float().sum().item()!=512:raise ValueError('QWEN_CUDA_PROBE')
        del x,y
        from qwen_tts import Qwen3TTSModel
        imported=time.perf_counter()
        self.model=Qwen3TTSModel.from_pretrained(str(root),device_map='cuda',dtype=torch.bfloat16,attn_implementation='sdpa',local_files_only=True,trust_remote_code=False)
        torch.cuda.synchronize();loaded=time.perf_counter()
        self.prompt=self.model.create_voice_clone_prompt(ref_audio=str(self.conditioning['path']),ref_text=transcript or None,x_vector_only_mode=self.mode=='x-vector')
        torch.cuda.synchronize();self.warmed=False
        free,total=torch.cuda.mem_get_info()
        return dict(seedContract=1,referenceContract=1,mode='wav-reference',referenceSha256=self.conditioning['sha256'],conditioningFingerprint=self.conditioning['fingerprint'],referenceCacheBuilds=1,adapterSha256=None,defaultVoice=None,modelRevision=REVISION,sourceCommit=None,runtimeFingerprint=self.promptKey,promptCacheKey=self.promptKey,**model_audit,environmentCheckMs=(environment_done-verified)*1000,runtimeImportMs=(imported-environment_done)*1000,modelLoadMs=(loaded-imported)*1000,loadMs=(loaded-started)*1000,promptMs=(time.perf_counter()-loaded)*1000,loaded=True,warmed=False,ready=True,workerPid=os.getpid(),capabilities=CAPABILITIES,attention='sdpa',dtype='bfloat16',cudaFreeBytes=free,cudaTotalBytes=total)

    def generate(self,text,seed):
        import torch
        import random
        import numpy as np
        if type(seed) is not int or not 1<=seed<=2147483647:raise ValueError('VOICE_SEED_INVALID')
        random.seed(seed);np.random.seed(seed);torch.manual_seed(seed);torch.cuda.manual_seed_all(seed)
        torch.cuda.reset_peak_memory_stats();started=time.perf_counter()
        wavs,rate=self.model.generate_voice_clone(text=text,language='Auto',voice_clone_prompt=self.prompt,non_streaming_mode=True,do_sample=True,max_new_tokens=720)
        torch.cuda.synchronize()
        if not isinstance(wavs,list) or len(wavs)!=1:raise ValueError('VOICE_INVALID_WAV')
        raw,pcm=pcm48(wavs[0],rate)
        generation=(time.perf_counter()-started)*1000
        return raw,rate,pcm,dict(generationMs=generation,firstAudioReadyMs=generation,durationMs=pcm.size/48,rawDurationMs=raw.size/rate*1000,rtf=generation/(raw.size/rate*1000),peakAllocatedBytes=torch.cuda.max_memory_allocated(),peakReservedBytes=torch.cuda.max_memory_reserved(),effectiveSeed=seed,synthesisStreaming=False,**process_memory())

    def prewarm(self,r):
        started=time.perf_counter();self.generate('응, 듣고 있어. 지금은 어떤 이야기를 할까?',42);self.warmed=True
        return dict(loaded=True,warmed=True,ready=True,prewarmMs=(time.perf_counter()-started)*1000,promptCacheKey=self.promptKey)

    def synthesize(self,r):
        b=r.get('binding',{})
        if b.get('runtimeSessionId')!=self.session:raise ValueError('VOICE_SESSION')
        if b.get('conditioningFingerprint')!=self.conditioning['fingerprint']:raise ValueError('VOICE_REFERENCE_BINDING')
        if b.get('engine')!=POLICY['engine'] or b.get('executionProfile')!='qwen-complete':raise ValueError('QWEN_EXECUTION_PROFILE')
        if type(b.get('speechEpoch')) is not int or b['speechEpoch']<0 or type(r.get('segmentIndex')) is not int or r['segmentIndex']<0:raise ValueError('VOICE_AUDIO_BINDING')
        seed=r.get('seed')
        if b.get('effectiveSeed')!=seed:raise ValueError('VOICE_SEED_MISMATCH')
        aid=str(uuid.UUID(r['audioId']))
        if aid!=r['audioId']:raise ValueError('VOICE_AUDIO_BINDING')
        text=r.get('text')
        if not isinstance(text,str) or not text.strip() or len(text)>600:raise ValueError('VOICE_MESSAGE')
        raw,rate,pcm,metrics=self.generate(text,seed)
        path=self.cache/(aid+'.wav');tmp=self.cache/(aid+'.tmp')
        with wave.open(str(tmp),'wb') as out:
            out.setnchannels(1);out.setsampwidth(2);out.setframerate(48000);out.writeframes(pcm.tobytes())
        if self.raw:
            import soundfile as sf
            sf.write(str(self.cache/(aid+'.raw.wav')),raw,rate,subtype='FLOAT')
        tmp.replace(path)
        return dict(audioId=aid,binding=b,segmentIndex=r['segmentIndex'],rawSampleRate=rate,promptCacheKey=self.promptKey,**metrics)

def main():
    worker=None
    while True:
        try:r=read_request(sys.stdin)
        except EOFError:return
        except Exception:return
        rid=r['requestId']
        try:
            with contextlib.redirect_stdout(sys.stderr):
                if r['type']=='init' and worker is None:
                    worker=QwenWorker();result=worker.initialize(r);kind='ready'
                elif r['type']=='synthesize' and worker:
                    result=worker.synthesize(r);kind='audio-ready'
                elif r['type']=='prewarm' and worker:
                    result=worker.prewarm(r);kind='warmed'
                elif r['type']=='shutdown':return
                else:raise ValueError('QWEN_PROTOCOL')
            emit(kind,rid,**result)
        except Exception as e:
            code=str(e) if isinstance(e,ValueError) and re.fullmatch('[A-Z_]{1,60}',str(e)) else 'QWEN_WORKER_ERROR'
            # Upstream exceptions can contain text, reference paths, URLs or prompts.
            emit('error',rid,code=code);return

if __name__=='__main__':
    PROTOCOL=os.fdopen(os.dup(1),'w',encoding='utf-8',buffering=1)
    os.dup2(2,1);sys.stdout=sys.stderr
    main()
