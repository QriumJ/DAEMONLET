"""Portable complete-package validation for user-selected compatible VoxCPM2 LoRAs."""
import re
from pathlib import Path
from worker import sha, inside, read_json, MODEL, REVISION, SOURCE, ADAPTER, CHECKSUMS


def verify_package(path):
    if path.is_symlink():raise ValueError('LINK')
    root=path.resolve();files={};folded=set();total=0;entries=0
    for p in root.rglob('*'):
        entries+=1
        if entries>256:raise ValueError('PACKAGE_CHANGED')
        if p.is_symlink():raise ValueError('LINK')
        name=p.relative_to(root).as_posix()
        if len(name)>240 or len(p.relative_to(root).parts)>8 or any(not part or part in ('.','..') or part[-1:] in (' ','.') or re.search(r'[\\:\x00-\x1f]',part) for part in p.relative_to(root).parts):raise ValueError('PATH')
        if any(re.match(r'^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)',part,re.I) for part in p.relative_to(root).parts):raise ValueError('PATH')
        if p.is_dir():continue
        if not p.is_file():raise ValueError('PATH')
        if name.lower() in folded:raise ValueError('PACKAGE_CHANGED')
        folded.add(name.lower());files[name]=p.stat().st_size;total+=files[name]
        if len(files)>128 or total>1024**3:raise ValueError('PACKAGE_CHANGED')
    if 'checksums.sha256' not in files or files['checksums.sha256']>1024**2:raise ValueError('PACKAGE_CHANGED')
    listed={};names=set()
    for line in (root/'checksums.sha256').read_text().strip().splitlines():
        match=re.fullmatch(r'([a-f0-9]{64})  (.+)',line)
        if not match:raise ValueError('PACKAGE_CHANGED')
        digest,name=match.groups();inside(root,name)
        if name=='checksums.sha256' or name.lower() in names:raise ValueError('PACKAGE_CHANGED')
        names.add(name.lower());listed[name]=digest
    if set(listed)!=set(files)-{'checksums.sha256'}:raise ValueError('PACKAGE_CHANGED')
    for name,digest in listed.items():
        if sha(inside(root,name))!=digest:raise ValueError('PACKAGE_CHANGED')
    voice=read_json(root/'voice.json')
    if voice.get('schema_version')!='voicelab.experimental.v1' or not re.fullmatch(r'[a-z0-9_-]{1,80}',voice.get('voice_id','')) or not re.fullmatch(r'[a-zA-Z0-9._-]{1,80}',voice.get('version','')):raise ValueError('SELECTION_MISMATCH')
    if not isinstance(voice.get('checkpoint'),str) or not voice['checkpoint'] or len(voice['checkpoint'])>120:raise ValueError('SELECTION_MISMATCH')
    if any(voice.get('engine',{}).get(k)!=v for k,v in dict(model_id=MODEL,model_revision=REVISION,source_commit=SOURCE).items()):raise ValueError('MODEL_REVISION')
    if voice.get('mode')!='reference' or voice.get('output_sample_rate')!=48000:raise ValueError('SELECTION_MISMATCH')
    for name in [voice['lora']+'/lora_config.json',voice['lora']+'/lora_weights.safetensors',voice['reference'],voice['preview'],'provenance.json','SOURCE_AND_USAGE_NOTES.md','VOXCPM-LICENSE']:
        if name not in listed:raise ValueError('PACKAGE_CHANGED')
    config=read_json(inside(root,voice['lora'])/'lora_config.json')
    expected=dict(r=32,alpha=32,dropout=0,enable_lm=True,enable_dit=True,enable_proj=False)
    if config.get('base_model')!=MODEL or any(config.get('lora_config',{}).get(k)!=v for k,v in expected.items()):raise ValueError('LORA_INCOMPLETE')
    if voice.get('inference')!=dict(cfg_value=2,inference_timesteps=10,normalize=False,denoise=False,retry_badcase=False,max_len=600,seed=42):raise ValueError('SELECTION_MISMATCH')
    adapter=listed[voice['lora']+'/lora_weights.safetensors'];digest=sha(root/'checksums.sha256');provenance=read_json(root/'provenance.json')
    if provenance.get('adapter_sha256')!=adapter or provenance.get('checkpoint')!=voice['checkpoint'] or provenance.get('condition',{}).get('reference_sha256')!=listed[voice['reference']]:raise ValueError('ADAPTER_MISMATCH')
    if voice['voice_id']=='belle_candidates_6000' and voice['version']=='0.5.0-selected-6000-e2' and (digest!=CHECKSUMS or adapter!=ADAPTER or voice['checkpoint']!='step_0002660'):raise ValueError('SELECTION_MISMATCH')
    return dict(voice=voice,packageSha256=digest,adapterSha256=adapter,referenceSha256=listed[voice['reference']])
