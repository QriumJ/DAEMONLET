import type {ExecutionProfile,ManagedVoiceModelRemoval,VoiceEngine,VoiceSnapshot} from './character-voice-contract'

export type VoiceSetupPathId='qwen-gguf'|'vox-gguf'|'vox-metal'|'qwen-mlx'|'vox-legacy'|'qwen-legacy'
export type VoiceSetupPath={id:VoiceSetupPathId;engine:VoiceEngine;profile:ExecutionProfile;title:string;description:string;legacy:boolean}
const paths:Record<VoiceSetupPathId,VoiceSetupPath>={
 'qwen-gguf':{id:'qwen-gguf',engine:'qwen3-tts-06b-gguf',profile:'qwen-gguf',title:'Qwen · 빠른 음성 복제',description:'사용 권한이 있는 WAV로 목소리를 추가합니다. Qwen 0.6B Base Q8 GGUF를 사용합니다.',legacy:false},
 'vox-gguf':{id:'vox-gguf',engine:'voxcpm2',profile:'gguf-cuda-f16',title:'VoxCPM2 · GGUF',description:'WAV 음성 또는 호환되는 개인 학습팩을 사용합니다. 학습팩은 해당 팩의 변환 결과가 필요합니다.',legacy:false},
 'vox-metal':{id:'vox-metal',engine:'voxcpm2',profile:'gguf-metal-f16',title:'VoxCPM2 · Mac 음성',description:'Apple Silicon의 Metal GGUF 경로입니다. 기본 음성과 개인 학습팩을 유지합니다.',legacy:false},
 'qwen-mlx':{id:'qwen-mlx',engine:'qwen3-tts-06b',profile:'qwen-mlx',title:'Qwen · Mac 음성 복제',description:'Apple Silicon의 MLX 경로입니다. 사용 권한이 있는 WAV로 목소리를 추가합니다.',legacy:false},
 'vox-legacy':{id:'vox-legacy',engine:'voxcpm2',profile:'cuda-compiled',title:'VoxCPM2 · 이전 Windows 방식',description:'기존 PyTorch 모델과 학습팩 연결을 사용할 수 있습니다.',legacy:true},
 'qwen-legacy':{id:'qwen-legacy',engine:'qwen3-tts-06b',profile:'qwen-complete',title:'Qwen · 이전 Windows 방식',description:'기존 PyTorch Qwen 모델을 사용하는 경로입니다.',legacy:true},
}
export function voiceSetupPaths(platform:string,arch:string):VoiceSetupPath[]{
 return (platform==='win32'?(arch==='x64'?['qwen-gguf','vox-gguf','vox-legacy','qwen-legacy']:['vox-legacy','qwen-legacy']):platform==='darwin'&&arch==='arm64'?['vox-metal','qwen-mlx']:[]).map(id=>paths[id as VoiceSetupPathId])
}
export function defaultVoiceSetup(platform:string,arch:string){
 const path=voiceSetupPaths(platform,arch)[0]
 return {engine:path?.engine??'voxcpm2' as VoiceEngine,profile:path?.profile??'baseline' as ExecutionProfile}
}
export function voiceSetupPlatform(state:VoiceSnapshot){
 const mac=state.executionProfile?.includes('mlx')||state.executionProfile?.includes('metal')||state.qwenInstall?.communityConversion
 return {platform:state.platform??(mac?'darwin':'win32'),arch:state.arch??(mac?'arm64':'x64')}
}
export function currentVoiceSetupPath(state:VoiceSnapshot):VoiceSetupPathId{
 if(state.engine==='qwen3-tts-06b-gguf')return 'qwen-gguf'
 if(state.engine==='qwen3-tts-06b')return state.platform==='darwin'||state.executionProfile?.includes('mlx')||state.qwenInstall?.communityConversion?'qwen-mlx':'qwen-legacy'
 if(state.executionProfile?.includes('metal'))return 'vox-metal'
 return /^gguf-(cuda|vulkan)-/.test(state.executionProfile??'')?'vox-gguf':'vox-legacy'
}
export function isLegacyVoiceModel(id:ManagedVoiceModelRemoval['id'],platform:string){return platform==='win32'&&(id==='voxcpm2-base'||id==='qwen3-tts-06b')}
