import { exposeAppLanguage } from "./app-language"
exposeAppLanguage()
import { contextBridge, ipcRenderer } from "electron"
import { BUBBLE_IPC, type SpeechBubbleFrame } from "../shared/bubble-presentation"

// Narrow bubble-local sizing/hover only; no settings, task or voice actions.
contextBridge.exposeInMainWorld("petSpeech", Object.freeze({
  size(value: { sequence: number; width: number; height: number; expanded: boolean }) { ipcRenderer.send(BUBBLE_IPC.speechSize, value) },
  pointer(sequence: number, interactive: boolean) { ipcRenderer.send(BUBBLE_IPC.speechPointer, sequence, interactive) },
  subscribe(listener: (frame: SpeechBubbleFrame | null) => void) {
    const receive = (_event: Electron.IpcRendererEvent, frame: SpeechBubbleFrame | null) => listener(frame)
    ipcRenderer.on(BUBBLE_IPC.speech, receive)
    return () => ipcRenderer.removeListener(BUBBLE_IPC.speech, receive)
  },
}))
