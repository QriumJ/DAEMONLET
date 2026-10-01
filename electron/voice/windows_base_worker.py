"""Default voice on the existing Windows PyTorch/CUDA compiled path.
No LoRA, GGUF conversion or training; optional validated WAV conditioning.
"""
import hashlib
import importlib.metadata as metadata
import importlib.util
import os
from pathlib import Path
import platform
import sys
import time
from worker import sha,inside,read_json,REVISION,SOURCE
from backend import CudaDevice


def policy():return read_json(Path(__file__).with_name('runtime-windows-base.json'))


def verify_model(root,expected,mode='full'):
    from windows_model_check import check_model
    return check_model(root,expected['model']['files'],mode,error='MODEL_CHANGED')


def verify_environment(expected):
    if sys.platform!='win32' or platform.python_version()!=expected['python']:raise ValueError('RUNTIME_VERSION')
    receipt=read_json(Path(sys.prefix)/'voice-runtime.json')
    if receipt.get('source_commit')!=SOURCE:raise ValueError('RUNTIME_RECEIPT')
    for name,version in expected['dependencies'].items():
        if metadata.version(name)!=version:raise ValueError('RUNTIME_VERSION')
    # The portable installer copies pinned Vox sources without a distribution
    # receipt. Locate the import target without executing its heavy imports.
    spec=importlib.util.find_spec('voxcpm')
    if spec is None or spec.origin is None:raise ImportError('VOX_SOURCE_MISSING')
    root=Path(spec.origin).parent
    for name,digest in expected['sourceFiles'].items():
        if hashlib.sha256(inside(root,name).read_bytes().replace(b'\r\n',b'\n')).hexdigest()!=digest:raise ValueError('RUNTIME_SOURCE_CHANGED')


def create_worker(parent):
    class WindowsBaseWorker(parent):
        def initialize(self,request):
            started=time.perf_counter();expected=policy();defaults=read_json(Path(__file__).with_name("base-voice-defaults.json"))
            if request.get('baseModel') is not True or request.get('executionProfile')!='compiled':raise ValueError('EXECUTION_PROFILE')
            CudaDevice.require_platform();self.backend=CudaDevice
            self.cache=Path(request['cache']);self.cache.mkdir(parents=True,exist_ok=True)
            os.environ.update(HF_HUB_OFFLINE='1',TRANSFORMERS_OFFLINE='1',HF_DATASETS_OFFLINE='1',HF_HOME=str(self.cache/'hf'),TORCH_HOME=str(self.cache/'torch'),PYTHONDONTWRITEBYTECODE='1')
            from reference_condition import verify_reference_condition
            self.conditioning=verify_reference_condition(request['conditioning'],self.cache) if 'conditioning' in request else None
            base=Path(request['model']);model_audit=verify_model(base,expected,request.get('modelVerification','full'));verified=time.perf_counter();verify_environment(expected);environment_done=time.perf_counter()
            import torch
            self.backend.require(torch)
            from engine import Engine,runtime_fingerprint
            identity=dict(defaultVoice=None if self.conditioning else defaults,model=REVISION,source=SOURCE,adapter='none',reference=self.conditioning['sha256'] if self.conditioning else 'none',policy=sha(Path(__file__).with_name('runtime-windows-base.json')),**self.backend.identity(torch),python=sys.version,engine=sha(Path(__file__).with_name('engine.py')))
            if self.conditioning:identity.update(conditioningFingerprint=self.conditioning['fingerprint'],preprocessingVersion=self.conditioning['preprocessingVersion'])
            fingerprint=runtime_fingerprint('compiled',identity);compiler=Path(request['compilerCache'])/fingerprint;compiler.mkdir(parents=True,exist_ok=True)
            os.environ.update(TORCHINDUCTOR_CACHE_DIR=str(compiler/'inductor'),TRITON_CACHE_DIR=str(compiler/'triton'),NUMBA_CACHE_DIR=str(compiler/'numba'))
            from voxcpm import VoxCPM
            imported=time.perf_counter()
            self.model=VoxCPM.from_pretrained(str(base),device='cuda',optimize=False,load_denoiser=False,local_files_only=True)
            if any('lora_' in name for name,_ in self.model.tts_model.named_parameters()):raise ValueError('LORA_TENSORS')
            self.settings={**expected['settings'],'seed':defaults['seed']};self.reference=self.conditioning['path'] if self.conditioning else None;self.model.tts_model.eval();self.backend.synchronize(torch)
            loaded=time.perf_counter()
            self.engine=Engine(self.model,self.reference,self.settings,'compiled',self.backend,voice_description=None if self.conditioning else defaults['description']);self.engine.prepare()
            if self.conditioning and (not isinstance(self.engine.cache,dict) or self.engine.cache.get('mode')!='reference' or self.engine.cache_builds!=1):raise ValueError('VOICE_REFERENCE_RUNTIME')
            self.engine.warmup()
            self.vae_forwards=[(m,m.forward) for m in self.model.tts_model.audio_vae.decoder.modules()]
            return dict(defaultVoice=None if self.conditioning else defaults,referenceContract=1,conditioningFingerprint=self.conditioning['fingerprint'] if self.conditioning else None,seedContract=1,warmupSeed=defaults['seed'],workerPid=os.getpid(),**model_audit,environmentCheckMs=(environment_done-verified)*1000,runtimeImportMs=(imported-environment_done)*1000,modelLoadMs=(loaded-imported)*1000,loadMs=(time.perf_counter()-started)*1000,backend='cuda',dtype='bfloat16',mode='wav-reference' if self.conditioning else 'base',adapterSha256=None,referenceSha256=self.conditioning['sha256'] if self.conditioning else None,loadedKeys=0,skippedKeys=0,missingKeys=0,modelRevision=REVISION,sourceCommit=SOURCE,executionProfile='compiled',runtimeFingerprint=fingerprint,referenceCacheBuilds=self.engine.cache_builds,**self.engine.audit)
        def check_condition(self,request):
            if self.conditioning and request.get('binding',{}).get('conditioningFingerprint')!=self.conditioning['fingerprint']:raise ValueError('VOICE_REFERENCE_BINDING')
        def stream(self,request,credit):
            self.check_condition(request)
            return super().stream(request,credit)
        def synthesize(self,request):
            self.check_condition(request)
            return super().synthesize(request)
    return WindowsBaseWorker
