import { net, protocol, session } from 'electron'
import { extname, join, normalize } from 'node:path'
import { pathToFileURL } from 'node:url'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { getSettings } from './settings'
import { isBuiltInWallpaper } from '../shared/wallpapers'

/**
 * Internal pages live behind `ie2://`, registered as a standard, secure scheme
 * so they get a real origin, normal fetch behaviour and no mixed-content
 * warnings — the same treatment Chrome gives `chrome://`.
 *
 * Must be called before app ready.
 */
export function registerInternalScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'ie2',
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true }
    }
  ])
}

/**
 * Serve `ie2://<page>/<asset>` out of the built renderer bundle, or out of the
 * Vite dev server when running `npm run dev` so hot reload still works.
 *
 * Every partition has its own protocol registry, and `protocol.handle` only
 * touches the default session. Tabs run in `persist:default` and `amnesia`, so
 * the handler has to be installed on each of those sessions too — otherwise
 * internal pages fail with ERR_FAILED in exactly the places they are used.
 */
export function handleInternalProtocol(partitions: string[]): void {
  const devServer = process.env['ELECTRON_RENDERER_URL']
  const root = join(__dirname, '../renderer')

  const handler = async (request: Request): Promise<Response> => {
    const url = new URL(request.url)

    // ie2://wallpaper resolves to whatever the user picked in Settings. The
    // path is never taken from the request, so a page cannot read the disk
    // through this — it only ever gets the file already chosen.
    if (url.hostname === WALLPAPER_HOST) {
      // ie2://wallpaper/<name> addresses one of the wallpapers we ship, so the
      // picker can show them all. Only names on the shipped list are served,
      // and the name is never joined onto a path before that check.
      const named = decodeURIComponent(url.pathname.replace(/^\//, ''))

      if (named) {
        if (!isBuiltInWallpaper(named)) return new Response('Not found', { status: 404 })
        return net.fetch(pathToFileURL(join(wallpaperRoot(), named)).toString())
      }

      const file = resolveWallpaper()
      if (!file) return new Response('No wallpaper', { status: 404 })
      return net.fetch(pathToFileURL(file).toString())
    }

    // ie2://home -> newtab.html; ie2://home/assets/x.js -> assets/x.js
    const path = url.pathname === '/' || url.pathname === '' ? `${url.hostname}.html` : url.pathname

    const relative = pageFile(url.hostname, path)
    if (!relative) return new Response('Not found', { status: 404 })

    if (devServer) return net.fetch(new URL(relative, devServer).toString())

    // Contain every request to the bundle directory — no traversal out of it.
    const target = normalize(join(root, relative))
    if (!target.startsWith(normalize(root))) return new Response('Forbidden', { status: 403 })

    return net.fetch(pathToFileURL(target).toString())
  }

  protocol.handle('ie2', handler)
  for (const partition of partitions) {
    session.fromPartition(partition).protocol.handle('ie2', handler)
  }
}

/** Hostnames that map to a real internal page. Anything else 404s. */
const PAGES = new Set(['home', 'help', 'settings', 'translate', 'bookmarks'])

/** Host that serves the chosen wallpaper, and nothing else on disk. */
const WALLPAPER_HOST = 'wallpaper'

function pageFile(host: string, path: string): string | null {
  if (!PAGES.has(host)) return null
  return path.startsWith('/') ? path.slice(1) : path
}

/** True for frames we are willing to expose internal APIs to. */
export function isInternalUrl(url: string | undefined): boolean {
  if (!url) return false
  try {
    return new URL(url).protocol === 'ie2:'
  } catch {
    return false
  }
}

const IMAGE_TYPES = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif', '.bmp'])

/**
 * The wallpaper currently in force: a single chosen image, or a random one from
 * the chosen folder. Folder mode picks again on every request, so each new tab
 * gets a different image.
 */
function resolveWallpaper(): string | null {
  const settings = getSettings()

  if (settings.homeBackground === 'builtin') {
    // Matched against the shipped list rather than joined blindly: the name
    // comes from settings, and settings should not be able to name a path.
    if (!isBuiltInWallpaper(settings.homeBuiltin)) return null
    const file = join(wallpaperRoot(), settings.homeBuiltin)
    return existsSync(file) ? file : null
  }

  if (settings.homeBackground === 'image') {
    return settings.homeImage && existsSync(settings.homeImage) ? settings.homeImage : null
  }

  if (settings.homeBackground === 'folder') {
    const images = listImages(settings.homeFolder)
    if (images.length === 0) return null
    return images[Math.floor(Math.random() * images.length)]
  }

  return null
}

/**
 * Where the shipped wallpapers live. Beside the renderer bundle in a build; the
 * dev server serves the same directory from source.
 */
function wallpaperRoot(): string {
  return join(__dirname, '../renderer/wallpapers')
}

export function listImages(folder: string): string[] {
  if (!folder || !existsSync(folder)) return []

  try {
    return readdirSync(folder)
      .filter((name) => IMAGE_TYPES.has(extname(name).toLowerCase()))
      .map((name) => join(folder, name))
      .filter((file) => {
        try {
          return statSync(file).isFile()
        } catch {
          return false
        }
      })
  } catch {
    return []
  }
}
