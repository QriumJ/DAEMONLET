import {expect,it} from 'vitest'
import {audioMouthParameters,mouthLayerParameters} from '../src/engine/anime25d/AudioMouth'
import {DEFAULT_PARAMETERS} from '../src/engine/anime25d/Anime25DParameters'
import {parsePoseManifest} from '../src/pose/PoseManifest'
const manifest:any={schemaVersion:1,id:'talk',label:'Talk',source:'source.png',psd:'model.psd',strategy:'independent-model',registration:{strategy:'identity',maxScaleDelta:0,maxRotationDeg:0,maxAnchorErrorPx:0},layers:{sharedFromBase:[],replaceFromBase:[],useFromPose:[],addFromPose:[]},transition:{enterMs:300,exitMs:280,swapStart:.35,swapEnd:.65}}
const asset=()=>({manifest:{...manifest,audioLipSync:'amplitude-3'},result:{model:{rig:{anchors:{mouth:{morph:{}}},layers:[{mouthExpression:'neutral'},{mouthExpression:'open'}]}}}} as any)
it('old manifests are unchanged; capability is bounded and explicitly opt-in',()=>{
 expect(parsePoseManifest(manifest).value.audioLipSync).toBeUndefined()
 expect(parsePoseManifest({...manifest,audioLipSync:'amplitude-3'}).warnings).toEqual([])
 for(const audioLipSync of ['phonemes',true,{},null])expect(()=>parsePoseManifest({...manifest,audioLipSync})).toThrow('audioLipSync')
 expect(()=>parsePoseManifest({...manifest,audioLipSync:'amplitude-3',strategy:'semantic-layer-swap',registration:{...manifest.registration,strategy:'eyes-and-neck'}})).toThrow('audioLipSync')
})
it.each([0,1,2] as const)('authored opt-in pose renders mouth level %i without altering other motion or input parameters',level=>{
 const original={...DEFAULT_PARAMETERS,mouthOpen:.7,mouthForm:.8,angleX:.4},rendered=audioMouthParameters(original,level,asset(),'ACTIVE_LOOP',false)
 expect(rendered).toMatchObject({mouthOpen:[0,.30,.70][level],mouthForm:0,mouthEase:0,angleX:.4});expect(original.mouthOpen).toBe(.7)
})
it.each(['old-pack','no-art','no-morph','transition','crossfade','inactive'])('falls back without any mouth override for %s',scenario=>{
 const a=asset();let level:0|1|2|null=2,state='ACTIVE_LOOP',crossfade=false
 if(scenario==='old-pack')delete a.manifest.audioLipSync
 if(scenario==='no-art')a.result.model.rig.layers.pop()
 if(scenario==='no-morph')delete a.result.model.rig.anchors.mouth.morph
 if(scenario==='transition')state='EXITING'
 if(scenario==='crossfade')crossfade=true
 if(scenario==='inactive')level=null
 expect(audioMouthParameters(DEFAULT_PARAMETERS,level,a,state,crossfade)).toBe(DEFAULT_PARAMETERS)
})

it('voice changes mouth layers only, with identical face/jaw/head and normal motion parameters',()=>{
 const original={...DEFAULT_PARAMETERS,mouthOpen:.2,mouthForm:.1,angleX:.4,angleY:-.3,body:.7}
 const mouth=audioMouthParameters(original,2,asset(),'ACTIVE_LOOP',false)
 for(const layer of [{name:'face',pose:true,independent:{}},{name:'head',pose:true,independent:{}},{mouthExpression:'open',pose:false,independent:{}},{mouthExpression:'open',pose:true,outgoing:true,independent:{}}])expect(mouthLayerParameters(layer,original,mouth)).toBe(original)
 const applied=mouthLayerParameters({mouthExpression:'open',pose:true,independent:{}},original,mouth)
 expect(applied).toEqual({...original,mouthOpen:.7,mouthForm:0,mouthEase:0});expect(original.mouthOpen).toBe(.2)
})
