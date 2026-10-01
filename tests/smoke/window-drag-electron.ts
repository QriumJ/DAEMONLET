import { app, ipcMain, type MouseInputEvent } from "electron"
import { join } from "node:path"
import { writeFile } from "node:fs/promises"
import assert from "node:assert/strict"
import { registerAppScheme, installAppProtocol } from "../../electron/main/AppProtocol"
import { PetWindowController } from "../../electron/main/PetWindowController"
import { WindowDragController } from "../../electron/main/WindowDragController"
import { isTrustedSender } from "../../electron/main/SecurityPolicy"
import { defaultDesktopSettings } from "../../electron/shared/desktop-settings"
import { validWindowDragRequest } from "../../electron/shared/window-drag"
import { IPC } from "../../electron/shared/ipc-contract"
const stage = process.env.DAEMONLET_DRAG_STAGE!, output = process.env.DAEMONLET_DRAG_OUTPUT!
app.setPath("userData", join(stage, "profile")); registerAppScheme()
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function main() {
  await app.whenReady(); installAppProtocol(join(stage, "renderer"))
  let modifierSample!: (pressed:boolean)=>void
  const pet = new PetWindowController({ modifierMonitor: sample=>{modifierSample=sample;return {start(){},stop(){sample(false)}}}, preloadPath: join(stage, "preload.cjs"), onBoundsChanged: () => {}, onWarning: console.error, onCloseRequested: () => {} })
  let settings = defaultDesktopSettings(); settings.bounds = { x: 100, y: 100, width: 300, height: 300, displayId: null }
  const win = pet.create(settings), cursor = { x: 150, y: 150 }, finishes: boolean[] = [], native: MouseInputEvent[] = []
  // sendInputEvent does not move the OS cursor. Only this sample is supplied by QA.
  const drag = new WindowDragController({ window: () => win, startCursor: () => pet.takeDragStart(), cursor: () => cursor,
    workArea: () => ({ x: 0, y: 0, width: 2000, height: 1500 }), allowed: () => true,
    lock: active => pet.setDragging(active), finish: (_bounds, committed) => { finishes.push(committed) } })
  ipcMain.handle(IPC.layoutSet, (_event,enabled)=>pet.setLayoutMode(enabled))
  ipcMain.handle(IPC.settingsPatch,(event,patch)=>{assert(isTrustedSender(event,win,"pet"));settings={...settings,...patch};pet.applySettings(settings);return settings})
  ipcMain.handle(IPC.windowDrag, (event, value, ...extra) => {
    assert(isTrustedSender(event, win, "pet") && !extra.length && validWindowDragRequest(value))
    return drag.request(value)
  })
  ipcMain.on(IPC.interactionLock, (event, active) => { assert(isTrustedSender(event, win, "pet")); pet.setInteractionLocked(active) })
  win.webContents.on("before-mouse-event", (_event, input) => { if (input.type === "mouseDown") native.push(input) })
  const js = (code: string) => win.webContents.executeJavaScript(code)
  async function until(check: () => boolean | Promise<boolean>) { for (let n = 0; n < 100; n++) { if (await check()) return; await wait(20) }; throw Error("drag condition timed out") }
  const mouse = (type: MouseInputEvent["type"], modifiers: MouseInputEvent["modifiers"] = [], x = 50, y = 50) => win.webContents.sendInputEvent({ type, button: "left", clickCount: 1, x, y, modifiers })
  try {
    await until(() => js("Boolean(window.dragSmoke)")); pet.reportReady(); win.focus(); await wait(100)
    assert.equal(drag.request({ action: "begin" }).id, null, "no native down cannot start")
    for (const modifiers of [[], ["alt", "control"], ["alt", "meta"]] as MouseInputEvent["modifiers"][]) {
      mouse("mouseDown", modifiers); mouse("mouseUp", modifiers); await wait(40)
    }
    mouse("mouseDown", ["alt"], 200, 200); mouse("mouseUp", ["alt"], 200, 200); await wait(40)
    assert.equal(await js("dragSmoke.begins"), 0, "ordinary, control, meta, transparent input stays outside drag")
    assert.equal(await js("dragSmoke.ordinaryDowns"), 4)
    const before = win.getBounds()
    mouse("mouseDown", ["alt"]); await until(() => drag.active)
    assert.equal(await js("dragSmoke.ordinaryDowns"), 4, "Option capture suppresses ordinary petting")
    assert.equal(await js("dragSmoke.locked"), true)
    cursor.x = before.x + 90; cursor.y = before.y + 80
    mouse("mouseMove", ["leftbuttondown"], 90, 80)
    await until(() => win.getBounds().x === before.x + 40)
    mouse("mouseUp", [], 90, 80); await until(() => !drag.active && js("!dragSmoke.locked"))
    assert.deepEqual(finishes, [true], "release after Option-up commits once")
    const saved = win.getBounds()
    cursor.x = saved.x + 50; cursor.y = saved.y + 50
    mouse("mouseDown", ["alt"]); await until(() => drag.active)
    cursor.x += 40; mouse("mouseMove", ["alt", "leftbuttondown"], 90, 50)
    await until(() => win.getBounds().x === saved.x + 40)
    win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" })
    await until(() => !drag.active && js("!dragSmoke.locked")); mouse("mouseUp")
    assert.deepEqual(win.getBounds(), saved, "Escape restores saved bounds")
    assert.deepEqual(finishes, [true, false])
    const wheel = (modifiers: Electron.MouseWheelInputEvent["modifiers"] = ["alt"], x=50, y=50, deltaY=-100) => win.webContents.sendInputEvent({type:"mouseWheel",x,y,deltaY,deltaX:0,modifiers})
    wheel([]); wheel(["alt"],200,200);await wait(150);assert.equal(await js("dragSmoke.wheelUpdates"),0)
    wheel(); await until(()=>settings.opacity===.9);assert.equal(settings.opacity,.9)
    assert(Math.abs(win.getOpacity()-.9)<.01,"native opacity applied")
    settings={...settings,opacity:0};pet.applySettings(settings)
    assert(win.isVisible() && win.getOpacity()===0);assert.equal(pet.getMousePolicy().effective,true)
    // Deterministic native-state adapter: physical Option querying is tested separately.
    const actualCursor=(await import("electron")).screen.getCursorScreenPoint(), b=win.getBounds()
    pet.setBounds({...b,x:actualCursor.x-50,y:actualCursor.y-50})
    modifierSample(true);assert.equal(win.getOpacity(),1);assert.equal(pet.getMousePolicy().effective,false)
    modifierSample(false);assert.equal(win.getOpacity(),0);assert.equal(pet.getMousePolicy().effective,true)
    settings={...settings,scale:.2};pet.applySettings(settings);pet.setBounds({x:100,y:100,width:92,height:92});pet.setLayoutMode(true);await until(()=>js("Boolean(document.getElementById(\"layout-scale\"))"));assert.equal(await js("(()=>{const r=document.querySelector(\".percent-setting\").getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.bottom<=innerHeight})()"),true);await writeFile(join(output,"layout-minimum.png"),(await win.webContents.capturePage()).toPNG());assert.equal(win.getBounds().width,280);assert.equal(win.getOpacity(),1)
    pet.setLayoutMode(false);assert.equal(win.getBounds().width,92);assert.equal(win.getOpacity(),0)
    settings={...settings,opacity:1};pet.applySettings(settings);assert.equal(win.getOpacity(),1)
    await writeFile(join(output, "opacity.png"),(await win.webContents.capturePage()).toPNG())
    await writeFile(join(output, "result.json"), JSON.stringify({ status: "PASS", platform: process.platform,
      electron: process.versions.electron, input: "Electron sendInputEvent; deterministic cursor and painted rectangle",
      nativeMouseDown: native, rendererModifiers: await js("dragSmoke.pointerModifiers"),
      checks: ["native origin required", "ordinary/control/meta/transparent rejected", "Option begins through real preload/IPC", "modifier release keeps drag", "move/release commits", "Escape rolls back", "modifier wheel only on painted canvas", "native opacity reflects persisted value", "zero stays visible and passes clicks", "modifier adapter recovers unfocused zero", "minimum layout edit area restores size", "opaque settings restore"],
      physicalDrag: "NOT_RUN", modelCalls: 0 }, null, 2))
  } finally { drag.cancel(); pet.destroy() }
}
main().then(() => app.exit(0), error => { console.error(error); app.exit(1) })
