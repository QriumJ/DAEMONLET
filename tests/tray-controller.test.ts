import { describe, expect, it, vi } from "vitest"
import { defaultDesktopSettings } from "../electron/shared/desktop-settings"

const electronMocks = vi.hoisted(() => ({ trayConstructor: vi.fn() }))

vi.mock("electron", () => ({
  Menu: { buildFromTemplate: vi.fn((value) => value) },
  Tray: class { constructor(...args: unknown[]) { electronMocks.trayConstructor(...args) } },
  dialog: { showMessageBox: vi.fn() },
  nativeImage: { createFromBuffer: vi.fn(() => ({ isEmpty: () => false, setTemplateImage: vi.fn(), addRepresentation: vi.fn() })) },
}))

describe("tray menu", () => {
  it("adds the shared activity summary and entry without changing the existing click action", async () => {
    const { buildTrayMenu } = await import("../electron/main/TrayController")
    const openActivity = vi.fn(), toggleVisible = vi.fn()
    const menu = buildTrayMenu(defaultDesktopSettings(), { state: "READY", message: null, restartCount: 0 }, {
      openActivity, toggleVisible, activity: () => ({ connection: "READY", counts: { running: 1, waiting: 1, failed: 2, completed: 3, attention: 6 } }),
    } as never)
    menu[0].click?.({} as never, {} as never, {} as never)
    expect(toggleVisible).toHaveBeenCalledOnce()
    const entry = menu.find(item => item.label === "작업 목록")!
    entry.click?.({} as never, {} as never, {} as never)
    expect(openActivity).toHaveBeenCalledOnce()
    if(process.platform === "darwin") {
      const status=menu.find(item=>item.label === "작업 현황")!.submenu as Array<Record<string, unknown>>
      expect(status.map(item=>item.label)).toEqual(["READY","입력 필요 1","미확인 실패: 2","미확인 종료: 3","실행 중: 1"])
      expect(status.every(item=>item.enabled === false)).toBe(true)
      expect(menu.some(item=>item.label?.includes(" · 미확인"))).toBe(false)
    } else expect(menu.some(item => item.label === "입력 필요 1 · 미확인 실패 2 · 미확인 종료 3 · 실행 중 1")).toBe(true)
  })

  it("retains the character context menu when native Tray creation fails", async () => {
    const { Menu } = await import("electron")
    const { TrayController } = await import("../electron/main/TrayController")
    const popup = vi.fn()
    vi.mocked(Menu.buildFromTemplate).mockReturnValueOnce({ popup } as never)
    electronMocks.trayConstructor.mockImplementationOnce(() => { throw new Error("unavailable tray") })
    const tray = new TrayController()
    expect(tray.create(defaultDesktopSettings(), { state: "READY", message: null, restartCount: 0 }, {} as never)).toBe(false)
    expect(tray.popup({} as never)).toBe(true)
    expect(popup).toHaveBeenCalledOnce()
    tray.destroy()
  })
  it("creates a non-empty 18px PNG template instead of relying on unsupported SVG data URLs", async () => {
    const { nativeImage } = await import("electron")
    const { createTrayIcon } = await import("../electron/main/TrayController")
    expect(createTrayIcon().isEmpty()).toBe(false)
    expect(vi.mocked(nativeImage.createFromBuffer)).toHaveBeenCalledWith(expect.any(Buffer))
    expect(vi.mocked(nativeImage.createFromBuffer).mock.calls[0][0].byteLength).toBeGreaterThan(100)
  })

  it("detects whether macOS assigned the Tray to a visible display", async () => {
    const { intersectsDisplay } = await import("../electron/main/TrayController")
    const displays = [{ x: 0, y: 0, width: 2056, height: 1329 }]
    expect(intersectsDisplay({ x: 1800, y: 0, width: 32, height: 24 }, displays)).toBe(true)
    expect(intersectsDisplay({ x: 0, y: 1329, width: 32, height: 24 }, displays)).toBe(false)
  })

  it("avoids stable Tray GUID placement state in the current unsigned builds", async () => {
    const { createNativeTray } = await import("../electron/main/TrayController")
    const image = {} as never
    electronMocks.trayConstructor.mockClear()

    createNativeTray(image)

    expect(electronMocks.trayConstructor).toHaveBeenNthCalledWith(1, image)
    expect(electronMocks.trayConstructor).toHaveBeenCalledTimes(1)
  })

  it("reflects visibility, character, scale, window, click-through, adapter, and quit state", async () => {
    const { buildTrayMenu } = await import("../electron/main/TrayController")
    const settings = { ...defaultDesktopSettings(), language: "en" as const, characterId: "gpichan" as const, scale: 1.25, visible: false, clickThrough: false }
    const actions = {
      toggleVisible: vi.fn(), setLayout: vi.fn(), resetPosition: vi.fn(), updateSettings: vi.fn(), openMotionLab: vi.fn(), reloadPet: vi.fn(), restartAdapter: vi.fn(), diagnostics: vi.fn(() => ({})), quit: vi.fn(),
    }
    const menu = buildTrayMenu(settings, { state: "READY", message: null, restartCount: 0 }, actions as never) as Array<Record<string, any>>
    expect(menu[0].label).toBe("Show character")
    expect(menu.find((item) => item.label === "Character")!.submenu).toMatchObject([{ label: "지피쨩", checked: true }])
    expect(menu.find((item) => item.label === "Character")!.submenu).toHaveLength(1)
    menu.find((item) => item.label === "Character")!.submenu[0].click()
    expect(actions.updateSettings).toHaveBeenCalledWith({ characterId: "gpichan" })
    expect(menu.find((item) => item.label === "Size")!.submenu.find((item: Record<string, unknown>) => item.label === "125%")).toMatchObject({ checked: true })
    expect(menu.find((item) => item.label === "Click through transparent areas")!.submenu[1]).toMatchObject({ label: "Disabled", checked: true })
    expect(menu.find((item) => item.label === "Codex Adapter")!.submenu[0].label).toBe("Status: READY (Owned)")
    expect(menu.at(-1)?.label).toBe("Quit")
  })
})

describe("speech bubble Tray toggle", () => {
  it.each([true, false])("reflects %s and saves the opposite value", async (speechBubblesEnabled) => {
    const { buildTrayMenu } = await import("../electron/main/TrayController")
    const updateSettings = vi.fn()
    const menu = buildTrayMenu({ ...defaultDesktopSettings(), speechBubblesEnabled }, { state: "READY", message: null, restartCount: 0 }, { updateSettings } as never)
    const toggle = menu.find((item) => item.label === "캐릭터 대사 표시")!
    expect(toggle).toMatchObject({ type: "checkbox", checked: speechBubblesEnabled })
    toggle.click?.({} as never, {} as never, {} as never)
    expect(updateSettings).toHaveBeenCalledWith({ speechBubblesEnabled: !speechBubblesEnabled })
  })
})


describe("tray language choice", () => {
  it("offers both languages without translating character names", async () => {
    const { buildTrayMenu } = await import("../electron/main/TrayController")
    const updateSettings = vi.fn()
    const actions = { updateSettings, characters: () => [{ id: "user-pack", name: "작업 중", status: "ready" }] }
    const menu = buildTrayMenu({ ...defaultDesktopSettings(), language: "en" }, { state: "READY", message: null, restartCount: 0 }, actions as never) as Array<Record<string, any>>
    const languages = menu.find(item => item.label === "언어 / Language")!.submenu
    expect(languages).toMatchObject([{ label: "한국어", checked: false }, { label: "English", checked: true }])
    languages[0].click(); expect(updateSettings).toHaveBeenCalledWith({ language: "ko" })
    expect(menu.find(item => item.label === "Character")!.submenu[0].label).toBe("작업 중")
  })
})

describe("dot controls at the display edge", () => {
  it.each(["ko", "en"] as const)("keeps session controls on the root menu in %s", async language => {
    const { buildTrayMenu } = await import("../electron/main/TrayController")
    const dotQuiet = vi.fn(), dotMuted = vi.fn(), dotCancel = vi.fn()
    const menu = buildTrayMenu({ ...defaultDesktopSettings(), language }, { state: "READY", message: null, restartCount: 0 }, { dot: () => ({ quiet: false, muted: true }), dotQuiet, dotMuted, dotCancel } as never)
    const pause = menu.find(i => i.label === (language === "ko" ? "표현 일시 중지" : "Pause presentation"))!
    const mute = menu.find(i => i.label === (language === "ko" ? "음소거" : "Mute"))!
    const stop = menu.find(i => i.label === (language === "ko" ? "현재 표현 중단" : "Stop current presentation"))!
    expect(pause.submenu).toBeUndefined(); expect(mute.checked).toBe(true)
    pause.click?.({} as never, {} as never, {} as never); mute.click?.({} as never, {} as never, {} as never); stop.click?.({} as never, {} as never, {} as never)
    expect(dotQuiet).toHaveBeenCalledWith(true); expect(dotMuted).toHaveBeenCalledWith(false); expect(dotCancel).toHaveBeenCalledOnce()
  })
})

it('labels explicitly distinguish local character chat from Codex task chat and preserve their routes',async()=>{
 const {buildTrayMenu}=await import('../electron/main/TrayController')
 const openCharacterChat=vi.fn(),openSideChat=vi.fn(),openTaskControl=vi.fn()
 const menu=buildTrayMenu(defaultDesktopSettings(),{state:'READY',message:null,restartCount:0},{openCharacterChat,openSideChat,openTaskControl} as never)
 for(const [label,fn] of [['로컬 캐릭터 대화',openCharacterChat],['Codex 작업 대화',openSideChat],['Codex 작업 제어 · 음성 입력',openTaskControl]] as const){const item=menu.find(item=>item.label===label)!;expect(item).toBeDefined();item.click?.({} as never,{} as never,{} as never);expect(fn).toHaveBeenCalledOnce()}
})

it("keeps an explicit opaque/visible recovery action even at zero opacity", async () => {
 const {buildTrayMenu}=await import("../electron/main/TrayController"),updateSettings=vi.fn()
 const menu=buildTrayMenu({...defaultDesktopSettings(),opacity:0,visible:false},{state:"READY",message:null,restartCount:0},{updateSettings} as never)
 const restore=menu.find(item=>item.label==="불투명도 100% 복원")!
 ;(restore.click as Function)();expect(updateSettings).toHaveBeenCalledWith({opacity:1,visible:true})
})

it('Mac popup uses event coordinates even when the cursor moves; missing/invalid coordinates retain native fallback',async()=>{
 const {Menu}=await import('electron');const {TrayController}=await import('../electron/main/TrayController');const popup=vi.fn(),window={} as never
 vi.mocked(Menu.buildFromTemplate).mockReturnValueOnce({popup} as never)
 const tray=new TrayController();tray.update(defaultDesktopSettings(),{state:'READY',message:null,restartCount:0},{} as never)
 tray.popup(window,{x:155.4,y:66.7});expect(popup).toHaveBeenLastCalledWith(process.platform==='darwin'?{window,x:155,y:67}:{window})
 tray.popup(window,{x:NaN,y:10});expect(popup).toHaveBeenLastCalledWith({window});tray.popup(window,{x:-1,y:-1});expect(popup).toHaveBeenLastCalledWith({window});tray.destroy()
})
