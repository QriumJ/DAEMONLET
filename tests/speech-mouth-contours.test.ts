import {expect,it} from 'vitest'
import {deriveSpeechMouthProfile} from '../src/engine/anime25d/SpeechMouthContours'
import {speechClosedExpression,speechMouthWeights} from '../src/engine/anime25d/AudioMouth'
import {deformMouthPoint,isValidMouthMorphProfile} from '../src/engine/anime25d/MouthMorph'
import type {RigLayer,MouthMorphProfile} from '../src/engine/anime25d/types'
const closed={u0:-4,u1:4,upper:[0,1,0],lower:[0,1,0]},open={u0:-4,u1:4,upper:[-2,-4,-2],lower:[2,5,2]}
const profile:MouthMorphProfile={center:{cx:10,cy:20},angleDeg:0,neutral:open,open,smile:closed}
it('open neutral emotion is preserved outside audio; speech uses its own smile closed contour and artwork',()=>{
 const original=structuredClone(profile)
 expect(speechClosedExpression(profile)).toBe('smile')
 for(const value of [0,.1,.3,.7,1]){
  const weights=speechMouthWeights(value,profile);expect(weights.neutral).toBe(0);expect(weights.open+weights.smile).toBeCloseTo(1)
  const top=deformMouthPoint(10,16,'open',value,0,profile,'smile'),bottom=deformMouthPoint(10,25,'open',value,0,profile,'smile')
  expect(bottom[1]-top[1]).toBeCloseTo(9*weights.aperture)
  if(value===0)expect(top).toEqual(bottom)
 }
 expect(deformMouthPoint(10,16,'neutral',0,0,profile)).toEqual([10,16])
 expect(profile).toEqual(original)
})
it('identical closed neutral/smile art selects exactly one layer; invalid/no closed profile fails safely',()=>{
 const p={...profile,neutral:closed}
 expect(speechClosedExpression(p)).toBe('neutral');expect(speechMouthWeights(0,p)).toMatchObject({neutral:1,smile:0,open:0})
 expect(speechClosedExpression({...profile,smile:open})).toBeNull()
 expect(speechClosedExpression({} as any)).toBeNull()
})
function layer(expression:'neutral'|'open'|'smile'):RigLayer{
 const data=new Uint8ClampedArray(7*9*4)
 for(let x=1;x<6;x++)for(let y=expression==='open'?2:4;y<=(expression==='open'?7:4);y++)data[(y*7+x)*4+3]=255
 return {mouthExpression:expression,x:101,y:202,img:{width:7,height:9,data}} as RigLayer
}
it('missing morph can be derived from its own nonempty alpha silhouette and anchor, without changing any pixel',()=>{
 const layers=[layer('neutral'),layer('open'),layer('smile')],before=layers.map(l=>Array.from(l.img.data))
 const p=deriveSpeechMouthProfile(layers,{cx:105,cy:206,x0:100,x1:110,y0:200,y1:212})
 expect(isValidMouthMorphProfile(p)).toBe(true);expect(p.center).toEqual({cx:105,cy:206});expect(p.neutral.upper).toEqual(p.neutral.lower)
 expect(p.open.lower.every((v,i)=>v>p.open.upper[i])).toBe(true)
 expect(layers.map(l=>Array.from(l.img.data))).toEqual(before)
 expect(()=>deriveSpeechMouthProfile(layers.slice(0,1),{cx:0,cy:0} as any)).toThrow('ART_MISSING')
 layers[1].img.data.fill(0);expect(()=>deriveSpeechMouthProfile(layers,{cx:0,cy:0} as any)).toThrow('CONTOUR_EMPTY')
})

it('external speech profiles have the same strict bounded schema as existing mouth morphs',async()=>{
 const {validateRigOverrides}=await import('../electron/shared/character-pack-validation')
 const mouth={x0:0,x1:20,y0:0,y1:30,cx:10,cy:20,speechMorph:profile}
 expect(()=>validateRigOverrides({anchorOverrides:{mouth}})).not.toThrow()
 for(const invalid of [{...profile,open:{...open,lower:open.upper}},{...profile,angleDeg:NaN},{...profile,arbitrary:true}])expect(()=>validateRigOverrides({anchorOverrides:{mouth:{...mouth,speechMorph:invalid}}})).toThrow('PACK_SCHEMA')
})
