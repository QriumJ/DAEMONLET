import type {MouthAnchor, MouthMorphProfile, MouthShape, RigLayer} from './types'

/** Derive metadata from this pose's supplied paint. Never creates or changes pixels.
 * This requires visually reviewed closed strokes and an open silhouette. */
export function deriveSpeechMouthProfile(layers: RigLayer[], anchor: MouthAnchor): MouthMorphProfile {
 const shape = (expression: 'neutral' | 'open' | 'smile'): MouthShape => {
  const layer = layers.find(layer => layer.mouthExpression === expression)
  if (!layer) throw Error('SPEECH_MOUTH_ART_MISSING: '+expression)
  const columns: Array<{x: number;top: number;bottom: number;center: number}> = []
  for (let x=0; x<layer.img.width; x++) {
   let top=Infinity,bottom=-Infinity,weight=0,weightedY=0
   for (let y=0; y<layer.img.height; y++) {
    const alpha=layer.img.data[(y*layer.img.width+x)*4+3]
    if (alpha < 128) continue
    top=Math.min(top,y);bottom=Math.max(bottom,y);weight+=alpha;weightedY+=alpha*y
   }
   if (weight && (expression !== 'open' || bottom-top >= 3)) columns.push({x,top,bottom,center:weightedY/weight})
  }
  if (columns.length<3) throw Error('SPEECH_MOUTH_CONTOUR_EMPTY: '+expression)
  const first=columns[0].x,last=columns[columns.length-1].x,upper: number[]=[],lower: number[]=[]
  for (let i=0; i<9; i++) {
   const x=first+(last-first)*i/8
   const column=columns.reduce((best,c)=>Math.abs(c.x-x)<Math.abs(best.x-x)?c:best)
   if (expression === 'open') {upper.push(layer.y+column.top-anchor.cy);lower.push(layer.y+column.bottom-anchor.cy)}
   else {const center=layer.y+column.center-anchor.cy;upper.push(center);lower.push(center)}
  }
  return {u0:layer.x+first-anchor.cx,u1:layer.x+last-anchor.cx,upper,lower}
 }
 return {center:{cx:anchor.cx,cy:anchor.cy},angleDeg:0,neutral:shape('neutral'),open:shape('open'),smile:shape('smile')}
}
