import type {} from "../../electron/shared/app-language"
import type { SpeechBubbleFrame } from "../../electron/shared/bubble-presentation"
import { SPEECH_WINDOW_PADDING } from "../../electron/shared/speech-bubble"
import { createTranslator } from "../../electron/shared/translations"
import "../pet/speech-bubble.css"
import "./speech-bubble.css"

declare global {
  interface Window { petSpeech: {
    subscribe(listener: (frame: SpeechBubbleFrame | null) => void): () => void
    size(value: { sequence: number; width: number; height: number; expanded: boolean }): void
    pointer(sequence: number, interactive: boolean): void
  } }
}
const bubble = document.querySelector<HTMLElement>(".speech-bubble")!
const text = bubble.querySelector<HTMLElement>(".speech-text")!
const toggle = bubble.querySelector<HTMLButtonElement>(".speech-expand")!
let current: SpeechBubbleFrame | null = null, expanded = false, hovered = false, lastSize = ""
const translate = (s: string) => createTranslator(window.appLanguage?.current() ?? "ko")(s)
bubble.style.left = `${SPEECH_WINDOW_PADDING}px`
bubble.style.top = `${SPEECH_WINDOW_PADDING}px`
function layout() {
  const frame = current
  if (!frame) return
  const sequence = frame.content.dotSequence
  bubble.dataset.dot = String(Boolean(sequence))
  bubble.dataset.expanded = String(expanded)
  toggle.textContent = translate(expanded ? "접기" : "전체 보기")
  toggle.setAttribute("aria-expanded", String(expanded))
  if (!sequence || !frame.viewport) {
    toggle.hidden = true; bubble.style.width = `${frame.content.width}px`; bubble.style.maxHeight = ""; text.style.maxHeight = ""; return
  }
  const width = Math.min(expanded ? 480 : 360, frame.viewport.width)
  const maxHeight = frame.viewport.height
  bubble.style.width = `${width}px`; bubble.style.maxHeight = `${maxHeight}px`
  // Reserve padding + button even on a small display. Only the text scrolls.
  text.style.maxHeight = `${Math.max(1, maxHeight - 58)}px`
  toggle.hidden = false
  const overflowing = text.scrollHeight > text.clientHeight + 1
  toggle.hidden = !expanded && !overflowing
  const size = { sequence, width, height: Math.max(24, Math.ceil(bubble.getBoundingClientRect().height)), expanded }
  const key = JSON.stringify(size)
  if (key !== lastSize) { lastSize = key; window.petSpeech.size(size) }
}
toggle.addEventListener("click", () => { expanded = !expanded; layout() })
document.addEventListener("keydown", e => {
  if (e.key === "Escape" && expanded) { e.preventDefault(); expanded = false; text.scrollTop = 0; layout() }
})
bubble.addEventListener("pointerenter", () => { hovered = true; if (current?.content.dotSequence) window.petSpeech.pointer(current.content.dotSequence, true) })
bubble.addEventListener("pointerleave", () => { hovered = false; if (current?.content.dotSequence) window.petSpeech.pointer(current.content.dotSequence, false) })
window.petSpeech.subscribe(frame => {
  const replaced = current?.content.dotSequence !== frame?.content.dotSequence || current?.content.text !== frame?.content.text
  current = frame
  if (replaced || !frame) { expanded = false; text.scrollTop = 0; lastSize = "" }
  bubble.dataset.phase = frame?.phase ?? "hidden"
  bubble.setAttribute("aria-hidden", String(!frame || frame.phase === "exiting"))
  if (!frame) { toggle.hidden = true; return }
  if (text.textContent !== frame.content.text) text.textContent = frame.content.text
  bubble.style.setProperty("--bubble-fade", `${frame.content.fadeMs}ms`)
  layout()
  if (hovered && frame.content.dotSequence) window.petSpeech.pointer(frame.content.dotSequence, true)
})
document.fonts.ready.then(layout)
const updateLanguage = () => { document.documentElement.lang = window.appLanguage?.current() ?? "ko"; layout() }
updateLanguage(); window.appLanguage?.onChanged(updateLanguage)
