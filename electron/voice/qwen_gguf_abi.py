"""ctypes ABI 5 for the reviewed Windows x64 qwentts.cpp build.

The layout is checked before a native entry is called. No library is loaded by
importing this module. Structures and callbacks use the C calling convention.
"""
import ctypes as C
from types import SimpleNamespace

ABI_VERSION = 5
CancelCB = C.CFUNCTYPE(C.c_bool, C.c_void_p)
ChunkCB = C.CFUNCTYPE(C.c_bool, C.POINTER(C.c_float), C.c_int, C.c_void_p)
LogCB = C.CFUNCTYPE(None, C.c_int, C.c_char_p, C.c_void_p)


class Init(C.Structure):
    _fields_ = [('abi_version', C.c_int), ('talker_path', C.c_char_p), ('codec_path', C.c_char_p),
                ('use_fa', C.c_bool), ('clamp_fp16', C.c_bool), ('max_batch', C.c_int),
                ('codec_chunk_sec', C.c_float)]


class Audio(C.Structure):
    _fields_ = [('samples', C.POINTER(C.c_float)), ('n_samples', C.c_int),
                ('sample_rate', C.c_int), ('channels', C.c_int)]


class Ref(C.Structure):
    _fields_ = [('ref_spk_emb', C.POINTER(C.c_float)), ('ref_spk_dim', C.c_int),
                ('ref_codes', C.POINTER(C.c_int32)), ('ref_T', C.c_int), ('num_codebooks', C.c_int)]


class Params(C.Structure):
    _fields_ = [('abi_version', C.c_int), ('text', C.c_char_p), ('lang', C.c_char_p),
                ('instruct', C.c_char_p), ('speaker', C.c_char_p), ('ref_audio_24k', C.POINTER(C.c_float)),
                ('ref_n_samples', C.c_int), ('ref_text', C.c_char_p), ('seed', C.c_int64),
                ('max_new_tokens', C.c_int), ('temperature', C.c_float), ('top_k', C.c_int),
                ('top_p', C.c_float), ('repetition_penalty', C.c_float), ('subtalker_temperature', C.c_float),
                ('subtalker_top_k', C.c_int), ('subtalker_top_p', C.c_float), ('dump_dir', C.c_char_p),
                ('cancel', CancelCB), ('cancel_user_data', C.c_void_p), ('on_chunk', ChunkCB),
                ('on_chunk_user_data', C.c_void_p), ('ref_spk_emb', C.POINTER(C.c_float)),
                ('ref_spk_dim', C.c_int), ('ref_codes', C.POINTER(C.c_int32)), ('ref_T', C.c_int)]


def verify_layout(layout):
    """Compare against the C++ sizeof/offsetof probe from the pinned header."""
    for name, cls in [('Init', Init), ('Audio', Audio), ('Ref', Ref), ('Params', Params)]:
        if layout[name]['size'] != C.sizeof(cls):
            raise ValueError('QWEN_GGUF_ABI')
        for field, _ in cls._fields_:
            if layout[name]['offsets'][field] != getattr(cls, field).offset:
                raise ValueError('QWEN_GGUF_ABI')


def bind(lib):
    lib.qt_version.argtypes = []; lib.qt_version.restype = C.c_char_p
    lib.qt_model_type.argtypes = [C.c_void_p]; lib.qt_model_type.restype = C.c_char_p
    lib.qt_init_default_params.argtypes = [C.POINTER(Init)]; lib.qt_init_default_params.restype = None
    lib.qt_init.argtypes = [C.POINTER(Init)]; lib.qt_init.restype = C.c_void_p
    lib.qt_tts_default_params.argtypes = [C.POINTER(Params)]; lib.qt_tts_default_params.restype = None
    lib.qt_extract_voice_ref.argtypes = [C.c_void_p, C.POINTER(C.c_float), C.c_int, C.POINTER(Ref)]
    lib.qt_extract_voice_ref.restype = C.c_int
    lib.qt_synthesize.argtypes = [C.c_void_p, C.POINTER(Params), C.POINTER(Audio)]
    lib.qt_synthesize.restype = C.c_int
    lib.qt_audio_free.argtypes = [C.POINTER(Audio)]; lib.qt_audio_free.restype = None
    lib.qt_voice_ref_free.argtypes = [C.POINTER(Ref)]; lib.qt_voice_ref_free.restype = None
    lib.qt_free.argtypes = [C.c_void_p]; lib.qt_free.restype = None
    lib.qt_log_set.argtypes = [LogCB, C.c_void_p]; lib.qt_log_set.restype = None
    return lib


def bind_devices(registry, base):
    """The pinned Windows build exports registry and device APIs separately.

    ggml-backend-reg.cpp belongs to ggml.dll; ggml-backend.cpp belongs to
    ggml-base.dll. Explicitly bind each export from its defining library and
    keep both handles alive for the opaque device pointer's lifetime.
    """
    functions = {}
    for name, lib, args, result in [
        ('ggml_backend_dev_by_name',registry,[C.c_char_p],C.c_void_p),
        ('ggml_backend_dev_name',base,[C.c_void_p],C.c_char_p),
        ('ggml_backend_dev_description',base,[C.c_void_p],C.c_char_p),
        ('ggml_backend_dev_type',base,[C.c_void_p],C.c_int),
        ('ggml_backend_dev_memory',base,[C.c_void_p,C.POINTER(C.c_size_t),C.POINTER(C.c_size_t)],None),
    ]:
        function = getattr(lib,name); function.argtypes = args; function.restype = result
        functions[name] = function
    return SimpleNamespace(**functions,_libraries=(registry,base))
