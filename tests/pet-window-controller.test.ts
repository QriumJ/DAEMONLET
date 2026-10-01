import { EventEmitter } from "node:events"
import { describe, expect, it, vi } from "vitest"
import { defaultDesktopSettings } from "../electron/shared/desktop-settings"

class FakeWebContents extends EventEmitter {
  id = 41
  readonly setWindowOpenHandler = vi.fn()
  readonly reload = vi.fn()
  readonly send = vi.fn()
  url = ""
}

class FakeBrowserWindow extends EventEmitter {
  readonly webContents = new FakeWebContents()
  readonly hide = vi.fn(() => { this.visible = false })
  readonly showInactive = vi.fn(() => { this.visible = true })
  readonly moveTop = vi.fn()
  readonly setAlwaysOnTop = vi.fn()
  readonly setVisibleOnAllWorkspaces = vi.fn()
  readonly setIgnoreMouseEvents = vi.fn()
  readonly setOpacity = vi.fn()
  readonly setFocusable = vi.fn()
  bounds = { x: 0, y: 0, width: 460, height: 460 }
  readonly setBounds = vi.fn((bounds) => { this.bounds = bounds })
  readonly destroy = vi.fn()
  visible = false
  minimized = false
  isMinimized() { return this.minimized }
  readonly restore = vi.fn(() => { this.minimized = false })
  isDestroyed() { return false }
  isVisible() { return this.visible }
  getBounds() { return { ...this.bounds } }
  async loadURL(url: string) { this.webContents.url = url }
}

const cursor = vi.hoisted(() => ({ x: 200, y: 200 }))
vi.mock("electron", () => ({ BrowserWindow: FakeBrowserWindow, screen: { getCursorScreenPoint: () => cursor } }))

describe("PetWindowController visibility", () => {
  it("waits for actual renderer readiness, restores minimized Pet and cancels pending reveal on hide", async () => {
    const { PetWindowController } = await import("../electron/main/PetWindowController")
    const controller = new PetWindowController({ preloadPath: "/preload.cjs", onBoundsChanged: vi.fn(), onWarning: vi.fn(), onCloseRequested: vi.fn() })
    const settings = defaultDesktopSettings(), window = controller.create(settings) as unknown as FakeBrowserWindow
    try {
      const signal = new AbortController(), opening = controller.reveal(signal.signal)
      window.minimized = true
      expect(window.moveTop).not.toHaveBeenCalled()
      controller.reportReady()
      expect(await opening).toBe(true); expect(window.restore).toHaveBeenCalledOnce()
      controller.reload()
      const pending = controller.reveal(new AbortController().signal)
      controller.applySettings({ ...settings, visible: false })
      expect(await pending).toBe(false)
      controller.reportReady(); expect(window.isVisible()).toBe(false)
    } finally { controller.destroy() }
  })
  it("captures Electron mouseDown without modifiers, consuming only a ready visible left-button origin", async () => {
    const { PetWindowController } = await import("../electron/main/PetWindowController")
    const controller = new PetWindowController({ preloadPath: "/preload.cjs", onBoundsChanged: vi.fn(), onWarning: vi.fn(), onCloseRequested: vi.fn() })
    const settings = defaultDesktopSettings(), window = controller.create(settings) as unknown as FakeBrowserWindow
    // Electron 43's before-mouse-event payload omits modifiers even for Option/Alt.
    const down = (button = "left", x = 30) => window.webContents.emit("before-mouse-event", {}, { type: "mouseDown", button, x, y: 40 })
    try {
      down(); expect(controller.takeDragStart()).toBeNull()
      controller.reportReady()
      down(); expect(controller.takeDragStart()).toEqual({ x: 30, y: 40 })
      expect(controller.takeDragStart()).toBeNull()
      down("right"); expect(controller.takeDragStart()).toBeNull()
      down("left", -1); expect(controller.takeDragStart()).toBeNull()
      controller.setLayoutMode(true); down(); expect(controller.takeDragStart()).toBeNull()
      controller.setLayoutMode(false)
      controller.applySettings({ ...settings, visible: false }); down(); expect(controller.takeDragStart()).toBeNull()
    } finally { controller.destroy() }
  })
  it("aborts a reveal before readiness without displaying later", async () => {
    const { PetWindowController } = await import("../electron/main/PetWindowController")
    const controller = new PetWindowController({ preloadPath: "/preload.cjs", onBoundsChanged: vi.fn(), onWarning: vi.fn(), onCloseRequested: vi.fn() })
    const window = controller.create(defaultDesktopSettings()) as unknown as FakeBrowserWindow
    const signal = new AbortController(), pending = controller.reveal(signal.signal)
    signal.abort(); expect(await pending).toBe(false)
    controller.reportReady(); expect(window.moveTop).not.toHaveBeenCalled()
    controller.destroy()
  })
  it.runIf(process.platform === "win32")("releases gaze outside the native window when DOM leave is missing, preserving drags and cleaning up", async () => {
    vi.useFakeTimers()
    const { PetWindowController } = await import("../electron/main/PetWindowController")
    const controller = new PetWindowController({ preloadPath: "/preload.cjs", onBoundsChanged: vi.fn(), onWarning: vi.fn(), onCloseRequested: vi.fn() })
    const window = controller.create(defaultDesktopSettings()) as unknown as FakeBrowserWindow
    try {
      controller.reportReady()
      Object.assign(cursor, { x: 200, y: 200 })
      vi.advanceTimersByTime(100)
      expect(window.webContents.send).not.toHaveBeenCalled()
      for (const point of [{ x: -1, y: 200 }, { x: 460, y: 200 }, { x: 200, y: -1 }, { x: 200, y: 460 }]) {
        Object.assign(cursor, point)
        vi.advanceTimersByTime(100)
        expect(window.webContents.send).toHaveBeenLastCalledWith("desktop.pointer.outside", true)
      }
      window.webContents.send.mockClear()
      controller.setInteractionLocked(true)
      vi.advanceTimersByTime(300)
      expect(window.webContents.send).not.toHaveBeenCalled()
      controller.setInteractionLocked(false)
      vi.advanceTimersByTime(100)
      expect(window.webContents.send).toHaveBeenCalledOnce()
      window.webContents.send.mockClear()
      controller.hide()
      vi.advanceTimersByTime(100)
      expect(window.webContents.send).not.toHaveBeenCalled()
      controller.show()
      controller.destroy()
      vi.advanceTimersByTime(300)
      expect(window.webContents.send).not.toHaveBeenCalled()
    } finally { controller.destroy(); vi.useRealTimers() }
  })
  it("routes a close request through the persisted visible setting", async () => {
    const { PetWindowController } = await import("../electron/main/PetWindowController")
    let settings = defaultDesktopSettings()
    let controller!: InstanceType<typeof PetWindowController>
    const onCloseRequested = vi.fn(() => {
      settings = { ...settings, visible: false }
      controller.applySettings(settings)
    })
    const onContextMenu = vi.fn()
    controller = new PetWindowController({
      preloadPath: "/preload.cjs",
      onBoundsChanged: vi.fn(),
      onWarning: vi.fn(),
      onCloseRequested,
      onContextMenu,
    })
    const window = controller.create(settings) as unknown as FakeBrowserWindow
    controller.reportReady()
    const event = { preventDefault: vi.fn() }
    window.emit("close", event)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(onCloseRequested).toHaveBeenCalledOnce()
    expect(settings.visible).toBe(false)
    expect(window.hide).toHaveBeenCalledOnce()
    window.webContents.emit("context-menu",{}, {x:20,y:30})
    expect(onContextMenu).toHaveBeenCalledWith(window,{x:20,y:30})
    controller.destroy()
  })
})

describe("opacity and modifier recovery", () => {
  async function fixture(opacity = .5) {
    const {PetWindowController} = await import("../electron/main/PetWindowController")
    let sample!: (pressed: boolean) => void
    const monitor = {start:vi.fn(),stop:vi.fn(() => sample(false))}
    const settings = {...defaultDesktopSettings(),opacity}
    const controller = new PetWindowController({preloadPath:"/preload.cjs",onBoundsChanged:vi.fn(),onWarning:vi.fn(),onCloseRequested:vi.fn(),modifierMonitor: cb=>{sample=cb;return monitor}})
    const win = controller.create(settings) as unknown as FakeBrowserWindow
    Object.assign(cursor,{x:200,y:200}); controller.reportReady()
    return {controller,win,monitor,settings,sample:(v:boolean)=>sample(v)}
  }
  it.each([0,.25,.5])("passes clicks at %s, recovers without DOM focus, and restores on Option up", async opacity => {
    const f=await fixture(opacity)
    try {
      expect(f.controller.getMousePolicy().effective).toBe(true); expect(f.win.setOpacity).toHaveBeenLastCalledWith(opacity)
      f.sample(true);expect(f.controller.getMousePolicy().effective).toBe(false);expect(f.win.setOpacity).toHaveBeenLastCalledWith(1)
      f.sample(false);expect(f.controller.getMousePolicy().effective).toBe(true);expect(f.win.setOpacity).toHaveBeenLastCalledWith(opacity)
      f.controller.setMousePassthrough(true);f.sample(true);expect(f.controller.getMousePolicy().effective).toBe(true)
      f.controller.setMousePassthrough(false);expect(f.controller.getMousePolicy().effective).toBe(false)
      expect(f.settings.opacity).toBe(opacity); expect(f.win.isVisible()).toBe(true)
    } finally {f.controller.destroy()}
  })
  it("limits modifier recovery to the pet rectangle and handles blur, sleep, reload, hide and cleanup", async () => {
    const f=await fixture(0)
    try {
      Object.assign(cursor,{x:-1});f.sample(true);expect(f.controller.getMousePolicy().effective).toBe(true)
      Object.assign(cursor,{x:200});f.sample(true);f.win.emit("blur");expect(f.controller.getMousePolicy().effective).toBe(true)
      f.sample(true);f.controller.setSuspended(true);expect(f.controller.getMousePolicy().effective).toBe(true);expect(f.monitor.stop).toHaveBeenCalled()
      f.controller.setSuspended(false);f.sample(true);expect(f.controller.getMousePolicy().effective).toBe(false)
      f.win.webContents.emit("did-start-loading");expect(f.win.setOpacity).toHaveBeenLastCalledWith(1)
      f.controller.reportReady();f.controller.applySettings({...f.settings,visible:false});f.sample(true);expect(f.win.isVisible()).toBe(false)
      f.controller.applySettings({...f.settings,opacity:1});expect(f.win.setOpacity).toHaveBeenLastCalledWith(1);expect(f.controller.getMousePolicy().effective).toBe(false)
    } finally {f.controller.destroy()}
    expect(f.monitor.stop).toHaveBeenCalled()
  })
  it("does not alter normal hit testing above 50% and temporarily keeps layout editing usable at 20% size/0% opacity", async () => {
    const f=await fixture(.51)
    try {
      expect(f.controller.getMousePolicy().effective).toBe(false)
      f.controller.setMousePassthrough(true);expect(f.controller.getMousePolicy().effective).toBe(true)
      f.controller.applySettings({...f.settings,opacity:0});f.controller.setBounds({x:100,y:100,width:92,height:92})
      f.controller.setLayoutMode(true);expect(f.win.getBounds()).toEqual({x:6,y:6,width:280,height:280});expect(f.win.setOpacity).toHaveBeenLastCalledWith(1)
      expect(f.controller.getMousePolicy().effective).toBe(false)
      f.controller.setLayoutMode(false);expect(f.win.getBounds()).toEqual({x:100,y:100,width:92,height:92});expect(f.win.setOpacity).toHaveBeenLastCalledWith(0)
      expect(f.controller.getMousePolicy().effective).toBe(true)
    } finally {f.controller.destroy()}
  })
})

it("recovers logical 20% geometry across display changes while the native editor remains larger", async () => {
 const {PetWindowController}=await import('../electron/main/PetWindowController')
 const {recoverWindowBounds}=await import('../electron/shared/desktop-settings')
 const controller=new PetWindowController({preloadPath:'/preload.cjs',onBoundsChanged:vi.fn(),onWarning:vi.fn(),onCloseRequested:vi.fn()})
 const win=controller.create(defaultDesktopSettings()) as unknown as FakeBrowserWindow
 try {
  controller.reportReady();controller.setBounds({x:100,y:100,width:92,height:92});controller.setLayoutMode(true)
  expect(win.getBounds().width).toBe(280);expect(controller.getLogicalBounds()).toEqual({x:100,y:100,width:92,height:92})
  const display={id:1,workArea:{x:0,y:0,width:1440,height:900}}
  const recovered=recoverWindowBounds({...controller.getLogicalBounds()!,displayId:null},[display],display)
  controller.setBounds(recovered);expect(controller.getLogicalBounds()?.width).toBe(92);expect(win.getBounds().width).toBe(280)
  controller.setLayoutMode(false);expect(win.getBounds().width).toBe(92)
 } finally {controller.destroy()}
})

it('pet context menu retains the originating event point instead of a later cursor position',async()=>{
 const {PetWindowController}=await import('../electron/main/PetWindowController');const context=vi.fn();const controller=new PetWindowController({preloadPath:'/preload.cjs',onBoundsChanged:vi.fn(),onWarning:vi.fn(),onCloseRequested:vi.fn(),onContextMenu:context})
 const window=controller.create(defaultDesktopSettings()) as unknown as FakeBrowserWindow
 window.webContents.emit('context-menu',{}, {x:125,y:40});expect(context).toHaveBeenCalledWith(window,{x:125,y:40});controller.destroy()
})
