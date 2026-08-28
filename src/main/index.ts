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
  CHROME_HEIGHT,
  DROPDOWN_MAX_HEIGHT,
  HOME_URL,
  READER_URL,
  TITLEBAR_HEIGHT,
  type BrowserState,
  type ReaderArticle,
  type TabsState
} from '../shared/types'
import { TabManager, lockDownSession, type Shortcut } from './tabs'
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
import { appIconPath, appUserModelIdFor, installApp } from './pwa'
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { showTabMenu } from './menus'
import { captureVisible, saveLastCapture } from './screenshot'
import { togglePictureInPicture } from './pip'
import { controlMedia, readMedia } from './media'
import { readProfile, scanForProfiles } from './import'
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
  return shells.get(event.sender.id) ?? shellOwningTab(event.sender.id) ?? focusedShell()
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

function createWindow(startUrl?: string): void {
  const win = new BaseWindow({
    width: 1280,
    height: 820,
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
    dropdownHeight: 0
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

  layoutChrome(shell)
  win.on('resize', () => layoutChrome(shell))

  if (process.env['ELECTRON_RENDERER_URL']) {
    chromeView.webContents.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    chromeView.webContents.loadFile(join(__dirname, '../renderer/index.html'))
  }

  chromeView.webContents.once('did-finish-load', () =>
    startUrl ? shell.tabs.createTab(startUrl) : restoreSession(shell)
  )

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
    if (shells.size !== 1) return
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

function createAppWindow(url: string): void {
  const host = new URL(url).hostname

  // This process serves one installed app, so it takes that app's identity:
  // its own taskbar button, its own icon, no grouping with the browser.
  app.setAppUserModelId(appUserModelIdFor(host))

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
      toggleBookmarkForActiveTab(shell)
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
  shell.tabs.refresh()
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
    settings: getSettings()
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

function layoutChrome(shell: Shell): void {
  const { width, height } = shell.window.getContentBounds()
  const wanted = CHROME_HEIGHT + shell.dropdownHeight
  shell.chrome.setBounds({ x: 0, y: 0, width, height: Math.min(wanted, height) })
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
    fromInternalPage((id: string, what: { bookmarks: boolean; history: boolean; searches: boolean }) => {
      const payload = readProfile(id)
      return importProfile({
        bookmarks: what.bookmarks ? payload.bookmarks : [],
        history: what.history ? payload.history : [],
        searches: what.searches ? payload.searches : []
      })
    })
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
  ipcMain.handle('internal:update-check', fromInternalPage(() => check()))
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
      pushStateEverywhere()
    })
  )

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
  ipcMain.handle('internal:open', (event: Electron.IpcMainInvokeEvent, url: string) => {
    if (!isInternalUrl(event.senderFrame?.url)) return
    shellFor(event)?.tabs.navigate(url)
  })
}

function registerIpc(): void {
  registerInternalIpc()

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
  ipcMain.handle('tab:detach', (e, id: number) => shellFor(e)?.tabs.detachTab(id) ?? false)
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

app.setAppUserModelId('com.internetexplorer2.browser')

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
  lockDownSession()

  // Installed web app? Open just that, and skip the browser chrome entirely.
  const singleSite = appModeUrl(process.argv)
  if (singleSite) {
    createAppWindow(singleSite)
    void initAdblock()
    return
  }

  registerIpc()
  initDownloads(pushStateEverywhere)

  // Opened by Windows with a link or a file? Start on that rather than the
  // new tab page. This is what being the default browser actually means.
  const opened = openableFromArgv(process.argv)
  createWindow(opened ?? undefined)

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

app.on('before-quit', () => {
  flush()
  closeDb()
})
