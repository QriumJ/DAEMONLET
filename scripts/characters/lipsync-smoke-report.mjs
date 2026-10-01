// A PASS requires the complete intended sample set and pose ownership transition.
export function completeLipSyncReport(report, expectedIds) {
 const sameIds=(actual,expected)=>actual.length===expected.length&&new Set(actual).size===expected.length&&expected.every(id=>actual.includes(id))
 const voices=['waiting','writing','bored','chat-cute-pout','chat-surprised','head-tap','chat-shy','waiting-open']
 const t=report.transitions
 return expectedIds.length===37&&new Set(expectedIds).size===37&&sameIds((report.poses??[]).map(p=>p.id),expectedIds)&&sameIds((report.voices??[]).map(v=>v.id),voices)
   &&!!t&&t.before>0&&t.noFresh===null&&t.fresh>0&&t.zero===0&&t.released===null
}
