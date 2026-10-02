import {runtimeTarget,verifyRuntime} from "./electron/main/character-chat/runtime-artifacts.mjs"
import {readFile} from 'node:fs/promises'
import {verifyPackagedManagedRuntime} from './scripts/release/managed-runtime-assets.mjs'
import { MakerZIP } from "@electron-forge/maker-zip"
import { resolve } from "node:path"

import { APP_NAME, BUNDLE_ID } from "./electron/shared/app-identity.mjs"

export default {
  packagerConfig: {
    name: APP_NAME,
    executableName: APP_NAME,
    appBundleId: BUNDLE_ID,
    ...((process.env.PET_BUILD_PLATFORM ?? process.platform) === "darwin" ? { icon: resolve(import.meta.dirname, "electron/assets/appIcon.icns") } : (process.env.PET_BUILD_PLATFORM ?? process.platform) === "win32" ? { icon: resolve(import.meta.dirname, "electron/assets/appIcon.ico") } : {}),
    asar: true,
    extendInfo: { CFBundleDevelopmentRegion: "en", ...((process.env.PET_BUILD_PLATFORM ?? process.platform) === "darwin" ? { LSMinimumSystemVersion: "13.0" } : {}), CFBundleLocalizations: ["ko", "en"], LSUIElement: true, NSMicrophoneUsageDescription: "말한 내용을 후속 질문 입력창에 받아쓰려면 마이크 접근이 필요합니다.", NSSpeechRecognitionUsageDescription: "말한 내용을 받아씁니다. 기기 내 인식을 사용할 수 없으면 음성이 Apple 음성 인식 서비스로 전송됩니다." },
    extraResource: ["dist-electron/voice", "dist-electron/local-llm", "dist-electron/app-update.yml", "dist-electron/codex", "dist-electron/dot", "dist-electron/native", "dist-notices/licenses", ...((process.env.PET_BUILD_PLATFORM ?? process.platform) === "darwin" ? ["electron/assets/locales/en.lproj", "electron/assets/locales/ko.lproj"] : [])],
    ignore: (path) => /^\/dist-electron\/(?:local-llm|voice\/(?:base-native|managed-gguf-runtime-archives))(?:\/|$)/.test(path) || path !== "" && !/^\/(package\.json|dist(?:\/|$)|dist-electron(?:\/|$))/.test(path),
  },
  hooks: {
    prePackage: async (_config, platform, arch) => {
      await verifyRuntime(resolve(import.meta.dirname, 'dist-electron/local-llm'), runtimeTarget(platform,arch))
      if(platform==='win32')await verifyPackagedManagedRuntime(resolve(import.meta.dirname,'dist-electron/voice'),runtimeTarget(platform,arch),{trustedCatalogPath:resolve(import.meta.dirname,'electron/voice/managed-gguf-runtime-catalog.json')})
      if(platform==='darwin'&&arch==='arm64'){const trusted=JSON.parse(await readFile(resolve(import.meta.dirname,'electron/voice/runtime-base-macos.json'),'utf8'));await verifyRuntime(resolve(import.meta.dirname,'dist-electron/voice/base-native'),'darwin-arm64',{trusted})}
    },
  },
  makers: [new MakerZIP({}, ["darwin", "win32"])],
}
