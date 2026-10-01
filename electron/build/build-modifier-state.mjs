import { execFile } from "node:child_process"
import { mkdir } from "node:fs/promises"
import { resolve } from "node:path"
import { promisify } from "node:util"
const root = resolve(import.meta.dirname, "../..")
const platform = process.env.PET_BUILD_PLATFORM ?? process.platform
if (platform === "darwin" && process.platform !== "darwin") throw Error("Build the macOS modifier helper on macOS")
if (platform === "darwin") {
  const cache = resolve(root, ".generated/swift-module-cache"), native = resolve(root, "dist-electron/native")
  await mkdir(cache, { recursive: true }); await mkdir(native, { recursive: true })
  const target = (process.env.PET_BUILD_ARCH ?? process.arch) === "arm64" ? "arm64-apple-macos13.0" : "x86_64-apple-macos13.0"
  await promisify(execFile)("/usr/bin/xcrun", ["swiftc", "-O", "-target", target, "-module-cache-path", cache,
    resolve(root, "electron/native/ModifierState.swift"), "-o", resolve(native, "DaemonletModifierState"), "-framework", "CoreGraphics"],
    { timeout: 120_000, maxBuffer: 1024 * 1024 })
}

if (platform === "win32") await import("./build-windows-modifier.mjs")
