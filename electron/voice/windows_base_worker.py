"""Default voice on the existing Windows PyTorch/CUDA compiled path.
No LoRA, reference file, GGUF conversion or training.
"""
import hashlib
import importlib.metadata as metadata
import os
from pathlib import Path
import platform
import sys
import time
from worker import sha,inside,read_json,REVISION,SOURCE
from backend import CudaDevice


def policy():return read_json(Path(__file__).with_name('runtime-windows-base.json'))


def verify_model(root,expected):
    if root.is_symlink():raise ValueError('LINK')
    for name,f in expected['model']['files'].items():
        p=inside(root,name)
        if not p.is_file() or p.stat().st_size!=f['bytes'] or sha(p)!=f['sha256']:raise ValueError('MODEL_CHANGED')


def verify_environment(expected):
    if sys.platform!='win32' or platform.python_version()!=expected['python']:raise ValueError('RUNTIME_VERSION')
    receipt=read_json(Path(sys.prefix)/'voice-runtime.json')
    if receipt.get('source_commit')!=SOURCE:raise ValueError('RUNTIME_RECEIPT')
    for name,version in expected['dependencies'].items():
        if metadata.version(name)!=version:raise ValueError('RUNTIME_VERSION')
    import voxcpm
    root=Path(voxcpm.__file__).parent
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
            base=Path(request['model']);verify_model(base,expected);verify_environment(expected)
            import torch
            self.backend.require(torch)
            from engine import Engine,runtime_fingerprint
            identity=dict(defaultVoice=defaults,model=REVISION,source=SOURCE,adapter='none',reference='none',policy=sha(Path(__file__).with_name('runtime-windows-base.json')),**self.backend.identity(torch),python=sys.version,engine=sha(Path(__file__).with_name('engine.py')))
            fingerprint=runtime_fingerprint('compiled',identity);compiler=Path(request['compilerCache'])/fingerprint;compiler.mkdir(parents=True,exist_ok=True)
            os.environ.update(TORCHINDUCTOR_CACHE_DIR=str(compiler/'inductor'),TRITON_CACHE_DIR=str(compiler/'triton'),NUMBA_CACHE_DIR=str(compiler/'numba'))
            from voxcpm import VoxCPM
            self.model=VoxCPM.from_pretrained(str(base),device='cuda',optimize=False,load_denoiser=False,local_files_only=True)
            if any('lora_' in name for name,_ in self.model.tts_model.named_parameters()):raise ValueError('LORA_TENSORS')
            self.settings={**expected['settings'],'seed':defaults['seed']};self.reference=None;self.model.tts_model.eval();self.backend.synchronize(torch)
            self.engine=Engine(self.model,None,self.settings,'compiled',self.backend,voice_description=defaults['description']);self.engine.prepare();self.engine.warmup()
            self.vae_forwards=[(m,m.forward) for m in self.model.tts_model.audio_vae.decoder.modules()]
            return dict(defaultVoice=defaults,workerPid=os.getpid(),loadMs=(time.perf_counter()-started)*1000,backend='cuda',dtype='bfloat16',mode='base',adapterSha256=None,referenceSha256=None,loadedKeys=0,skippedKeys=0,missingKeys=0,modelRevision=REVISION,sourceCommit=SOURCE,executionProfile='compiled',runtimeFingerprint=fingerprint,referenceCacheBuilds=0,**self.engine.audit)
    return WindowsBaseWorker
