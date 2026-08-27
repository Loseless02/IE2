import { app, net, session, shell, type WebContents } from 'electron'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PARTITION } from './partitions'
import type { InstallableApp } from '../shared/types'

const WORLD_ID = 998

/**
 * Reads the page's own description of itself: the manifest link plus the
 * fallbacks browsers use when a site has no manifest icons.
 */
const DETECT_SCRIPT = `
(() => {
  const link = document.querySelector('link[rel="manifest"]');
  const icon = document.querySelector('link[rel="apple-touch-icon"], link[rel="icon"]');
  return {
    manifestUrl: link ? new URL(link.getAttribute('href'), location.href).href : null,
    title: document.title || location.hostname,
    iconUrl: icon ? new URL(icon.getAttribute('href'), location.href).href : null
  };
})()
`

interface ManifestIcon {
  src: string
  sizes?: string
  type?: string
  purpose?: string
}

/**
 * Decide whether the current page presents itself as an installable web app,
 * and if so under what name and icon. Sites without a manifest are not
 * offered — that is the same rule Chrome and Brave apply.
 */
export async function detectInstallable(wc: WebContents): Promise<InstallableApp | null> {
  let probe: { manifestUrl: string | null; title: string; iconUrl: string | null }

  try {
    probe = await wc.executeJavaScriptInIsolatedWorld(WORLD_ID, [{ code: DETECT_SCRIPT }])
  } catch {
    return null
  }

  if (!probe?.manifestUrl) return null

  const pageUrl = wc.getURL()
  if (!/^https?:$/.test(safeProtocol(pageUrl))) return null

  const manifest = await fetchJson(probe.manifestUrl)
  if (!manifest) return null

  const name = String(manifest.short_name || manifest.name || probe.title).trim().slice(0, 60)
  const startUrl = resolve(manifest.start_url, probe.manifestUrl) ?? pageUrl
  const iconUrl = pickIcon(manifest.icons, probe.manifestUrl) ?? probe.iconUrl

  return { name: name || hostOf(pageUrl), startUrl, iconUrl, origin: hostOf(pageUrl) }
}

/**
 * Install: fetch the icon, convert it to a Windows .ico, and drop a desktop
 * shortcut that launches this browser in single-site mode.
 */
export async function installApp(entry: InstallableApp): Promise<string> {
  const dir = join(app.getPath('userData'), 'apps')
  await mkdir(dir, { recursive: true })

  const slug = appSlug(entry.origin)
  let iconPath: string | undefined

  if (entry.iconUrl) {
    const png = await fetchBinary(entry.iconUrl)
    if (png && isPng(png)) {
      iconPath = join(dir, `${slug}.ico`)
      await writeFile(iconPath, icoFromPng(png))
    }
  }

  // In development the executable is Electron itself, so the app directory has
  // to be passed along or the shortcut would launch a bare Electron.
  const args = app.isPackaged
    ? `--app="${entry.startUrl}"`
    : `"${app.getAppPath()}" --app="${entry.startUrl}"`

  const shortcut = join(app.getPath('desktop'), `${sanitiseFilename(entry.name)}.lnk`)

  // Windows groups taskbar buttons by AppUserModelID. Without a distinct one
  // per installed app, every app-mode window would share the browser's identity
  // — and the last shortcut's icon and name would be shown for all of them.
  shell.writeShortcutLink(shortcut, 'create', {
    target: process.execPath,
    args,
    description: entry.name,
    appUserModelId: appUserModelIdFor(entry.origin),
    ...(iconPath ? { icon: iconPath, iconIndex: 0 } : {})
  })

  return shortcut
}

export function appSlug(origin: string): string {
  return origin.replace(/[^a-z0-9]+/gi, '-').toLowerCase()
}

/** Stable per-site identity, so Windows treats each installed app separately. */
export function appUserModelIdFor(origin: string): string {
  return `com.internetexplorer2.app.${appSlug(origin)}`
}

/** Where the icon for an installed app was written, if it has one. */
export function appIconPath(origin: string): string {
  return join(app.getPath('userData'), 'apps', `${appSlug(origin)}.ico`)
}

// --- helpers ----------------------------------------------------------------

function safeProtocol(url: string): string {
  try {
    return new URL(url).protocol.replace(':', '') + ':'
  } catch {
    return ''
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

function resolve(value: unknown, base: string): string | null {
  if (typeof value !== 'string' || !value) return null
  try {
    return new URL(value, base).href
  } catch {
    return null
  }
}

/** Largest square PNG wins; maskable icons are skipped as they crop badly. */
function pickIcon(icons: unknown, base: string): string | null {
  if (!Array.isArray(icons)) return null

  const usable = (icons as ManifestIcon[])
    .filter((icon) => typeof icon?.src === 'string')
    .filter((icon) => !icon.purpose || !icon.purpose.includes('maskable'))
    .map((icon) => ({
      src: icon.src,
      size: Math.max(0, ...(icon.sizes ?? '').split(/\s+/).map((s) => parseInt(s, 10) || 0))
    }))
    .sort((a, b) => b.size - a.size)

  return usable.length > 0 ? resolve(usable[0].src, base) : null
}

async function fetchJson(url: string): Promise<Record<string, unknown> | null> {
  try {
    // Uses the browsing session so manifests behind a login still resolve.
    const response = await session.fromPartition(PARTITION).fetch(url)
    if (!response.ok) return null
    return (await response.json()) as Record<string, unknown>
  } catch {
    return null
  }
}

async function fetchBinary(url: string): Promise<Buffer | null> {
  try {
    const response = await net.fetch(url)
    if (!response.ok) return null
    return Buffer.from(await response.arrayBuffer())
  } catch {
    return null
  }
}

function isPng(buffer: Buffer): boolean {
  return buffer.length > 24 && buffer.readUInt32BE(0) === 0x89504e47
}

/**
 * ICO files may contain PNG data verbatim, so no decoding is needed — the
 * dimensions come straight out of the PNG header.
 */
function icoFromPng(png: Buffer): Buffer {
  const width = png.readUInt32BE(16)
  const height = png.readUInt32BE(20)

  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(1, 4)

  const entry = Buffer.alloc(16)
  entry[0] = width >= 256 ? 0 : width
  entry[1] = height >= 256 ? 0 : height
  entry.writeUInt16LE(1, 4)
  entry.writeUInt16LE(32, 6)
  entry.writeUInt32LE(png.length, 8)
  entry.writeUInt32LE(22, 12)

  return Buffer.concat([header, entry, png])
}

function sanitiseFilename(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim() || 'Web App'
}
