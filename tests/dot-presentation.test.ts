import {afterEach,expect,it,vi} from 'vitest'
import {parseDotCommand} from '../electron/shared/dot-presentation'
import {DotPresentationService} from '../electron/main/dot/DotPresentationService'
import {emptyChat} from '../electron/shared/character-chat-semantics'
import {dotPose,dotBubble,DotPresentationController} from '../src/pet/DotPresentationController'
const clean:Array<()=>Promise<void>>=[]
afterEach(async()=>{for(const fn of clean.splice(0))await fn();vi.useRealTimers()})
function fixture(){let context:any={characterId:'test',revision:'one',definition:emptyChat()};const publish=vi.fn(),speak=vi.fn((_text:string,_signal:AbortSignal,_scheduled:(delayMs:number)=>void)=>new Promise<void>(()=>{})),stop=vi.fn(async()=>{});const service=new DotPresentationService(()=>context,publish,speak,stop);clean.push(()=>service.close());return{service,publish,speak,stop,context:(value:any)=>context=value}}
it.each([{type:'present'},{type:'present',text:''},{type:'present',text:'x'.repeat(601)},{type:'present',text:'unsafe\x00'},{type:'present',text:'x',path:'/secret'},{type:'present',text:'x',speak:'true'},{type:'present',text:'x',durationMs:30001},{type:'present',text:'x',durationMs:1.5},{type:'present',state:'arbitrary'},{type:'cancel',text:'x'},[],null])('rejects invalid or unbounded presentation %#',v=>expect(()=>parseDotCommand(v)).toThrow())
it('normalizes plain text and unknown bounded pose to neutral without executing paths',()=>{expect(parseDotCommand({type:'present',text:'  안녕 😀  ',pose:'unknown'})).toMatchObject({text:'안녕 😀',pose:'neutral',fallback:true,speak:false});expect(()=>parseDotCommand({type:'present',pose:'../../secret'})).toThrow()})
it('default mute renders text but never calls voice or exposes context',async()=>{const f=fixture();const result=await f.service.present({type:'present',text:'hello',speak:true});expect(result).toMatchObject({accepted:true,voice:'muted'});expect(f.speak).not.toHaveBeenCalled();expect(JSON.stringify(result)).not.toContain('test');expect(f.service.snapshot()?.text).toBe('hello')})
it('expiry releases ownership and cancels in-flight speech',async()=>{vi.useFakeTimers();const f=fixture();await f.service.setMuted(false);await f.service.present({type:'present',text:'hello',speak:true,durationMs:1000});const signal=f.speak.mock.calls[0][1] as AbortSignal;f.speak.mock.calls[0][2](0);expect(signal.aborted).toBe(false);await vi.advanceTimersByTimeAsync(1000);expect(signal.aborted).toBe(true);expect(f.service.snapshot()).toBe(null);expect(f.stop).toHaveBeenCalledOnce()})
it('quiet and mute cancel current presentation; quiet rejects incoming signals',async()=>{const f=fixture();await f.service.present({type:'present',state:'thinking'});await f.service.setQuiet(true);await expect(f.service.present({type:'present',text:'late'})).rejects.toThrow('DOT_QUIET');await f.service.present({type:'cancel'});await f.service.setQuiet(false);await f.service.present({type:'present',text:'new'});await f.service.setMuted(true);expect(f.service.snapshot()).toBeNull()})
it('unavailable contexts fail without stealing existing behavior',async()=>{const f=fixture();f.context(null);await expect(f.service.present({type:'present',text:'x'})).rejects.toThrow('DOT_UNAVAILABLE');expect(f.speak).not.toHaveBeenCalled();expect(f.stop).not.toHaveBeenCalled()})
it('a newer cancellation retires a presentation awaiting voice shutdown',async()=>{const f=fixture();await f.service.present({type:'present',text:'old'});let release!:()=>void;f.stop.mockImplementationOnce(()=>new Promise<void>(r=>release=r));const next=f.service.present({type:'present',text:'new'});await vi.waitFor(()=>expect(release).toBeTypeOf('function'));await f.service.cancel();release();await expect(next).rejects.toThrow('DOT_CANCELLED');expect(f.service.snapshot()).toBeNull()})
it('voice unavailability is explicit before presentation acceptance',async()=>{const service=new DotPresentationService(()=>({characterId:'c',revision:'r',definition:emptyChat()}),()=>{},async()=>{},async()=>{},()=>{},()=>true);clean.push(()=>service.close());await service.setMuted(false);await expect(service.present({type:'present',text:'hello',speak:true})).rejects.toThrow('DOT_VOICE_UNAVAILABLE');expect(service.snapshot()).toBeNull()})
it('bubble retains bounded Unicode without recording dialogue history',async()=>{const f=fixture();await f.service.present({type:'present',text:'😀'.repeat(50)});const bubble=dotBubble(f.service.snapshot());expect([...bubble!.text!]).toHaveLength(50);expect(bubble?.text).toBe('😀'.repeat(50));expect(bubble?.history).toEqual([]);expect(dotBubble(f.service.snapshot(),Date.now()+40000)).toBeNull()})
it('semantic poses use validated existing rules and fall back to pack default',async()=>{const f=fixture();await f.service.present({type:'present',pose:'happy',text:'hello'});let frame=f.service.snapshot()!;frame.definition.presentation={defaultPoseId:'base',rules:[{id:'happy',when:{phase:'replying',emotion:'happy'},poseId:'smile',motionPolicy:'pose-approved',priority:1,weight:1}]};expect(dotPose(frame).poseId).toBe('smile');frame.pose='sad';expect(dotPose(frame).poseId).toBe('base')})
it('visual transitions are aborted on replacement and restored on cancel',async()=>{const runtime:any={setChatMotionPolicy:vi.fn(),transitionToPose:vi.fn(async()=>{}),exitPose:vi.fn(async()=>{}),resetPose:vi.fn()},session:any={runtime,behavior:{setControlMode:vi.fn(),setPresentationSuspended:vi.fn()},dialogue:{setEnabled:vi.fn(),clear:vi.fn()},setInteractionEnabled:vi.fn()};const f=fixture();await f.service.present({type:'present',pose:'thinking'});const renderer=new DotPresentationController(session);renderer.update(f.service.snapshot());const signal=runtime.exitPose.mock.calls[0][0].signal;renderer.update(null);expect(signal.aborted).toBe(true);expect(session.behavior.setControlMode).toHaveBeenLastCalledWith('AUTO_BEHAVIOR')})

it('visual callback failure releases ownership and reports unavailable',async()=>{const publish=vi.fn(()=>{throw Error('window destroyed')}),stop=vi.fn(async()=>{}),service=new DotPresentationService(()=>({characterId:'c',revision:'r',definition:emptyChat()}),publish,async()=>{},stop);clean.push(()=>service.close());await expect(service.present({type:'present',text:'x'})).rejects.toThrow('DOT_UNAVAILABLE');expect(service.snapshot()).toBeNull();expect(stop).toHaveBeenCalledOnce()})
it('later voice failure changes status without retaining text or blocking cancellation',async()=>{const f=fixture();f.speak.mockRejectedValueOnce(Error('missing runtime'));await f.service.setMuted(false);await f.service.present({type:'present',text:'hello',speak:true});await vi.waitFor(()=>expect(f.service.snapshot()?.state).toBe('error'));expect(f.service.snapshot()?.text).toBe('');await f.service.cancel();expect(f.service.snapshot()).toBeNull()})

it('worker cleanup failure clears visuals and pauses further incoming presentation',async()=>{const f=fixture();await f.service.present({type:'present',text:'old'});f.stop.mockRejectedValueOnce(Error('worker failed'));await f.service.cancel();expect(f.service.snapshot()).toBeNull();expect(f.service.quiet).toBe(true);await expect(f.service.present({type:'present',text:'later'})).rejects.toThrow('DOT_QUIET')})

it('passes the entire Korean multiline voice payload once independent of bubble layout',async()=>{const f=fixture(),text='오빠, 앞부분만 보여도 끝까지 읽을게.\n'.repeat(20);await f.service.setMuted(false);await f.service.present({type:'present',text,speak:true});f.speak.mock.calls[0][2](0);expect(dotBubble(f.service.snapshot())?.text).toBe(text.trim());expect(f.speak).toHaveBeenCalledExactlyOnceWith(text.trim(),expect.any(AbortSignal),expect.any(Function));await f.service.cancel();expect((f.speak.mock.calls[0][1] as AbortSignal).aborted).toBe(true)})

it('waits through cold preparation before starting the bounded first playback lifetime',async()=>{
 vi.useFakeTimers();const f=fixture();await f.service.setMuted(false);await f.service.present({type:'present',text:'읽어줘',speak:true,durationMs:30000})
 const [_,signal,scheduled]=f.speak.mock.calls[0];await vi.advanceTimersByTimeAsync(240000)
 expect(signal.aborted).toBe(false);expect(f.service.snapshot()?.voicePhase).toBe('preparing');expect(dotBubble(f.service.snapshot())?.text).toContain('음성 준비 중')
 for(const delay of [-1,Infinity,6001,NaN])scheduled(delay);expect(f.service.snapshot()?.voicePhase).toBe('preparing')
 scheduled(240);const deadline=f.service.snapshot()!.expiresAt;scheduled(6000);expect(f.service.snapshot()!.expiresAt).toBe(deadline)
 expect(dotBubble(f.service.snapshot())?.text).toBe('읽어줘');await vi.advanceTimersByTimeAsync(30239);expect(signal.aborted).toBe(false);await vi.advanceTimersByTimeAsync(1);expect(signal.aborted).toBe(true);expect(f.service.snapshot()).toBeNull()
})
it('no renderer acknowledgement has a finite preparation deadline and a truthful error',async()=>{
 vi.useFakeTimers();const f=fixture();await f.service.setMuted(false);await f.service.present({type:'present',text:'cold',speak:true,durationMs:1000})
 const [,signal,scheduled]=f.speak.mock.calls[0];await vi.advanceTimersByTimeAsync(900000)
 expect(signal.aborted).toBe(true);expect(signal.reason.message).toBe('VOICE_PRESENTATION_PREPARATION_TIMEOUT');expect(f.stop).toHaveBeenLastCalledWith('preparation-timeout');expect(f.service.snapshot()).toMatchObject({voicePhase:'error',voiceError:'preparation-timeout',text:''})
 scheduled(0);expect(f.service.snapshot()?.voicePhase).toBe('error');await vi.advanceTimersByTimeAsync(1000);expect(f.service.snapshot()).toBeNull()
})
it.each(['cancel','mute','quiet','close'] as const)('%s revokes cold speech and cannot revive from late scheduled audio',async boundary=>{
 vi.useFakeTimers();const f=fixture();await f.service.setMuted(false);await f.service.present({type:'present',text:'old',speak:true});const [,signal,scheduled]=f.speak.mock.calls[0]
 await (boundary==='cancel'?f.service.cancel():boundary==='mute'?f.service.setMuted(true):boundary==='quiet'?f.service.setQuiet(true):f.service.close());scheduled(0);await vi.advanceTimersByTimeAsync(900000)
 expect(signal.aborted).toBe(true);expect(f.service.snapshot()).toBeNull()
})
it('completion releases visuals immediately; a replaced promise and ACK never retire its successor',async()=>{
 vi.useFakeTimers();const f=fixture();let done!:()=>void;f.speak.mockImplementationOnce(()=>new Promise<void>(r=>done=r));await f.service.setMuted(false)
 await f.service.present({type:'present',text:'short',speak:true});f.speak.mock.calls[0][2](0);done();await vi.advanceTimersByTimeAsync(0);expect(f.service.snapshot()).toBeNull()
 let oldDone!:()=>void;f.speak.mockImplementationOnce(()=>new Promise<void>(r=>oldDone=r));await f.service.present({type:'present',text:'old',speak:true});const old=f.speak.mock.calls[1]
 await f.service.present({type:'present',text:'new',speak:true});old[2](0);oldDone();await vi.advanceTimersByTimeAsync(0);expect(old[1].aborted).toBe(true);expect(f.service.snapshot()?.voicePhase).toBe('preparing')
 f.speak.mock.calls[2][2](0);expect(f.service.snapshot()?.text).toBe('new')
})
it('a renderer/device failure reports failure; resolved speech without any validated start is not called playback',async()=>{
 vi.useFakeTimers();const f=fixture();await f.service.setMuted(false);f.speak.mockRejectedValueOnce(Error('VOICE_PLAYBACK'));await f.service.present({type:'present',text:'device',speak:true});await vi.advanceTimersByTimeAsync(0);expect(f.service.snapshot()?.voiceError).toBe('failed')
 f.speak.mockResolvedValueOnce();await f.service.present({type:'present',text:'no ACK',speak:true});await vi.advanceTimersByTimeAsync(0);expect(f.service.snapshot()?.voiceError).toBe('failed')
})
it('muted speech still uses the acceptance-time display budget and never prepares audio',async()=>{vi.useFakeTimers();const f=fixture();await f.service.present({type:'present',text:'silent',speak:true,durationMs:1000});expect(f.service.snapshot()?.text).toBe('silent');expect(f.speak).not.toHaveBeenCalled();await vi.advanceTimersByTimeAsync(1000);expect(f.service.snapshot()).toBeNull()})
it('idle mute reaches model cleanup and unmute only changes the voice gate',async()=>{
 const muteVoice=vi.fn(async()=>{}),speak=vi.fn(async()=>{}),service=new DotPresentationService(()=>({characterId:'c',revision:'r',definition:emptyChat()}),()=>{},speak,async()=>{},()=>{},()=>false,muteVoice);clean.push(()=>service.close())
 await service.setMuted(false);await service.setMuted(true)
 expect(muteVoice.mock.calls).toEqual([[false],[true]]);expect(speak).not.toHaveBeenCalled();expect(service.snapshot()).toBeNull()
})
it('mute/unmute during old cleanup preserves the newest gate and presentation',async()=>{
 let release!:()=>void;const muteVoice=vi.fn(async(value:boolean)=>{if(value)await new Promise<void>(r=>release=r)}),speak=vi.fn(()=>new Promise<void>(()=>{})),service=new DotPresentationService(()=>({characterId:'c',revision:'r',definition:emptyChat()}),()=>{},speak,async()=>{},()=>{},()=>false,muteVoice)
 await service.setMuted(false);await service.present({type:'present',text:'old',speak:true});const old=speak.mock.calls[0] as unknown as [string,AbortSignal,Function]
 const muting=service.setMuted(true);await service.setMuted(false);await service.present({type:'present',text:'new',speak:true});release();await muting
 old[2](0);expect(old[1].aborted).toBe(true);expect(service.muted).toBe(false);expect(service.snapshot()?.voicePhase).toBe('preparing');expect(speak).toHaveBeenCalledTimes(2)
 muteVoice.mockImplementation(async()=>{});await service.close()
})
