import { app, nativeImage, net, session, shell, type WebContents } from 'electron'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PARTITION } from './partitions'
import type { InstallableApp } from '../shared/types'

const WORLD_ID = 998

/**
 * Reads the page's own description of itself: the manifest link plus every
 * icon the document declares, best first — the fallbacks browsers use when a
 * manifest has no icon that can actually be drawn.
 */
const DETECT_SCRIPT = `
(() => {
  const link = document.querySelector('link[rel="manifest"]');

  const links = [...document.querySelectorAll('link[rel~="icon"], link[rel="apple-touch-icon"], link[rel="apple-touch-icon-precomposed"]')];
  const icons = links
    .map((el) => {
      const href = el.getAttribute('href');
      if (!href) return null;
      const rel = el.getAttribute('rel') || '';
      const size = Math.max(0, ...String(el.getAttribute('sizes') || '').split(/\\s+/).map((s) => parseInt(s, 10) || 0));
      try {
        return { url: new URL(href, location.href).href, size, touch: rel.includes('apple-touch') ? 1 : 0 };
      } catch (e) {
        return null;
      }
    })
    .filter(Boolean)
    // The touch icon is the one meant to be shown at desktop size, and it is
    // always a raster; after that, the biggest wins.
    .sort((a, b) => b.touch - a.touch || b.size - a.size)
    .map((icon) => icon.url);

  return {
    manifestUrl: link ? new URL(link.getAttribute('href'), location.href).href : null,
    title: document.title || location.hostname,
    icons
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
  let probe: { manifestUrl: string | null; title: string; icons: string[] }

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

  const name = String(manifest.short_name || manifest.name || probe.title)
    .trim()
    .slice(0, 60)
  const startUrl = resolve(manifest.start_url, probe.manifestUrl) ?? pageUrl

  // Every source there is, best first. Which one yields a usable raster differs
  // per site — a manifest listing only SVG, or only maskable icons, or serving
  // them from a CDN that refuses the request, is common enough that a single
  // guess came back empty often and the shortcut ended up wearing our own icon.
  const candidates = unique([
    ...manifestIcons(manifest.icons, probe.manifestUrl),
    ...(probe.icons ?? []),
    resolve('/apple-touch-icon.png', pageUrl),
    resolve('/favicon.ico', pageUrl)
  ])

  return {
    name: name || hostOf(pageUrl),
    startUrl,
    iconUrl: candidates[0] ?? null,
    iconUrls: candidates,
    origin: hostOf(pageUrl)
  }
}

/**
 * Install: fetch the icon, convert it to a Windows .ico, and drop a desktop
 * shortcut that launches this browser in single-site mode.
 */
export async function installApp(entry: InstallableApp): Promise<string> {
  const dir = join(app.getPath('userData'), 'apps')
  await mkdir(dir, { recursive: true })

  const slug = appSlug(entry.origin)
  const sources = entry.iconUrls?.length ? entry.iconUrls : entry.iconUrl ? [entry.iconUrl] : []

  const ico = await buildIcon(sources)
  let iconPath: string | undefined

  if (ico) {
    iconPath = join(dir, `${slug}.ico`)
    await writeFile(iconPath, ico)
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

function unique(urls: (string | null)[]): string[] {
  return [...new Set(urls.filter((url): url is string => Boolean(url)))]
}

/**
 * The manifest's icons, in the order worth trying.
 *
 * Rasters before vectors, because nothing here can draw an SVG. Ordinary icons
 * before maskable ones, which are drawn with a wide safety margin meant to be
 * cropped to a circle and look tiny and lost in a square. Then largest first: a
 * 512 shrinks to any size cleanly, a 32 blown up to 256 does not.
 */
function manifestIcons(icons: unknown, base: string): string[] {
  if (!Array.isArray(icons)) return []

  return (icons as ManifestIcon[])
    .filter((icon) => typeof icon?.src === 'string')
    .map((icon) => ({
      url: resolve(icon.src, base),
      vector: /\.svg(\?|$)/i.test(icon.src) || icon.type === 'image/svg+xml',
      maskable: Boolean(icon.purpose?.includes('maskable')),
      size: Math.max(0, ...(icon.sizes ?? '').split(/\s+/).map((s) => parseInt(s, 10) || 0))
    }))
    .filter((icon) => Boolean(icon.url))
    .sort(
      (a, b) =>
        Number(a.vector) - Number(b.vector) ||
        Number(a.maskable) - Number(b.maskable) ||
        b.size - a.size
    )
    .map((icon) => icon.url as string)
}

/**
 * Big enough for every slot Windows draws an icon in, so there is no reason to
 * keep fetching once something this size has been found.
 */
const ENOUGH = 180

/**
 * The best icon the site can be talked into providing.
 *
 * Not the first that decodes, but the largest of the first few: a site's
 * manifest can point at icons that no longer exist — Spotify's do, all of them
 * 404 — and what is left is a 32px favicon that makes a poor desktop icon. It
 * is worth spending two more requests to find out whether something better is
 * sitting at one of the usual addresses.
 */
async function buildIcon(sources: string[]): Promise<Buffer | null> {
  let best: Electron.NativeImage | null = null
  let bestSize = 0

  for (const url of sources.slice(0, 6)) {
    const data = await fetchBinary(url)
    if (!data || data.length === 0) continue

    const image = await decode(data, url)
    if (!image || image.isEmpty()) continue

    // A 16px favicon blown up to a desktop icon looks worse than our own icon
    // does, so it is not worth taking.
    const { width, height } = image.getSize()
    const size = Math.max(width, height)
    if (size < 32) continue

    if (size > bestSize) {
      best = image
      bestSize = size
    }

    if (bestSize >= ENOUGH) break
  }

  return best ? icoFrom(best) : null
}

/**
 * nativeImage reads PNG and JPEG from a buffer, but .ico only from a file — and
 * a favicon is very often an .ico. Writing it out costs one temporary file and
 * saves carrying an image decoder.
 */
async function decode(data: Buffer, url: string): Promise<Electron.NativeImage | null> {
  const direct = nativeImage.createFromBuffer(data)
  if (!direct.isEmpty()) return direct

  if (!isIco(data) && !/\.ico(\?|$)/i.test(url)) return null

  const scratch = join(tmpdir(), `ie2-icon-${Date.now()}-${Math.random().toString(36).slice(2)}.ico`)

  try {
    await writeFile(scratch, data)
    const fromFile = nativeImage.createFromPath(scratch)
    return fromFile.isEmpty() ? null : fromFile
  } catch {
    return null
  } finally {
    await rm(scratch, { force: true }).catch(() => {})
  }
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
  // Through the browsing session first, like the manifest: some sites serve
  // their icons from a CDN that turns away a request carrying no cookies.
  try {
    const response = await session.fromPartition(PARTITION).fetch(url)
    if (response.ok) return Buffer.from(await response.arrayBuffer())
  } catch {
    // Falls through to a plain request.
  }

  try {
    const response = await net.fetch(url)
    if (!response.ok) return null
    return Buffer.from(await response.arrayBuffer())
  } catch {
    return null
  }
}

function isIco(buffer: Buffer): boolean {
  return buffer.length > 6 && buffer.readUInt16LE(0) === 0 && buffer.readUInt16LE(2) === 1
}

/** The sizes Windows actually asks for, largest first. */
const ICON_SIZES = [256, 128, 64, 48, 32, 24, 16]

/**
 * Pack one image into a multi-resolution .ico.
 *
 * Windows picks a different size out of the file for every place it draws it —
 * 16 in a title bar, 32 on the taskbar, 48 on the desktop, 256 in a large-icon
 * folder view. A single-entry file leaves Windows to do that scaling itself,
 * with the nearest-neighbour result you can see from across a room.
 *
 * Each entry holds PNG data verbatim, which the format has allowed since Vista,
 * so no bitmap encoding is needed. A size byte of 0 is the format's way of
 * writing 256, which does not fit in a byte.
 */
function icoFrom(image: Electron.NativeImage): Buffer | null {
  const { width, height } = image.getSize()
  const source = width === height ? image : square(image)
  const largest = Math.max(width, height)

  const frames = ICON_SIZES.filter((size) => size <= Math.max(largest, 48))
    .map((size) => ({
      size,
      png: source.resize({ width: size, height: size, quality: 'best' }).toPNG()
    }))
    .filter((frame) => frame.png.length > 0)

  if (frames.length === 0) return null

  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(frames.length, 4)

  let offset = 6 + frames.length * 16
  const entries: Buffer[] = []

  for (const frame of frames) {
    const entry = Buffer.alloc(16)
    entry[0] = frame.size >= 256 ? 0 : frame.size
    entry[1] = frame.size >= 256 ? 0 : frame.size
    entry.writeUInt16LE(1, 4)
    entry.writeUInt16LE(32, 6)
    entry.writeUInt32LE(frame.png.length, 8)
    entry.writeUInt32LE(offset, 12)
    entries.push(entry)
    offset += frame.png.length
  }

  return Buffer.concat([header, ...entries, ...frames.map((frame) => frame.png)])
}

/**
 * A wordmark-shaped icon squashed into a square reads as a smear, so it is
 * centred in a transparent square instead. nativeImage cannot compose two
 * images, but it can hand over its raw pixels and take them back, and copying
 * rows into a bigger buffer is the whole of what compositing onto nothing is.
 */
function square(image: Electron.NativeImage): Electron.NativeImage {
  const { width, height } = image.getSize()
  const side = Math.max(width, height)

  const source = image.toBitmap()
  const out = Buffer.alloc(side * side * 4)

  const left = Math.floor((side - width) / 2)
  const top = Math.floor((side - height) / 2)

  for (let row = 0; row < height; row++) {
    source.copy(out, ((top + row) * side + left) * 4, row * width * 4, (row + 1) * width * 4)
  }

  const padded = nativeImage.createFromBitmap(out, { width: side, height: side })
  return padded.isEmpty() ? image : padded
}

function sanitiseFilename(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim() || 'Web App'
}
