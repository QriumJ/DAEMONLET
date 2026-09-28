"""Bounded diagnostic only: production profiles, assets and runtime stay FP32.

Load/audit the selected package through the production worker first, then change
only in-memory non-VAE tensors and rebuild the two non-module KV caches. Never
cast AudioVAE down and back up: that would irreversibly round its parameters.
"""
import argparse
import contextlib
import hashlib
import json
import os
import signal
from pathlib import Path
import sys
import time
import traceback
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'electron/voice'))
import worker as worker_module
from worker import Worker
from engine import Engine
from backend import MpsDevice

TEXTS = ['응.', '오빠, 오늘은 어떤 이야기를 할까?', '내일 오후 세 시에 다시 확인해 줘.', 'RTX 4090으로 음성을 만들고 있어.', '먼저 파일을 확인할게. 문제가 없으면 다음 작업으로 넘어가자.']


def retype_model(tts, dtype_name, torch):
    dtype = getattr(torch, dtype_name)
    for name, child in tts.named_children():
        if name != 'audio_vae':
            child.to(dtype=dtype)
    tts.config.dtype = dtype_name
    for lm in (tts.base_lm, tts.residual_lm):
        lm.setup_cache(1, tts.config.max_length, 'mps', dtype)
    groups = {}
    for name, tensor in tts.named_parameters():
        required = torch.float32 if name.startswith('audio_vae.') else dtype
        if tensor.device.type != 'mps' or tensor.dtype != required or not torch.isfinite(tensor).all().item():
            raise ValueError('EXPERIMENT_TENSOR_AUDIT')
        key = 'audioVaeFp32' if name.startswith('audio_vae.') else dtype_name
        groups[key] = groups.get(key, 0) + 1
    for lm in (tts.base_lm, tts.residual_lm):
        tensor = lm.kv_cache.kv_cache
        if tensor.device.type != 'mps' or tensor.dtype != dtype or lm.kv_cache.current_length != 0:
            raise ValueError('EXPERIMENT_KV_AUDIT')
    torch.mps.synchronize()
    return dict(parameters=groups, kvDevice='mps', kvDtype=dtype_name, audioVaeDtype='float32')


def wav_stats(path):
    import numpy as np
    import soundfile as sf
    audio, sr = sf.read(path, dtype='float32')
    return dict(sha256=hashlib.sha256(path.read_bytes()).hexdigest(), samples=len(audio), sampleRate=sr,
                peak=float(np.max(np.abs(audio))), rms=float(np.sqrt(np.mean(audio**2))),
                clippedFraction=float(np.mean(np.abs(audio)>=.999)),
                nearSilentFraction=float(np.mean(np.abs(audio)<1e-4)))


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--package',required=True,type=Path)
    parser.add_argument('--model',required=True,type=Path)
    parser.add_argument('--output',required=True,type=Path)
    parser.add_argument('--dtype',required=True,choices=['float32','bfloat16','float16'])
    parser.add_argument('--passes', type=int, choices=[1,2], default=2)
    parser.add_argument('--skip-stream', action='store_true')
    args=parser.parse_args()
    output=args.output.resolve()
    if output.is_relative_to(ROOT):parser.error('Private outputs must stay outside Git')
    output.mkdir(parents=True,exist_ok=False)
    report=dict(status='RUNNING',scope='isolated-precision-diagnostic',dtype=args.dtype,
                physicalListening='NOT_TESTED',appIntegration='NOT_TESTED',measurements=[],streams=[],
                assetsModified=False, settingsChanged=False)
    def save(): (output/'result.json').write_text(json.dumps(report,indent=2)+'\n')
    save()
    with (output/'engine.log').open('w') as log,contextlib.redirect_stdout(log),contextlib.redirect_stderr(log):
        try:
            def expired(*_):raise TimeoutError('EXPERIMENT_TIME_LIMIT')
            signal.signal(signal.SIGALRM, expired)
            signal.alarm(240)
            import torch
            worker=Worker()
            report['verifiedFp32Load']=worker.initialize(dict(package=str(args.package.resolve()),model=str(args.model.resolve()),cache=str(output/'audio'),executionProfile='mps-fp32-baseline',warmup=False))
            report['effectiveTensors']=retype_model(worker.model.tts_model,args.dtype,torch)
            report['settings']=worker.settings.copy()
            save()
            # Small first pass then exact repeats; no automatic retries or tuning.
            for repeat in range(args.passes):
                for index,text in enumerate(TEXTS):
                    ident=str(uuid.uuid4())
                    metrics=worker.synthesize(dict(text=text,audioId=ident,binding={},segmentIndex=index))
                    path=output/'audio'/f'{ident}.wav'
                    named=output/f'{repeat}-{index}.wav';path.replace(named)
                    report['measurements'].append(dict(repeat=repeat,index=index,text=text,file=named.name,**(metrics | wav_stats(named))))
                    save()
            # Same cache/chunk implementation as the app, with immediate credits.
            worker.engine=Engine(worker.model,worker.reference,worker.settings,'mps-fp32',MpsDevice)
            if not args.skip_stream:worker.engine.prepare()
            import numpy as np
            import soundfile as sf
            for index in ([] if args.skip_stream else [1,4]):
                chunks=[]
                def capture(kind, request_id, **value):
                    if kind=='audio-chunk':
                        path=worker.cache/(value['audioId']+'.wav')
                        chunks.append(sf.read(path,dtype='float32')[0]);path.unlink()
                worker_module.emit=capture
                metrics=worker.stream(dict(text=TEXTS[index],streamVersion=1,requestId=str(uuid.uuid4()),synthesisId=str(uuid.uuid4()),binding={},segmentIndex=index),lambda _:None)
                named=output/f'stream-{index}.wav';sf.write(named,np.concatenate(chunks),48000,subtype='PCM_16')
                report['streams'].append(dict(index=index,file=named.name,**(metrics | wav_stats(named))))
                save()
            report['repeatDeterministic']=(all(report['measurements'][i]['sha256']==report['measurements'][i+len(TEXTS)]['sha256'] for i in range(len(TEXTS))) if args.passes==2 else None)
            report['status']='PASS_NUMERICAL_ONLY'
        except KeyboardInterrupt:
            report.update(status='INTERRUPTED', stopReason='Operator stopped the owned diagnostic')
        except Exception as error:
            report.update(status='FAIL',errorType=type(error).__name__,error=str(error))
            traceback.print_exc(file=log)
        finally:
            signal.alarm(0)
            save()
    print(json.dumps(dict(status=report['status'],dtype=args.dtype,completed=len(report['measurements']),error=report.get('error'))))
    return 0 if report['status']=='PASS_NUMERICAL_ONLY' else 1

if __name__=='__main__':raise SystemExit(main())
