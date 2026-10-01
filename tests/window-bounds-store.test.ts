import type { DesktopSettingsV1 } from "../electron/shared/desktop-settings"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { WindowBoundsStore } from "../electron/main/WindowBoundsStore"
import { defaultDesktopSettings } from "../electron/shared/desktop-settings"

const directories: string[] = []
afterEach(async () => Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))))

describe("WindowBoundsStore", () => {
  it("atomically saves and loads settings", async () => {
    const directory = await mkdtemp(join(tmpdir(), "desktop-settings-")); directories.push(directory)
    const store = new WindowBoundsStore(directory)
    const settings = { ...defaultDesktopSettings(), characterId: "gpichan" as const }
    await store.save(settings)
    expect((await store.load()).value).toEqual(settings)
    expect(await readFile(store.path, "utf8")).toContain('"gpichan"')
  })

  it("preserves the last settings when a pending save overlaps shutdown in the same millisecond", async () => {
    const directory = await mkdtemp(join(tmpdir(), "desktop-settings-overlap-")); directories.push(directory)
    const store = new WindowBoundsStore(directory)
    const now = vi.spyOn(Date, "now").mockReturnValue(1789180593750)
    const first = defaultDesktopSettings()
    const last = { ...first, visible: false, speechBubblesEnabled: false }
    try {
      const writes = await Promise.allSettled([store.save(first), store.save(last)])
      expect(writes.map(write => write.status)).toEqual(["fulfilled", "fulfilled"])
      expect((await store.load()).value).toEqual(last)
    } finally { now.mockRestore() }
  })

  it("quarantines a corrupt file and returns defaults", async () => {
    const directory = await mkdtemp(join(tmpdir(), "desktop-settings-corrupt-")); directories.push(directory)
    const store = new WindowBoundsStore(directory)
    await writeFile(store.path, "{")
    const loaded = await store.load()
    expect(loaded.value).toEqual(defaultDesktopSettings())
    expect(loaded.quarantinedPath).toContain(".corrupt-")
    expect(await readFile(loaded.quarantinedPath!, "utf8")).toBe("{")
  })
})

it("round-trips recovered 400% geometry without expanding again on next launch", async () => {
 const {defaultDesktopSettings,recoverWindowBounds,DEFAULT_WINDOW_SIZE}=await import('../electron/shared/desktop-settings')
 const {mkdtemp,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path')
 const root=await mkdtemp(join(tmpdir(),'daemonlet-recovered-scale-'))
 try {
  const display={id:1,workArea:{x:0,y:0,width:1440,height:900}};const settings: DesktopSettingsV1={...defaultDesktopSettings(),scale:4,bounds:{x:-9000,y:-9000,width:1840,height:1840,displayId:99}}
  settings.bounds=recoverWindowBounds(settings.bounds,[display],display);settings.scale=settings.bounds.width/DEFAULT_WINDOW_SIZE
  const store=new WindowBoundsStore(root);await store.save(settings);const next=(await store.load()).value
  expect(next.scale).toBe(900/460);expect(next.bounds.width).toBe(900)
 } finally {await rm(root,{recursive:true,force:true})}
})
