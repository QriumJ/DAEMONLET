"""Small real-device baseline; results/audio stay outside the source tree."""
import argparse
import contextlib
import json
import os
from pathlib import Path
import platform
import sys
import time
import traceback
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'electron/voice'))
from worker import Worker


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--package', required=True, type=Path)
    parser.add_argument('--model', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    output = args.output.resolve()
    if output.is_relative_to(ROOT):
        parser.error('Private results must be outside checkout')
    output.mkdir(parents=True, exist_ok=False)
    report = dict(status='RUNNING', scope='MPS-FP32-engine-only', host=dict(platform=sys.platform, arch=platform.machine(), os=platform.mac_ver(), python=platform.python_version()), overrides={k:os.environ.get(k) for k in ['VOXCPM_MPS_DTYPE','PYTORCH_ENABLE_MPS_FALLBACK']}, measurements=[], appPlayback='NOT_TESTED', listening='NOT_TESTED')
    def save():
        (output/'result.json').write_text(json.dumps(report, indent=2)+'\n')
    save()
    with (output/'engine.log').open('w') as log, contextlib.redirect_stdout(log), contextlib.redirect_stderr(log):
        try:
            worker = Worker()
            report['load'] = worker.initialize(dict(package=str(args.package.resolve()), model=str(args.model.resolve()), cache=str(output/'audio'), executionProfile='mps-fp32-baseline', warmup=False))
            save()
            # First pass cold, then two warm passes; no optimization/CPU fallback.
            for repeat in range(3):
                for index, text in enumerate(['응.', '오빠, 오늘은 어떤 이야기를 할까?']):
                    result = worker.synthesize(dict(text=text, audioId=str(uuid.uuid4()), binding={}, segmentIndex=index))
                    report['measurements'].append(dict(repeat=repeat, index=index, **result))
                    save()
                if repeat == 1 and all(v['rtf'] > 1 for v in report['measurements'][-2:]):
                    report['throughput'] = 'NOT_REALTIME'
                    # Budget is still one final warm pass, never an open-ended search.
            report['status'] = 'PASS'
        except Exception as error:
            report.update(status='FAIL', errorType=type(error).__name__, error=str(error))
            traceback.print_exc(file=log)
        finally:
            save()
    print(json.dumps(report, indent=2))
    return 0 if report['status'] == 'PASS' else 1


if __name__ == '__main__':
    raise SystemExit(main())
