import { app, ipcMain, session, webContents } from 'electron'
import { ElectronBlocker } from '@ghostery/adblocker-electron'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ALL_PARTITIONS } from './partitions'
import { blockedCount, bumpBlockedCount, bumpCounter, isAdblockOff, setAdblockOff } from './db'
import { getSettings, setSetting } from './settings'
import type { AdblockState } from '../shared/types'

let blocker: ElectronBlocker | null = null
let enabled = true

/** Blocked since launch. The lifetime total lives in the database. */
let sessionBlocked = 0

/**
 * Of the blocked requests, how many were heading to a different site than the
 * page itself — the cross-site calls that carry tracking cookies.
 */
let sessionThirdParty = 0
let pendingThirdParty = 0

/** Blocked per tab, keyed by webContents id, reset on each navigation. */
const perTab = new Map<number, number>()

/** Which domains are doing the most work to reach you, this session. */
const perDomain = new Map<string, number>()

/** Flushed to disk in batches — a counter is not worth a write per request. */
let pendingWrites = 0

/**
 * Counts every blocked request: overall, per tab, per domain, and how many were
 * cross-site. Named rather than inline because the engine is replaced whenever
 * the filter lists are refreshed, and the new one needs the same handler.
 */
function onBlocked(request: {
  tabId?: number
  domain?: string
  hostname?: string
  isThirdParty?: boolean
}): void {
  sessionBlocked++

  if (request.tabId) perTab.set(request.tabId, (perTab.get(request.tabId) ?? 0) + 1)

  const source = request.domain || request.hostname
  if (source) perDomain.set(source, (perDomain.get(source) ?? 0) + 1)

  // The library's own judgement, which understands public suffixes — so
  // bbc.co.uk is not treated as third party to www.bbc.co.uk.
  if (request.isThirdParty) {
    sessionThirdParty++
    pendingThirdParty++
  }

  if (++pendingWrites >= 25) flush()
}

/**
 * Where the serialized engine lives.
 *
 * The name carries which list set built it. The library's cache is a plain
 * read-and-deserialize with no record of its provenance:
 *
 *     read(path).then(deserialize).catch(() => buildFromNetwork())
 *
 * so a cache written by the ads-and-tracking lists is handed straight back to a
 * caller asking for the full set, for as long as the file exists. Changing the
 * lists we ask for therefore had no effect on any machine that had already run
 * the browser once — the reason YouTube kept showing ads after the switch.
 * Naming the file after its lists makes that impossible: different lists,
 * different file.
 */
const ENGINE_SET = 'full'

function enginePath(): string {
  return join(app.getPath('userData'), `adblock-engine-${ENGINE_SET}.bin`)
}

/** Cached lists this old are refetched before use rather than trusted. */
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000

/**
 * Read the cache, but only if it is recent. Stale filter lists are exactly why
 * ads start slipping through on sites that change how they serve them, and the
 * library has no expiry of its own.
 */
async function readFreshEnough(path: string): Promise<Buffer> {
  const { mtimeMs } = await stat(path)
  if (Date.now() - mtimeMs > CACHE_MAX_AGE_MS) throw new Error('cached lists are stale')
  return readFile(path)
}

/**
 * Ads and trackers, blocked at the network layer for every tab. The filter
 * engine is serialized to userData after the first fetch, so later launches
 * start blocking immediately and offline.
 */
export async function initAdblock(): Promise<void> {
  const cachePath = enginePath()

  try {
    // The full set rather than ads-and-tracking alone: it carries the extra
    // cosmetic rules and scriptlets that sites like YouTube need, where the ad
    // is served from the same place as the content and cannot be blocked by
    // URL alone.
    blocker = await ElectronBlocker.fromPrebuiltFull(fetch, {
      path: cachePath,
      read: readFreshEnough,
      write: writeFile
    })
  } catch {
    // Stale cache and no network: fall back to whatever is on disk, since old
    // rules block more than no rules.
    try {
      blocker = ElectronBlocker.deserialize(await readFile(cachePath))
    } catch {
      // Nothing cached either. Carry on without blocking rather than failing
      // to start the browser.
      return
    }
  }

  blocker.on('request-blocked', onBlocked)

  // Synchronous on purpose: the preload asking this question is racing the
  // page's own scripts, and an async answer loses that race every time.
  ipcMain.on('ie2:scriptlets', (event, url: string) => {
    event.returnValue = typeof url === 'string' ? scriptletsFor(url) : []
  })

  enabled = getSettings().blockAds

  // Filter lists go stale, and a stale list is exactly why ads start slipping
  // through on sites that change their delivery. Refresh in the background.
  scheduleListRefresh(cachePath)

  try {
    applyToSessions(enabled)
  } catch (error) {
    // Browsing without blocking beats not starting.
    console.error('adblock: could not enable blocking', error)
    enabled = false
  }
}

export function isAdblockEnabled(): boolean {
  return enabled && blocker !== null
}

export function toggleAdblock(): boolean {
  if (!blocker) return false
  enabled = !enabled
  setSetting('blockAds', enabled)

  try {
    applyToSessions(enabled)
  } catch (error) {
    console.error('adblock: failed to apply blocking state', error)
    enabled = !enabled
  }

  return enabled
}

export function blockedThisSession(): number {
  return sessionBlocked
}

/** A page starting fresh should not inherit the previous page's tally. */
export function resetTabBlocked(webContentsId: number): void {
  perTab.delete(webContentsId)
}

export function forgetTabBlocked(webContentsId: number): void {
  perTab.delete(webContentsId)
}

/**
 * Everything the shield popup shows: whether blocking is on, what it stopped
 * on this page, this session and all time, and who was trying hardest.
 */
export function adblockStats(activeWebContentsId: number | null): AdblockState {
  const top = [...perDomain.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([domain, count]) => ({ domain, count }))

  const page = activeWebContentsId !== null ? webContents.fromId(activeWebContentsId) : null
  const host = page ? hostOf(page.getURL()) : ''

  return {
    enabled: isAdblockEnabled(),
    available: blocker !== null,
    page: activeWebContentsId !== null ? (perTab.get(activeWebContentsId) ?? 0) : 0,
    session: sessionBlocked,
    // The database total lags by whatever has not been flushed yet.
    lifetime: blockedCount() + pendingWrites,
    top,
    site: host,
    siteOff: host ? isAdblockOff(host) : false
  }
}

/**
 * Turn blocking off, or back on, for the site in the active tab. A site that
 * breaks under blocking needs an answer narrower than switching the shield off
 * everywhere.
 */
export function toggleSiteBlocking(url: string): boolean {
  const host = hostOf(url)
  if (!host) return false

  const off = !isAdblockOff(host)
  setAdblockOff(host, off)
  return off
}

/** Persist the outstanding count. Called on a timer and before quitting. */
export function flush(): void {
  if (pendingThirdParty > 0) {
    bumpCounter('blocked_thirdparty', pendingThirdParty)
    pendingThirdParty = 0
  }

  if (pendingWrites === 0) return
  bumpBlockedCount(pendingWrites)
  pendingWrites = 0
}

export function blockedThirdPartyThisSession(): number {
  return sessionThirdParty
}

/** How old the cached lists may get before they are fetched again. */
const LIST_MAX_AGE_MS = 12 * 60 * 60 * 1000

let lastListUpdate = 0

/**
 * Rebuild the engine from the network, then hand the new one to every session.
 * Failure is silent and harmless: the cached engine keeps working.
 */
async function refreshLists(cachePath: string): Promise<boolean> {
  try {
    const fresh = await ElectronBlocker.fromPrebuiltFull(fetch, {
      path: cachePath,
      read: async () => {
        // Ignore the cache here — the point of this call is to go and look.
        throw new Error('forced refresh')
      },
      write: writeFile
    })

    if (enabled) applyToSessions(false)

    blocker = fresh
    blocker.on('request-blocked', onBlocked)
    lastListUpdate = Date.now()

    if (enabled) applyToSessions(true)
    return true
  } catch (error) {
    // Silence here is how a refresh that never once succeeded went unnoticed
    // for days while the cached lists went stale.
    console.error('adblock: filter list refresh failed', error)
    return false
  }
}

function scheduleListRefresh(cachePath: string): void {
  const tick = (): void => {
    if (Date.now() - lastListUpdate < LIST_MAX_AGE_MS) return
    void refreshLists(cachePath)
  }

  // Once shortly after start, then twice a day while the browser is open.
  setTimeout(tick, 30_000)
  setInterval(tick, 6 * 60 * 60 * 1000)
}

export function updateFilterLists(): Promise<boolean> {
  return refreshLists(enginePath())
}

export function listsUpdatedAt(): number {
  return lastListUpdate
}

/**
 * Sites where the filter lists' scriptlets break the page, and are therefore
 * withheld while network and cosmetic blocking carry on.
 *
 * Deliberately empty. chatgpt.com lived here first, because two of its
 * scriptlets wrapped `fetch` in turn and recursed until the stack ran out. That
 * turned out not to be anything about the site: scriptlets were being injected
 * both late and into one shared global scope, so they collided with each other.
 * With each one now injected once, at document start, in its own function
 * scope, chatgpt.com loads with all of them running.
 *
 * The mechanism stays because a filter list will break a site again eventually,
 * and this is a gentler answer than switching blocking off for it.
 */
const SCRIPTLET_BREAKS: string[] = []

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

function matches(host: string, domains: string[]): boolean {
  return domains.some((domain) => host === domain || host.endsWith(`.${domain}`))
}

const INJECT_CHANNEL = '@ghostery/adblocker/inject-cosmetic-filters'

/** A scriptlet, as the library builds it, always carries this preamble. */
const SCRIPTLET_MARKER = 'scriptletGlobals'

/**
 * Our own cosmetic handler, standing in front of the library's.
 *
 * It handles the hiding rules only. Scriptlets are stripped here and delivered
 * by our own preload instead — see {@link scriptletsFor} — because the
 * library's asynchronous delivery arrives too late to be of any use. Sites the
 * user has excused get nothing at all.
 */
async function onInjectCosmetics(
  event: Electron.IpcMainInvokeEvent,
  url: string,
  msg: unknown
): Promise<void> {
  if (!blocker) return

  const host = hostOf(url)
  if (host && isAdblockOff(host)) return

  const sender = event.sender
  const passThrough = sender.executeJavaScript.bind(sender)

  // Scriptlets have already been injected, at document start, by our preload.
  // Letting the library inject them again here would wrap `fetch` a second
  // time — which is how chatgpt.com ended up recursing until the stack ran out.
  sender.executeJavaScript = ((code: string, gesture?: boolean) =>
    typeof code === 'string' && code.includes(SCRIPTLET_MARKER)
      ? Promise.resolve(undefined)
      : passThrough(code, gesture)) as typeof sender.executeJavaScript

  try {
    await blocker.onInjectCosmeticFilters(event, url, msg as never)
  } finally {
    sender.executeJavaScript = passThrough
  }
}

/**
 * The scriptlets a page should run, answered synchronously so the preload can
 * apply them before the page's own scripts start.
 */
function scriptletsFor(url: string): string[] {
  if (!blocker || !enabled) return []

  const host = hostOf(url)
  if (!host) return []
  if (isAdblockOff(host)) return []
  if (matches(host, SCRIPTLET_BREAKS)) return []

  try {
    const { active, scripts } = blocker.getCosmeticsFilters({
      url,
      hostname: host,
      domain: parentDomain(host),
      getBaseRules: false,
      getInjectionRules: true,
      getExtendedRules: false,
      getRulesFromDOM: false,
      getRulesFromHostname: true
    })

    return active === false ? [] : (scripts ?? [])
  } catch {
    return []
  }
}

/**
 * Best-effort registrable domain. The library normally derives this with a
 * public-suffix list; the last two labels agree with it for the sites that
 * carry hostname-specific rules, and a wrong guess costs a rule, not safety.
 */
function parentDomain(host: string): string {
  const labels = host.split('.')
  return labels.length <= 2 ? host : labels.slice(-2).join('.')
}

/**
 * Likewise for network blocking: requests made by a page the user has excused
 * are let through. Electron allows a single `onBeforeRequest` listener per
 * session, so ours replaces the library's and calls into it.
 */
function installNetworkGuard(ses: Electron.Session): void {
  ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    if (!blocker) {
      callback({})
      return
    }

    const page = details.webContentsId ? webContents.fromId(details.webContentsId) : null
    if (page && isAdblockOff(hostOf(page.getURL()))) {
      callback({})
      return
    }

    blocker.onBeforeRequest(details, callback)
  })
}

/**
 * Cosmetic filtering in @ghostery/adblocker-electron registers *global*
 * ipcMain handlers, not per-session ones, so enabling a second session throws
 * "Attempted to register a second handler" and that session ends up with no
 * blocking at all. Clearing the handlers before each enable lets every session
 * be set up; the last registration serves them all, which is correct because
 * they share one filter engine.
 *
 * Sessions are always enabled and disabled together, so the shared handler is
 * never left pointing at a session that has been turned off.
 */
const COSMETIC_CHANNELS = [
  '@ghostery/adblocker/inject-cosmetic-filters',
  '@ghostery/adblocker/is-mutation-observer-enabled'
]

/** Ids of our scriptlet preload, one per session, so it can be removed again. */
const scriptletPreloads = new Map<Electron.Session, string>()

function installScriptletPreload(ses: Electron.Session): void {
  if (scriptletPreloads.has(ses)) return

  const id = ses.registerPreloadScript({
    type: 'frame',
    filePath: join(__dirname, '../preload/adblock.js')
  })

  scriptletPreloads.set(ses, id)
}

function removeScriptletPreload(ses: Electron.Session): void {
  const id = scriptletPreloads.get(ses)
  if (id === undefined) return

  ses.unregisterPreloadScript(id)
  scriptletPreloads.delete(ses)
}

function applyToSessions(on: boolean): void {
  if (!blocker) return

  for (const partition of ALL_PARTITIONS) {
    const ses = session.fromPartition(partition)

    if (on) {
      for (const channel of COSMETIC_CHANNELS) ipcMain.removeHandler(channel)
      blocker.enableBlockingInSession(ses)
      installNetworkGuard(ses)
      installScriptletPreload(ses)
    } else {
      blocker.disableBlockingInSession(ses)
      removeScriptletPreload(ses)
    }
  }

  // Ours goes on last so it is the handler the pages reach.
  if (on) {
    ipcMain.removeHandler(INJECT_CHANNEL)
    ipcMain.handle(INJECT_CHANNEL, onInjectCosmetics)
  }
}
