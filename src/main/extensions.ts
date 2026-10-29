import {
  app,
  BaseWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  session,
  webContents as allWebContents,
  WebContentsView,
  type ContextMenuParams,
  type MenuItemConstructorOptions,
  type NativeImage,
  type Rectangle,
  type WebContents
} from 'electron'
import { installChromeWebStore, uninstallExtension } from 'electron-chrome-web-store'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, normalize, sep } from 'node:path'
import { CHROME_WEB_STORE_URL, type ExtensionInfo, type ExtensionInstallRequest } from '../shared/types'
import { PARTITION } from './partitions'
import { shortcutFor } from './tabs'
import { getSettings, setSetting } from './settings'

/**
 * Chrome extensions.
 *
 * Installing comes from the Chrome Web Store itself, through
 * electron-chrome-web-store: its "Add to Chrome" button works here and the
 * extension lands in the profile, updates itself and loads at startup.
 *
 * Electron then runs the extension — content scripts, storage, messaging —
 * but has no browser around it. Everything a browser adds is here: the toolbar
 * button and its popup, badges, right-click items, which tabs and windows
 * exist and which is in front, notifications, turning extensions off and
 * removing them. The extension's side of those calls is the preload in
 * src/preload/extension.ts.
 *
 * Extensions run in normal tabs and installed apps only. Amnesia tabs are a
 * separate session with nothing loaded into it, as in other browsers'
 * private windows.
 */

/** A tab as extensions are told about it. Its id is the page's webContents id. */
export interface ExtensionTab {
  contents: WebContents
  index: number
  active: boolean
  pinned: boolean
  url: string
  title: string
  favicon: string | null
}

export interface ExtensionWindow {
  id: number
  window: BaseWindow
  type: 'normal' | 'app'
  tabs: ExtensionTab[]
}

export interface ExtensionHooks {
  /** Ask in the window holding this page whether to add an extension; false if there is none. */
  promptInstall: (contents: WebContents, request: ExtensionInstallRequest) => boolean
  cancelInstallPrompt: (contents: WebContents, requestId: number) => void
  /** Every browser window and installed app, with their tabs. */
  windows: () => ExtensionWindow[]
  openTab: (url: string, options: { windowId?: number; active: boolean; index?: number; pinned?: boolean }) => WebContents | null
  activateTab: (contents: WebContents) => void
  closeTab: (contents: WebContents) => void
  pinTab: (contents: WebContents, pinned: boolean) => void
  openWindow: (url: string) => void
  /** The window a toolbar — a browser window's chrome, an app's title bar — sits in. */
  windowFor: (toolbar: WebContents) => ExtensionWindow | null
  /** Every toolbar that shows extensions, and the page in front of it. */
  toolbars: () => { toolbar: WebContents; active: WebContents | null }[]
}

let hooks: ExtensionHooks | null = null

const ses = (): Electron.Session => session.fromPartition(PARTITION)
const extensionsPath = (): string => join(app.getPath('userData'), 'Extensions')

// --- what is installed ---------------------------------------------------------

/**
 * Every extension seen this run, turned off ones included: a turned off
 * extension is not loaded, so Electron forgets it, but it still has a row.
 */
const known = new Map<string, Electron.Extension>()

/* eslint-disable @typescript-eslint/no-explicit-any */
type Manifest = Record<string, any>

const manifestOf = (id: string): Manifest => (known.get(id)?.manifest ?? {}) as Manifest
const actionOf = (manifest: Manifest): Manifest | null =>
  manifest.action ?? manifest.browser_action ?? manifest.page_action ?? null
const optionsPageOf = (manifest: Manifest): string | null =>
  manifest.options_ui?.page ?? manifest.options_page ?? null
const isLoaded = (id: string): boolean => Boolean(ses().extensions.getExtension(id))

/** A file inside the extension, or nothing if the path tries to leave it. */
function fileIn(id: string, relative: string): string | null {
  const root = known.get(id)?.path
  if (!root || typeof relative !== 'string') return null
  const file = normalize(join(root, relative.replace(/^\/+/, '')))
  return file.startsWith(normalize(root) + sep) ? file : null
}

/** The size closest above `wanted` from a {size: path} map, or the largest. */
function pickSize<T>(source: Record<string, T> | T, wanted = 32): T | null {
  if (!source || typeof source !== 'object') return (source as T) ?? null
  const sizes = Object.keys(source)
    .map(Number)
    .filter((size) => !Number.isNaN(size))
    .sort((a, b) => a - b)
  if (sizes.length === 0) return null
  const size = sizes.find((each) => each >= wanted) ?? sizes[sizes.length - 1]
  return (source as Record<string, T>)[String(size)] ?? null
}

function toolbarImage(image: NativeImage): string | null {
  if (image.isEmpty()) return null
  const { width } = image.getSize()
  return (width > 32 ? image.resize({ width: 32, height: 32, quality: 'best' }) : image).toDataURL()
}

function iconFromPath(id: string, path: unknown): string | null {
  const relative = typeof path === 'string' ? path : pickSize(path as Record<string, string>)
  const file = relative ? fileIn(id, relative) : null
  return file && existsSync(file) ? toolbarImage(nativeImage.createFromPath(file)) : null
}

const defaultIcons = new Map<string, string | null>()

function defaultIcon(id: string): string | null {
  if (!defaultIcons.has(id)) {
    const manifest = manifestOf(id)
    defaultIcons.set(id, iconFromPath(id, actionOf(manifest)?.default_icon) ?? iconFromPath(id, manifest.icons))
  }
  return defaultIcons.get(id) ?? null
}

/**
 * Manifest text can be a placeholder — `__MSG_appName__` — for the extension's
 * own translations. Electron fills in the name; titles and descriptions are
 * filled in here, in the browser's language where the extension has it.
 */
const messageTables = new Map<string, Record<string, string>>()

function localized(id: string, text: unknown): string {
  if (typeof text !== 'string') return ''
  const key = /^__MSG_(\w+)__$/.exec(text)?.[1]
  if (!key) return text
  let table = messageTables.get(id)
  if (!table) {
    table = {}
    const root = known.get(id)?.path
    const locale = app.getLocale()
    const candidates = [locale.replace('-', '_'), locale.split('-')[0], manifestOf(id).default_locale, 'en']
    for (const each of candidates) {
      if (!root || typeof each !== 'string') continue
      const file = join(root, '_locales', each, 'messages.json')
      if (!existsSync(file)) continue
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, { message?: string }>
        for (const [name, entry] of Object.entries(parsed)) table[name.toLowerCase()] = String(entry?.message ?? '')
        break
      } catch {
        // A broken translation file: try the next language.
      }
    }
    messageTables.set(id, table)
  }
  return table[key.toLowerCase()] || text
}

// --- the toolbar button's state --------------------------------------------------

/** What an extension set for its button, everywhere or for one tab. */
interface ActionState {
  text?: string
  color?: string
  textColor?: string
  title?: string
  icon?: string | null
  popup?: string
  disabled?: boolean
}

const actionEverywhere = new Map<string, ActionState>()
const actionPerTab = new Map<string, Map<number, ActionState>>()

function actionFor(id: string, tabId: number | null | undefined): ActionState {
  const tab = tabId != null ? actionPerTab.get(id)?.get(tabId) : undefined
  return { ...actionEverywhere.get(id), ...tab }
}

function setAction(id: string, tabId: number | null | undefined, changes: ActionState): void {
  if (tabId != null) {
    let tabs = actionPerTab.get(id)
    if (!tabs) actionPerTab.set(id, (tabs = new Map()))
    tabs.set(tabId, { ...tabs.get(tabId), ...changes })
  } else {
    actionEverywhere.set(id, { ...actionEverywhere.get(id), ...changes })
  }
  changed()
}

/** Chrome takes a colour as CSS text or as [r, g, b, a]. */
function cssColour(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (Array.isArray(value) && value.length >= 3) {
    const [r, g, b, a = 255] = value.map(Number)
    return `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(3)})`
  }
  return undefined
}

/** And hands it back as [r, g, b, a]. */
function colourArray(value: string | undefined, fallback: number[]): number[] {
  if (!value) return fallback
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value)?.[1]
  if (hex) {
    const full = hex.length === 3 ? [...hex].map((each) => each + each).join('') : hex
    return [0, 2, 4].map((at) => parseInt(full.slice(at, at + 2), 16)).concat(255)
  }
  const rgba = /rgba?\(([^)]+)\)/.exec(value)?.[1]?.split(',').map((each) => parseFloat(each))
  if (rgba && rgba.length >= 3) return [rgba[0], rgba[1], rgba[2], Math.round((rgba[3] ?? 1) * 255)]
  return fallback
}

const DEFAULT_BADGE = '#5f6368'

function infoFor(id: string, tabId: number | null): ExtensionInfo {
  const manifest = manifestOf(id)
  const extension = known.get(id)
  const state = actionFor(id, tabId)
  const action = actionOf(manifest)
  const popup = state.popup !== undefined ? state.popup : (action?.default_popup ?? '')
  return {
    id,
    name: localized(id, extension?.name ?? id),
    version: extension?.version ?? '',
    description: localized(id, manifest.description),
    icon: state.icon !== undefined ? state.icon : defaultIcon(id),
    enabled: isLoaded(id),
    pinned: getSettings().pinnedExtensions.includes(id),
    badgeText: state.text ?? '',
    badgeColor: state.color ?? DEFAULT_BADGE,
    badgeTextColor: state.textColor ?? '#ffffff',
    title: state.title ?? localized(id, action?.default_title ?? extension?.name ?? id),
    hasPopup: Boolean(popup),
    actionDisabled: Boolean(state.disabled),
    hasOptions: Boolean(optionsPageOf(manifest))
  }
}

/** Every extension, as the toolbar in front of `active` should show it. */
export function extensionsFor(active: WebContents | null): ExtensionInfo[] {
  const tabId = active && !active.isDestroyed() ? active.id : null
  return [...known.keys()]
    .map((id) => infoFor(id, tabId))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
}

let changeTimer: NodeJS.Timeout | null = null

/** Tell every toolbar, once, however many badges changed at once. */
function changed(): void {
  if (changeTimer) return
  changeTimer = setTimeout(() => {
    changeTimer = null
    for (const { toolbar, active } of hooks?.toolbars() ?? []) {
      if (!toolbar.isDestroyed()) toolbar.send('ext:changed', extensionsFor(active))
    }
  }, 30)
}

// --- tabs and windows, as extensions see them ----------------------------------

/** Remembered so a tab that has gone can still say which window it was in. */
const tabWindows = new Map<number, number>()
let lastFocusedWindow: number | null = null

function windows(): ExtensionWindow[] {
  const list = hooks?.windows() ?? []
  const focused = BaseWindow.getFocusedWindow()
  for (const each of list) {
    if (each.window === focused) lastFocusedWindow = each.id
    for (const tab of each.tabs) tabWindows.set(tab.contents.id, each.id)
  }
  return list
}

function findTab(tabId: number): { window: ExtensionWindow; tab: ExtensionTab } | null {
  for (const window of windows()) {
    const tab = window.tabs.find((each) => each.contents.id === tabId)
    if (tab) return { window, tab }
  }
  return null
}

function tabObject(window: ExtensionWindow, tab: ExtensionTab): Record<string, unknown> {
  const contents = tab.contents
  const alive = !contents.isDestroyed()
  const bounds = window.window.getContentBounds()
  return {
    id: contents.id,
    index: tab.index,
    windowId: window.id,
    openerTabId: undefined,
    active: tab.active,
    highlighted: tab.active,
    selected: tab.active,
    pinned: tab.pinned,
    incognito: false,
    url: tab.url,
    title: tab.title,
    favIconUrl: tab.favicon ?? undefined,
    status: alive && contents.isLoading() ? 'loading' : 'complete',
    audible: alive && contents.isCurrentlyAudible(),
    mutedInfo: { muted: alive && contents.isAudioMuted() },
    discarded: false,
    autoDiscardable: true,
    frozen: false,
    groupId: -1,
    width: bounds.width,
    height: bounds.height
  }
}

function windowObject(window: ExtensionWindow, populate = false): Record<string, unknown> {
  const win = window.window
  const bounds = win.getBounds()
  return {
    id: window.id,
    focused: win.isFocused(),
    top: bounds.y,
    left: bounds.x,
    width: bounds.width,
    height: bounds.height,
    incognito: false,
    type: window.type === 'app' ? 'app' : 'normal',
    state: win.isFullScreen() ? 'fullscreen' : win.isMinimized() ? 'minimized' : win.isMaximized() ? 'maximized' : 'normal',
    alwaysOnTop: win.isAlwaysOnTop(),
    tabs: populate ? window.tabs.map((tab) => tabObject(window, tab)) : undefined
  }
}

/** Chrome's match patterns: `<all_urls>`, `*://*.example.com/*` and so on. */
function matchesPattern(url: string, pattern: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (pattern === '<all_urls>') return /^(https?|wss?|ftp|file):$/.test(parsed.protocol)
  const parts = /^(\*|[a-z-]+):\/\/(\*|\*\.[^/]+|[^/*]*)(\/.*)$/.exec(pattern)
  if (!parts) return false
  const [, scheme, host, path] = parts
  if (scheme === '*' ? !/^https?:$/.test(parsed.protocol) : parsed.protocol !== `${scheme}:`) return false
  if (host && host !== '*') {
    if (host.startsWith('*.')) {
      const base = host.slice(2)
      if (parsed.hostname !== base && !parsed.hostname.endsWith(`.${base}`)) return false
    } else if (parsed.hostname !== host) return false
  }
  return glob(path).test(parsed.pathname + parsed.search)
}

function glob(text: string): RegExp {
  return new RegExp(`^${text.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 's')
}

function matchesAny(url: string, patterns: unknown): boolean {
  const list = Array.isArray(patterns) ? patterns : [patterns]
  return list.some((pattern) => typeof pattern === 'string' && matchesPattern(url, pattern))
}

/** A relative address in an extension call is relative to the extension. */
function resolveUrl(id: string, url: unknown): string {
  if (typeof url !== 'string' || !url) return 'about:blank'
  try {
    return new URL(url, `chrome-extension://${id}/`).toString()
  } catch {
    return 'about:blank'
  }
}

// --- installed and updated ---------------------------------------------------------

/**
 * The version of each extension last seen, so the first run after installing
 * or updating one can be told to it as `runtime.onInstalled`.
 */
const versionsFile = (): string => join(app.getPath('userData'), 'extension-versions.json')
let versions: Record<string, string> = {}
/** Waiting to be told, until the extension starts listening. */
const installNotices = new Map<string, Record<string, unknown>>()

function loadVersions(): void {
  try {
    versions = JSON.parse(readFileSync(versionsFile(), 'utf8')) as Record<string, string>
  } catch {
    versions = {}
  }
}

function saveVersions(): void {
  try {
    writeFileSync(versionsFile(), JSON.stringify(versions))
  } catch (error) {
    console.warn('Could not save extension versions:', error)
  }
}

function noticeVersion(extension: Electron.Extension): void {
  const before = versions[extension.id]
  if (before === extension.version) return
  versions[extension.id] = extension.version
  saveVersions()
  installNotices.set(extension.id, before ? { reason: 'update', previousVersion: before } : { reason: 'install' })
  if (listening.get(extension.id)?.has('runtime.onInstalled')) tellInstalled(extension.id)
}

function tellInstalled(id: string): void {
  const details = installNotices.get(id)
  if (!details) return
  installNotices.delete(id)
  setImmediate(() => void dispatch(id, 'runtime.onInstalled', [details]))
}

// --- events, to an extension's pages and its worker -------------------------------

/** Which events each extension has asked for, so only those workers are woken. */
const listening = new Map<string, Set<string>>()

async function dispatch(id: string, name: string, args: unknown[]): Promise<void> {
  if (!listening.get(id)?.has(name) || !isLoaded(id)) return
  const prefix = `chrome-extension://${id}/`
  for (const contents of allWebContents.getAllWebContents()) {
    if (!contents.isDestroyed() && contents.getURL().startsWith(prefix)) contents.send('ext:event', name, args)
  }
  if (!manifestOf(id).background?.service_worker) return
  try {
    // A Manifest V3 worker stops when idle; an event starts it again.
    const worker = await ses().serviceWorkers.startWorkerForScope(prefix)
    worker.send('ext:event', name, args)
  } catch (error) {
    console.warn(`Extension ${id} could not be told about ${name}:`, error)
  }
}

function broadcast(name: string, args: unknown[]): void {
  for (const [id, names] of listening) if (names.has(name)) void dispatch(id, name, args)
}

const lastActive = new Map<number, number>()
let activeCheck = false

/**
 * Called whenever a window's tabs change: tells extensions which tab came to
 * the front, and redraws badges, which can differ from tab to tab.
 */
export function noticeTabs(): void {
  if (activeCheck) return
  activeCheck = true
  setImmediate(() => {
    activeCheck = false
    for (const window of windows()) {
      const active = window.tabs.find((tab) => tab.active)
      if (!active || lastActive.get(window.id) === active.contents.id) continue
      lastActive.set(window.id, active.contents.id)
      broadcast('tabs.onActivated', [{ tabId: active.contents.id, windowId: window.id }])
    }
    changed()
  })
}

/**
 * The Chrome Web Store nags anything that is not Chrome: a "Switch to Chrome"
 * banner over every listing and a pop-up under the search box, both with an
 * "Install IE2" button that goes nowhere. Installing works without them.
 * Matched by the parts Google's page keeps across languages, not by its words.
 */
const STORE_NAG_CSS = `
  [jscontroller="o2G9me"],
  [role="dialog"]:has(#promo-header) { display: none !important; }
`

/** Tab events, from every page in the browsing session that turns out to be a tab. */
function watchPage(contents: WebContents): void {
  const id = contents.id
  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || shortcutFor(input)) return
    if (runShortcut(contents, input)) event.preventDefault()
  })
  contents.on('dom-ready', () => {
    try {
      if (new URL(contents.getURL()).host === new URL(CHROME_WEB_STORE_URL).host) void contents.insertCSS(STORE_NAG_CSS)
    } catch {
      // Not an address.
    }
  })
  const updated = (changes: Record<string, unknown>): void => {
    if (![...listening.values()].some((names) => names.has('tabs.onUpdated'))) return
    const found = findTab(id)
    if (found) broadcast('tabs.onUpdated', [id, changes, tabObject(found.window, found.tab)])
  }
  setImmediate(() => {
    const found = contents.isDestroyed() ? null : findTab(id)
    if (found) broadcast('tabs.onCreated', [tabObject(found.window, found.tab)])
  })
  contents.on('did-start-loading', () => updated({ status: 'loading' }))
  contents.on('did-stop-loading', () => updated({ status: 'complete' }))
  contents.on('did-navigate', (_event, url) => updated({ url }))
  contents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
    if (isMainFrame) updated({ url })
  })
  contents.on('page-title-updated', (_event, title) => updated({ title }))
  contents.on('page-favicon-updated', (_event, favicons) => updated({ favIconUrl: favicons[0] }))
  contents.once('destroyed', () => {
    const windowId = tabWindows.get(id)
    tabWindows.delete(id)
    for (const tabs of actionPerTab.values()) tabs.delete(id)
    if (windowId !== undefined) broadcast('tabs.onRemoved', [id, { windowId, isWindowClosing: false }])
  })
}

// --- keyboard shortcuts --------------------------------------------------------------

/** A command's key for Windows, as written in the manifest: "Ctrl+Shift+P". */
function keyOf(command: Manifest): string | null {
  const keys = command?.suggested_key
  if (typeof keys === 'string') return keys
  return keys?.windows ?? keys?.default ?? null
}

/** Whether a key press is that key. Matched on the physical key, so keyboard layout does not matter. */
function pressed(input: Electron.Input, key: string): boolean {
  const parts = key.split('+').map((part) => part.trim())
  const main = parts.pop() ?? ''
  const has = (name: string): boolean => parts.includes(name)
  if (input.control !== has('Ctrl') || input.alt !== has('Alt') || input.shift !== has('Shift')) return false
  const codes: Record<string, string> = {
    Up: 'ArrowUp',
    Down: 'ArrowDown',
    Left: 'ArrowLeft',
    Right: 'ArrowRight',
    Comma: 'Comma',
    Period: 'Period',
    Space: 'Space'
  }
  const code = /^[A-Z]$/.test(main) ? `Key${main}` : /^[0-9]$/.test(main) ? `Digit${main}` : (codes[main] ?? main)
  return input.code === code
}

/**
 * An extension's keyboard shortcut, pressed in a page. IE2's own shortcuts come
 * first; whatever is left over goes to the extension that asked for it.
 */
function runShortcut(contents: WebContents, input: Electron.Input): boolean {
  for (const id of known.keys()) {
    if (!isLoaded(id)) continue
    for (const [name, command] of Object.entries((manifestOf(id).commands ?? {}) as Record<string, Manifest>)) {
      const key = keyOf(command)
      if (!key || !pressed(input, key)) continue
      const found = findTab(contents.id)
      if (!found) return false
      if (name === '_execute_action' || name === '_execute_browser_action') {
        const box = found.window.window.getContentBounds()
        const path = actionFor(id, contents.id).popup ?? actionOf(manifestOf(id))?.default_popup
        if (path) openPopup(id, path, found.window, anchors.get(found.window.id) ?? { x: box.width - 48, y: 44, width: 36, height: 36 })
        else void dispatch(id, 'action.onClicked', [tabObject(found.window, found.tab)])
      } else {
        void dispatch(id, 'commands.onCommand', [name, tabObject(found.window, found.tab)])
      }
      return true
    }
  }
  return false
}

// --- alarms ---------------------------------------------------------------------------

interface Alarm {
  name: string
  scheduledTime: number
  periodInMinutes?: number
  timer: NodeJS.Timeout
}

/** Per extension, by name. Kept while IE2 runs; extensions set theirs again when they start. */
const alarms = new Map<string, Map<string, Alarm>>()

const alarmInfo = (alarm: Alarm): Record<string, unknown> => ({
  name: alarm.name,
  scheduledTime: alarm.scheduledTime,
  periodInMinutes: alarm.periodInMinutes
})

function clearAlarm(id: string, name: string): boolean {
  const alarm = alarms.get(id)?.get(name)
  if (!alarm) return false
  clearTimeout(alarm.timer)
  alarms.get(id)?.delete(name)
  return true
}

function setAlarm(id: string, name: string, info: Manifest): void {
  clearAlarm(id, name)
  const period = typeof info.periodInMinutes === 'number' ? info.periodInMinutes : undefined
  const delay =
    typeof info.when === 'number'
      ? info.when - Date.now()
      : ((typeof info.delayInMinutes === 'number' ? info.delayInMinutes : period) ?? 0) * 60_000
  let table = alarms.get(id)
  if (!table) alarms.set(id, (table = new Map()))
  const alarm: Alarm = {
    name,
    scheduledTime: Date.now() + Math.max(0, delay),
    periodInMinutes: period,
    timer: setTimeout(function fire() {
      void dispatch(id, 'alarms.onAlarm', [alarmInfo(alarm)])
      if (period) {
        alarm.scheduledTime = Date.now() + period * 60_000
        alarm.timer = setTimeout(fire, period * 60_000)
      } else {
        alarms.get(id)?.delete(name)
      }
    }, Math.max(0, delay))
  }
  table.set(name, alarm)
}

// --- the popup ----------------------------------------------------------------------

interface Popup {
  view: WebContentsView
  window: BaseWindow
  windowId: number
  extensionId: string
  cleanup: () => void
}

let popup: Popup | null = null
/** So a click on the button that just closed a popup by taking focus does not reopen it. */
let lastClosed = { id: '', at: 0 }
/** Where each window's extensions button is, for a popup the extension opens itself. */
const anchors = new Map<number, Rectangle>()

export function closeExtensionPopup(): void {
  if (!popup) return
  const { view, window, extensionId, cleanup } = popup
  popup = null
  lastClosed = { id: extensionId, at: Date.now() }
  cleanup()
  try {
    window.contentView.removeChildView(view)
  } catch {
    // The window is already gone.
  }
  if (!view.webContents.isDestroyed()) view.webContents.close()
}

function openPopup(id: string, path: string, window: ExtensionWindow, anchor: Rectangle): void {
  const file = fileIn(id, path.split(/[?#]/)[0])
  if (!file) return
  closeExtensionPopup()

  const view = new WebContentsView({
    webPreferences: {
      partition: PARTITION,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      enablePreferredSizeMode: true
    }
  })
  view.setBackgroundColor('#ffffff')
  view.setBorderRadius(8)
  // Out of sight until the page says how big it wants to be.
  view.setBounds({ x: anchor.x, y: anchor.y + anchor.height, width: 0, height: 0 })

  const win = window.window
  const close = (): void => {
    if (popup === current) closeExtensionPopup()
  }
  const current: Popup = {
    view,
    window: win,
    windowId: window.id,
    extensionId: id,
    cleanup: () => {
      win.off('resize', close)
      win.off('move', close)
      win.off('blur', close)
    }
  }
  popup = current
  win.on('resize', close)
  win.on('move', close)
  win.on('blur', close)
  win.contentView.addChildView(view)

  const contents = view.webContents
  // Chrome's limits for popups: at least 25 square, at most 800 by 600.
  contents.on('preferred-size-changed', (_event, size) => {
    if (popup !== current) return
    const box = win.getContentBounds()
    const width = Math.max(25, Math.min(800, size.width))
    const top = anchor.y + anchor.height + 4
    const height = Math.max(25, Math.min(600, size.height, box.height - top - 8))
    const x = Math.max(8, Math.min(anchor.x + anchor.width - width, box.width - width - 8))
    view.setBounds({ x, y: top, width, height })
  })
  contents.on('blur', () => {
    if (!contents.isDevToolsOpened()) close()
  })
  contents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape') {
      event.preventDefault()
      close()
    }
  })
  contents.on('did-finish-load', () => contents.focus())
  contents.on('render-process-gone', close)
  contents.setWindowOpenHandler(({ url }) => {
    hooks?.openTab(url, { active: true, windowId: window.id })
    close()
    return { action: 'deny' }
  })
  void contents.loadURL(resolveUrl(id, path))
}

function clickAction(id: string, toolbar: WebContents, anchor: Rectangle): void {
  if (!isLoaded(id) || !hooks) return
  const window = hooks.windowFor(toolbar)
  if (!window) return
  anchors.set(window.id, anchor)
  if (popup?.extensionId === id || (lastClosed.id === id && Date.now() - lastClosed.at < 300)) {
    closeExtensionPopup()
    return
  }
  const active = window.tabs.find((tab) => tab.active) ?? null
  const info = infoFor(id, active?.contents.id ?? null)
  if (info.actionDisabled) return
  const state = actionFor(id, active?.contents.id)
  const path = state.popup !== undefined ? state.popup : (actionOf(manifestOf(id))?.default_popup ?? '')
  if (path) openPopup(id, path, window, anchor)
  else if (active) void dispatch(id, 'action.onClicked', [tabObject(window, active)])
}

// --- right-click items ------------------------------------------------------------

interface MenuEntry {
  /** As the extension gave it — a number stays a number in onClicked. */
  id: string | number
  parentId?: string | number
  title?: string
  type: 'normal' | 'checkbox' | 'radio' | 'separator'
  checked: boolean
  enabled: boolean
  visible: boolean
  contexts: string[]
  documentUrlPatterns?: string[]
  targetUrlPatterns?: string[]
}

/**
 * Per extension, in the order made. Kept on disk: extensions make their items
 * once, when installed, and expect Chrome to remember them.
 */
const menus = new Map<string, MenuEntry[]>()
const menusFile = (): string => join(app.getPath('userData'), 'extension-menus.json')
let menuSaveTimer: NodeJS.Timeout | null = null

function loadMenus(): void {
  try {
    const stored = JSON.parse(readFileSync(menusFile(), 'utf8')) as Record<string, MenuEntry[]>
    for (const [id, entries] of Object.entries(stored)) if (Array.isArray(entries)) menus.set(id, entries)
  } catch {
    // None yet.
  }
}

function saveMenus(): void {
  if (menuSaveTimer) clearTimeout(menuSaveTimer)
  menuSaveTimer = setTimeout(() => {
    menuSaveTimer = null
    try {
      writeFileSync(menusFile(), JSON.stringify(Object.fromEntries(menus)))
    } catch (error) {
      console.warn('Could not save extension menu items:', error)
    }
  }, 200)
}

function menuEntry(properties: Manifest, base?: MenuEntry): MenuEntry {
  const pick = <T>(key: string, fallback: T): T => (properties[key] !== undefined ? properties[key] : fallback)
  return {
    id: pick('id', base?.id ?? ''),
    parentId: pick('parentId', base?.parentId),
    title: pick('title', base?.title),
    type: pick('type', base?.type ?? 'normal'),
    checked: Boolean(pick('checked', base?.checked ?? false)),
    enabled: pick('enabled', base?.enabled ?? true) !== false,
    visible: pick('visible', base?.visible ?? true) !== false,
    contexts: pick('contexts', base?.contexts ?? ['page']),
    documentUrlPatterns: pick('documentUrlPatterns', base?.documentUrlPatterns),
    targetUrlPatterns: pick('targetUrlPatterns', base?.targetUrlPatterns)
  }
}

function removeMenu(id: string, itemId: string | number): void {
  const entries = menus.get(id)
  if (!entries) return
  const doomed = new Set([String(itemId)])
  // Children go with their parent, and theirs with them.
  for (let grew = true; grew; ) {
    grew = false
    for (const entry of entries) {
      if (entry.parentId !== undefined && doomed.has(String(entry.parentId)) && !doomed.has(String(entry.id))) {
        doomed.add(String(entry.id))
        grew = true
      }
    }
  }
  menus.set(
    id,
    entries.filter((entry) => !doomed.has(String(entry.id)))
  )
}

/** The contexts a right-click is in, in Chrome's words. */
function contextsOf(params: Partial<ContextMenuParams> | null): Set<string> {
  if (!params) return new Set(['action', 'browser_action', 'page_action'])
  const found = new Set<string>()
  if (params.selectionText) found.add('selection')
  if (params.linkURL) found.add('link')
  if (params.isEditable) found.add('editable')
  if (params.mediaType === 'image') found.add('image')
  if (params.mediaType === 'video') found.add('video')
  if (params.mediaType === 'audio') found.add('audio')
  if (params.frameURL) found.add('frame')
  if (found.size === 0 || (found.size === 1 && found.has('frame'))) found.add('page')
  return found
}

/**
 * Menu items for one extension's entries under `parent`. `params` is the
 * page's right-click, or null for a click on the extension's own button.
 */
function menuItemsFor(
  id: string,
  parent: string | number | undefined,
  params: Partial<ContextMenuParams> | null,
  tab: { window: ExtensionWindow; tab: ExtensionTab } | null,
  pageUrl: string
): MenuItemConstructorOptions[] {
  const contexts = contextsOf(params)
  const target = params?.linkURL || params?.srcURL || ''
  const items: MenuItemConstructorOptions[] = []
  for (const entry of menus.get(id) ?? []) {
    if (String(entry.parentId ?? '') !== String(parent ?? '') || !entry.visible) continue
    const wanted = entry.contexts.includes('all') ? (params ? [...contexts] : ['action']) : entry.contexts
    if (!wanted.some((context) => contexts.has(context))) continue
    if (params && entry.documentUrlPatterns && !matchesAny(pageUrl, entry.documentUrlPatterns)) continue
    if (params && target && entry.targetUrlPatterns && !matchesAny(target, entry.targetUrlPatterns)) continue

    if (entry.type === 'separator') {
      items.push({ type: 'separator' })
      continue
    }
    const children = menuItemsFor(id, entry.id, params, tab, pageUrl)
    const label = (entry.title ?? '').replace(/%s/g, (params?.selectionText ?? '').slice(0, 40))
    items.push({
      label,
      type: children.length ? 'submenu' : entry.type === 'normal' ? 'normal' : entry.type,
      checked: entry.checked,
      enabled: entry.enabled,
      submenu: children.length ? children : undefined,
      click: () => {
        const wasChecked = entry.checked
        if (entry.type === 'checkbox') entry.checked = !entry.checked
        if (entry.type === 'radio') {
          for (const sibling of menus.get(id) ?? []) {
            if (sibling.type === 'radio' && String(sibling.parentId ?? '') === String(entry.parentId ?? '')) {
              sibling.checked = sibling === entry
            }
          }
        }
        const info: Record<string, unknown> = {
          menuItemId: entry.id,
          parentMenuItemId: entry.parentId,
          editable: Boolean(params?.isEditable),
          pageUrl: pageUrl || undefined,
          frameUrl: params?.frameURL || undefined,
          linkUrl: params?.linkURL || undefined,
          srcUrl: params?.srcURL || undefined,
          selectionText: params?.selectionText || undefined,
          mediaType: params?.mediaType && params.mediaType !== 'none' ? params.mediaType : undefined
        }
        if (entry.type === 'checkbox' || entry.type === 'radio') {
          info.wasChecked = wasChecked
          info.checked = entry.checked
        }
        void dispatch(id, 'contextMenus.onClicked', [info, tab ? tabObject(tab.window, tab.tab) : undefined])
      }
    })
  }
  // Chrome drops a separator with nothing on one side of it.
  return items.filter(
    (item, at) => item.type !== 'separator' || (at > 0 && at < items.length - 1 && items[at - 1].type !== 'separator')
  )
}

function menuIcon(id: string): NativeImage | undefined {
  const url = defaultIcon(id)
  return url ? nativeImage.createFromDataURL(url).resize({ width: 16, height: 16, quality: 'best' }) : undefined
}

/**
 * Extensions' items for a right-click on a page: one extension's single item
 * shows as it is, several sit under the extension's name, as in Chrome.
 */
export function extensionMenuItems(contents: WebContents, params: ContextMenuParams): MenuItemConstructorOptions[] {
  if (contents.session !== ses()) return []
  const tab = findTab(contents.id)
  const pageUrl = params.pageURL || contents.getURL()
  const items: MenuItemConstructorOptions[] = []
  for (const id of known.keys()) {
    if (!isLoaded(id)) continue
    const own = menuItemsFor(id, undefined, params, tab, pageUrl)
    if (own.length === 0) continue
    if (own.length === 1 && own[0].type !== 'separator') items.push({ ...own[0], icon: menuIcon(id) })
    else items.push({ label: known.get(id)?.name ?? id, icon: menuIcon(id), submenu: own })
  }
  return items
}

// --- notifications ----------------------------------------------------------------

const notifications = new Map<string, Notification>()
let nextNotification = 1
let nextDownload = 1

function showNotification(id: string, notificationId: string, options: Manifest): string {
  const key = notificationId || `ie2-${nextNotification++}`
  notifications.get(`${id}/${key}`)?.close()
  let icon: NativeImage | undefined
  if (typeof options.iconUrl === 'string') {
    icon = options.iconUrl.startsWith('data:')
      ? nativeImage.createFromDataURL(options.iconUrl)
      : (() => {
          const file = fileIn(id, new URL(resolveUrl(id, options.iconUrl)).pathname)
          return file ? nativeImage.createFromPath(file) : undefined
        })()
  }
  const notification = new Notification({
    title: String(options.title ?? known.get(id)?.name ?? ''),
    body: [options.message, options.contextMessage].filter(Boolean).join('\n'),
    icon: icon && !icon.isEmpty() ? icon : undefined,
    silent: Boolean(options.silent)
  })
  notification.on('click', () => void dispatch(id, 'notifications.onClicked', [key]))
  notification.on('close', () => {
    notifications.delete(`${id}/${key}`)
    void dispatch(id, 'notifications.onClosed', [key, true])
  })
  notifications.set(`${id}/${key}`, notification)
  notification.show()
  return key
}

// --- answering the extension's calls ----------------------------------------------

async function handleCall(id: string, method: string, args: any[], sender: WebContents | null): Promise<unknown> {
  if (!hooks || !isLoaded(id)) throw new Error('Extension is not running')
  const all = windows()

  // "The current window": the popup's, the page's own, or the one in front.
  const currentWindow = (): ExtensionWindow | null => {
    if (sender && popup && sender === popup.view.webContents) {
      const windowId = popup.windowId
      return all.find((each) => each.id === windowId) ?? null
    }
    if (sender) {
      const own = all.find((each) => each.tabs.some((tab) => tab.contents === sender))
      if (own) return own
    }
    return all.find((each) => each.id === lastFocusedWindow) ?? all[0] ?? null
  }
  const windowById = (windowId: unknown): ExtensionWindow | null =>
    windowId === undefined || windowId === null || windowId === -2
      ? currentWindow()
      : (all.find((each) => each.id === windowId) ?? null)
  const tabOrActive = (tabId: unknown): { window: ExtensionWindow; tab: ExtensionTab } | null => {
    if (typeof tabId === 'number') return findTab(tabId)
    const window = currentWindow()
    const tab = window?.tabs.find((each) => each.active)
    return window && tab ? { window, tab } : null
  }
  const mustFind = (tabId: unknown): { window: ExtensionWindow; tab: ExtensionTab } => {
    const found = tabOrActive(tabId)
    if (!found) throw new Error(`No tab with id: ${tabId}.`)
    return found
  }
  const details = (args[0] ?? {}) as Manifest
  const action = actionOf(manifestOf(id))

  switch (method) {
    case 'events.listen': {
      let names = listening.get(id)
      if (!names) listening.set(id, (names = new Set()))
      names.add(String(args[0]))
      if (args[0] === 'runtime.onInstalled') tellInstalled(id)
      return null
    }

    // --- action ---
    case 'action.setBadgeText':
      setAction(id, details.tabId, { text: String(details.text ?? '') })
      return null
    case 'action.getBadgeText':
      return actionFor(id, details.tabId).text ?? ''
    case 'action.setBadgeBackgroundColor':
      setAction(id, details.tabId, { color: cssColour(details.color) })
      return null
    case 'action.getBadgeBackgroundColor':
      return colourArray(actionFor(id, details.tabId).color, [95, 99, 104, 255])
    case 'action.setBadgeTextColor':
      setAction(id, details.tabId, { textColor: cssColour(details.color) })
      return null
    case 'action.getBadgeTextColor':
      return colourArray(actionFor(id, details.tabId).textColor, [255, 255, 255, 255])
    case 'action.setTitle':
      setAction(id, details.tabId, { title: String(details.title ?? '') })
      return null
    case 'action.getTitle':
      return actionFor(id, details.tabId).title ?? action?.default_title ?? known.get(id)?.name ?? ''
    case 'action.setPopup':
      setAction(id, details.tabId, { popup: String(details.popup ?? '') })
      return null
    case 'action.getPopup': {
      const path = actionFor(id, details.tabId).popup ?? action?.default_popup ?? ''
      return path ? resolveUrl(id, path) : ''
    }
    case 'action.setIcon': {
      let icon: string | null = null
      const data = details.imageData as { width: number; height: number; data: number[] } | null
      if (data?.data?.length) {
        // RGBA from the page; Electron wants BGRA.
        const bytes = Buffer.from(data.data)
        for (let at = 0; at < bytes.length; at += 4) [bytes[at], bytes[at + 2]] = [bytes[at + 2], bytes[at]]
        icon = toolbarImage(nativeImage.createFromBitmap(bytes, { width: data.width, height: data.height }))
      } else if (details.path) {
        icon = iconFromPath(id, details.path)
      }
      if (icon) setAction(id, details.tabId, { icon })
      return null
    }
    case 'action.enable':
    case 'action.disable':
      setAction(id, typeof args[0] === 'number' ? args[0] : undefined, { disabled: method === 'action.disable' })
      return null
    case 'action.isEnabled':
      return !actionFor(id, typeof args[0] === 'number' ? args[0] : undefined).disabled
    case 'action.getUserSettings':
      return { isOnToolbar: getSettings().pinnedExtensions.includes(id) }
    case 'action.openPopup': {
      const window = windowById(details.windowId)
      if (!window) return null
      const box = window.window.getContentBounds()
      const anchor = anchors.get(window.id) ?? { x: box.width - 48, y: 44, width: 36, height: 36 }
      const path = actionFor(id, null).popup ?? action?.default_popup
      if (path) openPopup(id, path, window, anchor)
      return null
    }

    // --- context menus ---
    case 'contextMenus.create': {
      const entry = menuEntry(details)
      removeMenu(id, entry.id)
      menus.set(id, [...(menus.get(id) ?? []), entry])
      saveMenus()
      return null
    }
    case 'contextMenus.update': {
      const entries = menus.get(id) ?? []
      const at = entries.findIndex((entry) => String(entry.id) === String(args[0]))
      if (at < 0) throw new Error(`Cannot find menu item with id ${args[0]}`)
      entries[at] = menuEntry({ ...(args[1] ?? {}), id: entries[at].id }, entries[at])
      saveMenus()
      return null
    }
    case 'contextMenus.remove':
      removeMenu(id, args[0])
      saveMenus()
      return null
    case 'contextMenus.removeAll':
      menus.delete(id)
      saveMenus()
      return null

    // --- tabs ---
    case 'tabs.query': {
      const query = details
      const current = currentWindow()
      const result: Record<string, unknown>[] = []
      for (const window of all) {
        if (query.currentWindow === true && window !== current) continue
        if (query.currentWindow === false && window === current) continue
        if (query.lastFocusedWindow === true && window.id !== (lastFocusedWindow ?? current?.id)) continue
        if (query.windowId !== undefined && window !== windowById(query.windowId)) continue
        if (query.windowType !== undefined && query.windowType !== (window.type === 'app' ? 'app' : 'normal')) continue
        for (const tab of window.tabs) {
          const object = tabObject(window, tab)
          if (query.active !== undefined && tab.active !== query.active) continue
          if (query.highlighted !== undefined && tab.active !== query.highlighted) continue
          if (query.pinned !== undefined && tab.pinned !== query.pinned) continue
          if (query.audible !== undefined && object.audible !== query.audible) continue
          if (query.status !== undefined && object.status !== query.status) continue
          if (query.index !== undefined && tab.index !== query.index) continue
          if (query.url !== undefined && !matchesAny(tab.url, query.url)) continue
          if (query.title !== undefined && !glob(String(query.title)).test(tab.title)) continue
          if (query.muted !== undefined && (object.mutedInfo as { muted: boolean }).muted !== query.muted) continue
          result.push(object)
        }
      }
      return result
    }
    case 'tabs.get': {
      const found = mustFind(args[0])
      return tabObject(found.window, found.tab)
    }
    case 'tabs.getCurrent': {
      const found = sender ? findTab(sender.id) : null
      return found ? tabObject(found.window, found.tab) : null
    }
    case 'tabs.create': {
      const window = windowById(details.windowId)
      const contents = hooks.openTab(resolveUrl(id, details.url ?? 'ie2://newtab'), {
        windowId: window?.id,
        active: details.active !== false,
        index: typeof details.index === 'number' ? details.index : undefined,
        pinned: Boolean(details.pinned)
      })
      const found = contents ? findTab(contents.id) : null
      return found ? tabObject(found.window, found.tab) : null
    }
    case 'tabs.duplicate': {
      const found = mustFind(args[0])
      const contents = hooks.openTab(found.tab.url, { windowId: found.window.id, active: true, index: found.tab.index + 1 })
      const copy = contents ? findTab(contents.id) : null
      return copy ? tabObject(copy.window, copy.tab) : null
    }
    case 'tabs.update': {
      const found = mustFind(args[0])
      const changes = (args[1] ?? {}) as Manifest
      const contents = found.tab.contents
      if (typeof changes.url === 'string') void contents.loadURL(resolveUrl(id, changes.url))
      if (changes.active === true || changes.highlighted === true) hooks.activateTab(contents)
      if (typeof changes.pinned === 'boolean') hooks.pinTab(contents, changes.pinned)
      if (typeof changes.muted === 'boolean') contents.setAudioMuted(changes.muted)
      const after = findTab(contents.id)
      return after ? tabObject(after.window, after.tab) : null
    }
    case 'tabs.highlight': {
      const window = windowById(details.windowId)
      const index = Array.isArray(details.tabs) ? details.tabs[0] : details.tabs
      const tab = window?.tabs.find((each) => each.index === index)
      if (tab) hooks.activateTab(tab.contents)
      return window ? windowObject(window, true) : null
    }
    case 'tabs.remove': {
      const ids = Array.isArray(args[0]) ? args[0] : [args[0]]
      for (const tabId of ids) {
        const found = findTab(Number(tabId))
        if (found) hooks.closeTab(found.tab.contents)
      }
      return null
    }
    case 'tabs.captureVisibleTab': {
      const window = windowById(args[0])
      const tab = window?.tabs.find((each) => each.active)
      if (!tab) throw new Error('No active tab to capture')
      const image = await tab.contents.capturePage()
      const options = (args[1] ?? {}) as Manifest
      if (options.format === 'png') return image.toDataURL()
      const quality = typeof options.quality === 'number' ? options.quality : 92
      return `data:image/jpeg;base64,${image.toJPEG(quality).toString('base64')}`
    }

    // --- windows ---
    case 'windows.get': {
      const window = windowById(args[0])
      if (!window) throw new Error(`No window with id: ${args[0]}.`)
      return windowObject(window, Boolean(args[1]?.populate))
    }
    case 'windows.getCurrent':
    case 'windows.getLastFocused': {
      const window =
        method === 'windows.getCurrent' ? currentWindow() : (all.find((each) => each.id === lastFocusedWindow) ?? currentWindow())
      if (!window) throw new Error('No window')
      return windowObject(window, Boolean(args[1]?.populate))
    }
    case 'windows.getAll':
      return all.map((window) => windowObject(window, Boolean(args[1]?.populate)))
    case 'windows.create': {
      const url = Array.isArray(details.url) ? details.url[0] : details.url
      hooks.openWindow(resolveUrl(id, url ?? 'ie2://newtab'))
      const newest = windows().reduce<ExtensionWindow | null>((best, each) => (!best || each.id > best.id ? each : best), null)
      return newest ? windowObject(newest, true) : null
    }
    case 'windows.update': {
      const window = windowById(args[0])
      if (!window) throw new Error(`No window with id: ${args[0]}.`)
      const changes = (args[1] ?? {}) as Manifest
      const win = window.window
      if (changes.state === 'minimized') win.minimize()
      else if (changes.state === 'maximized') win.maximize()
      else if (changes.state === 'fullscreen') win.setFullScreen(true)
      else if (changes.state === 'normal') {
        win.setFullScreen(false)
        win.restore()
      }
      if (changes.focused === true || changes.drawAttention === true) win.focus()
      return windowObject(window)
    }
    case 'windows.remove': {
      windowById(args[0])?.window.close()
      return null
    }

    // --- notifications ---
    case 'notifications.create':
      return showNotification(id, String(args[0] ?? ''), (args[1] ?? {}) as Manifest)
    case 'notifications.update':
      if (!notifications.has(`${id}/${args[0]}`)) return false
      showNotification(id, String(args[0]), (args[1] ?? {}) as Manifest)
      return true
    case 'notifications.clear': {
      const notification = notifications.get(`${id}/${args[0]}`)
      notification?.close()
      return Boolean(notification)
    }
    case 'notifications.getAll':
      return Object.fromEntries(
        [...notifications.keys()].filter((key) => key.startsWith(`${id}/`)).map((key) => [key.slice(id.length + 1), true])
      )
    case 'notifications.getPermissionLevel':
      return 'granted'

    // --- commands, alarms, permissions, downloads ---
    case 'commands.getAll':
      return Object.entries((manifestOf(id).commands ?? {}) as Record<string, Manifest>).map(([name, command]) => ({
        name,
        description: localized(id, command.description ?? ''),
        shortcut: keyOf(command) ?? ''
      }))
    case 'alarms.create':
      setAlarm(id, String(args[0] ?? ''), (args[1] ?? {}) as Manifest)
      return null
    case 'alarms.get': {
      const alarm = alarms.get(id)?.get(String(args[0] ?? ''))
      return alarm ? alarmInfo(alarm) : null
    }
    case 'alarms.getAll':
      return [...(alarms.get(id)?.values() ?? [])].map(alarmInfo)
    case 'alarms.clear':
      return clearAlarm(id, String(args[0] ?? ''))
    case 'alarms.clearAll': {
      const had = (alarms.get(id)?.size ?? 0) > 0
      for (const name of [...(alarms.get(id)?.keys() ?? [])]) clearAlarm(id, name)
      return had
    }
    case 'permissions.getAll':
    case 'permissions.contains': {
      const manifest = manifestOf(id)
      const declared: string[] = [...(manifest.permissions ?? []), ...(manifest.optional_permissions ?? [])].filter(
        (each: unknown): each is string => typeof each === 'string'
      )
      const hosts: string[] = [
        ...(manifest.host_permissions ?? []),
        ...(manifest.optional_host_permissions ?? []),
        ...declared.filter((each) => each.includes('://') || each === '<all_urls>')
      ]
      if (method === 'permissions.getAll') {
        return { permissions: declared.filter((each) => !hosts.includes(each)), origins: hosts }
      }
      const everywhere = hosts.some((host) => host === '<all_urls>' || /^(\*|https?):\/\/\*\//.test(host))
      const wanted = details as { permissions?: string[]; origins?: string[] }
      return (
        (wanted.permissions ?? []).every((each) => declared.includes(each)) &&
        (wanted.origins ?? []).every((origin) => everywhere || hosts.includes(origin))
      )
    }
    // Optional permissions are granted as asked: the extension listed them when it was added.
    case 'permissions.request':
      return true
    case 'permissions.remove':
      return false
    case 'downloads.download': {
      if (typeof details.url !== 'string') throw new Error('A download needs a url')
      ses().downloadURL(resolveUrl(id, details.url))
      return nextDownload++
    }
    case 'sidePanel.ignored':
      return null
    case 'sidePanel.getOptions':
      return { enabled: false, openPanelOnActionClick: false }

    // --- the rest ---
    case 'runtime.openOptionsPage':
      openOptions(id)
      return null
    case 'window.close': {
      if (sender && popup && sender === popup.view.webContents) closeExtensionPopup()
      else if (sender && findTab(sender.id)) hooks.closeTab(sender)
      return null
    }
  }
  throw new Error(`${method} is not supported in IE2`)
}

function openOptions(id: string): void {
  const page = optionsPageOf(manifestOf(id))
  if (!page || !hooks) return
  const url = resolveUrl(id, page)
  // An options page already open is brought forward rather than opened twice.
  for (const window of windows()) {
    const open = window.tabs.find((tab) => tab.url.startsWith(url))
    if (open) {
      hooks.activateTab(open.contents)
      return
    }
  }
  hooks.openTab(url, { active: true })
}

// --- installing, turning off, removing --------------------------------------------

/** What an extension asks for, in the words Chrome uses for it. */
function permissionWarnings(manifest: Manifest): string[] {
  const permissions: string[] = [...(manifest.permissions ?? []), ...(manifest.optional_permissions ?? [])].filter(
    (each): each is string => typeof each === 'string'
  )
  const hosts: string[] = [
    ...(manifest.host_permissions ?? []),
    ...permissions.filter((each) => each.includes('://') || each === '<all_urls>'),
    ...(manifest.content_scripts ?? []).flatMap((script: Manifest) => script.matches ?? [])
  ]
  const warnings: string[] = []
  const everywhere = hosts.some((host) => host === '<all_urls>' || /^(\*|https?):\/\/\*\//.test(host))
  if (everywhere) warnings.push('Read and change all your data on all websites')
  else if (hosts.length) {
    const names = [...new Set(hosts.map((host) => host.replace(/^[^:]+:\/\/(\*\.)?/, '').replace(/\/.*$/, '')))]
    warnings.push(`Read and change your data on ${names.slice(0, 3).join(', ')}${names.length > 3 ? ` and ${names.length - 3} more` : ''}`)
  }
  const words: Record<string, string> = {
    tabs: 'Read your browsing history',
    webNavigation: 'Read your browsing history',
    history: 'Read and change your browsing history',
    bookmarks: 'Read and change your bookmarks',
    clipboardRead: 'Read data you copy and paste',
    clipboardWrite: 'Modify data you copy and paste',
    downloads: 'Manage your downloads',
    notifications: 'Display notifications',
    geolocation: 'Detect your physical location',
    management: 'Manage your apps, extensions, and themes',
    proxy: 'Change your proxy settings',
    privacy: 'Change your privacy-related settings'
  }
  for (const permission of permissions) {
    const text = words[permission]
    if (text && !warnings.includes(text) && !(everywhere && permission === 'tabs')) warnings.push(text)
  }
  return warnings
}

/** Parts of Chrome that IE2 does not have, named so the user knows before adding. */
function unsupported(manifest: Manifest): string[] {
  const names: Record<string, string> = {
    proxy: 'proxy settings (how VPN extensions work)',
    vpnProvider: 'VPN connections',
    sidePanel: 'the side panel',
    tabCapture: 'recording tabs',
    desktopCapture: 'screen recording',
    nativeMessaging: 'talking to programs on this PC',
    identity: 'signing in with Google',
    debugger: 'the page debugger',
    tts: 'speech',
    ttsEngine: 'speech',
    privacy: 'privacy settings',
    contentSettings: 'site settings',
    pageCapture: 'saving pages',
    sessions: 'recently closed tabs',
    topSites: 'most visited sites'
  }
  const permissions: string[] = (manifest.permissions ?? []).filter((each: unknown) => typeof each === 'string')
  const found = [...new Set(permissions.map((permission) => names[permission]).filter(Boolean))]
  if (manifest.commands && Object.keys(manifest.commands).length) found.push('keyboard shortcuts')
  return found
}

/** Install questions waiting for an answer from the toolbar. */
const installQuestions = new Map<number, (allow: boolean) => void>()
let nextInstallQuestion = 1

async function confirmInstall(details: {
  localizedName: string
  manifest: unknown
  icon: NativeImage
  frame: Electron.WebFrameMain
}): Promise<{ action: 'allow' | 'deny' }> {
  const manifest = details.manifest as unknown as Manifest
  const warnings = permissionWarnings(manifest)
  const missing = unsupported(manifest)

  // Asked in the browser's own card, under the toolbar, where the store tab is.
  const store = details.frame.isDestroyed() ? null : allWebContents.fromFrame(details.frame)
  if (store && !store.isDestroyed() && hooks) {
    const request: ExtensionInstallRequest = {
      requestId: nextInstallQuestion++,
      name: details.localizedName,
      icon: details.icon.isEmpty() ? null : details.icon.resize({ width: 48, height: 48, quality: 'best' }).toDataURL(),
      warnings,
      missing
    }
    const answer = new Promise<boolean>((resolve) => {
      let settled = false
      const settle = (allow: boolean): void => {
        if (settled) return
        settled = true
        installQuestions.delete(request.requestId)
        if (!store.isDestroyed()) {
          store.off('did-start-navigation', left)
          store.off('destroyed', gone)
        }
        hooks?.cancelInstallPrompt(store, request.requestId)
        resolve(allow)
      }
      // Leaving the store page, or closing it, is a no.
      const left = (event: { isMainFrame: boolean; isSameDocument: boolean }): void => {
        if (event.isMainFrame && !event.isSameDocument) settle(false)
      }
      const gone = (): void => settle(false)
      installQuestions.set(request.requestId, settle)
      store.on('did-start-navigation', left)
      store.once('destroyed', gone)
      // No window to ask in: let go, and ask below instead.
      if (!hooks?.promptInstall(store, request)) settle(false)
    })
    if (installQuestions.has(request.requestId)) return { action: (await answer) ? 'allow' : 'deny' }
  }

  // Nowhere to show the card: the system's own box.
  const lines = [
    warnings.length ? `It can:\n${warnings.map((each) => `•  ${each}`).join('\n')}` : 'It asks for no special access.',
    missing.length
      ? `Not in IE2, so these parts of it will not work: ${missing.join(', ')}.`
      : ''
  ]
  const options: Electron.MessageBoxOptions = {
    type: 'none',
    title: 'Add extension',
    message: `Add "${details.localizedName}"?`,
    detail: lines.filter(Boolean).join('\n\n'),
    icon: details.icon.isEmpty() ? undefined : details.icon.resize({ width: 48, height: 48, quality: 'best' }),
    buttons: ['Add extension', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    noLink: true
  }
  const parent = BaseWindow.getFocusedWindow()
  const result = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options)
  return { action: result.response === 0 ? 'allow' : 'deny' }
}

function setEnabled(id: string, enabled: boolean): void {
  const extension = known.get(id)
  if (!extension) return
  const disabled = getSettings().disabledExtensions.filter((each) => each !== id)
  setSetting('disabledExtensions', enabled ? disabled : [...disabled, id])
  if (enabled) {
    if (!isLoaded(id)) void ses().extensions.loadExtension(extension.path, { allowFileAccess: false }).catch(console.error)
  } else {
    if (popup?.extensionId === id) closeExtensionPopup()
    if (isLoaded(id)) ses().extensions.removeExtension(id)
  }
  changed()
}

function setPinned(id: string, pinned: boolean): void {
  const rest = getSettings().pinnedExtensions.filter((each) => each !== id)
  setSetting('pinnedExtensions', pinned ? [...rest, id] : rest)
  changed()
}

async function remove(id: string, parent: BaseWindow | null): Promise<void> {
  const extension = known.get(id)
  if (!extension) return
  const options: Electron.MessageBoxOptions = {
    type: 'none',
    title: 'Remove extension',
    message: `Remove "${extension.name}"?`,
    detail: 'Its settings and anything it saved go with it.',
    icon: menuIcon(id)?.resize({ width: 32, height: 32 }),
    buttons: ['Remove', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    noLink: true
  }
  const result = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options)
  if (result.response !== 0) return

  if (popup?.extensionId === id) closeExtensionPopup()
  known.delete(id)
  menus.delete(id)
  saveMenus()
  listening.delete(id)
  delete versions[id]
  saveVersions()
  actionEverywhere.delete(id)
  actionPerTab.delete(id)
  const settings = getSettings()
  setSetting('pinnedExtensions', settings.pinnedExtensions.filter((each) => each !== id))
  setSetting('disabledExtensions', getSettings().disabledExtensions.filter((each) => each !== id))
  try {
    // Not loaded (turned off)? It still has files to delete.
    if (!isLoaded(id)) await ses().extensions.loadExtension(extension.path).catch(() => undefined)
    await uninstallExtension(id, { session: ses(), extensionsPath: extensionsPath() })
  } catch (error) {
    console.error(`Removing extension ${id} failed:`, error)
  }
  changed()
}

/** The ⋯ menu beside an extension: options, pinning, turning off, removing. */
function showMenu(id: string, toolbar: WebContents): void {
  const extension = known.get(id)
  if (!extension || !hooks) return
  const window = hooks.windowFor(toolbar)
  const info = infoFor(id, window?.tabs.find((tab) => tab.active)?.contents.id ?? null)
  const active = window?.tabs.find((tab) => tab.active)
  const own = info.enabled
    ? menuItemsFor(id, undefined, null, window && active ? { window, tab: active } : null, active?.url ?? '')
    : []
  const items: MenuItemConstructorOptions[] = [
    { label: extension.name, enabled: false, icon: menuIcon(id) },
    { type: 'separator' },
    ...(own.length ? [...own, { type: 'separator' } as MenuItemConstructorOptions] : []),
    { label: 'Options', visible: info.hasOptions, enabled: info.enabled, click: () => openOptions(id) },
    {
      label: info.pinned ? 'Unpin from toolbar' : 'Pin to toolbar',
      enabled: info.enabled,
      click: () => setPinned(id, !info.pinned)
    },
    { label: info.enabled ? 'Turn off' : 'Turn on', click: () => setEnabled(id, !info.enabled) },
    { label: 'Remove from IE2…', click: () => void remove(id, window?.window ?? null) },
    { type: 'separator' },
    {
      label: 'View in Chrome Web Store',
      click: () => hooks?.openTab(`${CHROME_WEB_STORE_URL}detail/${id}`, { active: true, windowId: window?.id })
    }
  ]
  Menu.buildFromTemplate(items).popup(window ? { window: window.window } : undefined)
}

/** Whether an extension's own page may use a browser permission it declared. */
export function extensionAllows(url: string | undefined, permission: string): boolean | null {
  if (!url?.startsWith('chrome-extension://')) return null
  let id: string
  try {
    id = new URL(url).host
  } catch {
    return false
  }
  const declared: string[] = manifestOf(id).permissions ?? []
  const needs: Record<string, string> = {
    'clipboard-read': 'clipboardRead',
    'clipboard-sanitized-write': 'clipboardWrite',
    notifications: 'notifications',
    geolocation: 'geolocation'
  }
  return Boolean(needs[permission] && declared.includes(needs[permission]))
}

// --- start ------------------------------------------------------------------------

export function registerExtensionIpc(given: ExtensionHooks): void {
  hooks = given

  ipcMain.handle('ext:list', (event) => {
    const window = hooks?.windowFor(event.sender)
    return extensionsFor(window?.tabs.find((tab) => tab.active)?.contents ?? null)
  })
  ipcMain.handle('ext:click', (event, id: string, anchor: Rectangle) => clickAction(String(id), event.sender, anchor))
  ipcMain.handle('ext:menu', (event, id: string) => showMenu(String(id), event.sender))
  ipcMain.handle('ext:pin', (_event, id: string, pinned: boolean) => setPinned(String(id), Boolean(pinned)))
  ipcMain.handle('ext:install-answer', (_event, requestId: number, allow: boolean) => {
    installQuestions.get(Number(requestId))?.(Boolean(allow))
  })
  ipcMain.handle('ext:store', (event) => {
    hooks?.openTab(CHROME_WEB_STORE_URL, { active: true, windowId: hooks.windowFor(event.sender)?.id })
  })

  // Calls from extensions' own pages: popups, options, background pages.
  ipcMain.handle('ext:call', (event, method: string, args: unknown[]) => {
    const url = event.senderFrame?.url ?? ''
    if (!url.startsWith('chrome-extension://')) throw new Error('Only extensions may call this')
    return handleCall(new URL(url).host, String(method), Array.isArray(args) ? args : [], event.sender)
  })
}

/**
 * Load what is installed and open the Chrome Web Store for installing more.
 * Resolves once installed extensions are loaded, so tabs opened after it have
 * their content scripts.
 */
export async function initExtensions(): Promise<void> {
  const browsing = ses()
  loadMenus()
  loadVersions()

  // Our half of the extension API, in extensions' pages and their workers.
  const preload = join(__dirname, '../preload/extension.js')
  browsing.registerPreloadScript({ id: 'ie2-extension-frames', type: 'frame', filePath: preload })
  browsing.registerPreloadScript({ id: 'ie2-extension-workers', type: 'service-worker', filePath: preload })

  // A worker's calls arrive on the worker, not ipcMain, so each one starting is
  // given somewhere to send them.
  const wired = new WeakSet<Electron.ServiceWorkerMain>()
  browsing.serviceWorkers.on('running-status-changed', ({ versionId, runningStatus }) => {
    if (runningStatus !== 'starting' && runningStatus !== 'running') return
    const worker = browsing.serviceWorkers.getWorkerFromVersionID(versionId)
    if (!worker || wired.has(worker) || !worker.scope.startsWith('chrome-extension://')) return
    wired.add(worker)
    const id = new URL(worker.scope).host
    try {
      worker.ipc.handle('ext:call', (_event, method: string, args: unknown[]) =>
        handleCall(id, String(method), Array.isArray(args) ? args : [], null)
      )
    } catch {
      // Already answering.
    }
  })

  browsing.extensions.on('extension-loaded', (_event, extension) => {
    known.set(extension.id, extension)
    defaultIcons.delete(extension.id)
    noticeVersion(extension)
    // Installed but turned off: the store loads everything it finds.
    if (getSettings().disabledExtensions.includes(extension.id)) {
      setImmediate(() => browsing.extensions.removeExtension(extension.id))
    }
    changed()
  })
  browsing.extensions.on('extension-unloaded', (_event, extension) => {
    actionEverywhere.delete(extension.id)
    actionPerTab.delete(extension.id)
    changed()
  })

  app.on('web-contents-created', (_event, contents) => {
    if (contents.session === browsing) watchPage(contents)
  })

  try {
    await installChromeWebStore({
      session: browsing,
      extensionsPath: extensionsPath(),
      autoUpdate: true,
      beforeInstall: confirmInstall
    })
  } catch (error) {
    console.error('Chrome extensions could not start:', error)
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */
