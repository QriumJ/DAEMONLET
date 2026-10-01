import { ModifierStateMonitor } from "./ModifierStateMonitor"
import { OPACITY_CLICK_THROUGH_THRESHOLD } from "../shared/desktop-settings"
import { NativeDragStart } from "./NativeDragStart"
import { bindWindowLanguage, languageArguments } from "./AppLanguage"
import { BrowserWindow, screen, type Rectangle } from "electron"
import { join } from "node:path"
import type { DesktopSettingsV1 } from "../shared/desktop-settings"
import { IPC, type AdapterStatus } from "../shared/ipc-contract"
import { expectedRendererUrl, secureWebContents } from "./SecurityPolicy"

type PetWindowOptions = {
  preloadPath: string
  modifierHelperPath?: string
  modifierMonitor?: (sample: (pressed: boolean) => void) => Pick<ModifierStateMonitor, "start" | "stop">
  devServerUrl?: string
  onBoundsChanged: (bounds: Rectangle) => void
  onWarning: (message: string) => void
  onCloseRequested: () => void
  onContextMenu?: (window: BrowserWindow) => void
  onRendererReset?: () => void
}

export class PetWindowController {
  window: BrowserWindow | null = null
  private opacity = 1
  private nativeOpacity: number | null = null
  private alwaysOnTop = true
  private allWorkspaces = true
  private overFullScreen = false
  private modifierEditing = false
  private suspended = false
  private layoutBounds: Rectangle | null = null
  private modifierMonitor: Pick<ModifierStateMonitor, "start" | "stop"> | null = null
  private layoutMode = false
  private interactionLocked = false
  private requestedPassthrough = false
  private ready = false
  private readyTimer: ReturnType<typeof setTimeout> | null = null
  private pointerBoundaryTimer: ReturnType<typeof setInterval> | null = null
  private crashReloaded = false
  private clickThrough = true
  private desiredVisible = true
  private effectivePassthrough = false
  private dragging = false
  private dragStart = new NativeDragStart()
  private revealWaiters = new Set<(ready: boolean) => void>()

  constructor(private readonly options: PetWindowOptions) {}

  create(settings: DesktopSettingsV1): BrowserWindow {
    if (this.window && !this.window.isDestroyed()) return this.window
    this.clickThrough = settings.clickThrough
    this.opacity = settings.opacity
    this.desiredVisible = settings.visible
    this.alwaysOnTop = settings.alwaysOnTop; this.allWorkspaces = settings.showOnAllWorkspaces; this.overFullScreen = settings.showOverFullScreen
    this.nativeOpacity = null
    const win = new BrowserWindow({
      ...settings.bounds,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      hasShadow: false,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: settings.alwaysOnTop,
      focusable: true,
      acceptFirstMouse: true,
      webPreferences: { additionalArguments: languageArguments(),
        // A transparent/background pet must render its first real frame even
        // while Settings obscures it; readiness still waits for that frame.
        backgroundThrottling: false,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        webviewTag: false,
        navigateOnDragDrop: false,
        spellcheck: false,
        devTools: !process.env.ELECTRON_IS_PACKAGED,
        preload: this.options.preloadPath,
      },
    })
    bindWindowLanguage(win); this.window = win
    const sample = (pressed: boolean) => {
      if (win.isDestroyed()) { this.modifierEditing = false; return }
      const bounds = win.getBounds(), cursor = screen.getCursorScreenPoint()
      const inside = cursor.x >= bounds.x && cursor.y >= bounds.y && cursor.x < bounds.x + bounds.width && cursor.y < bounds.y + bounds.height
      this.modifierEditing = pressed && inside && this.ready && this.desiredVisible && win.isVisible() && !this.suspended
      this.applyMousePolicy()
    }
    this.modifierMonitor = this.options.modifierMonitor?.(sample) ?? ((process.platform === "darwin" || process.platform === "win32") && this.options.modifierHelperPath
      ? new ModifierStateMonitor(process.platform === "win32" ? this.options.modifierHelperPath + ".exe" : this.options.modifierHelperPath, sample, () => this.options.onWarning(process.platform === "win32" ? "Alt recovery is unavailable; restore opacity in the tray or Settings" : "Option recovery is unavailable; restore opacity in the tray or Settings")) : null)
    secureWebContents(win.webContents, "pet", this.options.devServerUrl)
    win.setAlwaysOnTop(settings.alwaysOnTop, "floating")
    if (process.platform === "darwin") win.setVisibleOnAllWorkspaces(settings.showOnAllWorkspaces, { visibleOnFullScreen: settings.showOverFullScreen })
    const capture = () => {
      const bounds = win.getBounds()
      if (this.layoutBounds) {
        this.layoutBounds = { ...this.layoutBounds, x: Math.round(bounds.x + (bounds.width - this.layoutBounds.width) / 2), y: Math.round(bounds.y + (bounds.height - this.layoutBounds.height) / 2) }
        this.options.onBoundsChanged(this.layoutBounds)
      } else this.options.onBoundsChanged(bounds)
    }
    win.on("move", capture); win.on("moved", capture)
    win.on("blur", () => { this.interactionLocked = false; this.modifierEditing = false; this.applyMousePolicy() })
    win.on("hide", () => { this.interactionLocked = false; this.modifierEditing = false; this.modifierMonitor?.stop(); this.applyMousePolicy() })
    win.on("close", (event) => {
      if (!win.isDestroyed()) { event.preventDefault(); this.options.onCloseRequested() }
    })
    win.webContents.on("render-process-gone", (_event, details) => {
      this.options.onRendererReset?.()
      this.failSafe(`Pet renderer exited: ${details.reason}`)
      if (!this.crashReloaded) { this.crashReloaded = true; win.webContents.reload() }
    })
    win.webContents.on("did-start-loading", () => { this.ready = false; this.modifierEditing = false; this.modifierMonitor?.stop(); this.applyMousePolicy(); this.options.onRendererReset?.() })
    win.webContents.on("did-fail-load", (_event, code, description, url, mainFrame) => {
      if (mainFrame) this.failSafe(`Pet load failed (${code} ${description}): ${url}`)
    })
    win.webContents.on("context-menu", () => this.options.onContextMenu?.(win))
    win.webContents.on("before-mouse-event", (_event, input) => {
      if (input.type !== "mouseDown") return
      // Electron omits modifiers from before-mouse-event. The renderer checks
      // Option/Alt and painted pixels; Main retains the native left-down origin.
      this.dragStart.record(win.getBounds(), input, input.button === "left")
    })
    if ((typeof __APP_QA__ === "undefined" || __APP_QA__) && process.env.ELECTRON_SMOKE_TEST === "1") {
      win.webContents.on("console-message", (details) => {
        process.stderr.write(`[pet:${details.level}] ${details.message}\n`)
        if (details.level === "error") this.options.onWarning(`Renderer console: ${details.message}`)
      })
    }
    win.on("unresponsive", () => this.failSafe("Pet renderer became unresponsive"))
    win.once("closed", () => { this.modifierMonitor?.stop(); this.stopPointerBoundaryCheck(); this.window = null })
    // Windows click-through can stop DOM mouse delivery without pointerleave.
    // Check native coordinates without moving the cursor or taking focus.
    if (process.platform === "win32") {
      this.pointerBoundaryTimer = setInterval(() => {
        if (!this.ready || win.isDestroyed() || !win.isVisible() || this.interactionLocked || this.layoutMode) return
        const cursor = screen.getCursorScreenPoint(), bounds = win.getBounds()
        if (cursor.x < bounds.x || cursor.y < bounds.y || cursor.x >= bounds.x + bounds.width || cursor.y >= bounds.y + bounds.height) {
          this.send(IPC.pointerOutside, true)
        }
      }, 100)
      this.pointerBoundaryTimer.unref()
    }
    void win.loadURL(expectedRendererUrl("pet", this.options.devServerUrl)).catch((error) => this.failSafe(`Pet navigation failed: ${String(error)}`))
    this.readyTimer = setTimeout(() => {
      if (!this.ready && !win.isDestroyed()) {
        for (const finish of [...this.revealWaiters]) finish(false)
        this.options.onWarning("Pet renderer did not report ready within 15 seconds")
        if (this.desiredVisible) win.showInactive()
      }
    }, 15_000)
    return win
  }

  reportReady(): void {
    this.ready = true
    if (this.readyTimer) clearTimeout(this.readyTimer)
    this.readyTimer = null
    if (this.desiredVisible && this.window && !this.window.isDestroyed()) this.window.showInactive()
    this.syncModifierMonitor()
    this.applyMousePolicy()
    for (const finish of [...this.revealWaiters]) finish(true)
  }

  async reveal(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted || !this.desiredVisible || !this.window || this.window.isDestroyed()) return false
    if (!this.ready) {
      const ready = await new Promise<boolean>(resolve => {
        const abort = () => finish(false)
        const finish = (ready: boolean) => { this.revealWaiters.delete(finish); signal.removeEventListener("abort", abort); resolve(ready) }
        this.revealWaiters.add(finish); signal.addEventListener("abort", abort, { once: true })
      })
      if (!ready || signal.aborted || !this.desiredVisible) return false
    }
    this.show()
    return Boolean(this.window && !this.window.isDestroyed() && this.window.isVisible())
  }

  setMousePassthrough(ignore: boolean): void {
    this.requestedPassthrough = ignore
    this.applyMousePolicy()
  }

  setInteractionLocked(locked: boolean): void {
    this.interactionLocked = locked
    this.applyMousePolicy()
  }
  setDragging(value: boolean) {
    this.dragging = value
    this.applyMousePolicy()
    if (!value) this.send(IPC.dragCancelled, true)
  }
  takeDragStart() {
    const point = this.dragStart.take()
    return point && this.ready && !this.layoutMode && this.desiredVisible ? { x: point.x, y: point.y } : null
  }

  setLayoutMode(enabled: boolean): void {
    const win = this.window
    if (enabled && !this.layoutMode && win) this.layoutBounds = win.getBounds()
    this.layoutMode = enabled
    if (win && this.layoutBounds) {
      const bounds = this.layoutBounds
      if (enabled) this.setBounds(bounds)
      else { this.layoutBounds = null; win.setBounds(bounds, false) }
    }
    this.applyMousePolicy()
    this.window?.setFocusable(true)
    this.send(IPC.layoutChanged, enabled)
    if (enabled) this.show()
  }

  applySettings(settings: DesktopSettingsV1): void {
    const win = this.window
    if (!win || win.isDestroyed()) return
    this.clickThrough = settings.clickThrough
    this.opacity = settings.opacity
    this.desiredVisible = settings.visible
    if (!settings.visible) for (const finish of [...this.revealWaiters]) finish(false)
    if (this.alwaysOnTop !== settings.alwaysOnTop) { this.alwaysOnTop = settings.alwaysOnTop; win.setAlwaysOnTop(settings.alwaysOnTop, "floating") }
    if (process.platform === "darwin" && (this.allWorkspaces !== settings.showOnAllWorkspaces || this.overFullScreen !== settings.showOverFullScreen)) {
      this.allWorkspaces = settings.showOnAllWorkspaces; this.overFullScreen = settings.showOverFullScreen
      win.setVisibleOnAllWorkspaces(settings.showOnAllWorkspaces, { visibleOnFullScreen: settings.showOverFullScreen })
    }
    if (win.isVisible() !== settings.visible) settings.visible ? win.showInactive() : win.hide()
    this.syncModifierMonitor()
    this.applyMousePolicy()
    this.send(IPC.settingsChanged, settings)
  }

  /** The selected character geometry, excluding the temporary minimum editor. */
  getLogicalBounds(): Rectangle | undefined {
    const win = this.window
    return win && !win.isDestroyed() ? { ...(this.layoutBounds ?? win.getBounds()) } : undefined
  }
  setBounds(bounds: Rectangle): void {
    if (this.layoutMode) {
      this.layoutBounds = { ...bounds }
      const size = Math.max(280, bounds.width, bounds.height)
      this.window?.setBounds({ ...bounds, x: Math.round(bounds.x + (bounds.width - size) / 2), y: Math.round(bounds.y + (bounds.height - size) / 2), width: size, height: size }, false)
    } else this.window?.setBounds(bounds, false)
  }
  setSuspended(value: boolean) { this.suspended = value; this.modifierEditing = false; this.syncModifierMonitor(); this.applyMousePolicy() }
  show(): void { if (this.window && !this.window.isDestroyed()) { if (this.window.isMinimized()) this.window.restore(); this.window.showInactive(); this.syncModifierMonitor(); this.applyMousePolicy(); this.window.moveTop() } }
  hide(): void { this.window?.hide() }
  reload(): void { this.crashReloaded = false; this.failSafe("Pet reload requested"); this.window?.webContents.reload() }
  send(channel: string, value: unknown): void { if (this.window && !this.window.isDestroyed()) this.window.webContents.send(channel, value) }
  getMousePolicy(): { requested: boolean; effective: boolean; interactionLocked: boolean; layoutMode: boolean } {
    return { requested: this.requestedPassthrough, effective: this.effectivePassthrough, interactionLocked: this.interactionLocked, layoutMode: this.layoutMode }
  }

  destroy(): void {
    for (const finish of [...this.revealWaiters]) finish(false)
    this.modifierMonitor?.stop(); this.modifierMonitor = null
    this.stopPointerBoundaryCheck()
    if (this.readyTimer) clearTimeout(this.readyTimer)
    this.readyTimer = null
    const win = this.window
    this.window = null
    if (win && !win.isDestroyed()) { win.removeAllListeners("close"); win.destroy() }
  }

  private syncModifierMonitor(): void {
    if (this.ready && this.desiredVisible && !this.suspended && this.opacity <= OPACITY_CLICK_THROUGH_THRESHOLD) this.modifierMonitor?.start()
    else { this.modifierEditing = false; this.modifierMonitor?.stop() }
  }

  private stopPointerBoundaryCheck(): void {
    if (this.pointerBoundaryTimer) clearInterval(this.pointerBoundaryTimer)
    this.pointerBoundaryTimer = null
  }

  private applyMousePolicy(): void {
    const win = this.window
    if (!win || win.isDestroyed()) return
    const lowOpacity = this.opacity <= OPACITY_CLICK_THROUGH_THRESHOLD
    const ignore = this.ready && (lowOpacity && !this.modifierEditing || this.clickThrough && this.requestedPassthrough) && !this.interactionLocked && !this.layoutMode && !this.dragging
    const opacity = !this.ready || this.layoutMode || this.modifierEditing ? 1 : this.opacity
    if (opacity !== this.nativeOpacity) { this.nativeOpacity = opacity; win.setOpacity(opacity) }
    if (ignore !== this.effectivePassthrough) { this.effectivePassthrough = ignore; win.setIgnoreMouseEvents(ignore, { forward: true }) }
  }

  private failSafe(message: string): void {
    for (const finish of [...this.revealWaiters]) finish(false)
    this.ready = false
    this.modifierEditing = false; this.modifierMonitor?.stop()
    this.nativeOpacity = 1; this.window?.setOpacity(1)
    this.requestedPassthrough = false
    this.effectivePassthrough = false
    this.window?.setIgnoreMouseEvents(false)
    this.options.onWarning(message)
  }
}
