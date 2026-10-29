// Before everything else: decides which profile folder this copy uses.
import { APP_USER_MODEL_ID } from './profile'
import {
  app,
  BaseWindow,
  BrowserWindow,
  Menu,
  clipboard,
  dialog,
  WebContentsView,
  ipcMain,
  session,
  shell,
  webContents
} from 'electron'
import { join } from 'node:path'
import {
  BOOKMARKS_BAR_HEIGHT,
  BOOKMARKS_URL,
  CHROME_HEIGHT,
  DROPDOWN_MAX_HEIGHT,
  HOME_URL,
  PASSWORDS_URL,
  READER_URL,
  SIDEBAR_WIDTH,
  TITLEBAR_HEIGHT,
  type BookmarkEntry,
  type BrowserState,
  type ReaderArticle,
  type TabsState
} from '../shared/types'
import { TabManager, type Shortcut } from './tabs'
import { answerPermission, initPermissions, pendingPermissions } from './permissions'
import { ALL_PARTITIONS, PARTITION } from './partitions'
import { buildSuggestions, engineSuggestions } from './suggest'
import {
  handleInternalProtocol,
  isInternalUrl,
  listImages,
  registerInternalScheme
} from './protocol'
import {
  adblockStats,
  flush,
  initAdblock,
  listsUpdatedAt,
  toggleAdblock,
  toggleSiteBlocking,
  updateFilterLists
} from './adblock'
import { appIconPath, appLaunchArgs, appUserModelIdFor, installApp } from './pwa'
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { showTabMenu } from './menus'
import { exportBookmarks } from './bookmark-export'
import { normalizeInput } from './url'
import { publicIp } from './publicip'
import { registerPasswordIpc, registerVaultPageIpc } from './passwords'
import { registerAudioFxIpc } from './audiofx'
import { captureVisible, saveLastCapture } from './screenshot'
import { togglePictureInPicture } from './pip'
import { controlMedia, readMedia } from './media'
import { importFirefoxCookies, readProfile, scanForProfiles } from './import'
import {
  addLanguage,
  exportLocale,
  importLocale,
  listLanguages,
  localeEntries,
  messagesFor,
  removeLanguage,
  setMessage
} from './locale'
import { getSettings, loadSettings, resetSettings, setSetting } from './settings'
import { isDefaultBrowser, openableFromArgv, requestDefaultBrowser } from './defaults'
import { extractArticle } from './reader'
import {
  check,
  download,
  initUpdater,
  installNow,
  latestChanges,
  onUpdateState,
  updateState
} from './updater'
import { themeById } from '../shared/themes'
import type { TabGroupColour } from '../shared/groups'
import type { Settings } from '../shared/settings'
import {
  cancelDownload,
  clearFinishedDownloads,
  initDownloads,
  listDownloads,
  revealDownload
} from './downloads'
import {
  addBookmark,
  addNeverRemember,
  bookmarkFolders,
  createBookmarkFolder,
  deleteBookmarkFolder,
  getBookmark,
  listSitePermissions,
  renameBookmarkFolder,
  setSitePermission,
  updateBookmark,
  clearAllHistory,
  clearHistoryOnly,
  closeDb,
  forgetSite,
  forgetUrl,
  forgetVisit,
  historyCount,
  historyPage,
  initDb,
  importProfile,
  listNeverRemember,
  removeNeverRemember,
  listBookmarks,
  loadSession,
  recallStats,
  recentHistory,
  removeBookmark,
  saveSession,
  searchFullText
} from './db'

/**
 * Everything a single browser window owns.
 *
 * These used to be module-level singletons, which meant opening a second window
 * silently took over the first one's tabs: every IPC call landed on whichever
 * window was created last, and closing it left the original inert. State is per
 * window now, and each IPC call is resolved back to the window that sent it.
 */
interface Shell {
  window: BaseWindow
  chrome: WebContentsView
  tabs: TabManager
  dropdownHeight: number
  /** The bookmarks sidebar docked on the right, while it is open. */
  sidebar: WebContentsView | null
  /**
   * Where a tab dragged in from another window would land in this strip, as
   * last reported by this window's renderer, or null when nothing is hovering.
   */
  dropIndex: number | null
}

/** A tab torn out of a window, waiting for the new window it opens to load. */
interface TornTab {
  from: Shell
  tabId: number
  /** Screen point it was dropped at; the new window opens under it. */
  x: number
  y: number
}

/** Keyed by the chrome view's webContents id, which is what IPC events carry. */
const shells = new Map<number, Shell>()

/**
 * The article reader mode extracted, per tab.
 *
 * Held here rather than passed through the URL or the page: the content came
 * from an arbitrary website, and ie2://reader is a page with the internal API
 * attached. This way the reader asks for its own article and receives data,
 * never markup.
 */
const readerArticles = new Map<number, ReaderArticle>()

/**
 * Pages already relaying find results. `found-in-page` fires repeatedly for a
 * single search as Chromium refines the count, so the listener is attached
 * once and kept — re-attaching per keystroke would multiply the messages.
 */
const findWired = new WeakSet<Electron.WebContents>()

/**
 * Which window does this call belong to? Normally the sender is a chrome UI, but
 * internal pages send from a tab, so that is checked too. The focused window is
 * a last resort rather than a default.
 */
function shellFor(event: Electron.IpcMainInvokeEvent): Shell | undefined {
  return (
    shells.get(event.sender.id) ??
    shellOwningTab(event.sender.id) ??
    shellOwningSidebar(event.sender.id) ??
    focusedShell()
  )
}

function shellOwningSidebar(webContentsId: number): Shell | undefined {
  for (const shell of shells.values()) {
    if (shell.sidebar?.webContents.id === webContentsId) return shell
  }
  return undefined
}

function shellOwningTab(webContentsId: number): Shell | undefined {
  for (const shell of shells.values()) {
    if (shell.tabs.ownsWebContents(webContentsId)) return shell
  }
  return undefined
}

function focusedShell(): Shell | undefined {
  const focused = BaseWindow.getFocusedWindow()
  if (focused) {
    for (const shell of shells.values()) if (shell.window === focused) return shell
  }
  return shells.values().next().value
}

/**
 * The minimise, maximise and close buttons are drawn by Windows, not by us, so
 * they only match the interface if we hand Windows the theme's own colours.
 * They used to be fixed to the default palette, which left them sitting in a
 * dark slab on every other theme — and unreadable on the light ones.
 */
function overlayColours(): { color: string; symbolColor: string; height: number } {
  const settings = getSettings()
  const { colours } = themeById(settings.theme)

  return {
    color: colours.bg,
    symbolColor: colours.text,
    height: TITLEBAR_HEIGHT
  }
}

/** Repaint the native buttons after the theme changes. */
function applyOverlay(): void {
  for (const shell of shells.values()) {
    // Only Windows draws this overlay; elsewhere the call is not available.
    if (process.platform !== 'win32') return
    try {
      shell.window.setTitleBarOverlay(overlayColours())
    } catch {
      // A window closing mid-broadcast is not worth reporting.
    }
  }
}

function createWindow(startUrl?: string, torn?: TornTab): void {
  // A torn-out tab opens its window the size of the one it came from, with
  // the tab strip under the pointer, so the tab appears to stay in the hand.
  const from = torn?.from.window.getBounds()
  const win = new BaseWindow({
    width: from?.width ?? 1280,
    height: from?.height ?? 820,
    ...(torn ? { x: Math.round(torn.x - 120), y: Math.round(torn.y - 20) } : {}),
    minWidth: 520,
    minHeight: 400,
    title: 'IE2',
    backgroundColor: themeById(getSettings().theme).colours.bg,
    // No OS title bar and no menu bar: the tab strip *is* the title bar, with
    // the native window buttons overlaid on the right of it. Keeping them
    // native preserves Windows 11 snap layouts on hover.
    titleBarStyle: 'hidden',
    titleBarOverlay: overlayColours()
  })

  // The browser UI itself. This one gets a preload and talks to the main
  // process; it never loads remote content.
  const chromeView = new WebContentsView({
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  // This view is grown over the page to host panels, so wherever it is not
  // painting a toolbar or a popover it has to let the page show through.
  chromeView.setBackgroundColor('#00000000')

  win.contentView.addChildView(chromeView)

  const shell = {
    window: win,
    chrome: chromeView,
    dropdownHeight: 0,
    dropIndex: null,
    sidebar: null
  } as Shell

  shell.tabs = new TabManager(
    win,
    (state) => {
      if (!chromeView.webContents.isDestroyed()) {
        chromeView.webContents.send('browser:state', withAdblock(shell, state))
      }
    },
    () => raiseChrome(shell),
    (action) => runShortcut(shell, action),
    (url) => createWindow(url)
  )

  shells.set(chromeView.webContents.id, shell)

  layoutShell(shell)
  win.on('resize', () => layoutShell(shell))

  if (process.env['ELECTRON_RENDERER_URL']) {
    chromeView.webContents.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    chromeView.webContents.loadFile(join(__dirname, '../renderer/index.html'))
  }

  chromeView.webContents.once('did-finish-load', () => {
    if (torn) {
      // The source window may have gone, or closed the tab, while this loaded.
      const moved = shells.has(torn.from.chrome.webContents.id) &&
        torn.from.tabs.moveTabTo(torn.tabId, shell.tabs)
      if (!moved) shell.tabs.createTab()
      return
    }
    if (startUrl) shell.tabs.createTab(startUrl)
    else restoreSession(shell)
  })

  // The chrome UI handles its own typing, but shortcuts are resolved centrally
  // so Ctrl+W means the same thing no matter where the focus happens to be.
  chromeView.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    const mod = input.control || input.meta
    if (!mod && input.key !== 'F12') return

    const key = input.key.toLowerCase()

    if (input.shift && ['n', 't', 'p'].includes(key)) {
      event.preventDefault()
      runShortcut(shell, key === 'n' ? 'amnesia-tab' : key === 't' ? 'reopen-tab' : 'palette')
    } else if (!input.shift && key === 'f') {
      event.preventDefault()
      runShortcut(shell, 'find')
    } else if (!input.shift && ['t', 'w', 'l', 'r', 'd', 'k'].includes(key)) {
      event.preventDefault()
      runShortcut(
        shell,
        key === 't'
          ? 'new-tab'
          : key === 'w'
            ? 'close-tab'
            : key === 'l'
              ? 'focus-omnibox'
              : key === 'r'
                ? 'reload'
                : key === 'k'
                  ? 'palette'
                  : 'bookmark'
      )
    } else if (input.key === 'F12') {
      event.preventDefault()
      runShortcut(shell, 'devtools')
    }
  })

  // Only the last window standing writes the session, or closing one window
  // would replace the restore list with just that window's tabs.
  win.on('close', () => {
    // A quit started by the app itself has already saved the session, and has
    // closed the database by the time the windows close. See before-quit.
    if (quitting || shells.size !== 1) return
    const snapshot = shell.tabs.snapshot()
    saveSession(snapshot.tabs, snapshot.activeIndex, snapshot.groups)
  })

  // Tabs go to sleep on a timer rather than on a schedule of their own, so the
  // check is cheap and the setting can change without anything to reschedule.
  const sleepTimer = setInterval(() => {
    const settings = getSettings()
    if (!settings.sleepTabs) return
    shell.tabs.sleepIdleTabs(Math.max(1, settings.sleepAfterMinutes))
  }, 60_000)

  win.on('closed', () => {
    clearInterval(sleepTimer)
    if (shell.sidebar && !shell.sidebar.webContents.isDestroyed()) shell.sidebar.webContents.close()
    shells.delete(chromeView.webContents.id)
  })
}

/**
 * Installed web apps launch with `--app=<url>`: one window, one site, no tab
 * strip and no omnibox. It still uses the normal browsing session, so logins
 * and ad blocking carry over from the browser.
 */
function appModeUrl(argv: string[]): string | null {
  const flag = argv.find((arg) => arg.startsWith('--app='))
  if (!flag) return null

  const url = flag.slice('--app='.length).replace(/^"|"$/g, '')
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : null
  } catch {
    return null
  }
}

/** Open installed-app windows, one per site, so a second launch focuses it. */
const appWindows = new Map<string, BrowserWindow>()

/**
 * An installed web app: its own window, its own taskbar button and icon, no
 * tabs and no address bar — whether or not the browser is already open.
 *
 * The identity is set on the window, not the process. Setting it process-wide
 * (as this once did) renamed the browser too, and a launch while the browser
 * was running never got here at all: the running copy took the shortcut's
 * arguments, ignored --app, and just focused itself.
 */
function createAppWindow(url: string): void {
  const host = new URL(url).hostname

  const open = appWindows.get(host)
  if (open && !open.isDestroyed()) {
    if (open.isMinimized()) open.restore()
    open.focus()
    return
  }

  const icon = appIconPath(host)

  const win = new BrowserWindow({
    width: 1100,
    height: 780,
    title: host,
    ...(existsSync(icon) ? { icon } : {}),
    backgroundColor: '#1b1d21',
    autoHideMenuBar: true,
    webPreferences: {
      partition: PARTITION,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  // Its own taskbar button and icon, and pinning it pins the app, not IE2.
  if (process.platform === 'win32') {
    win.setAppDetails({
      appId: appUserModelIdFor(host),
      ...(existsSync(icon) ? { appIconPath: icon, appIconIndex: 0 } : {}),
      relaunchCommand: `"${process.execPath}" ${appLaunchArgs(url)}`,
      relaunchDisplayName: host
    })
  }

  appWindows.set(host, win)
  win.on('closed', () => appWindows.delete(host))

  win.loadURL(url)

  // Links that leave the app's own origin belong in a real browser window.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    shell.openExternal(target)
    return { action: 'deny' }
  })
}

function restoreSession(shell: Shell): void {
  const saved = loadSession()
  const pinned = saved.tabs.filter((tab) => tab.pinned)

  // "Start with a new tab" is about where you left off reading, not about
  // throwing away tabs that were pinned precisely so they would stay.
  if (getSettings().onStartup === 'newtab') {
    for (const tab of pinned) shell.tabs.createTab(tab.url, { activate: false, pinned: true })
    shell.tabs.createTab(getSettings().homePage)
    return
  }

  if (saved.tabs.length === 0) {
    shell.tabs.createTab(HOME_URL)
    return
  }

  // Groups first, so the tabs can be filed into them as they are created.
  shell.tabs.restoreGroups(
    saved.groups.map((group) => ({
      id: group.id,
      name: group.name,
      colour: group.colour as TabGroupColour,
      collapsed: false
    }))
  )

  saved.tabs.forEach((tab, i) =>
    shell.tabs.createTab(tab.url, {
      activate: i === saved.activeIndex,
      pinned: tab.pinned,
      groupId: tab.groupId
    })
  )
}

/**
 * One place where every browser shortcut is carried out, whether the key was
 * pressed while a page had focus or while the chrome UI did.
 */
function runShortcut(shell: Shell, action: Shortcut): void {
  if (action === 'group-new-tab' || action === 'group-close') {
    const groupId = shell.tabs.activeGroupId()
    if (groupId === null) return
    if (action === 'group-new-tab') shell.tabs.newTabInGroup(groupId)
    else shell.tabs.closeGroup(groupId)
    return
  }

  switch (action) {
    case 'new-tab':
      shell.tabs.createTab()
      break
    case 'amnesia-tab':
      shell.tabs.createTab(HOME_URL, { amnesia: true })
      break
    case 'close-tab': {
      const id = shell.tabs.state().activeTabId
      if (id != null) shell.tabs.closeTab(id)
      break
    }
    case 'focus-omnibox':
      // Focus has to move back to the chrome view before the input can take it.
      shell.chrome.webContents.focus()
      shell.chrome.webContents.send('browser:focus-omnibox')
      break
    case 'find':
      // Same reason: the field lives in the chrome, and the page has the keys.
      shell.chrome.webContents.focus()
      shell.chrome.webContents.send('browser:open-find')
      break
    case 'reload':
      shell.tabs.reload()
      break
    case 'bookmark':
      // The editor lives in the chrome, which needs focus to type a name.
      shell.chrome.webContents.focus()
      shell.chrome.webContents.send('browser:edit-bookmark')
      break
    case 'back':
      shell.tabs.goBack()
      break
    case 'forward':
      shell.tabs.goForward()
      break
    case 'devtools':
      shell.tabs.toggleDevTools()
      break
    case 'reopen-tab':
      shell.tabs.reopenClosed()
      break
    case 'screenshot':
      void takeScreenshot(shell)
      break
    case 'pip':
      void floatVideo(shell)
      break
    case 'split':
      shell.tabs.splitWithNeighbour()
      break
    case 'palette':
      // The palette lives in the chrome UI, which must hold focus to type.
      shell.chrome.webContents.focus()
      shell.chrome.webContents.send('browser:open-palette')
      break
  }
}

function toggleBookmarkForActiveTab(shell: Shell): void {
  const url = shell.tabs.activeUrl()
  if (!url) return

  if (shell.tabs.state().bookmarked) removeBookmark(url)
  else addBookmark(url, shell.tabs.activeTitle())
  bookmarksChanged()
}

/**
 * The star: save the page if it is not saved yet — straight into the bookmarks
 * bar, where it can be seen — and hand back what the editor needs to show
 * where it went and let it be renamed or moved.
 */
function bookmarkActiveTab(
  shell: Shell
): { entry: BookmarkEntry; folders: string[]; created: boolean } | null {
  const url = shell.tabs.activeUrl()
  if (!url || url === 'about:blank') return null

  let entry = getBookmark(url)
  const created = entry === null
  if (!entry) {
    addBookmark(url, shell.tabs.activeTitle() || url)
    entry = getBookmark(url)
    bookmarksChanged()
  }
  return entry ? { entry, folders: bookmarkFolders(), created } : null
}

/** Every window's bar, star and sidebar redraw from the new bookmarks. */
function bookmarksChanged(): void {
  for (const shell of shells.values()) {
    pushState(shell)
    if (!shell.chrome.webContents.isDestroyed()) shell.chrome.webContents.send('browser:bookmarks-changed')
  }
  // The sidebars, and any bookmarks page open in a tab.
  for (const contents of webContents.getAllWebContents()) {
    if (!contents.isDestroyed() && contents.getURL().startsWith(BOOKMARKS_URL)) {
      contents.send('ie2:bookmarks-changed')
    }
  }
}

/**
 * Open or close the bookmarks sidebar. It is a page of its own docked beside
 * the tab — the tab gets narrower rather than covered — so it can be as tall
 * as the window and scroll by itself.
 */
function toggleSidebar(shell: Shell, open = !shell.sidebar): void {
  if (open && !shell.sidebar) {
    const view = new WebContentsView({
      webPreferences: {
        partition: PARTITION,
        preload: join(__dirname, '../preload/internal.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false
      }
    })
    view.setBackgroundColor(themeById(getSettings().theme).colours.bg)

    // It only ever shows the bookmarks page; anything else is refused.
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    view.webContents.on('will-navigate', (event, url) => {
      if (!isInternalUrl(url)) event.preventDefault()
    })

    view.webContents.loadURL(`${BOOKMARKS_URL}/?sidebar`)
    shell.window.contentView.addChildView(view)
    shell.sidebar = view
    raiseChrome(shell)
  } else if (!open && shell.sidebar) {
    const view = shell.sidebar
    shell.sidebar = null
    shell.window.contentView.removeChildView(view)
    view.webContents.close()
  }

  layoutShell(shell)
  pushState(shell)
}

/**
 * Push the full state to the chrome UI. Downloads arrive independently of the
 * tab layer, so they cannot rely on a tab event happening to fire.
 */
function pushState(shell: Shell): void {
  if (shell.chrome.webContents.isDestroyed()) return
  shell.chrome.webContents.send('browser:state', withAdblock(shell, shell.tabs.state()))
}

/**
 * Float the active tab's video above other windows, or put it back if one is
 * already floating. The chrome UI is told the outcome so it can say when there
 * was nothing to float.
 */
async function floatVideo(shell: Shell): Promise<void> {
  const wc = shell.tabs.activeWebContents()
  if (!wc) return

  const result = await togglePictureInPicture(wc)

  if (!shell.chrome.webContents.isDestroyed()) {
    shell.chrome.webContents.send('browser:pip', result)
  }
}

/**
 * Capture the active tab, put it on the clipboard, and show the result in the
 * chrome UI so it can be saved as well.
 */
async function takeScreenshot(shell: Shell): Promise<void> {
  const wc = shell.tabs.activeWebContents()
  if (!wc) return

  const result = await captureVisible(wc)
  if (!result) return

  if (!shell.chrome.webContents.isDestroyed()) {
    shell.chrome.webContents.send('browser:screenshot', result)
  }
}

/** Settings are global: apply once, then tell every window about it. */
function broadcastSettings(next: Settings): Settings {
  for (const shell of shells.values()) {
    // The bookmarks bar may have been switched on or off.
    layoutShell(shell)
    pushState(shell)
    if (!shell.chrome.webContents.isDestroyed()) {
      shell.chrome.webContents.send('browser:settings', next)
    }
  }
  // The window buttons belong to Windows and do not hear about our themes.
  applyOverlay()
  return next
}

/** Downloads and blocking are process-wide, so every window hears about them. */
function pushStateEverywhere(): void {
  for (const shell of shells.values()) pushState(shell)
}

/** The tab layer knows only about tabs; the chrome UI shows everything. */
function withAdblock(shell: Shell, state: TabsState): BrowserState {
  return {
    ...state,
    adblock: adblockStats(shell.tabs.activeWebContentsId()),
    messages: messagesFor(getSettings().language),
    downloads: listDownloads(),
    settings: getSettings(),
    sidebarOpen: shell.sidebar !== null
  }
}

/**
 * Keep the chrome above page content. Tab views are added to the same parent
 * later, so without this the page would paint over the toolbar and dropdown.
 */
function raiseChrome(shell: Shell): void {
  shell.window.contentView.removeChildView(shell.chrome)
  shell.window.contentView.addChildView(shell.chrome)
}

/** Toolbar and tab strip, plus the bookmarks bar when it is shown. */
function chromeTop(): number {
  return CHROME_HEIGHT + (getSettings().showBookmarksBar ? BOOKMARKS_BAR_HEIGHT : 0)
}

function layoutChrome(shell: Shell): void {
  const { width, height } = shell.window.getContentBounds()
  const wanted = chromeTop() + shell.dropdownHeight
  shell.chrome.setBounds({ x: 0, y: 0, width, height: Math.min(wanted, height) })
}

/** Chrome on top, the sidebar down the right, and the tabs in what is left. */
function layoutShell(shell: Shell): void {
  layoutChrome(shell)

  const { width, height } = shell.window.getContentBounds()
  const top = chromeTop()
  shell.sidebar?.setBounds({
    x: Math.max(0, width - SIDEBAR_WIDTH),
    y: top,
    width: Math.min(SIDEBAR_WIDTH, width),
    height: Math.max(0, height - top)
  })
  shell.tabs.setInsets(top, shell.sidebar ? SIDEBAR_WIDTH : 0)
}

/**
 * Grow the chrome view over the page so the omnibox dropdown has somewhere to
 * paint. The renderer reports the height its list actually needs, so the panel
 * never covers more of the page than it uses.
 */
function setDropdownHeight(shell: Shell, px: number): void {
  const next = Math.max(0, Math.min(Math.round(px), DROPDOWN_MAX_HEIGHT))
  if (next === shell.dropdownHeight) return
  shell.dropdownHeight = next
  layoutChrome(shell)
}

/**
 * The other window whose tab strip is under this screen point, if any. A little
 * slack around the strip, because a drop aimed at a thin target lands just off
 * it as often as on it.
 */
function shellAtStrip(source: Shell, x: number, y: number): Shell | undefined {
  for (const shell of shells.values()) {
    if (shell === source || shell.window.isMinimized() || !shell.window.isVisible()) continue
    const box = shell.window.getContentBounds()
    if (x < box.x || x > box.x + box.width) continue
    if (y < box.y - 8 || y > box.y + TITLEBAR_HEIGHT + 8) continue
    return shell
  }
  return undefined
}

function clearTabHover(except?: Shell): void {
  for (const shell of shells.values()) {
    if (shell === except || shell.dropIndex === null) continue
    shell.dropIndex = null
    if (!shell.chrome.webContents.isDestroyed()) shell.chrome.webContents.send('browser:tab-hover', null)
  }
}

/**
 * A tab is being dragged outside its own strip. If it is over another window's
 * strip, that window shows where it would land, and reports the slot back
 * through `tab:drop-index`.
 */
function showTabHover(source: Shell, x: number, y: number): void {
  const target = shellAtStrip(source, x, y)
  clearTabHover(target)
  if (!target || target.chrome.webContents.isDestroyed()) return

  // Until the renderer answers with a slot, the end of the strip.
  target.dropIndex ??= target.tabs.tabCount()
  target.chrome.webContents.send('browser:tab-hover', x - target.window.getContentBounds().x)
}

/**
 * Let go of a tab dragged out of its strip. Over another window's strip it
 * joins that window at the marked slot; anywhere else it becomes a window of
 * its own. Either way the page moves rather than reloading.
 */
function dropTab(source: Shell, id: number, x: number, y: number): boolean {
  const target = shellAtStrip(source, x, y)
  const index = target?.dropIndex ?? undefined
  clearTabHover()

  if (target) {
    if (!source.tabs.moveTabTo(id, target.tabs, index)) return false
    target.window.focus()
    target.chrome.webContents.focus()
    // Its last tab gone, the window it came from has nothing left to show.
    if (source.tabs.tabCount() === 0) source.window.close()
    return true
  }

  // A lone tab is already its own window; tearing it out would leave an empty one.
  if (source.tabs.tabCount() < 2) return false

  createWindow(undefined, { from: source, tabId: id, x, y })
  return true
}

/**
 * Channels the internal pages use. The preload only exposes these to `ie2://`
 * frames, but that check lives in the renderer process — this is the boundary
 * that actually holds, so every handler re-verifies the sender itself.
 */
function registerInternalIpc(): void {
  const fromInternalPage = <A extends unknown[], R>(handler: (...args: A) => R) => {
    return (event: Electron.IpcMainInvokeEvent, ...args: A): R | null => {
      if (!isInternalUrl(event.senderFrame?.url)) return null
      return handler(...args)
    }
  }

  // Cookie count comes from the session rather than the database, so this one
  // handler is async and merges the two.
  ipcMain.handle('internal:stats', async (event: Electron.IpcMainInvokeEvent) => {
    if (!isInternalUrl(event.senderFrame?.url)) return null

    const stats = recallStats()
    try {
      stats.cookies = (await session.fromPartition(PARTITION).cookies.get({})).length
    } catch {
      stats.cookies = 0
    }
    return stats
  })
  ipcMain.handle(
    'internal:recall',
    fromInternalPage((query: string) => searchFullText(query, 20))
  )
  ipcMain.handle(
    'internal:recent',
    fromInternalPage((limit?: number) => recentHistory(limit ?? 10))
  )
  ipcMain.handle(
    'internal:forget',
    fromInternalPage((url: string) => forgetUrl(url))
  )

  /**
   * Forgetting where you went without forgetting what you read. The history
   * page and the new tab list both work this way, so removing a site from the
   * list never quietly throws away the thing the browser exists to keep.
   */
  ipcMain.handle(
    'internal:forget-visit',
    fromInternalPage((urls: string[]) => {
      for (const url of urls) forgetVisit(url)
      return urls.length
    })
  )
  ipcMain.handle(
    'internal:forget-history',
    fromInternalPage(() => clearHistoryOnly())
  )
  ipcMain.handle(
    'internal:history',
    fromInternalPage((query: string, limit: number, offset: number) => ({
      rows: historyPage(query ?? '', Math.min(limit || 200, 500), Math.max(0, offset || 0)),
      total: historyCount(query ?? '')
    }))
  )
  ipcMain.handle(
    'internal:forget-all',
    fromInternalPage((alsoCookies: boolean) => {
      clearAllHistory()
      if (alsoCookies) {
        for (const partition of ALL_PARTITIONS) {
          void session.fromPartition(partition).clearStorageData({
            storages: ['cookies', 'localstorage', 'indexdb', 'cachestorage', 'serviceworkers']
          })
        }
      }
    })
  )
  ipcMain.handle('internal:import-scan', fromInternalPage(() => scanForProfiles()))
  ipcMain.handle(
    'internal:import-run',
    fromInternalPage(
      async (
        id: string,
        what: { bookmarks: boolean; history: boolean; searches: boolean; cookies?: boolean }
      ) => {
        // Only a profile the scan found can be read: the path comes from there,
        // never from whatever the page passes in.
        if (!scanForProfiles().some((source) => source.id === id)) return null

        const payload = readProfile(id)
        const result = importProfile({
          bookmarks: what.bookmarks ? payload.bookmarks : [],
          history: what.history ? payload.history : [],
          searches: what.searches ? payload.searches : []
        })
        if (what.cookies) result.cookies = await importFirefoxCookies(id, session.fromPartition(PARTITION))
        bookmarksChanged()
        return result
      }
    )
  )
  ipcMain.handle('internal:settings-get', fromInternalPage(() => getSettings()))
  ipcMain.handle(
    'internal:settings-set',
    fromInternalPage((key: keyof Settings, value: Settings[keyof Settings]) =>
      broadcastSettings(setSetting(key, value))
    )
  )
  ipcMain.handle('internal:settings-reset', fromInternalPage(() => broadcastSettings(resetSettings())))

  ipcMain.handle('internal:languages', fromInternalPage(() => listLanguages()))
  ipcMain.handle(
    'internal:language-add',
    fromInternalPage((code: string, name: string) =>
      addLanguage(String(code ?? ''), String(name ?? ''))
    )
  )
  ipcMain.handle(
    'internal:language-remove',
    fromInternalPage((code: string) => {
      removeLanguage(String(code ?? ''))
      // Fall back to English if the language just removed was the one in use.
      if (getSettings().language === code) broadcastSettings(setSetting('language', 'en'))
    })
  )

  // Internal pages run in a session that refuses every permission, clipboard
  // included, so navigator.clipboard rejects there. Copying through the main
  // process works and, unlike the old fire-and-forget call, can report failure.
  ipcMain.handle(
    'internal:copy-text',
    fromInternalPage((text: string) => {
      if (typeof text !== 'string' || text === '') return false
      clipboard.writeText(text)
      return true
    })
  )

  // Almost nothing needs this — settings apply live — but a restart is the
  // honest answer when something has genuinely wedged.
  ipcMain.handle(
    'internal:restart',
    fromInternalPage(() => {
      app.relaunch()
      app.exit(0)
    })
  )
  // --- updates ---------------------------------------------------------------

  ipcMain.handle('internal:default-browser', fromInternalPage(() => isDefaultBrowser()))
  ipcMain.handle('internal:make-default', fromInternalPage(() => requestDefaultBrowser()))

  ipcMain.handle('internal:changelog', fromInternalPage(() => latestChanges()))
  ipcMain.handle('internal:update-state', fromInternalPage(() => updateState()))
  ipcMain.handle('internal:update-check', fromInternalPage(() => check(true)))
  ipcMain.handle('internal:update-download', fromInternalPage(() => download()))
  ipcMain.handle('internal:update-install', fromInternalPage(() => installNow()))

  // Picking a wallpaper or folder goes through the OS dialog, so the page never
  // sees a path it did not get from the user.
  ipcMain.handle('internal:pick-image', async (event: Electron.IpcMainInvokeEvent) => {
    if (!isInternalUrl(event.senderFrame?.url)) return null
    const result = await dialog.showOpenDialog({
      title: 'Choose a wallpaper',
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'bmp'] }]
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  ipcMain.handle('internal:pick-folder', async (event: Electron.IpcMainInvokeEvent) => {
    if (!isInternalUrl(event.senderFrame?.url)) return null
    const result = await dialog.showOpenDialog({
      title: 'Choose a wallpaper folder',
      properties: ['openDirectory']
    })
    if (result.canceled || !result.filePaths[0]) return null
    return { folder: result.filePaths[0], count: listImages(result.filePaths[0]).length }
  })

  // Translations: read the catalogue, write one string at a time, move files.
  ipcMain.handle('internal:messages', fromInternalPage((language: string) => messagesFor(language)))
  ipcMain.handle(
    'internal:locale-entries',
    fromInternalPage((language: string) => localeEntries(language))
  )
  ipcMain.handle(
    'internal:set-message',
    fromInternalPage((language: string, key: string, value: string) => {
      setMessage(language, key, value)
      // Every open page should pick up the new wording.
      broadcastSettings(getSettings())
    })
  )
  ipcMain.handle('internal:locale-export', fromInternalPage((language: string) => exportLocale(language)))
  ipcMain.handle('internal:locale-import', fromInternalPage((language: string) => importLocale(language)))

  ipcMain.handle('internal:bookmarks', fromInternalPage(() => listBookmarks()))
  ipcMain.handle(
    'internal:bookmark-remove',
    fromInternalPage((url: string) => {
      removeBookmark(url)
      bookmarksChanged()
    })
  )
  ipcMain.handle(
    'internal:bookmark-update',
    fromInternalPage((url: string, changes: { title?: string; folder?: string }) => {
      updateBookmark(url, changes)
      bookmarksChanged()
    })
  )
  ipcMain.handle('internal:bookmark-folders', fromInternalPage(() => bookmarkFolders()))
  ipcMain.handle(
    'internal:folder-create',
    fromInternalPage((path: string) => {
      const made = createBookmarkFolder(path)
      bookmarksChanged()
      return made
    })
  )
  ipcMain.handle(
    'internal:folder-rename',
    fromInternalPage((from: string, to: string) => {
      renameBookmarkFolder(from, to)
      bookmarksChanged()
    })
  )
  ipcMain.handle(
    'internal:folder-delete',
    fromInternalPage((path: string, withBookmarks: boolean) => {
      const count = deleteBookmarkFolder(path, withBookmarks)
      bookmarksChanged()
      return count
    })
  )
  ipcMain.handle('internal:bookmarks-export', fromInternalPage(() => exportBookmarks()))
  ipcMain.handle('internal:permissions', fromInternalPage(() => listSitePermissions()))
  ipcMain.handle(
    'internal:permission-forget',
    fromInternalPage((origin: string, permission: string) => setSitePermission(origin, permission, null))
  )
  ipcMain.handle('internal:sidebar-close', (event: Electron.IpcMainInvokeEvent) => {
    if (!isInternalUrl(event.senderFrame?.url)) return
    const shell = shellOwningSidebar(event.sender.id)
    if (shell) toggleSidebar(shell, false)
  })

  ipcMain.handle('internal:update-lists', fromInternalPage(() => updateFilterLists()))
  ipcMain.handle('internal:lists-updated', fromInternalPage(() => listsUpdatedAt()))

  ipcMain.handle('internal:never-list', fromInternalPage(() => listNeverRemember()))
  ipcMain.handle(
    'internal:never-add',
    fromInternalPage((domain: string) => addNeverRemember(domain))
  )
  ipcMain.handle(
    'internal:never-remove',
    fromInternalPage((domain: string) => removeNeverRemember(domain))
  )
  ipcMain.handle(
    'internal:forget-site',
    fromInternalPage((domain: string) => forgetSite(domain))
  )
  ipcMain.handle('internal:open', (event: Electron.IpcMainInvokeEvent, url: string, newTab?: boolean) => {
    if (!isInternalUrl(event.senderFrame?.url)) return
    const shell = shellFor(event)
    if (!shell) return
    if (newTab) shell.tabs.createTab(normalizeInput(url))
    else shell.tabs.navigate(url)
  })
}

function registerIpc(): void {
  registerInternalIpc()

  registerPasswordIpc({
    chromeFor: (tab) => shellOwningTab(tab.id)?.chrome.webContents ?? null,
    activeTabFor: (chrome) => shells.get(chrome.id)?.tabs.activeWebContents() ?? null,
    allChromes: () => [...shells.values()].map((shell) => shell.chrome.webContents)
  })
  registerVaultPageIpc((url) => isInternalUrl(url) && (url ?? '').startsWith(PASSWORDS_URL))
  registerAudioFxIpc({
    activeTabFor: (chrome) => shells.get(chrome.id)?.tabs.activeWebContents() ?? null,
    chromeFor: (tab) => shellOwningTab(tab.id)?.chrome.webContents ?? null
  })

  // Every handler below acts on the window that sent the call. Resolving the
  // window per call is what keeps a second window from hijacking the first.
  ipcMain.handle('tab:create', (e, url?: string) => shellFor(e)?.tabs.createTab(url))
  ipcMain.handle('tab:create-at', (e, url: string, index: number) =>
    shellFor(e)?.tabs.createTab(url, { index, activate: true })
  )
  ipcMain.handle('tab:amnesia', (e) =>
    shellFor(e)?.tabs.createTab(HOME_URL, { amnesia: true })
  )
  ipcMain.handle('tab:close', (e, id: number) => shellFor(e)?.tabs.closeTab(id))
  ipcMain.handle('tab:activate', (e, id: number) => shellFor(e)?.tabs.activate(id))
  ipcMain.handle('tab:move', (e, id: number, toIndex: number) =>
    shellFor(e)?.tabs.moveTab(id, toIndex)
  )
  ipcMain.handle('tab:drag-hover', (e, x: number, y: number) => {
    const shell = shellFor(e)
    if (shell) showTabHover(shell, x, y)
  })
  ipcMain.handle('tab:drop-index', (e, index: number) => {
    const shell = shells.get(e.sender.id)
    if (shell) shell.dropIndex = index
  })
  ipcMain.handle('tab:drop', (e, id: number, x: number, y: number) => {
    const shell = shellFor(e)
    return shell ? dropTab(shell, id, x, y) : false
  })
  ipcMain.handle('tab:closed-list', (e) => shellFor(e)?.tabs.closedTabs() ?? [])
  ipcMain.handle('tab:reopen', (e, id?: number) => shellFor(e)?.tabs.reopenClosed(id) ?? false)
  // --- pinning and groups ---------------------------------------------------

  ipcMain.handle('tab:sleep', (e, id: number) => shellFor(e)?.tabs.sleepTab(id))
  ipcMain.handle('tab:wake', (e, id: number) => shellFor(e)?.tabs.wakeTab(id))

  /**
   * Reader mode. The article is extracted from the page and held here, then
   * the tab is sent to ie2://reader, which asks for it. Passing it through the
   * URL or through the page itself would mean trusting page-authored content
   * on a page that has the internal API.
   */
  /**
   * Find in page.
   *
   * Chromium does the searching and highlighting; this only drives it and
   * relays the counts. The result arrives on an event rather than as a return
   * value, and keeps arriving as the search refines, so the listener is
   * attached once per page and left alone.
   */
  ipcMain.handle(
    'page:find',
    (e, text: string, options?: { forward?: boolean; findNext?: boolean }) => {
      const shell = shellFor(e)
      const wc = shell?.tabs.activeWebContents()
      if (!shell || !wc) return false

      if (!text) {
        wc.stopFindInPage('clearSelection')
        return false
      }

      if (!findWired.has(wc)) {
        findWired.add(wc)
        wc.on('found-in-page', (_event, result) => {
          if (shell.chrome.webContents.isDestroyed()) return
          shell.chrome.webContents.send('browser:find-result', {
            matches: result.matches,
            active: result.activeMatchOrdinal
          })
        })
      }

      wc.findInPage(text, {
        forward: options?.forward ?? true,
        findNext: options?.findNext ?? false,
        matchCase: false
      })

      return true
    }
  )

  ipcMain.handle('page:find-stop', (e) => {
    shellFor(e)?.tabs.activeWebContents()?.stopFindInPage('clearSelection')
  })

  ipcMain.handle('page:reader', async (e) => {
    const shell = shellFor(e)
    const wc = shell?.tabs.activeWebContents()
    if (!shell || !wc) return false

    // Already reading? The button goes back to the page it came from.
    const article = readerArticles.get(wc.id)
    if (wc.getURL().startsWith(READER_URL)) {
      if (article) wc.loadURL(article.url)
      return true
    }

    const found = await extractArticle(wc)
    if (!found) return false

    // Kept against the tab's own webContents id, so the reader page can ask
    // for its own article and get nothing if some other page asks.
    readerArticles.set(wc.id, found)
    wc.loadURL(READER_URL)
    return true
  })

  ipcMain.handle('internal:reader-article', (event: Electron.IpcMainInvokeEvent) => {
    if (!isInternalUrl(event.senderFrame?.url)) return null
    return readerArticles.get(event.sender.id) ?? null
  })

  ipcMain.handle('tab:navigate', (e, id: number, url: string) =>
    shellFor(e)?.tabs.navigateTab(id, url)
  )

  ipcMain.handle('tab:pin', (e, ids: number[], pinned: boolean) =>
    shellFor(e)?.tabs.setPinned(ids, pinned)
  )
  ipcMain.handle('tab:group-create', (e, ids: number[], name?: string) =>
    shellFor(e)?.tabs.createGroup(ids, name ?? '')
  )
  ipcMain.handle('tab:group-add', (e, ids: number[], groupId: number) =>
    shellFor(e)?.tabs.addToGroup(ids, groupId)
  )
  ipcMain.handle('tab:group-remove', (e, ids: number[]) => shellFor(e)?.tabs.removeFromGroup(ids))
  ipcMain.handle(
    'tab:group-update',
    (e, groupId: number, changes: { name?: string; colour?: TabGroupColour; collapsed?: boolean }) =>
      shellFor(e)?.tabs.updateGroup(groupId, changes)
  )
  ipcMain.handle('tab:group-ungroup', (e, groupId: number) => shellFor(e)?.tabs.ungroup(groupId))
  ipcMain.handle('tab:group-close', (e, groupId: number) => shellFor(e)?.tabs.closeGroup(groupId))
  ipcMain.handle('tab:group-new-tab', (e, groupId: number) =>
    shellFor(e)?.tabs.newTabInGroup(groupId)
  )

  // `selected` carries every tab the user has ctrl-clicked, so the menu can act
  // on all of them at once rather than only the one under the pointer.
  ipcMain.handle('tab:menu', (e, id: number, selected: number[] = []) => {
    const shell = shellFor(e)
    if (shell) showTabMenu(shell.tabs, id, selected)
  })

  ipcMain.handle('nav:go', (e, input: string) => shellFor(e)?.tabs.navigate(input))
  ipcMain.handle('nav:back', (e) => shellFor(e)?.tabs.goBack())
  ipcMain.handle('nav:forward', (e) => shellFor(e)?.tabs.goForward())
  ipcMain.handle('nav:reload', (e) => shellFor(e)?.tabs.reload())
  ipcMain.handle('nav:stop', (e) => shellFor(e)?.tabs.stop())

  ipcMain.handle('view:compat', (e) => shellFor(e)?.tabs.toggleCompat())
  ipcMain.handle('view:devtools', (e) => shellFor(e)?.tabs.toggleDevTools())
  ipcMain.handle('view:dropdown', (e, px: number) => {
    const shell = shellFor(e)
    if (shell) setDropdownHeight(shell, px)
  })

  ipcMain.handle('browser:state', (e) => {
    const shell = shellFor(e)
    return shell ? withAdblock(shell, shell.tabs.state()) : null
  })

  // Blocking is process-wide, so its state has to reach every open window.
  ipcMain.handle('adblock:toggle', () => {
    toggleAdblock()
    pushStateEverywhere()
  })
  ipcMain.handle('adblock:status', (e) =>
    adblockStats(shellFor(e)?.tabs.activeWebContentsId() ?? null)
  )

  // Blocking off for one site only, for the pages that filter lists break.
  ipcMain.handle('adblock:toggle-site', (e) => {
    const shell = shellFor(e)
    const wc = shell?.tabs.activeWebContents()
    if (!shell || !wc) return false

    const off = toggleSiteBlocking(wc.getURL())
    wc.reload()
    pushStateEverywhere()
    return off
  })

  ipcMain.handle('download:cancel', (_e, id: number) => cancelDownload(id))
  ipcMain.handle('download:reveal', (_e, id: number) => revealDownload(id))
  ipcMain.handle('download:clear', () => clearFinishedDownloads())
  ipcMain.handle('download:list', () => listDownloads())

  ipcMain.handle('settings:get', () => getSettings())
  ipcMain.handle('settings:set', (_e, key: keyof Settings, value: Settings[keyof Settings]) =>
    broadcastSettings(setSetting(key, value))
  )
  ipcMain.handle('settings:reset', () => broadcastSettings(resetSettings()))

  ipcMain.handle('app:install', async (e) => {
    const entry = shellFor(e)?.tabs.activeInstallable()
    if (!entry) return null
    try {
      const shortcut = await installApp(entry)
      return { name: entry.name, shortcut }
    } catch (error) {
      console.error('install failed', error)
      return null
    }
  })

  ipcMain.handle('bookmark:edit', (e) => {
    const shell = shellFor(e)
    return shell ? bookmarkActiveTab(shell) : null
  })
  ipcMain.handle('bookmark:save', (_e, url: string, changes: { title?: string; folder?: string }) => {
    updateBookmark(url, changes)
    bookmarksChanged()
  })
  ipcMain.handle('bookmark:remove', (_e, url: string) => {
    removeBookmark(url)
    bookmarksChanged()
  })
  ipcMain.handle('bookmark:folders', () => bookmarkFolders())
  ipcMain.handle('net:public-ip', () => publicIp())
  ipcMain.handle('permission:answer', (_e, id: number, allow: boolean, remember: boolean) =>
    answerPermission(id, allow, remember)
  )
  ipcMain.handle('permission:pending', () => pendingPermissions())
  ipcMain.handle('permission:site', (_e, origin: string) => listSitePermissions(origin))
  ipcMain.handle('permission:set', (_e, origin: string, permission: string, allow: boolean | null) =>
    setSitePermission(origin, permission, allow)
  )
  ipcMain.handle('sidebar:toggle', (e) => {
    const shell = shellFor(e)
    if (shell) toggleSidebar(shell)
  })
  ipcMain.handle('bookmark:toggle', (e) => {
    const shell = shellFor(e)
    if (shell) toggleBookmarkForActiveTab(shell)
  })
  ipcMain.handle('bookmark:list', () => listBookmarks())

  ipcMain.handle('omni:suggest', (e, input: string) => {
    // The engine's autocomplete is chased separately and delivered when it
    // arrives, so a network round trip never delays the local results.
    const sender = e.sender

    void engineSuggestions(input).then((extra) => {
      if (extra.length === 0 || sender.isDestroyed()) return
      // Tagged with the query it answers: the renderer drops it if the user has
      // typed on since.
      sender.send('omni:suggestions-extra', { query: input, items: extra })
    })

    return buildSuggestions(input)
  })
  ipcMain.handle('nav:home', (e) => shellFor(e)?.tabs.navigate(getSettings().homePage))
  ipcMain.handle('page:screenshot', async (e) => {
    const shell = shellFor(e)
    if (!shell) return null
    const wc = shell.tabs.activeWebContents()
    return wc ? captureVisible(wc) : null
  })
  ipcMain.handle('page:screenshot-save', () => saveLastCapture())
  // The QR image is produced in the renderer; saving it is the main process's
  // job because only it can open a dialog and touch the disk.
  ipcMain.handle('page:save-qr', async (e, dataUrl: string, host: string) => {
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png;base64,')) return null

    const result = await dialog.showSaveDialog({
      title: 'Save QR code',
      defaultPath: join(app.getPath('downloads'), `ie2-qr-${host || 'page'}.png`),
      filters: [{ name: 'PNG image', extensions: ['png'] }]
    })
    if (result.canceled || !result.filePath) return null

    try {
      await writeFile(result.filePath, Buffer.from(dataUrl.split(',')[1], 'base64'))
      return result.filePath
    } catch {
      return null
    }
  })

  ipcMain.handle('page:media', async (e) => {
    const wc = shellFor(e)?.tabs.activeWebContents()
    return wc ? readMedia(wc) : null
  })
  ipcMain.handle('page:media-control', async (e, action: string) => {
    const wc = shellFor(e)?.tabs.activeWebContents()
    return wc ? controlMedia(wc, action) : false
  })
  ipcMain.handle('tab:split', (e, id: number | null) => shellFor(e)?.tabs.toggleSplitWith(id))
  ipcMain.handle('tab:split-toggle', (e) => shellFor(e)?.tabs.splitWithNeighbour())
  ipcMain.handle('tab:split-adjust', (e, delta: number) => shellFor(e)?.tabs.adjustSplit(delta))
  ipcMain.handle('page:pip', async (e) => {
    const shell = shellFor(e)
    if (!shell) return 'unavailable'
    const wc = shell.tabs.activeWebContents()
    return wc ? togglePictureInPicture(wc) : 'unavailable'
  })
  ipcMain.handle('page:copy-link', (e) => {
    const url = shellFor(e)?.tabs.activeUrl()
    if (!url) return null
    clipboard.writeText(url)
    return url
  })
  ipcMain.handle('history:recent', (_e, limit?: number) => recentHistory(limit))
  ipcMain.handle('history:forget', (_e, url: string) => forgetUrl(url))
  ipcMain.handle('history:clear', () => clearAllHistory())

}

// When the app is started from a terminal whose pipe is later closed, any
// write to stdout raises EPIPE, which Electron reports as a fatal main-process
// exception. Logging must never be able to take the browser down.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EPIPE') console.error('stream error', error)
  })
}

// Must run before the app is ready.
registerInternalScheme()

app.setAppUserModelId(APP_USER_MODEL_ID)

/**
 * One browser, however many links are clicked.
 *
 * As the default browser, Windows launches the executable again for every link
 * opened from another program. Without this lock each one would start a
 * complete second browser — its own windows, its own 120 MB, and two processes
 * writing to the same database. The second instance hands its URL to the first
 * and exits.
 */
if (!app.requestSingleInstanceLock()) {
  app.exit(0)
} else {
  app.on('second-instance', (_event, argv) => {
    // An installed app's shortcut, clicked while the browser is open.
    const single = appModeUrl(argv)
    if (single) {
      createAppWindow(single)
      return
    }

    const url = openableFromArgv(argv)
    const shell = focusedShell()

    if (!shell) {
      createWindow(url ?? undefined)
      return
    }

    if (url) shell.tabs.createTab(url)
    if (shell.window.isMinimized()) shell.window.restore()
    shell.window.focus()
  })
}

app.whenReady().then(() => {
  // No File / Edit / View menu bar. Clipboard and text-editing shortcuts are
  // handled by Chromium inside web contents, so nothing useful is lost.
  Menu.setApplicationMenu(null)

  initDb()
  loadSettings()
  handleInternalProtocol(ALL_PARTITIONS)
  initPermissions((contents, request) => {
    const shell = shellOwningTab(contents.id)
    if (!shell || shell.chrome.webContents.isDestroyed()) return false
    shell.chrome.webContents.send('browser:permission-request', request)
    return true
  })

  registerIpc()
  initDownloads(pushStateEverywhere)

  // Installed web app? Open just that window. Everything else is still set up,
  // because this process is now the browser too: opening IE2 while the app is
  // running lands here, and has to get a working browser window.
  const singleSite = appModeUrl(process.argv)
  if (singleSite) {
    createAppWindow(singleSite)
  } else {
    // Opened by Windows with a link or a file? Start on that rather than the
    // new tab page. This is what being the default browser actually means.
    const opened = openableFromArgv(process.argv)
    createWindow(opened ?? undefined)
  }

  // Filter lists load in the background; the window does not wait on them.
  void initAdblock().then(pushStateEverywhere)

  // Updates report themselves as they progress. The Settings page is a *tab*,
  // not the chrome view, so sending only to chrome left the button with no way
  // to show that anything was happening.
  onUpdateState((state) => {
    for (const contents of webContents.getAllWebContents()) {
      if (contents.isDestroyed()) continue
      if (!isInternalUrl(contents.getURL()) && !shells.has(contents.id)) continue
      contents.send('update:state', state)
    }
  })
  initUpdater()

  // Blocked-request counts are batched, so flush periodically as well.
  setInterval(flush, 60_000)

  app.on('activate', () => {
    if (BaseWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

/**
 * Set once the app has started quitting, so nothing writes to the database
 * after it is closed.
 */
let quitting = false

app.on('before-quit', () => {
  // Closing the last window saves the session on the way out, and only then
  // does the app quit. A quit the app starts itself — restarting to install an
  // update — runs the other way round: this fires first, while every window is
  // still open, and closes the database before any of them get to save. The
  // tabs would be gone after the update. So the session is saved here, from the
  // window last in use, before anything is shut.
  if (!quitting) {
    const shell = focusedShell()
    if (shell) {
      const snapshot = shell.tabs.snapshot()
      saveSession(snapshot.tabs, snapshot.activeIndex, snapshot.groups)
    }
  }

  quitting = true
  flush()
  closeDb()
})
