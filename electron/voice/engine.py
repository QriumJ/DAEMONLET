"""Adapter for the pinned VoxCPM2 public cache APIs. No source/model mutation."""
import hashlib
import importlib.metadata
import json
import re
import time

PROFILES = {'baseline', 'cached', 'compiled'}


class Engine:
    def __init__(self, model, reference, settings, profile):
        if profile not in PROFILES:
            raise ValueError('EXECUTION_PROFILE')
        self.model, self.reference, self.settings, self.profile = model, reference, settings, profile
        self.cache = None
        self.cache_builds = 0
        self.compile_counts = {}
        self.audit = dict(compileRequested=profile == 'compiled', compileEffectiveByComponent={}, compileFailureCode=None, compileWarningsRedacted=[], warmupCompleted=False, conditioningMs=0)

    def prepare(self):
        import torch
        if self.profile != 'baseline':
            start = time.perf_counter()
            self.cache = self.model.tts_model.build_prompt_cache(reference_wav_path=str(self.reference))
            torch.cuda.synchronize()
            self.cache_builds += 1
            self.audit['conditioningMs'] = (time.perf_counter()-start)*1000
        if self.profile == 'compiled':
            try:
                import triton
                if not triton.__version__.startswith('3.4.') or not torch.__version__.startswith('2.8.'):
                    raise ValueError('COMPILE_RUNTIME')
                # Match torch 2.8's standard backend mode translation. Passing
                # `mode` directly to compile_fx is unsupported for custom backends.
                # PyTorch 2.8's Windows static launcher parses the CUDA stream
                # handle as C long (32-bit). Use its supported dynamic launcher
                # option; kernels and CUDA graphs remain compiled. No DLL patch.
                compiler = torch._TorchCompileInductorWrapper('reduce-overhead', {'use_static_cuda_launcher': False}, None)
                self.audit['staticCudaLauncher'] = False
                tts = self.model.tts_model
                # Pinned optimize() keeps variable-length prefill eager while
                # compiling the single-step encoder used during generation.
                tts._feat_encoder_raw = tts.feat_encoder
                # Same four targets and mode as pinned optimize(). The backend
                # wrapper records actual compiled graph execution, not just flags.
                for name, owner, field in [('base', tts.base_lm, 'forward_step'), ('residual', tts.residual_lm, 'forward_step'), ('encoder', tts, 'feat_encoder'), ('estimator', tts.feat_decoder, 'estimator')]:
                    counts = self.compile_counts[name] = dict(graphs=0, executions=0)
                    def backend(graph, inputs, _counts=counts, **kwargs):
                        compiled = compiler(graph, inputs)
                        _counts['graphs'] += 1
                        def execute(*args):
                            result = compiled(*args)
                            _counts['executions'] += 1
                            return result
                        return execute
                    setattr(owner, field, torch.compile(getattr(owner, field), backend=backend, fullgraph=True))
            except Exception as error:
                raise ValueError('COMPILE_UNAVAILABLE') from error

    def generate(self, text, streaming=False):
        if self.profile == 'baseline':
            if streaming:
                raise ValueError('EXECUTION_PROFILE')
            yield self.model.generate(text=text, reference_wav_path=str(self.reference), **self.settings)
            return
        text = re.sub(r'\s+', ' ', text.replace('\n', ' '))
        settings = {key: self.settings[key] for key in ('cfg_value', 'inference_timesteps', 'retry_badcase', 'max_len', 'seed')}
        tts = self.model.tts_model
        if streaming:
            result = tts.generate_with_prompt_cache_streaming(target_text=text, prompt_cache=self.cache, **settings)
            try:
                for audio, _, _ in result:
                    yield audio.squeeze(0).cpu().numpy()
            finally:
                result.close()
        else:
            audio, _, _ = tts.generate_with_prompt_cache(target_text=text, prompt_cache=self.cache, **settings)
            yield audio.squeeze(0).cpu().numpy()

    def warmup(self):
        if self.profile == 'baseline':
            return
        import torch
        start = time.perf_counter()
        try:
            for _ in self.generate('응, 듣고 있어. 지금은 어떤 이야기를 할까?'):
                pass
            torch.cuda.synchronize()
            if self.profile == 'compiled':
                self.audit['compileEffectiveByComponent'] = {k: v['graphs'] > 0 and v['executions'] > 0 for k, v in self.compile_counts.items()}
                if len(self.audit['compileEffectiveByComponent']) != 4 or not all(self.audit['compileEffectiveByComponent'].values()):
                    raise ValueError('COMPILE_UNAVAILABLE')
            self.audit.update(warmupCompleted=True, warmupMs=(time.perf_counter()-start)*1000, compileCounts=self.compile_counts)
        except Exception as error:
            if self.profile == 'compiled':
                self.audit.update(compileFailureCode='COMPILE_UNAVAILABLE', compileWarningsRedacted=[type(error).__name__], compileCounts=self.compile_counts)
                raise ValueError('COMPILE_UNAVAILABLE') from error
            raise


def runtime_fingerprint(profile, identity):
    versions = {}
    for name in ['torch', 'torchaudio', 'transformers', 'triton-windows']:
        try:
            versions[name] = importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError:
            versions[name] = None
    return hashlib.sha256(json.dumps(dict(profile=profile, identity=identity, versions=versions), sort_keys=True).encode()).hexdigest()
