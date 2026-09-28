"""User-selected compatible LoRA -> original-base FP32 merge -> audited GGUF cache.

No downloads/training/quantization. Originals are hashed and never written.
The external C++ source must be the reviewed immutable commit. This tool does not
register a backend in the application or claim inference/listening equivalence.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

ROOT=Path(__file__).resolve().parent
from worker import sha,inside,read_json,MODEL,REVISION,SOURCE
from voice_package import verify_package
CPP_SOURCE='873056743b74e1a4ce5dcf7290e2298428e214db'
BASE_SHA='f7f964cfa9da23653baec6e6f7750719977ad944ed9f95fe52fe3a620506891d'


def main():
    if sys.flags.optimize:
        raise RuntimeError("Run without -O: diagnostic validation must remain enabled")
    parser=argparse.ArgumentParser()
    for key in ['package','model','source','output']:parser.add_argument('--'+key,required=True,type=Path)
    parser.add_argument('--dtype',choices=['f32','f16'],default='f32')
    args=parser.parse_args()
    package,model,source,output=[getattr(args,k).resolve() for k in ['package','model','source','output']]
    if output.exists() or output.is_relative_to(ROOT) or any(output.is_relative_to(p) or p.is_relative_to(output) for p in [package,model,source]):
        parser.error('Use a new, separate output outside the repository and inputs')
    from macos_runtime import verify_runtime
    verify_runtime(read_json(Path(sys.prefix)/'voice-runtime.json'))
    policy=read_json(ROOT/'runtime-gguf-macos.json')
    for name,digest in policy['converterFiles'].items():
        if sha(inside(source,name))!=digest:raise ValueError('CONVERTER_SOURCE_CHANGED')
    selected=verify_package(package);voice=selected['voice']
    adapter_sha=selected['adapterSha256'];package_sha=selected['packageSha256']
    snapshot=read_json(model/'snapshot-provenance.json')
    assert snapshot['model_id']==MODEL and snapshot['revision']==REVISION
    for name,digest in snapshot['files'].items():assert sha(inside(model,name))==digest,name
    assert sha(model/'model.safetensors')==BASE_SHA
    lora=inside(package,voice['lora']);assert sha(lora/'lora_weights.safetensors')==adapter_sha
    config=read_json(lora/'lora_config.json')['lora_config']
    assert config['r']==32 and config['alpha']==32 and config['dropout']==0 and not config['enable_proj']
    import torch
    import numpy as np
    from safetensors.torch import load_file,save_file
    torch.set_num_threads(4)
    base=load_file(str(model/'model.safetensors'))
    adapter=load_file(str(lora/'lora_weights.safetensors'))
    assert len(adapter)==384 and all(torch.isfinite(t).all() for t in adapter.values())
    assert not any('lora_' in key for key in base)
    expected={f'{prefix}.layers.{i}.self_attn.{proj}.lora_{part}' for prefix,count in [('base_lm',28),('residual_lm',8),('feat_decoder.estimator.decoder',12)] for i in range(count) for proj in ['q_proj','k_proj','v_proj','o_proj'] for part in ['A','B']}
    assert set(adapter)==expected,'LORA_KEY_SET'
    merged={key:value.float().contiguous() for key,value in base.items()}
    del base
    records=[];generator=torch.Generator().manual_seed(42)
    digest_tensor=lambda t:hashlib.sha256(t.contiguous().numpy().tobytes()).hexdigest()
    for key in sorted(k for k in adapter if k.endswith('.lora_A')):
        prefix=key[:-7];weight_key=prefix+'.weight';b_key=prefix+'.lora_B'
        a,b=adapter[key].float(),adapter[b_key].float();weight=merged[weight_key]
        assert a.shape[0]==b.shape[1]==32 and (b.shape[0],a.shape[1])==tuple(weight.shape)
        delta=(b@a)*(config['alpha']/config['r']);combined=(weight+delta).contiguous()
        assert torch.isfinite(combined).all()
        x=torch.randn(3,a.shape[1],generator=generator)
        original=torch.nn.functional.linear(x,weight)+torch.nn.functional.linear(torch.nn.functional.linear(x,a),b)
        folded=torch.nn.functional.linear(x,combined)
        torch.testing.assert_close(folded,original,rtol=2e-4,atol=2e-5)
        records.append(dict(a=key,b=b_key,weight=weight_key,aShape=list(a.shape),bShape=list(b.shape),weightShape=list(weight.shape),scale=1,baseFp32Sha256=digest_tensor(weight),deltaSha256=digest_tensor(delta),mergedSha256=digest_tensor(combined),linearMaxAbsError=float((folded-original).abs().max())))
        merged[weight_key]=combined
    assert len(records)==192
    output.mkdir(parents=True)
    manifest=dict(status='MERGED_NOT_CONVERTED',sourceCommit=CPP_SOURCE,upstreamSourceCommit=SOURCE,modelRevision=REVISION,originalBaseSha256=BASE_SHA,adapterSha256=adapter_sha,packageSha256=package_sha,mergeCount=1,mergeDtype='float32',ggufDtype=args.dtype,quantization=False,adapterKeys=384,mergedMatrices=192,records=records)
    def save(): (output/'conversion.json').write_text(json.dumps(manifest,indent=2)+'\n')
    save()
    merged_file=output/'model.safetensors';save_file(merged,str(merged_file))
    manifest['mergedFileSha256']=sha(merged_file)
    # The pinned converter's lightweight reader assumes lexical offset order.
    # Require our all-F32 derivative to satisfy that assumption before conversion.
    import struct
    with merged_file.open('rb') as f:header=json.loads(f.read(struct.unpack('<Q',f.read(8))[0]))
    offset=0
    for key in sorted(header):
        assert header[key]['dtype']=='F32' and header[key]['data_offsets'][0]==offset
        offset=header[key]['data_offsets'][1]
    manifest['converterOffsetOrderChecked']=True
    converter_input=merged_file
    if args.dtype=='f16':
        # Pinned SafeTensorFile keeps F32 acoustic weights even with --dtype f16.
        # Its supported weights_only DictWeightSource path applies the cast.
        converter_input=output/'merged-fp32.bin'
        torch.save(merged,converter_input)
        manifest['converterInputSha256']=sha(converter_input)
        manifest['converterInputFormat']='pytorch-weights-only-fp32'
    save()
    expected_gguf={r['weight']:hashlib.sha256(merged[r['weight']].numpy().astype(np.float32 if args.dtype=='f32' else np.float16).tobytes()).hexdigest() for r in records}
    del merged
    converter=source/'tools/omni/voxcpm2/convert_voxcpm2_to_gguf.py'
    manifest['converterSha256']=sha(converter)
    command=[sys.executable,'-B',str(converter),'--model',converter_input.name,'--vae',str(model/'audiovae.pth'),'--config',str(model/'config.json'),'--tokenizer-dir',str(model),'--output',str(output/'gguf'),'--dtype',args.dtype]
    import runpy,contextlib
    os.environ.update(HF_HUB_OFFLINE='1',TRANSFORMERS_OFFLINE='1',PYTHONDONTWRITEBYTECODE='1')
    old_argv=sys.argv;old_cwd=Path.cwd()
    try:
        sys.argv=command[2:]
        # Upstream guesses model names from path substrings (including package versions).
        # Pass only our scratch basename so a version like 0.5.0 cannot rename VoxCPM2.
        os.chdir(output)
        with (output/'converter.log').open('w') as log,contextlib.redirect_stdout(log),contextlib.redirect_stderr(log):runpy.run_path(str(converter),run_name='__main__')
    finally:sys.argv=old_argv;os.chdir(old_cwd)
    spec=importlib.util.spec_from_file_location('pinned_converter',converter);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    from gguf import GGUFReader
    readers={group:GGUFReader(str(output/'gguf'/f'VoxCPM2-{group}-{args.dtype.upper()}.gguf')) for group in ['BaseLM','Acoustic']}
    tensors={group:{t.name:t for t in reader.tensors} for group,reader in readers.items()}
    maps={**module.BASE_LM_GGUF_TENSOR_MAP,**module.ACOUSTIC_GGUF_PREFIX_MAP}
    for record in records:
        matches=[]
        for template,target in maps.items():
            pattern=re.escape(template).replace(r'\{i\}',r'(\d+)');match=re.fullmatch(pattern,record['weight'])
            if match:matches.append(target.format(i=int(match.group(1))) if match.groups() else target)
        assert len(matches)==1,record['weight']
        name=matches[0];group='BaseLM' if record['weight'].startswith('base_lm.') else 'Acoustic';tensor=tensors[group][name]
        assert tuple(tensor.data.shape)==tuple(record['weightShape']) and tensor.data.dtype==(np.float32 if args.dtype=='f32' else np.float16),(name,tensor.data.shape)
        assert hashlib.sha256(tensor.data.tobytes()).hexdigest()==expected_gguf[record['weight']],name
        record.update(ggufGroup=group,ggufName=name,ggufExpectedCastSha256=expected_gguf[record['weight']],ggufExactExpectedCastBytes=True)
    manifest.update(status='PASS_CONVERSION_ONLY',ggufFiles={p.name:sha(p) for p in (output/'gguf').glob('*.gguf')},inference='NOT_TESTED',listening='NOT_TESTED')
    assert sha(model/'model.safetensors')==BASE_SHA and sha(lora/'lora_weights.safetensors')==adapter_sha and sha(package/'checksums.sha256')==package_sha
    for original,name in [(package/'VOXCPM-LICENSE','VOXCPM-LICENSE'),(package/'SOURCE_AND_USAGE_NOTES.md','SOURCE_AND_USAGE_NOTES.md'),(source/'LICENSE','LLAMA-CPP-LICENSE')]:shutil.copyfile(original,output/name)
    manifest.update(voiceId=voice['voice_id'],voiceVersion=voice['version'],checkpoint=voice['checkpoint'])
    save();print(json.dumps({k:manifest[k] for k in ['status','adapterKeys','mergedMatrices','mergeCount','mergedFileSha256','ggufFiles']}))

if __name__=='__main__':
    # Abrupt parent death must not leave a CPU conversion process running.
    import threading,time
    parent=os.getppid()
    def parent_watch():
        while True:
            time.sleep(.1)
            if os.getppid()!=parent:os._exit(70)
    threading.Thread(target=parent_watch,daemon=True).start()
    main()
