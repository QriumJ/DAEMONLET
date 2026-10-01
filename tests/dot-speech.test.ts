import { describe, expect, it } from "vitest"
import { dotSpeechViewport, validDotSpeechSize } from "../electron/shared/dot-speech"
import { validatePetBubblePresentation } from "../electron/shared/bubble-presentation"
import { positionDesktopSpeechBubble } from "../electron/shared/speech-bubble"
const report = { epoch: 1, sequence: 1, available: true, phase: "shown", anchor: { x0: .3, x1: .7, y0: .03, y1: .3 } }
describe("bounded full dot text", () => {
  it("retains multiline Korean/literal text only for dot and preserves the authored limit", () => {
    const text = "오빠, 전체 문장을 읽어봐.\n".repeat(25), speech = { text, width: 240, height: 140, fadeMs: 0, dotSequence: 3 }
    expect(validatePetBubblePresentation({ ...report, speech })?.speech?.text).toBe(text)
    const { dotSequence: _, ...authored } = speech
    expect(validatePetBubblePresentation({ ...report, speech: authored })).toBeNull()
    for (const dotSequence of [0, -1, 1.5, Infinity, "1"]) expect(validatePetBubblePresentation({ ...report, speech: { ...speech, dotSequence } })).toBeNull()
    expect(validatePetBubblePresentation({ ...report, speech: { ...speech, text: "한".repeat(601) } })).toBeNull()
    expect(validatePetBubblePresentation({ ...report, speech: { ...authored, text: "기존 짧은 대사" } })).not.toBeNull()
  })
  it("rejects arbitrary geometry/fields and invalid sizes", () => {
    const size = { sequence: 3, width: 480, height: 480, expanded: true }
    expect(validDotSpeechSize(size)).toBe(true)
    for (const extra of [{ x: 0 }, { height: 481 }, { width: Infinity }, { expanded: "true" }, { sequence: 0 }]) expect(validDotSpeechSize({ ...size, ...extra })).toBe(false)
  })
  it.each([{ x: 0, y: 24, width: 800, height: 600 }, { x: -1920, y: -400, width: 1920, height: 1080 }, { x: 0, y: 0, width: 320, height: 240 }])("fits compact/expanded text around all screen edges %j", area => {
    const limit = dotSpeechViewport(area)
    for (const size of [280, 460, 720]) for (const x of [area.x, area.x + area.width - size]) for (const y of [area.y, area.y + area.height - size]) for (const expanded of [false, true]) {
      const b = positionDesktopSpeechBubble({ x, y, width: size, height: size }, area, report.anchor, { width: Math.min(expanded ? 480 : 360, limit.width), height: Math.min(expanded ? 480 : 140, limit.height) })
      expect(b.x).toBeGreaterThanOrEqual(area.x + 8); expect(b.y).toBeGreaterThanOrEqual(area.y + 8)
      expect(b.x + b.width).toBeLessThanOrEqual(area.x + area.width - 8); expect(b.y + b.height).toBeLessThanOrEqual(area.y + area.height - 8)
    }
  })
})
