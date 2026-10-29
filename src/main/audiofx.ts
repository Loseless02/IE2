import { ipcMain, type WebContents } from 'electron'
import { cleanFx, isNeutral, type AudioFx, type AudioFxReport, type AudioFxState } from '../shared/audiofx'
import { fxForSite, setFxForSite } from './db'

/**
 * The audio effects tool's state. Each tab keeps its own settings for as long
 * as it is open, through navigations — the next song on a music site plays
 * slowed like the last. A site can also be remembered, so it opens with them.
 */

const perTab = new Map<number, AudioFx>()
const reports = new Map<number, AudioFxReport>()

interface Hooks {
  activeTabFor: (chrome: WebContents) => WebContents | null
  chromeFor: (tab: WebContents) => WebContents | null
}

function originOf(url: string | undefined): string | null {
  try {
    const parsed = new URL(url ?? '')
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.origin : null
  } catch {
    return null
  }
}

function remembered(origin: string | null): AudioFx | null {
  if (!origin) return null
  const stored = fxForSite(origin)
  if (!stored) return null
  try {
    return cleanFx(JSON.parse(stored) as Partial<AudioFx>)
  } catch {
    return null
  }
}

function forget(tab: WebContents): void {
  const id = tab.id
  tab.once('destroyed', () => {
    perTab.delete(id)
    reports.delete(id)
  })
}

export function registerAudioFxIpc(hooks: Hooks): void {
  const stateFor = (tab: WebContents): AudioFxState | null => {
    const origin = originOf(tab.getURL())
    if (!origin) return null
    const site = remembered(origin)
    return {
      origin,
      fx: perTab.get(tab.id) ?? site ?? cleanFx(null),
      remembered: site !== null,
      report: reports.get(tab.id) ?? null
    }
  }

  // A page starting up: the tab's settings, or the site's remembered ones.
  ipcMain.handle('fx:initial', (event) => {
    if (!event.senderFrame || event.senderFrame.parent !== null) return null
    const origin = originOf(event.senderFrame.url)
    reports.delete(event.sender.id)
    const fx = perTab.get(event.sender.id) ?? remembered(origin)
    return fx && !isNeutral(fx) ? fx : null
  })

  ipcMain.handle('fx:report', (event, value: unknown) => {
    if (!event.senderFrame || event.senderFrame.parent !== null) return
    const report = value as Partial<AudioFxReport> | null
    if (!reports.has(event.sender.id) && !perTab.has(event.sender.id)) forget(event.sender)
    reports.set(event.sender.id, { hasMedia: Boolean(report?.hasMedia), limited: Boolean(report?.limited) })
    const chrome = hooks.chromeFor(event.sender)
    if (chrome && !chrome.isDestroyed()) chrome.send('browser:fx-changed')
  })

  ipcMain.handle('fx:get', (event) => {
    const tab = hooks.activeTabFor(event.sender)
    return tab ? stateFor(tab) : null
  })

  ipcMain.handle('fx:set', (event, value: Partial<AudioFx>, remember: boolean) => {
    const tab = hooks.activeTabFor(event.sender)
    const origin = originOf(tab?.getURL())
    if (!tab || !origin) return null

    const fx = cleanFx(value)
    if (!perTab.has(tab.id) && !reports.has(tab.id)) forget(tab)
    perTab.set(tab.id, fx)
    if (remember) setFxForSite(origin, JSON.stringify(fx))
    else if (remembered(origin)) setFxForSite(origin, null)

    tab.mainFrame.send('fx:apply', fx)
    return stateFor(tab)
  })
}
