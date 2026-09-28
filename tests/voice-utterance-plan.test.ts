import {expect,it} from 'vitest'
import {planSpeech,speechSegments} from '../electron/shared/character-voice-contract'
export const requiredA='비 소리 들으니까 밖은 진짜 축축하겠다. 우리 오늘은 그냥 가게 문 닫고 좀 쉴까? 아, 그래도 손님 오실 수도 있으니까 가게는 열어두고 안에서 쉬자. 그럼 내가 따뜻한 차라도 좀 더 끓여올게. 오빠도 옆에 앉아서 좀 쉬어, 오늘 고생 많았잖아.'
export const requiredB='아... 하, 안 돼... 그만...'
it.each([[requiredA,5],[requiredB,3],['아… 하, 안 돼… 그만…',1]] as const)('reproduces legacy calls and groups unchanged text', (text,count)=>{
 expect(planSpeech(text,'legacy-sentence-v1').segments).toHaveLength(count)
 expect(planSpeech(text,'utterance-v1').segments).toMatchObject([{text,start:0,end:text.length,index:0}])
})
it.each(['응.','왜?','알았어.','응, 듣고 있어. 지금은 어떤 이야기를 할까?','아\n잠깐\n기다려','  뭐?! 정말!!! ”응.”\r\n'])('short input is one lossless invocation: %s',text=>expect(speechSegments(text)).toMatchObject([{text}]))
it.each([179,180,181,399,400,6000])('bounded, deterministic, contiguous %i',length=>{
 const text='가'.repeat(length),segments=speechSegments(text)
 expect(speechSegments(text)).toEqual(segments);expect(segments.map(s=>s.text).join('')).toBe(text)
 for(const [i,s] of segments.entries()){expect(s.index).toBe(i);expect(s.start).toBe(i?segments[i-1].end:0);expect(s.text.length).toBeLessThanOrEqual(400);expect(Buffer.byteLength(s.text)).toBeLessThanOrEqual(1600);expect(s.text.trim()).not.toBe('')}
})
it.each(['응.','그만...'])('avoids tiny tail without routinely filling 400 units',tail=>{
 const text='가'.repeat(179)+' '+tail,segments=planSpeech(text,'utterance-v1').segments
 expect(segments).toHaveLength(1);expect(segments[0].cutReason).toBe('tiny-tail-merge')
 const longer=speechSegments('가'.repeat(345)+' '+tail)
 expect(longer.length).toBeGreaterThan(1);expect(longer.every(s=>s.readableGraphemes>=12)).toBe(true)
})
it.each(['...','……','?!','!!!”'])('does not split punctuation run at soft limit %s',run=>{
 const segments=speechSegments('가'.repeat(179)+run+' 나'.repeat(60))
 expect(segments.some(s=>s.text.includes(run))).toBe(true)
})
it('dots in numbers, versions, abbreviations and paths are not sentence cuts',()=>{
 const text=('숫자 3.14 v0.8.1 Dr. Kim https://example.org/a.wav file.wav ').repeat(12)
 for(const s of speechSegments(text))expect(s.text).not.toMatch(/(?:Dr\.|https:\/\/example\.)$/u)
})
it('rejects impossible graphemes and keeps the total input limit',()=>{
 for(const text of [' ','가'.repeat(6001),'a'+'\u0301'.repeat(401)])expect(()=>speechSegments(text)).toThrow('VOICE_TEXT_LIMIT')
})

it('listening revision: discourse transitions produce three groups, short hesitations stay whole',()=>{
 const plan=planSpeech(requiredA);expect(plan.policy).toBe('transition-v1');expect(plan.preferredLength).toBe(96)
 expect(plan.segments.map(s=>s.text)).toEqual([requiredA.slice(0,46),requiredA.slice(46,84),requiredA.slice(84)])
 expect(plan.segments.map(s=>s.cutReason)).toEqual(['discourse-transition','discourse-transition','end'])
 expect(speechSegments(requiredB)).toHaveLength(1)
})
it.each(['응. 그럼 가자.','아... 하, 안 돼... 그만...','아\n잠깐\n기다려'])('transition policy does not fragment short expressions: %s',text=>expect(speechSegments(text)).toHaveLength(1))
it('transition words inside a sentence do not force a cut',()=>{
 const text='오늘은 네가 그럼 어떻게 할지 먼저 이야기해 줬으면 좋겠어. 나는 여기에서 천천히 기다리고 있을게.'
 expect(speechSegments(text)).toHaveLength(1)
})

it('keeps a whole closing punctuation chain at the preferred boundary',()=>{
 const run='!”)]',text='가'.repeat(94)+run+' 나'.repeat(80)
 expect(speechSegments(text).some(s=>s.text.includes(run))).toBe(true)
})
