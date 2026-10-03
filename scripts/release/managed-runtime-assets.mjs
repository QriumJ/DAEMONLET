// Build/Forge/installer checks consume the same fixed archive pins. These
// archives are data here: no interpreter, native binary or installer is run.
import { constants } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import {verifyRuntimeTermsDocuments} from './runtime-terms.mjs'

export const managedRuntimeCatalogName = 'managed-gguf-runtime-catalog.json'
export const managedRuntimeArchivesName = 'managed-gguf-runtime-archives'
const runtimeIds = ['qwen-cuda', 'qwen-vulkan', 'vox-cuda', 'vox-vulkan']
const missing = error => error?.code === 'ENOENT'
const fail = reason => Error('GGUF_RUNTIME_PACKAGE_NOT_READY: ' + reason)
const ordinary = info => info.isFile() && !info.isSymbolicLink() && info.nlink === 1n
const stamp = info => [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].map(String)

async function verifyWorkerCatalogPins(voiceDirectory, bytes) {
  const expected = { filename: managedRuntimeCatalogName, bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex') }
  for (const name of ['runtime-qwen-gguf-windows.json', 'runtime-gguf-windows-voxcpm2.json']) {
    const policy = JSON.parse(await readFile(join(voiceDirectory, name), 'utf8'))
    if (!isDeepStrictEqual(policy.managedRuntimeCatalog, expected)) throw fail('worker catalog pin differs: ' + name)
  }
}

export function managedRuntimeArchivePins(catalog, { requireAvailable = true } = {}) {
  if (catalog?.schemaVersion !== 1 || catalog.platform !== 'win32-x64' || !catalog.components || !catalog.runtimes ||
      !isDeepStrictEqual(Object.keys(catalog.runtimes).sort(), [...runtimeIds].sort())) throw fail('invalid catalog')
  const used = new Set()
  for (const id of runtimeIds) {
    const runtime = catalog.runtimes[id]
    if (!runtime || runtime.id !== id || typeof runtime.available !== 'boolean' || !Array.isArray(runtime.components) ||
        requireAvailable && !runtime.available) throw fail('runtime artifact unavailable: ' + id)
    if (runtime.available) {
      if (!runtime.components.length || new Set(runtime.components).size !== runtime.components.length) throw fail('invalid runtime components')
      for (const component of runtime.components) used.add(component)
    }
  }
  const pins = [], names = new Set()
  for (const id of used) {
    const component = Object.hasOwn(catalog.components, id) ? catalog.components[id] : undefined
    const archive = component?.archive
    if (component?.id !== id || !archive || archive.format !== 'zip' ||
        !/^[a-z][a-z0-9-]*\.zip$/.test(archive.name) || archive.bundledPath !== archive.name ||
        !Number.isSafeInteger(archive.bytes) || archive.bytes < 22 || archive.bytes > 4 * 1024 ** 3 ||
        !/^[a-f0-9]{64}$/.test(archive.sha256) || names.has(archive.name.toLowerCase()) ||
        !component.files || !Object.keys(component.files).length || !component.provenance || !Object.keys(component.provenance).length) throw fail('invalid component: ' + id)
    names.add(archive.name.toLowerCase())
    pins.push({ id, name: archive.name, bytes: archive.bytes, sha256: archive.sha256 })
  }
  if (Object.keys(catalog.components).some(id => !used.has(id))) throw fail('unreferenced archive component')
  return pins.sort((a, b) => a.name.localeCompare(b.name))
}

async function directory(path) {
  if (!isAbsolute(path) || resolve(path) !== path) throw fail('noncanonical archive path')
  for (let current = path;; current = dirname(current)) {
    const info = await lstat(current)
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(current) !== current) throw fail('archive directory is linked')
    if (dirname(current) === current) break
  }
}

async function archiveFile(path, pin, destination) {
  const before = await lstat(path, { bigint: true })
  if (!ordinary(before) || before.size !== BigInt(pin.bytes)) throw fail('archive size or file type differs: ' + pin.name)
  const source = await open(path, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW))
  let output
  try {
    const identity = await source.stat({ bigint: true })
    if (!ordinary(identity) || !isDeepStrictEqual(stamp(identity), stamp(before))) throw fail('archive changed: ' + pin.name)
    if (destination) output = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
    const hash = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024)
    let offset = 0
    for (;;) {
      const { bytesRead } = await source.read(buffer, 0, buffer.length, offset)
      if (!bytesRead) break
      offset += bytesRead
      if (offset > pin.bytes) throw fail('archive grew: ' + pin.name)
      const part = buffer.subarray(0, bytesRead)
      hash.update(part)
      if (output) await output.writeFile(part)
    }
    if (offset !== pin.bytes || hash.digest('hex') !== pin.sha256 ||
        !ordinary(await source.stat({ bigint: true })) || !ordinary(await lstat(path, { bigint: true })) ||
        !isDeepStrictEqual(stamp(identity), stamp(await source.stat({ bigint: true }))) ||
        !isDeepStrictEqual(stamp(identity), stamp(await lstat(path, { bigint: true })))) throw fail('archive SHA or identity differs: ' + pin.name)
    if (output) await output.sync()
  } finally {
    try { await output?.close() } finally { await source.close() }
  }
}

export async function verifyManagedRuntimeArchives(path, catalog) {
  const pins = managedRuntimeArchivePins(catalog)
  try {
    await directory(path)
    if (!isDeepStrictEqual((await readdir(path)).sort(), pins.map(pin => pin.name).sort())) throw fail('archive allowlist differs; stage all fixed runtime archives')
    for (const pin of pins) await archiveFile(join(path, pin.name), pin)
  } catch (error) {
    if (missing(error)) throw fail('missing archive; stage the fixed Windows GGUF runtime and rebuild')
    throw error
  }
  return { archives: pins.length, bytes: pins.reduce((total, pin) => total + pin.bytes, 0) }
}

/** @param {string} root @param {string} voiceDirectory @param {{target?: string, production?: boolean, sourceOnlyRuntime?: boolean}} options */
export async function stageManagedRuntimeArchives(root, voiceDirectory, { target, production = false, sourceOnlyRuntime = false } = {}) {
  const report = { schemaVersion: 1, target, status: 'not-required', archives: 0, bytes: 0, cleanHostVerified: false, publicReleaseApproved: false }
  if (!target?.startsWith('win32-')) return report
  if (target !== 'win32-x64') throw fail('unsupported Windows target: ' + target)
  const catalogBytes = await readFile(join(root, 'electron/voice', managedRuntimeCatalogName))
  await verifyWorkerCatalogPins(join(root, 'electron/voice'), catalogBytes)
  const catalog = JSON.parse(catalogBytes.toString('utf8'))
  report.catalogSha256 = createHash('sha256').update(catalogBytes).digest('hex')
  const pins = managedRuntimeArchivePins(catalog)
  const source = join(root, '.generated/voice-gguf-runtime/win32-x64/archives')
  // Explicit source CI can compile the production graph without local archives.
  // An existing archive directory must still pass every integrity check.
  // The default production build and Forge package require all pinned archives.
  if (!production || sourceOnlyRuntime) {
    try {
      await lstat(source)
    } catch (error) {
      if (!missing(error)) throw error
      // Missing descendants must not hide an existing linked parent directory.
      for (let parent = dirname(source);; parent = dirname(parent)) {
        try { await lstat(parent) } catch (parentError) { if (missing(parentError)) continue; throw parentError }
        await directory(parent)
        break
      }
      return { ...report, status: 'source-only-runtime-unavailable', ...(sourceOnlyRuntime ? { sourceOnlyRuntime: true } : {}) }
    }
  }
  await verifyManagedRuntimeArchives(source, catalog)
  await directory(voiceDirectory)
  const targetDirectory = join(voiceDirectory, managedRuntimeArchivesName)
  try { await lstat(targetDirectory); throw fail('archive output already exists') } catch (error) { if (!missing(error)) throw error }
  const temporary = join(voiceDirectory, '.managed-gguf-archives-' + randomUUID())
  await mkdir(temporary, { mode: 0o700 })
  try {
    for (const pin of pins) await archiveFile(join(source, pin.name), pin, join(temporary, pin.name))
    const verified = await verifyManagedRuntimeArchives(temporary, catalog)
    await rename(temporary, targetDirectory)
    return { ...report, ...verified, status: 'bundled' }
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

export function verifyManagedRuntimeBuildReport(report, catalogBytes, { sourceOnlyRuntime = false } = {}) {
  if (report.target === 'win32-x64') {
    const pins = managedRuntimeArchivePins(JSON.parse(catalogBytes.toString('utf8')))
    const pinned = report.catalogSha256 === createHash('sha256').update(catalogBytes).digest('hex')
    const bundled = report.status === 'bundled' && report.archives === pins.length &&
      report.bytes === pins.reduce((total, pin) => total + pin.bytes, 0)
    const unavailable = sourceOnlyRuntime && report.sourceOnlyRuntime === true &&
      report.status === 'source-only-runtime-unavailable' && report.archives === 0 && report.bytes === 0
    if (!pinned || !(bundled || unavailable)) throw fail('source-only build cannot become a Windows installer candidate')
  } else if (report.target?.startsWith('win32-')) throw fail('unsupported Windows runtime target')
}

export async function verifyPackagedManagedRuntime(voiceDirectory, target, { trustedCatalogPath } = {}) {
  if (!target?.startsWith('win32-')) return { status: 'not-required', archives: 0, bytes: 0 }
  if (target !== 'win32-x64') throw fail('unsupported Windows target: ' + target)
  const bytes = await readFile(join(voiceDirectory, managedRuntimeCatalogName))
  if (trustedCatalogPath && !bytes.equals(await readFile(trustedCatalogPath))) throw fail('packaged runtime catalog differs from source')
  await verifyWorkerCatalogPins(voiceDirectory, bytes)
  const catalog=JSON.parse(bytes.toString('utf8'))
  if(Object.values(catalog.components).some(component=>Object.keys(component.files).some(path=>/(?:vcruntime140|msvcp140|vcomp140)/i.test(path))))await verifyRuntimeTermsDocuments(voiceDirectory)
  return { status: 'bundled', ...await verifyManagedRuntimeArchives(join(voiceDirectory, managedRuntimeArchivesName), catalog) }
}
