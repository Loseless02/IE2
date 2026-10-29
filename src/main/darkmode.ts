import { app, session, type WebContents } from 'electron'
import { ALL_PARTITIONS } from './partitions'
import { getSettings, onSettingsChanged } from './settings'

/**
 * Dark mode for websites, without the flash.
 *
 * Extensions that darken pages restyle them after they have loaded, so a white
 * page is on screen for a moment first — and their restyling breaks layouts.
 * This does neither. Each page is told two things before it draws:
 *
 * - Prefer dark. A site with a dark theme of its own uses it, exactly as its
 *   designers made it.
 * - Chromium's own automatic dark mode: the renderer darkens light backgrounds
 *   and lightens dark text as it paints, so the first frame is already dark.
 *   It leaves photos alone, and leaves pages that are already dark alone, so a
 *   site's own dark theme is not turned back to light.
 *
 * Both are set through the page's DevTools protocol, which is the only way
 * Electron offers to set them for one page rather than the whole browser.
 */

const DARK_BACKGROUND = '#121212'

/** Whether each page has dark mode set on it right now. */
const applied = new Map<number, boolean>()
const pages = new Set<WebContents>()
let changed: () => void = () => undefined

/** What a tab shows before its page draws: dark when dark mode is on, so not even that flashes. */
export function pageBackground(): string {
  return getSettings().darkMode ? DARK_BACKGROUND : '#ffffff'
}

/** A site's name for the per-site switch: its host, without `www.`. */
export function darkSiteKey(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return parsed.hostname.replace(/^www\./, '')
  } catch {
    return null
  }
}

function wantsDark(url: string): boolean {
  const settings = getSettings()
  if (!settings.darkMode) return false
  // A blank page on its way somewhere is dark too, or it is the flash.
  if (url === 'about:blank') return true
  const site = darkSiteKey(url)
  if (site) return !settings.darkModeOff.includes(site)
  return url.startsWith('file:')
}

async function apply(contents: WebContents, dark: boolean): Promise<void> {
  if (contents.isDestroyed() || applied.get(contents.id) === dark) return
  // Never darkened, and dark mode off: nothing to undo, and no reason to attach.
  // With it on, a site switched off still needs its white background.
  if (!dark && !applied.has(contents.id) && !getSettings().darkMode) return
  applied.set(contents.id, dark)
  const debug = contents.debugger
  try {
    if (!debug.isAttached()) debug.attach('1.3')
    await debug.sendCommand('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : '' }]
    })
    await debug.sendCommand('Emulation.setAutoDarkModeOverride', dark ? { enabled: true } : {})
    // A page with no background of its own shows the tab's, which is dark
    // while dark mode is on — so a site it is switched off for gets white.
    await debug.sendCommand('Emulation.setDefaultBackgroundColorOverride', {
      color: dark ? { r: 18, g: 18, b: 18, a: 1 } : { r: 255, g: 255, b: 255, a: 1 }
    })
  } catch (error) {
    applied.delete(contents.id)
    console.warn('Dark mode could not be set on a page:', error)
  }
}

function watch(contents: WebContents): void {
  pages.add(contents)
  // Set as the navigation starts, before the new page draws anything.
  contents.on('did-start-navigation', (event) => {
    if (event.isMainFrame && !event.isSameDocument) void apply(contents, wantsDark(event.url))
  })
  // Opening DevTools on some pages takes the protocol over; take it back next time.
  contents.debugger.on('detach', () => applied.delete(contents.id))
  contents.once('destroyed', () => {
    pages.delete(contents)
    applied.delete(contents.id)
  })
}

/** Turned on or off, or a site switched: every open page follows at once. */
function reapply(): void {
  for (const contents of pages) {
    if (!contents.isDestroyed()) void apply(contents, wantsDark(contents.getURL()))
  }
  changed()
}

/** `onChange` repaints what shows before pages draw, in every window. */
export function initDarkMode(onChange: () => void): void {
  changed = onChange
  const sessions = ALL_PARTITIONS.map((partition) => session.fromPartition(partition))
  app.on('web-contents-created', (_event, contents) => {
    if (sessions.includes(contents.session)) watch(contents)
  })

  let last = `${getSettings().darkMode}|${getSettings().darkModeOff.join()}`
  onSettingsChanged((settings) => {
    const now = `${settings.darkMode}|${settings.darkModeOff.join()}`
    if (now === last) return
    last = now
    reapply()
  })
}
