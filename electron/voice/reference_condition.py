"""Strict managed reference contract. Standard library only; never reads the import source."""
import hashlib
import json
import math
import os
from pathlib import Path
import re
import stat
import struct

POLICY=json.loads(Path(__file__).with_name('reference-policy.json').read_text(encoding='utf-8'))


def verify_reference_condition(condition,cache):
    try:
        if not isinstance(condition,dict) or set(condition)!={'kind','path','sha256','preprocessingVersion','fingerprint','sampleRate','samples'}:raise ValueError()
        if condition['kind']!='wav-reference' or condition['preprocessingVersion']!=POLICY['preprocessingVersion']:raise ValueError()
        for name in ('sha256','fingerprint'):
            if not isinstance(condition[name],str) or not re.fullmatch('[a-f0-9]{64}',condition[name]):raise ValueError()
        path=Path(condition['path'])
        if not path.is_absolute() or path.name!='reference.wav' or '..' in path.parts:raise ValueError()
        for p in [path,*path.parents]:
            s=p.lstat()
            if p.is_symlink() or getattr(s,'st_file_attributes',0)&getattr(stat,'FILE_ATTRIBUTE_REPARSE_POINT',0x400):raise ValueError()
        fd=os.open(path,os.O_RDONLY|getattr(os,'O_NOFOLLOW',0)|getattr(os,'O_BINARY',0))
        with os.fdopen(fd,'rb') as f:
            before=os.fstat(f.fileno())
            if not stat.S_ISREG(before.st_mode) or not 44<=before.st_size<=44+POLICY['maxSeconds']*48000*2:raise ValueError()
            data=f.read(before.st_size+1);after=os.fstat(f.fileno())
        if len(data)!=before.st_size or any(getattr(before,k)!=getattr(after,k) for k in ('st_dev','st_ino','st_size','st_mtime_ns','st_ctime_ns')):raise ValueError()
        if hashlib.sha256(data).hexdigest()!=condition['sha256']:raise ValueError()
        if data[:4]!=b'RIFF' or data[8:16]!=b'WAVEfmt ' or data[36:40]!=b'data':raise ValueError()
        size,=struct.unpack_from('<I',data,4);fmt,encoding,channels,rate,byte_rate,align,bits=struct.unpack_from('<IHHIIHH',data,16);length,=struct.unpack_from('<I',data,40)
        if size+8!=len(data) or fmt!=16 or encoding!=1 or channels!=1 or rate not in POLICY['sampleRates'] or byte_rate!=rate*2 or align!=2 or bits!=16 or length!=len(data)-44 or length%2:raise ValueError()
        samples=length//2
        if not rate*POLICY['minSeconds']<=samples<=rate*POLICY['maxSeconds'] or type(condition['sampleRate']) is not int or condition['sampleRate']!=rate or type(condition['samples']) is not int or condition['samples']!=samples:raise ValueError()
        total=squared=0.0
        for (sample,) in struct.iter_unpack('<h',data[44:]):
            v=sample/32768;total+=v;squared+=v*v
        if math.sqrt(max(0,squared/samples-(total/samples)**2))<POLICY['minAcRms']:raise ValueError()
        # The engine reads this owned immutable snapshot, never a path that can change after validation.
        reference=Path(cache)/'reference.wav'
        with reference.open('xb') as f:f.write(data);f.flush();os.fsync(f.fileno())
        return dict(condition,path=reference)
    except (ValueError,TypeError,KeyError,OSError,OverflowError,struct.error) as e:
        raise ValueError('VOICE_REFERENCE_CHANGED') from e
