import { createHash } from 'node:crypto'
import { normalize } from 'node:path'
import { extractFile } from '@electron/asar'
import { managedRuntimeArchivePins, managedRuntimeArchivesName, managedRuntimeCatalogName } from './managed-runtime-assets.mjs'

// Runtime workers are executable application resources, not authoring tools.
// Keep this list explicit and bind each external copy to the packaged ASAR.
export const voiceRuntimeFiles = Object.freeze([
  'qwen_gguf_worker.py','qwen_gguf_abi.py','runtime-qwen-gguf-windows.json',
  'voxcpm_windows_gguf_worker.py','voxcpm_windows_gguf_runtime.py','runtime-gguf-windows-voxcpm2.json',
  'managed_gguf_runtime.py', 'managed-gguf-runtime-catalog.json',
  'install_qwen.py','install-qwen-darwin-arm64.json','install-qwen-win32-x64.json','windows_model_check.py', 'qwen_mlx_worker.py', 'qwen_audio.py', 'qwen-mlx-policy.json', 'qwen_worker.py', 'qwen_memory.py', 'qwen-policy.json',
  'reference-import-worker.cjs', 'reference-policy.json', 'reference_condition.py','seed_contract.py', 'worker.py', 'engine.py', 'control.py', 'base-voice-defaults.json',
  'backend.py', 'macos_runtime.py', 'runtime-macos.json', 'gguf_worker.py',
  'gguf_runtime.py', 'gguf_cache.py', 'gguf_prepare.py', 'voice_package.py',
  'runtime-gguf-macos.json', 'windows_base_worker.py', 'runtime-windows-base.json',
  'install-windows-base.json', 'install_windows_base.py',
])

export function checkInstallerPayload(files, asar) {
  const expected = new Set(voiceRuntimeFiles.map(name => 'resources/voice/' + name))
  const found = new Set()
  const catalog = JSON.parse(extractFile(asar, normalize('dist-electron/voice/' + managedRuntimeCatalogName)).toString('utf8'))
  const archives = new Map(managedRuntimeArchivePins(catalog).map(pin => ['resources/voice/' + managedRuntimeArchivesName + '/' + pin.name, pin]))
  const foundArchives = new Set()
  for (const file of files) {
    if (expected.has(file.path)) {
      if (found.has(file.path)) throw Error('Duplicate voice runtime resource')
      const bytes = extractFile(asar, normalize('dist-electron/voice/' + file.path.slice('resources/voice/'.length)))
      if (bytes.length !== file.bytes || createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw Error('Voice runtime differs from packaged ASAR: ' + file.path)
      found.add(file.path)
    } else if (archives.has(file.path)) {
      if (foundArchives.has(file.path)) throw Error('Duplicate managed GGUF runtime archive')
      const pin = archives.get(file.path)
      if (file.bytes !== pin.bytes || file.sha256 !== pin.sha256) throw Error('Managed GGUF runtime archive differs from packaged catalog: ' + file.path)
      foundArchives.add(file.path)
    } else if (file.path.startsWith('resources/voice/') || /(^|\/)(skills|scripts|node_modules|docs|outputs|workflows|__pycache__)(\/|$)|\.(py|pyc|map|petchar|gguf|safetensors|ckpt|pt|pth|onnx)$/i.test(file.path)) {
      throw Error('Authoring or development content found in installer payload: ' + file.path)
    }
  }
  if (found.size !== expected.size) throw Error('Missing voice runtime resource in installer payload')
  if (foundArchives.size !== archives.size) throw Error('GGUF_RUNTIME_PACKAGE_NOT_READY: Missing fixed runtime archive in installer payload')
}
