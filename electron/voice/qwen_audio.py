def pcm48(audio,rate):
    import numpy as np
    from scipy.signal import resample_poly
    from math import gcd
    if type(rate) is not int or rate not in (16000,22050,24000,44100,48000):raise ValueError('QWEN_SAMPLE_RATE')
    a=np.asarray(audio)
    if a.ndim!=1 or not 0<a.size<=rate*60 or not np.isfinite(a).all():raise ValueError('VOICE_INVALID_WAV')
    raw=np.asarray(a,dtype=np.float32)
    if rate!=48000:
        factor=gcd(rate,48000);a=resample_poly(raw,48000//factor,rate//factor)
    if not 0<a.size<=48000*60 or not np.isfinite(a).all():raise ValueError('VOICE_INVALID_WAV')
    # Required boundary conversion only: no loudness normalization, denoise or trim.
    pcm=np.rint(np.clip(a,-1,32767/32768)*32768).astype('<i2')
    return raw,pcm

class IncrementalPcm:
    """Keep the FIR tail until more real samples arrive; never fabricate audio."""
    def __init__(self,rate):self.rate=rate;self.parts=[];self.offset=0
    def push(self,a,final=False):
        import numpy as np
        self.parts.append(np.asarray(a,dtype=np.float32))
        raw,pcm=pcm48(np.concatenate(self.parts),self.rate)
        end=len(pcm) if final else max(self.offset,len(pcm)-64)
        out=pcm[self.offset:end];self.offset=end
        return raw,out
