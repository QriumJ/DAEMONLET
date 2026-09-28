import { createHash } from 'node:crypto'
import { normalize } from 'node:path'
import { extractFile } from '@electron/asar'

// Runtime workers are executable application resources, not authoring tools.
// Keep this list explicit and bind each external copy to the packaged ASAR.
export const voiceRuntimeFiles = Object.freeze([
  'reference-import-worker.cjs', 'reference-policy.json', 'reference_condition.py', 'worker.py', 'engine.py', 'control.py', 'base-voice-defaults.json',
  'backend.py', 'macos_runtime.py', 'runtime-macos.json', 'gguf_worker.py',
  'gguf_runtime.py', 'gguf_cache.py', 'gguf_prepare.py', 'voice_package.py',
  'runtime-gguf-macos.json', 'windows_base_worker.py', 'runtime-windows-base.json',
  'install-windows-base.json', 'install_windows_base.py',
])

export function checkInstallerPayload(files, asar) {
  const expected = new Set(voiceRuntimeFiles.map(name => 'resources/voice/' + name))
  const found = new Set()
  for (const file of files) {
    if (expected.has(file.path)) {
      if (found.has(file.path)) throw Error('Duplicate voice runtime resource')
      const bytes = extractFile(asar, normalize('dist-electron/voice/' + file.path.slice('resources/voice/'.length)))
      if (bytes.length !== file.bytes || createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw Error('Voice runtime differs from packaged ASAR: ' + file.path)
      found.add(file.path)
    } else if (file.path.startsWith('resources/voice/') || /(^|\/)(skills|scripts|node_modules|docs|outputs|workflows|__pycache__)(\/|$)|\.(py|pyc|map|petchar|gguf|safetensors|ckpt|pt|pth|onnx)$/i.test(file.path)) {
      throw Error('Authoring or development content found in installer payload: ' + file.path)
    }
  }
  if (found.size !== expected.size) throw Error('Missing voice runtime resource in installer payload')
}
