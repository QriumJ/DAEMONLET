import type { BubbleRect } from "./bubble-position"
/** DIP limits independent of Pet scale. Scrolling retains all 600 code points. */
export function dotSpeechViewport(area: Pick<BubbleRect, "width" | "height">) {
  return { width: Math.max(24, Math.min(480, area.width - 28)), height: Math.max(24, Math.min(480, area.height - 28)) }
}
export type DotSpeechSize = { sequence: number; width: number; height: number; expanded: boolean }
export function validDotSpeechSize(v: unknown): v is DotSpeechSize {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false
  const r = v as DotSpeechSize
  return Object.keys(r).sort().join() === "expanded,height,sequence,width" && Number.isSafeInteger(r.sequence) && r.sequence > 0
    && Number.isInteger(r.width) && r.width >= 24 && r.width <= 480
    && Number.isInteger(r.height) && r.height >= 24 && r.height <= 480 && typeof r.expanded === "boolean"
}
