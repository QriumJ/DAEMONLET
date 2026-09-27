"""Device policy. No implicit CPU fallback or CUDA compilation on Apple Silicon."""
import os
import platform
import sys


class WorkerError(Exception):
    pass


class CudaDevice:
    device = 'cuda'
    dtype = 'bfloat16'
    profiles = {'baseline', 'cached', 'compiled'}

    @staticmethod
    def require_platform():
        if sys.platform != 'win32':
            raise WorkerError('UNSUPPORTED_DEVICE')

    @staticmethod
    def require(torch):
        CudaDevice.require_platform()
        if not torch.cuda.is_available() or not torch.cuda.is_bf16_supported():
            raise WorkerError('UNSUPPORTED_DEVICE')

    @staticmethod
    def synchronize(torch):
        torch.cuda.synchronize()

    @staticmethod
    def begin_measurement(torch):
        torch.cuda.reset_peak_memory_stats()

    @staticmethod
    def memory(torch):
        return dict(peakAllocatedBytes=torch.cuda.max_memory_allocated(), peakReservedBytes=torch.cuda.max_memory_reserved())

    @staticmethod
    def identity(torch):
        return dict(device=torch.cuda.get_device_name(), capability=torch.cuda.get_device_capability(), dtype='bfloat16', backend='cuda')


class MpsDevice:
    device = 'mps'
    dtype = 'float32'
    profiles = {'mps-fp32-baseline', 'mps-fp32'}

    @staticmethod
    def require_platform():
        if sys.platform != 'darwin' or platform.machine() != 'arm64':
            raise WorkerError('UNSUPPORTED_DEVICE')
        # Refuse inherited low-precision / mixed CPU execution overrides.
        if os.environ.get('PYTORCH_ENABLE_MPS_FALLBACK', '0') != '0' or os.environ.get('VOXCPM_MPS_DTYPE', 'float32') not in ('float32', 'fp32'):
            raise WorkerError('RUNTIME_POLICY')

    @staticmethod
    def require(torch):
        MpsDevice.require_platform()
        if not torch.backends.mps.is_built() or not torch.backends.mps.is_available():
            raise WorkerError('UNSUPPORTED_DEVICE')

    @staticmethod
    def synchronize(torch):
        torch.mps.synchronize()

    @staticmethod
    def begin_measurement(torch):
        pass  # MPS has no CUDA-equivalent reset/peak allocator counters.

    @staticmethod
    def memory(torch):
        return dict(mpsCurrentAllocatedBytes=torch.mps.current_allocated_memory(), mpsDriverAllocatedBytes=torch.mps.driver_allocated_memory())

    @staticmethod
    def identity(torch):
        return dict(device='Apple Silicon MPS', dtype='float32', backend='mps')

    @staticmethod
    def audit_model(model, torch):
        parameters = list(model.parameters())
        if not parameters or any(p.device.type != 'mps' or (p.is_floating_point() and p.dtype != torch.float32) for p in parameters):
            raise WorkerError('RUNTIME_TENSORS')
        return dict(parameterCount=len(parameters), effectiveDevice='mps', effectiveDtype='float32')


def select_backend(profile):
    backend = MpsDevice if profile in MpsDevice.profiles else CudaDevice
    backend.require_platform()
    if profile not in backend.profiles:
        raise WorkerError('EXECUTION_PROFILE')
    return backend
