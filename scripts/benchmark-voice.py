"""Explicit local GPU benchmark. Never downloads models or publishes audio."""
import argparse
import contextlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import time
import uuid


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--package', required=True)
    parser.add_argument('--model', required=True)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--profile', default='baseline')
    parser.add_argument('--compiler-cache', type=Path)
    parser.add_argument('--worker', type=Path, default=Path(__file__).resolve().parents[1] / 'electron/voice/worker.py')
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=False)
    sys.path.insert(0, str(args.worker.parent.resolve()))
    spec = importlib.util.spec_from_file_location('voice_worker', args.worker)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    report = dict(profile=args.profile, pid=os.getpid(), session=str(uuid.uuid4()), measurements=[], physicalListening='NOT_TESTED')
    try:
        with contextlib.redirect_stdout(sys.stderr):
            worker = module.Worker()
            start = time.perf_counter()
            report['audit'] = worker.initialize(dict(package=args.package, model=args.model, cache=str(args.output / 'audio'), executionProfile=args.profile, compilerCache=str(args.compiler_cache or args.output.parent / 'compiler')))
            report['workerInitMs'] = (time.perf_counter()-start)*1000
            import torch
            report['environment'] = dict(python=sys.version, executable=sys.executable, torch=torch.__version__, cuda=torch.version.cuda, device=torch.cuda.get_device_name(), dtype='bfloat16')
            for repeat in range(3):
                for index, text in enumerate(['응, 듣고 있어. 지금은 어떤 이야기를 할까?', '먼저 파일을 확인할게. 문제가 없으면 다음 작업으로 넘어가자.']):
                    result = worker.synthesize(dict(text=text, audioId=str(uuid.uuid4()), binding={}, segmentIndex=index))
                    report['measurements'].append(dict(repeat=repeat, sentence=index, **result))
                    (args.output / 'result.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
                    print(json.dumps(dict(repeat=repeat, sentence=index, **result)), file=sys.stderr, flush=True)
        report['status'] = 'PASS'
    except Exception as error:
        report['status'] = 'FAIL'
        report['errorCode'] = module.error_code(error)
        if hasattr(worker, 'engine'):
            report['audit'] = worker.engine.audit
        raise
    finally:
        (args.output / 'result.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')


if __name__ == '__main__':
    main()
