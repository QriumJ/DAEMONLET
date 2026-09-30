import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from "electron"
import { BUBBLE_IPC, validatePetBubblePresentation } from "../shared/bubble-presentation"
import type { ActivityBubbleWindowController } from "./ActivityBubbleWindowController"
import { isTrustedSender } from "./SecurityPolicy"
import { PLACEMENT_IPC } from "../shared/bubble-placement"

export class BubblePresentationIpcController {
  private counts = new Map<string, { start: number; count: number }>()
  constructor(private readonly bubble: ActivityBubbleWindowController, private readonly devServerUrl?: string, private readonly now = Date.now) {}
  private accept(event: IpcMainEvent | IpcMainInvokeEvent, role: "pet" | "activity-bubble" | "speech-bubble", limit: number, channel: string): boolean {
    if (!isTrustedSender(event, role === "pet" ? this.bubble.petWindow : role === "speech-bubble" ? this.bubble.speech.window : this.bubble.window, role, this.devServerUrl)) return false
    const key = `${role}:${channel}`, at = this.now(), old = this.counts.get(key)
    const bucket = !old || at - old.start >= 1000 ? { start: at, count: 0 } : old
    this.counts.set(key, bucket); return ++bucket.count <= limit
  }
  register(): void {
    ipcMain.handle(PLACEMENT_IPC.get, (event, ...args) => !args.length && this.accept(event, "activity-bubble", 10, "placement-get") ? this.bubble.placementSnapshot() : { editing: false, revision: 0 })
    ipcMain.handle(PLACEMENT_IPC.action, (event, ...args) => args.length === 1 && this.accept(event, "activity-bubble", 120, "placement-action") ? this.bubble.placementAction(args[0]) : { ok: false })
    ipcMain.handle(BUBBLE_IPC.begin, (event, ...args: unknown[]) => {
      if (args.length || !this.accept(event, "pet", 10, "begin")) return 0
      return this.bubble.presentation.begin()
    })
    ipcMain.handle(BUBBLE_IPC.report, (event, ...args: unknown[]) => {
      const report = args.length === 1 ? validatePetBubblePresentation(args[0]) : null
      if (!report || !this.accept(event, "pet", 30, "report")) return { epoch: 0, sequence: 0, granted: false }
      return this.bubble.presentation.report(report)
    })
    ipcMain.on(BUBBLE_IPC.interaction, this.interaction)
    ipcMain.on(BUBBLE_IPC.pointer, this.pointer)
    ipcMain.on(BUBBLE_IPC.height, this.height)
    ipcMain.on(BUBBLE_IPC.speechSize, this.speechSize)
    ipcMain.on(BUBBLE_IPC.speechPointer, this.speechPointer)
  }
  private interaction = (event: IpcMainEvent, ...args: unknown[]) => {
    if (args.length === 2 && typeof args[0] === "boolean" && typeof args[1] === "boolean" && !(args[1] && !args[0]) && this.accept(event, "activity-bubble", 60, "interaction")) this.bubble.setInteractionLocked(args[0], args[1])
  }
  private pointer = (event: IpcMainEvent, ...args: unknown[]) => {
    if (args.length === 1 && typeof args[0] === "boolean" && this.accept(event, "activity-bubble", 60, "pointer")) this.bubble.setPointerInteractive(args[0])
  }
  private height = (event: IpcMainEvent, ...args: unknown[]) => {
    const height = args[0]
    if (args.length === 1 && typeof height === "number" && Number.isInteger(height) && height >= 44 && height <= 480 && this.accept(event, "activity-bubble", 20, "height")) this.bubble.setContentHeight(height)
  }
  private speechSize = (event: IpcMainEvent, ...args: unknown[]) => {
    if (args.length === 1 && this.accept(event, "speech-bubble", 20, "speech-size")) this.bubble.speech.setContentSize(args[0])
  }
  private speechPointer = (event: IpcMainEvent, ...args: unknown[]) => {
    if (args.length === 2 && Number.isSafeInteger(args[0]) && typeof args[1] === "boolean" && this.accept(event, "speech-bubble", 60, "speech-pointer")) this.bubble.speech.setPointerInteractive(args[0] as number, args[1])
  }
  dispose(): void {
    ipcMain.removeHandler(PLACEMENT_IPC.get); ipcMain.removeHandler(PLACEMENT_IPC.action)
    ipcMain.removeHandler(BUBBLE_IPC.begin); ipcMain.removeHandler(BUBBLE_IPC.report)
    ipcMain.removeListener(BUBBLE_IPC.interaction, this.interaction); ipcMain.removeListener(BUBBLE_IPC.pointer, this.pointer); ipcMain.removeListener(BUBBLE_IPC.height, this.height)
    ipcMain.removeListener(BUBBLE_IPC.speechSize, this.speechSize); ipcMain.removeListener(BUBBLE_IPC.speechPointer, this.speechPointer)
    this.counts.clear()
  }
}
