import {expect,it} from 'vitest'
import {completeLipSyncReport} from '../scripts/characters/lipsync-smoke-report.mjs'
const ids=Array.from({length:37},(_,n)=>String(n)),voices=['waiting','writing','bored','chat-cute-pout','chat-surprised','head-tap','chat-shy','waiting-open']
const fixture=()=>({poses:ids.map(id=>({id})),voices:voices.map(id=>({id})),transitions:{before:.7,noFresh:null,fresh:.7,zero:0,released:null}})
it('requires all distinct pose/voice IDs and every ownership transition assertion',()=>{
 expect(completeLipSyncReport(fixture(),ids)).toBe(true)
 for(const key of ['poses','voices'] as const){const r=fixture();r[key].pop();expect(completeLipSyncReport(r,ids)).toBe(false)}
 const duplicate=fixture();duplicate.poses[0]=duplicate.poses[1];expect(completeLipSyncReport(duplicate,ids)).toBe(false)
 for(const key of ['before','noFresh','fresh','zero','released']){const r=fixture();(r.transitions as any)[key]=key==='noFresh'||key==='released'?.7:key==='before'||key==='fresh'?0:1;expect(completeLipSyncReport(r,ids)).toBe(false)}
})
