import { appText, bindWindowLanguage, languageArguments } from "./AppLanguage"
import { BrowserWindow, screen } from "electron"
import { BUBBLE_IPC, type BubbleAnchor, type SpeechBubbleContent, type SpeechBubbleFrame } from "../shared/bubble-presentation"
import type { BubbleRect } from "../shared/bubble-position"
import { dotSpeechViewport, validDotSpeechSize, type DotSpeechSize } from "../shared/dot-speech"
import type { DesktopSettingsV1 } from "../shared/desktop-settings"
import { positionDesktopSpeechBubble } from "../shared/speech-bubble"
import { bubblePlacementReference, positionRelativeBubble } from "../shared/bubble-placement"
import { expectedRendererUrl, secureWebContents } from "./SecurityPolicy"

/** Short authored dialogue stays click-through. Dot expansion is bubble-local. */
export class SpeechBubbleWindowController {
  window: BrowserWindow | null = null
  private ready = false
  private dotSize: DotSpeechSize | null = null
  private resync: (() => void) | null = null
  private viewport: { width: number; height: number } | undefined
  private frame: SpeechBubbleFrame | null = null
  private appearanceKey = ""
  private placement: { text: string; anchor: BubbleAnchor; content: SpeechBubbleContent; environment: string; bounds: BubbleRect | null } | null = null
  constructor(private readonly preloadPath: string, private readonly devServerUrl?: string) {}

  sync(pet: BrowserWindow | null, settings: DesktopSettingsV1 | null, anchor: BubbleAnchor | null, frame: SpeechBubbleFrame | null, inLayout: boolean, controls?: BrowserWindow | null): void {
    this.resync = () => this.sync(pet, settings, anchor, frame, inLayout, controls)
    if (this.window?.isDestroyed()) { this.window = null; this.ready = false; this.placement = null }
    if (!pet || pet.isDestroyed() || !pet.isVisible() || pet.isMinimized() || !settings?.visible || !settings.speechBubblesEnabled || inLayout || !anchor || !frame) {
      this.frame = null
      this.dotSize = null
      this.window?.setIgnoreMouseEvents(true, { forward: true })
      this.window?.setFocusable(false)
      this.placement = null
      this.window?.webContents.send(BUBBLE_IPC.speech, null)
      this.window?.hide()
      return
    }
    if (this.frame?.content.dotSequence !== frame.content.dotSequence || this.frame?.content.text !== frame.content.text) {
      this.dotSize = null
      this.window?.setIgnoreMouseEvents(true, { forward: true })
      this.window?.setFocusable(false)
    }
    this.frame = frame
    if (!this.window) this.create()
    const win = this.window!, bounds = pet.getBounds()
    const appearanceKey = `${settings.alwaysOnTop}:${settings.showOnAllWorkspaces}:${settings.showOverFullScreen}`
    if (appearanceKey !== this.appearanceKey) {
      win.setAlwaysOnTop(settings.alwaysOnTop, "floating")
      if (process.platform === "darwin") win.setVisibleOnAllWorkspaces(settings.showOnAllWorkspaces, { visibleOnFullScreen: settings.showOverFullScreen })
      this.appearanceKey = appearanceKey
    }
    const avoid = controls && !controls.isDestroyed() && controls.isVisible() ? controls.getBounds() : undefined
    const area = screen.getDisplayMatching(bubblePlacementReference(bounds, settings.bubblePlacement)).workArea
    this.viewport = frame.content.dotSequence ? dotSpeechViewport(area) : undefined
    const content = this.viewport ? { ...frame.content, width: Math.min(this.dotSize?.width ?? 360, this.viewport.width), height: Math.min(this.dotSize?.height ?? 140, this.viewport.height) } : frame.content
    if (!this.placement || this.placement.text !== frame.content.text) {
      this.placement = {
        text: frame.content.text, anchor: { ...anchor },
        content: { ...frame.content, outline: frame.content.outline?.slice() },
        environment: "", bounds: null,
      }
    }
    // Pin one line to its opening pose. Animation reports cannot move a box
    // the user is reading; real window moves/resizes still reposition it.
    const placement = this.placement
    const environment = JSON.stringify([bounds, area, avoid, content.width, content.height, settings.bubblePlacement])
    if (!placement.bounds || placement.environment !== environment) {
      const automatic = positionDesktopSpeechBubble(bounds, area, placement.anchor, { ...placement.content, width: content.width, height: content.height }, avoid)
      placement.bounds = settings.bubblePlacement.mode === "relative" ? positionRelativeBubble(bounds, area, automatic, settings.bubblePlacement) : automatic
      placement.environment = environment
    }
    const next = placement.bounds
    const current = win.getBounds()
    if (Object.keys(next).some(k => next[k as keyof typeof next] !== current[k as keyof typeof next])) win.setBounds(next, false)
    if (this.ready) {
      win.webContents.send(BUBBLE_IPC.speech, this.displayFrame())
      if (!win.isVisible()) win.showInactive()
    }
  }

  private displayFrame(): SpeechBubbleFrame | null { return this.frame ? { ...this.frame, ...(this.viewport ? { viewport: this.viewport } : {}) } : null }
  setContentSize(value: unknown): boolean {
    if (!validDotSpeechSize(value) || value.sequence !== this.frame?.content.dotSequence || this.frame.phase !== "shown" || !this.window?.isVisible()) return false
    const focus = value.expanded && !this.dotSize?.expanded
    this.dotSize = value
    this.window.setFocusable(value.expanded)
    this.resync?.()
    if (focus) { this.window.setIgnoreMouseEvents(false); this.window.focus() }
    return true
  }
  setPointerInteractive(sequence: number, value: boolean): void {
    if (sequence === this.frame?.content.dotSequence && this.frame.phase === "shown") this.window?.setIgnoreMouseEvents(!value, { forward: true })
  }
  private create(): void {
    const win = new BrowserWindow({
      width: 252, height: 100, title: appText("Daemonlet 대사"), show: false,
      transparent: true, frame: false, resizable: false, movable: false,
      minimizable: false, maximizable: false, fullscreenable: false, focusable: false,
      skipTaskbar: true, acceptFirstMouse: true, hasShadow: false, backgroundColor: "#00000000",
      webPreferences: { additionalArguments: languageArguments(), preload: this.preloadPath, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, webviewTag: false, navigateOnDragDrop: false, spellcheck: false, backgroundThrottling: false },
    })
    bindWindowLanguage(win, "Daemonlet 대사"); this.window = win; this.ready = false; this.appearanceKey = ""
    win.setIgnoreMouseEvents(true, { forward: true })
    secureWebContents(win.webContents, "speech-bubble", this.devServerUrl)
    win.webContents.on("did-finish-load", () => {
      this.ready = true
      win.webContents.send(BUBBLE_IPC.speech, this.displayFrame())
      if (this.frame) win.showInactive()
    })
    win.webContents.on("render-process-gone", () => { this.ready = false; win.hide(); win.webContents.reload() })
    win.once("closed", () => { if (this.window === win) { this.window = null; this.ready = false } })
    void win.loadURL(expectedRendererUrl("speech-bubble", this.devServerUrl)).catch(() => { this.frame = null; win.hide() })
  }

  destroy(): void { this.resync = null; this.dotSize = null; this.frame = null; this.placement = null; this.window?.destroy(); this.window = null; this.ready = false }
}
