// Lossless UTF-16 offsets; grapheme boundaries are preserved even at the hard limit.
export function legacySpeechSegments(text:string,max=180) {
 if(!text.trim()||text.length>6000||!Number.isSafeInteger(max)||max<16||max>400)throw Error('VOICE_TEXT_LIMIT')
 const graphemes=[...new Intl.Segmenter('ko',{granularity:'grapheme'}).segment(text)]
 const result:Array<{text:string;start:number;end:number;index:number}>=[]
 let start=0,boundary=0
 const flush=(end:number)=>{
  if(end>start)result.push({text:text.slice(start,end),start,end,index:result.length})
  start=end;boundary=end
 }
 for(let i=0;i<graphemes.length;i++) {
  const g=graphemes[i],end=g.index+g.segment.length,next=graphemes[i+1]?.segment||''
  if(g.segment.length>400)throw Error('VOICE_TEXT_LIMIT')
  // Never split a grapheme, including one larger than the preferred chunk size.
  if(end-start>400)flush(g.index)
  if(/\s/u.test(g.segment))boundary=end
  const sentence=/[!?。！？\n]/u.test(g.segment)||g.segment==='.'&&(!next||/\s/u.test(next))
  if(sentence||end-start>=max)flush(!sentence&&boundary>start?boundary:end)
 }
 // A preferred whitespace cut may leave a suffix on the final iteration.
 flush(text.length)
 return result
}

export type SpeechPolicy='transition-v1'|'utterance-v1'|'legacy-sentence-v1'
export const DEFAULT_SPEECH_POLICY:SpeechPolicy='transition-v1'
export type SpeechSegment={text:string;start:number;end:number;index:number;cutReason:string;readableGraphemes:number;tinyReason?:string}
const bytes=(text:string)=>new TextEncoder().encode(text).length

/** One immutable, lossless plan per completed answer; independent of audio delivery mode. */
export function planSpeech(text:string,policy:SpeechPolicy=DEFAULT_SPEECH_POLICY,max=policy==='transition-v1'?96:180){
 if(!text.trim()||text.length>6000||!Number.isSafeInteger(max)||max<16||max>400)throw Error('VOICE_TEXT_LIMIT')
 if(!['transition-v1','utterance-v1','legacy-sentence-v1'].includes(policy))throw Error('VOICE_SPEECH_POLICY')
 const gs=[...new Intl.Segmenter('ko',{granularity:'grapheme'}).segment(text)]
 if(gs.some(g=>g.segment.length>400||bytes(g.segment)>1600))throw Error('VOICE_TEXT_LIMIT')
 const cuts=gs.map(g=>g.index+g.segment.length)
 const counts=new Map<number,number>([[0,0]]);let count=0
 for(const g of gs){if(/[\p{L}\p{N}\p{S}]/u.test(g.segment))count++;counts.set(g.index+g.segment.length,count)}
 const readable=(start:number,end=text.length)=>counts.get(end)!-counts.get(start)!
 const valid=(start:number,end:number)=>end>start&&end-start<=400&&bytes(text.slice(start,end))<=1600&&!!text.slice(start,end).trim()
 const protectedCut=(end:number)=>{
  const left=text.slice(0,end),right=text.slice(end)
  // Punctuation runs and their closing quotes stay together, including ellipses.
  return /[.!?。！？…][”’"')\]}]*$/u.test(left)&&/^[.!?。！？…”’"')\]}]/u.test(right)
 }
 const kind=(end:number)=>{
  const left=text.slice(0,end),right=text.slice(end)
  if(/\n[ \t]*\r?\n[ \t]*$/u.test(left))return 'paragraph'
  if(/\s$/u.test(left)){
   const trimmed=left.trimEnd()
   if(/[!?。！？][”’"')\]}]*$/u.test(trimmed))return 'sentence'
   if(/(?<!\.)\.[”’"')\]}]*$/u.test(trimmed)&&!/(?:\b(?:Dr|Mr|Mrs|Ms|Prof|Sr|Jr|St)|\b[A-Z])\.$/u.test(trimmed))return 'sentence'
   return 'space'
  }
  if(/[!?。！？][”’"')\]}]*$/u.test(left)&&(!right||/^\s/u.test(right)))return 'sentence'
  return 'grapheme'
 }
 const spans:Array<{start:number;end:number;cutReason:string}>=[]
 if(policy==='legacy-sentence-v1')for(const s of legacySpeechSegments(text,max))spans.push({...s,cutReason:'legacy'})
 else {
  let start=0
  while(start<text.length){
   // User listening feedback: retain local continuity but permit a new delivery at
   // explicit discourse turns. Never infer or alter emotion/reference parameters.
   const transition=policy==='transition-v1'&&text.length-start>48?cuts.find(end=>
    end-start>=24&&end-start<=max&&valid(start,end)&&readable(start,end)>=12&&readable(end)>=12&&
    /[.!?。！？][”’"')\]}]*$/u.test(text.slice(start,end).trimEnd())&&
    /^\s*(?:아[,，]?\s*(?:그래도|하지만)|그래도|하지만|그런데|그럼|그러면|대신|반대로|한편)(?:\s|[,，])/u.test(text.slice(end))):undefined
   if(transition){spans.push({start,end:transition,cutReason:'discourse-transition'});start=transition;continue}
   if(text.length-start<=max&&valid(start,text.length)){spans.push({start,end:text.length,cutReason:'end'});break}
   const available=cuts.filter(end=>end>start&&end-start<=max&&valid(start,end)&&!protectedCut(end)&&!!text.slice(end).trim())
   // Prefer a substantial sentence/paragraph boundary, then whitespace; no tiny opener.
   const substantial=available.filter(end=>end-start>=max/2&&readable(start,end)>=12)
   let end=substantial.filter(end=>['sentence','paragraph'].includes(kind(end))).at(-1)
    ??substantial.filter(end=>kind(end)==='space').at(-1)??available.at(-1)
   let reason=end?kind(end):'indivisible'
   if(!end){end=cuts.find(end=>valid(start,end)&&!protectedCut(end)&&(end===text.length||!!text.slice(end).trim()))}
   if(!end)throw Error('VOICE_TEXT_LIMIT')
   // A tiny tail may exceed the soft target by at most 32 UTF-16 units.
   if(readable(end)<12&&text.length-start<=max+32&&valid(start,text.length)){end=text.length;reason='tiny-tail-merge'}
   spans.push({start,end,cutReason:reason});start=end
  }
  // Rebalance a tiny final group when merging would exceed the limited soft exception.
  if(spans.length>1){
   const last=spans.at(-1)!,prev=spans.at(-2)!
   if(readable(last.start,last.end)<12){
    const choices=cuts.filter(end=>valid(prev.start,end)&&valid(end,last.end)&&end-prev.start<=max&&last.end-end<=max&&!protectedCut(end)&&readable(prev.start,end)>=12&&readable(end,last.end)>=12)
    const structural=choices.filter(end=>kind(end)!=='grapheme'),pool=structural.length?structural:choices
    pool.sort((a,b)=>Math.abs(a-(prev.start+last.end)/2)-Math.abs(b-(prev.start+last.end)/2)||a-b)
    if(pool.length){prev.end=last.start=pool[0];prev.cutReason='tiny-tail-rebalance'}
   }
  }
 }
 const segments:SpeechSegment[]=spans.map((s,index)=>{const value=text.slice(s.start,s.end),count=readable(s.start,s.end);return {...s,text:value,index,readableGraphemes:count,...(count<12?{tinyReason:spans.length===1?'whole-input':'boundary-or-hard-limit'}:{})}})
 return {policy,preferredLength:max,hardLimit:400,utf8Limit:1600,tinyThreshold:12,segments}
}
export function speechSegments(text:string,max?:number){return planSpeech(text,DEFAULT_SPEECH_POLICY,max).segments}
