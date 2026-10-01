import React, { useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import { LayoutOverlay } from "../../src/pet/LayoutOverlay"
import { defaultDesktopSettings } from "../../electron/shared/desktop-settings"
import "../../src/pet/pet.css"
import { OpacityWheelController } from "../../src/pet/OpacityWheelController"
import { ModifierDragController } from "../../src/pet/ModifierDragController"
const canvas = document.querySelector("canvas")!
const desktop = window.petDesktop!
const context = canvas.getContext("2d")!
context.fillStyle = "#609060"; context.fillRect(20, 20, 100, 100)
const state = { ordinaryDowns: 0, locked: false, begins: 0, pointerModifiers: [] as unknown[], opacity: 1, wheelUpdates: 0, ordinaryWheels: 0 }
Object.assign(window, { dragSmoke: state })
new ModifierDragController(canvas, {
  platform: desktop.platform, allowed: () => true,
  // Deterministic painted rectangle, not the character renderer's alpha sampler.
  hit: (x, y) => x >= 20 && x < 120 && y >= 20 && y < 120,
  request: value => { if (value.action === "begin") state.begins++; return desktop.dragWindow(value) },
  lock: active => { state.locked = active; desktop.setInteractionLocked(active) },
})
canvas.addEventListener("pointerdown", () => { state.ordinaryDowns++ })
window.addEventListener("pointerdown", event => state.pointerModifiers.push({ alt: event.altKey, ctrl: event.ctrlKey, meta: event.metaKey, altGraph: event.getModifierState("AltGraph") }), true)

new OpacityWheelController(canvas, {platform:desktop.platform,allowed:()=>!state.locked,hit:(x,y)=>x>=20&&x<120&&y>=20&&y<120,opacity:()=>state.opacity,update:async opacity=>{state.opacity=opacity;state.wheelUpdates++;await desktop.updateSettings({opacity})}})
canvas.addEventListener('wheel',()=>state.ordinaryWheels++)

function Layout() {
 const [visible,setVisible]=useState(false),[settings,setSettings]=useState(defaultDesktopSettings())
 useEffect(()=>desktop.onLayoutChanged(setVisible),[])
 useEffect(()=>desktop.onSettingsChanged(setSettings),[])
 return visible ? React.createElement(LayoutOverlay,{settings,onScale:(scale:number)=>{void desktop.updateSettings({scale})},onDone:()=>{void desktop.setLayoutMode(false)}}) : null
}
createRoot(document.getElementById('layout-root')!).render(React.createElement(Layout))
