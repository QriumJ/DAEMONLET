import { EventEmitter } from "node:events"
import { expect, it, vi } from "vitest"
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

const monitor = vi.hoisted(() => ({path:"",sample:(_:boolean)=>{},start:vi.fn(),stop:vi.fn()}))
vi.mock("../electron/main/ModifierStateMonitor",()=>({ModifierStateMonitor:class {
 constructor(path:string,sample:(pressed:boolean)=>void){monitor.path=path;monitor.sample=sample}
 start(){monitor.start()}
 stop(){monitor.stop();monitor.sample(false)}
}}))
const cursor = vi.hoisted(() => ({ x: 200, y: 200 }))
vi.mock("electron", () => ({ BrowserWindow: FakeBrowserWindow, screen: { getCursorScreenPoint: () => cursor } }))

it.runIf(process.platform==="win32")("wires the Windows exe helper and keeps native recovery in the pet rectangle with normal-opacity restoration",async()=>{
 const {PetWindowController}=await import('../electron/main/PetWindowController')
 const settings={...defaultDesktopSettings(),opacity:0},warning=vi.fn()
 const controller=new PetWindowController({preloadPath:'/preload.cjs',modifierHelperPath:'/resources/native/DaemonletModifierState',onBoundsChanged:vi.fn(),onWarning:warning,onCloseRequested:vi.fn()})
 const win=controller.create(settings) as unknown as FakeBrowserWindow
 try {
  expect(monitor.path).toBe('/resources/native/DaemonletModifierState.exe')
  controller.reportReady();expect(monitor.start).toHaveBeenCalledOnce()
  Object.assign(cursor,{x:200,y:200});monitor.sample(true)
  expect(win.setOpacity).toHaveBeenLastCalledWith(1);expect(controller.getMousePolicy().effective).toBe(false)
  Object.assign(cursor,{x:-1});monitor.sample(true)
  expect(win.setOpacity).toHaveBeenLastCalledWith(0);expect(controller.getMousePolicy().effective).toBe(true)
  Object.assign(cursor,{x:200});monitor.sample(true);monitor.sample(false)
  expect(win.setOpacity).toHaveBeenLastCalledWith(0);expect(controller.getMousePolicy().effective).toBe(true)
  controller.setSuspended(true);expect(monitor.stop).toHaveBeenCalled()
  controller.applySettings({...settings,opacity:1});expect(win.setOpacity).toHaveBeenLastCalledWith(1)
  expect(warning).not.toHaveBeenCalled()
 }finally{controller.destroy()}
})
