import { BaseWindow, WebContentsView, shell, session } from 'electron'
import { join } from 'node:path'
import {
  CHROME_HEIGHT,
  HOME_URL,
  type ClosedTab,
  type InstallableApp,
  type TabGroup,
  type TabsState,
  type TabState
} from '../shared/types'
import { isAllowedUrl, normalizeInput } from './url'
import { nextGroupColour, type TabGroupColour } from '../shared/groups'
import { ALL_PARTITIONS, AMNESIA_PARTITION, PARTITION } from './partitions'
import { forgetTabBlocked, resetTabBlocked } from './adblock'
import { capturePageText, shouldIndex } from './capture'
import { detectInstallable } from './pwa'
import { attachContextMenu } from './menus'
import { getSettings } from './settings'
import {
  indexPageText,
  isBookmarked,
  recordVisit,
  updateFavicon,
  updateTitle
} from './db'


/** Compatibility Mode, in the only sense that word ever meant anything. */
const IE6_UA = 'Mozilla/4.0 (compatible; MSIE 6.0; Windows NT 5.1; .NET CLR 1.1.4322)'

/**
 * Period-accurate typography, applied over whatever the site intended. The user
 * asked for Compatibility Mode; this is what compatibility looked like.
 */
const IE6_CSS = `
  *, *::before, *::after {
    font-family: "Comic Sans MS", "Times New Roman", cursive, serif !important;
    letter-spacing: 0 !important;
  }
  a { color: #0000ee !important; text-decoration: underline !important; }
  a:visited { color: #551a8b !important; }
  button, input[type="button"], input[type="submit"] {
    border: 2px outset buttonface !important;
    border-radius: 0 !important;
    background: #d4d0c8 !important;
    color: #000 !important;
  }
  img { image-rendering: pixelated !important; }
`

/** Matches the browser's own scrollbars, for pages that ask for the default. */
const PAGE_SCROLLBAR_CSS = `
  ::-webkit-scrollbar { width: 11px; height: 11px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb {
    border: 3px solid transparent;
    border-radius: 8px;
    background: rgba(140, 140, 150, 0.45);
    background-clip: content-box;
  }
  ::-webkit-scrollbar-thumb:hover { background: rgba(160, 160, 172, 0.75); background-clip: content-box; }
  ::-webkit-scrollbar-corner { background: transparent; }
`

/**
 * How long a new tab keeps its claim on the caret. Long enough to outlast the
 * page load that would steal it, short enough that a click a moment later is
 * still read as the user choosing the page.
 */
const OMNIBOX_GRACE_MS = 2500

interface Tab {
  id: number
  view: WebContentsView
  favicon: string | null
  amnesia: boolean
  compat: boolean
  compatKey: string | null
  installable: InstallableApp | null
  /**
   * A new tab should leave the caret in the omnibox. Focus has to be re-taken
   * once the page finishes loading, because Chromium focuses the document at
   * that point and would otherwise steal it back.
   */
  wantsOmnibox: boolean
  /** Pinned tabs live at the front of the strip and outlive the session. */
  pinned: boolean
  /**
   * Asleep: the page has been thrown away and only its address, title and
   * favicon are kept. Waking reloads it. This is the only way to actually give
   * the memory back — a background page that is merely throttled still holds
   * its entire DOM and JavaScript heap.
   */
  asleep: boolean
  /** What to reload, and what to show in the strip, while asleep. */
  sleepingUrl: string
  sleepingTitle: string
  /**
   * The tab's whole navigation history, kept across sleep so waking restores
   * where it had been rather than starting over at the current page.
   */
  sleepingEntries: Electron.NavigationEntry[]
  /** Which entry was in view. */
  sleepingIndex: number
  /** When this tab was last looked at, for deciding what has gone stale. */
  lastActiveAt: number
  /** Group membership, or null. A pinned tab is never in a group. */
  groupId: number | null
  /**
   * Until this moment, a page taking focus is assumed to be Chromium doing it
   * on load rather than the user clicking, and the omnibox takes it back. After
   * it, focus landing on the page means the user put it there and the claim is
   * dropped. Without the distinction the load-time steal cancels the claim and
   * the caret ends up in the page on every new tab.
   */
  omniboxGraceUntil: number
}

export interface TabOptions {
  activate?: boolean
  amnesia?: boolean
  /** Where to put the tab in the strip. Appended when not given. */
  index?: number
  pinned?: boolean
  groupId?: number | null
}

export type Shortcut =
  | 'new-tab'
  | 'close-tab'
  | 'amnesia-tab'
  | 'focus-omnibox'
  | 'reload'
  | 'bookmark'
  | 'back'
  | 'forward'
  | 'devtools'
  | 'reopen-tab'
  | 'palette'
  | 'screenshot'
  | 'pip'
  | 'split'
  | 'group-new-tab'
  | 'group-close'

/**
 * Once a tab is focused, key presses go to the page, not to our chrome UI — so
 * browser shortcuts have to be recognised in the main process, before the page
 * sees them. Returns the action to run, or null to let the page have the key.
 */
function shortcutFor(input: Electron.Input): Shortcut | null {
  if (input.type !== 'keyDown') return null

  const key = input.key.toLowerCase()

  if (input.alt && !input.control && !input.meta) {
    if (input.key === 'ArrowLeft') return 'back'
    if (input.key === 'ArrowRight') return 'forward'
    // Shift+Alt on the active tab's group, as the group panel advertises.
    if (input.shift && key === 'c') return 'group-new-tab'
    if (input.shift && key === 'w') return 'group-close'
    return null
  }

  if (input.key === 'F12') return 'devtools'
  if (!input.control && !input.meta) return null

  if (input.shift) {
    if (key === 'n') return 'amnesia-tab'
    if (key === 't') return 'reopen-tab'
    if (key === 'p') return 'palette'
    if (key === 's') return 'screenshot'
    if (key === 'i') return 'pip'
    if (key === 'e') return 'split'
    return null
  }

  switch (key) {
    case 't':
      return 'new-tab'
    case 'w':
      return 'close-tab'
    case 'l':
      return 'focus-omnibox'
    case 'r':
      return 'reload'
    case 'd':
      return 'bookmark'
    case 'k':
      return 'palette'
    default:
      return null
  }
}

/**
 * Owns every tab in one window: creation, destruction, layout, history
 * recording and the state snapshot pushed to the chrome UI.
 *
 * Web content lives in its own WebContentsView with no preload and no Node,
 * fully separate from the chrome renderer. Nothing a page does can reach the
 * browser UI or the main process except through the handlers below.
 */
/** How many closed tabs stay reopenable. */
const CLOSED_HISTORY = 25

export class TabManager {
  private tabs: Tab[] = []
  private activeId: number | null = null
  private nextId = 1

  /** Most recently closed first. Amnesia tabs are never recorded. */
  private closed: ClosedTab[] = []

  /**
   * Split view: a second tab shown beside the active one. The active tab is
   * always the left pane, so switching tabs changes the left side and leaves
   * the companion in place.
   */
  private splitId: number | null = null

  /** Share of the width given to the left pane. */
  private splitRatio = 0.5

  /** Tab groups, keyed by id. Strip order is derived from the tabs themselves. */
  private groups = new Map<number, TabGroup>()
  private nextGroupId = 1

  constructor(
    private window: BaseWindow,
    private onUpdate: (state: TabsState) => void,
    /** Called after a tab view is added, so the chrome can be kept on top. */
    private raiseChrome: () => void,
    /** Keyboard shortcuts caught inside page content — see `wireShortcuts`. */
    private onShortcut: (action: Shortcut) => void,
    /** Opens a URL in a separate browser window. */
    private onOpenWindow: (url: string) => void
  ) {
    this.window.on('resize', () => this.layout())
  }

  createTab(url: string = HOME_URL, options: TabOptions = {}): number {
    const { activate = true, amnesia = false } = options

    const view = new WebContentsView({
      webPreferences: {
        partition: amnesia ? AMNESIA_PARTITION : PARTITION,
        // Exposes an API to our own ie2:// pages only, and nothing to the web.
        preload: join(__dirname, '../preload/internal.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false,
        webSecurity: true
      }
    })

    const tab: Tab = {
      id: this.nextId++,
      view,
      favicon: null,
      amnesia,
      compat: false,
      compatKey: null,
      installable: null,
      wantsOmnibox: activate && url === HOME_URL,
      omniboxGraceUntil: Date.now() + OMNIBOX_GRACE_MS,
      pinned: options.pinned ?? false,
      groupId: options.groupId ?? null,
      asleep: false,
      sleepingUrl: '',
      sleepingTitle: '',
      sleepingEntries: [],
      sleepingIndex: 0,
      lastActiveAt: Date.now()
    }
    // A link dropped between two tabs opens where it was dropped.
    if (options.index === undefined) this.tabs.push(tab)
    else this.tabs.splice(Math.max(0, Math.min(options.index, this.tabs.length)), 0, tab)

    this.normalise()

    this.wire(tab)
    attachContextMenu(view.webContents, () => this, amnesia)

    this.window.contentView.addChildView(view)
    this.raiseChrome()
    view.setVisible(false)
    view.webContents.loadURL(url)

    // A brand new tab has nothing to read, so the caret belongs in the omnibox
    // rather than in the page.
    if (activate) this.activate(tab.id, { focusPage: !tab.wantsOmnibox })
    else this.layout()

    if (tab.wantsOmnibox) {
      this.onShortcut('focus-omnibox')
      // The claim expires on its own, so a tab returned to much later focuses
      // its page like any other.
      setTimeout(() => (tab.wantsOmnibox = false), OMNIBOX_GRACE_MS)
    }

    this.emit()
    return tab.id
  }

  /**
   * Compatibility Mode: spoof an MSIE 6.0 user agent and reload, so the site
   * serves whatever it keeps in the cupboard for ancient browsers, then apply
   * period typography on top. Genuinely useful for testing. Mostly not.
   */
  toggleCompat(): void {
    const tab = this.active()
    if (!tab) return

    const wc = tab.view.webContents
    tab.compat = !tab.compat
    tab.compatKey = null

    // Inserted CSS does not survive a navigation; `wire` reapplies it on load.
    wc.setUserAgent(tab.compat ? IE6_UA : wc.session.getUserAgent())
    wc.reload()
    this.emit()
  }

  closeTab(id: number): void {
    const index = this.tabs.findIndex((t) => t.id === id)
    if (index === -1) return

    // Closing the last tab leaves an empty window, so open the replacement
    // first and let the close proceed normally against it.
    if (this.tabs.length === 1) this.createTab(HOME_URL, { activate: false })

    // Closing either pane ends the split rather than leaving a gap.
    if (this.splitId === id) this.splitId = null

    const [tab] = this.tabs.splice(index, 1)
    this.rememberClosed(tab)
    forgetTabBlocked(tab.view.webContents.id)
    this.window.contentView.removeChildView(tab.view)
    tab.view.webContents.close()

    if (this.activeId === id) {
      const next = this.tabs[index] ?? this.tabs[this.tabs.length - 1]
      if (next) this.activate(next.id)
      else this.activeId = null
    }

    this.layout()
    this.emit()
  }

  activate(id: number, options: { focusPage?: boolean } = {}): void {
    const tab = this.tabs.find((t) => t.id === id)
    if (!tab) return

    this.activeId = id
    tab.lastActiveAt = Date.now()
    if (tab.asleep) this.wake(tab)

    // Activating the companion pane would leave it beside itself.
    if (this.splitId === id) this.splitId = null

    this.applyVisibility()
    this.layout()
    if (options.focusPage !== false) this.focusActive()
    this.emit()
  }

  navigate(input: string): void {
    const tab = this.active()
    if (!tab) return
    tab.view.webContents.loadURL(normalizeInput(input))
  }

  /**
   * Send a named tab somewhere. Used when a link is dropped onto a tab, which
   * means "open it here" rather than "open it in a new one".
   */
  navigateTab(id: number, input: string): void {
    const tab = this.tabs.find((t) => t.id === id)
    if (!tab) return

    const url = normalizeInput(input)
    if (!isAllowedUrl(url)) return

    tab.view.webContents.loadURL(url)
    this.activate(id)
  }

  goBack(): void {
    this.active()?.view.webContents.navigationHistory.goBack()
  }

  goForward(): void {
    this.active()?.view.webContents.navigationHistory.goForward()
  }

  reload(): void {
    this.active()?.view.webContents.reload()
  }

  stop(): void {
    this.active()?.view.webContents.stop()
  }

  toggleDevTools(): void {
    const wc = this.active()?.view.webContents
    if (!wc) return
    if (wc.isDevToolsOpened()) wc.closeDevTools()
    else wc.openDevTools({ mode: 'bottom' })
  }

  focusActive(): void {
    this.active()?.view.webContents.focus()
  }

  activeUrl(): string {
    return this.active()?.view.webContents.getURL() ?? ''
  }

  activeTitle(): string {
    return this.active()?.view.webContents.getTitle() ?? ''
  }

  /** What the active tab offers to install, if anything. */
  activeInstallable(): InstallableApp | null {
    return this.active()?.installable ?? null
  }

  /** The active tab's webContents, for callers that need to act on the page. */
  activeWebContents(): Electron.WebContents | null {
    return this.active()?.view.webContents ?? null
  }

  /** webContents id of the active tab — how blocked-request counts are keyed. */
  activeWebContentsId(): number | null {
    return this.active()?.view.webContents.id ?? null
  }

  /**
   * Open URLs, in tab order, plus which one is active — for session restore.
   * Amnesia tabs are excluded: restoring them would defeat the entire point.
   */
  snapshot(): {
    tabs: { url: string; pinned: boolean; groupId: number | null }[]
    groups: TabGroup[]
    activeIndex: number
  } {
    const keepers = this.tabs.filter((tab) => {
      if (tab.amnesia) return false
      const url = this.urlOf(tab)
      return Boolean(url) && url !== 'about:blank'
    })

    return {
      tabs: keepers.map((tab) => ({
        url: this.urlOf(tab),
        pinned: tab.pinned,
        groupId: tab.groupId
      })),
      groups: this.groupsInStripOrder(),
      activeIndex: Math.max(0, keepers.findIndex((tab) => tab.id === this.activeId))
    }
  }

  /** Recreate groups from a saved session, keeping their saved ids. */
  restoreGroups(groups: TabGroup[]): void {
    for (const group of groups) {
      this.groups.set(group.id, { ...group })
      this.nextGroupId = Math.max(this.nextGroupId, group.id + 1)
    }
  }

  /**
   * Keep what is needed to bring a tab back. Amnesia tabs are excluded: an
   * undo list that resurrects them would be a record of them existing.
   */
  private rememberClosed(tab: Tab): void {
    if (tab.amnesia) return

    const url = this.urlOf(tab)
    if (!url || url === 'about:blank' || url === HOME_URL) return

    this.closed.unshift({
      id: tab.id,
      url,
      title: (tab.asleep ? tab.sleepingTitle : tab.view.webContents.getTitle()) || url,
      favicon: tab.favicon,
      closedAt: Date.now()
    })
    this.closed = this.closed.slice(0, CLOSED_HISTORY)
  }

  /** Does this window contain the given tab? Used to route IPC to a window. */
  ownsWebContents(webContentsId: number): boolean {
    return this.tabs.some((t) => t.view.webContents.id === webContentsId)
  }

  closedTabs(): ClosedTab[] {
    return this.closed
  }

  /** Reopen a specific closed tab, or the most recent one. */
  reopenClosed(id?: number): boolean {
    const index = id === undefined ? 0 : this.closed.findIndex((t) => t.id === id)
    if (index === -1 || this.closed.length === 0) return false

    const [entry] = this.closed.splice(index, 1)
    this.createTab(entry.url)
    return true
  }

  reloadTab(id: number): void {
    this.tabs.find((t) => t.id === id)?.view.webContents.reload()
  }

  closeOthers(keepId: number): void {
    for (const tab of [...this.tabs]) if (tab.id !== keepId) this.closeTab(tab.id)
  }

  closeToTheRight(fromId: number): void {
    const index = this.tabs.findIndex((t) => t.id === fromId)
    if (index === -1) return
    for (const tab of this.tabs.slice(index + 1)) this.closeTab(tab.id)
  }

  /** Reorder by drag: move `id` so it sits at `toIndex` in the strip. */
  moveTab(id: number, toIndex: number): void {
    const from = this.tabs.findIndex((t) => t.id === id)
    if (from === -1) return

    const target = Math.max(0, Math.min(this.tabs.length - 1, toIndex))
    if (from === target) return

    const [tab] = this.tabs.splice(from, 1)
    this.tabs.splice(target, 0, tab)

    // Dropping a tab among a group's members joins it to that group, and
    // dragging it clear of one leaves. This is how a tab is added to a group by
    // dragging: membership follows where the tab was actually put.
    if (!tab.pinned) {
      const before = this.tabs[target - 1]
      const after = this.tabs[target + 1]

      if (before && after && before.groupId === after.groupId && before.groupId !== null) {
        // Landed inside a group's run.
        tab.groupId = before.groupId
      } else if (tab.groupId !== null) {
        // Still touching its own group? Then it has only been reordered within
        // it. Otherwise it has been dragged out.
        const touching =
          before?.groupId === tab.groupId || after?.groupId === tab.groupId
        if (!touching) tab.groupId = null
      }
    }

    // normalise() puts the pinned block back in front, so a tab dragged across
    // that boundary simply settles at the edge of its own section.
    this.normalise()
    this.layout()
    this.emit()
  }

  /** Tear a URL out into its own browser window. */
  openWindow(url: string): void {
    this.onOpenWindow(url)
  }

  /**
   * Drag a tab out of the strip: the URL opens in a fresh window and the
   * original tab closes, so the page appears to have moved rather than been
   * duplicated. Amnesia tabs are refused — a new window would restore them to
   * the recording session, which is the opposite of what they are for.
   */
  detachTab(id: number): boolean {
    const tab = this.tabs.find((t) => t.id === id)
    if (!tab || tab.amnesia) return false

    const url = tab.view.webContents.getURL()
    if (!url || url === 'about:blank') return false

    // A lone tab is already its own window; moving it would leave an empty one.
    if (this.tabs.length === 1) return false

    this.onOpenWindow(url)
    this.closeTab(id)
    return true
  }

  layout(): void {
    const { width, height } = this.window.getContentBounds()
    const top = CHROME_HEIGHT
    const usable = Math.max(0, height - top)

    const split = this.splitId !== null ? this.tabs.find((t) => t.id === this.splitId) : undefined

    if (!split || split.id === this.activeId) {
      const bounds = { x: 0, y: top, width, height: usable }
      for (const tab of this.tabs) tab.view.setBounds(bounds)
      return
    }

    // A one pixel gutter, so the two pages do not appear to bleed together.
    const gutter = 1
    const leftWidth = Math.round((width - gutter) * this.splitRatio)
    const rightWidth = width - gutter - leftWidth

    for (const tab of this.tabs) {
      if (tab.id === this.activeId) {
        tab.view.setBounds({ x: 0, y: top, width: leftWidth, height: usable })
      } else if (tab.id === split.id) {
        tab.view.setBounds({ x: leftWidth + gutter, y: top, width: rightWidth, height: usable })
      } else {
        // Off-screen rather than resized, so a hidden page keeps its layout.
        tab.view.setBounds({ x: 0, y: top, width, height: usable })
      }
    }
  }

  /**
   * Put a tab beside the active one, or take it away again. Splitting a tab
   * with itself is meaningless, so that clears the split instead.
   */
  toggleSplitWith(id: number | null): void {
    if (id === null || id === this.activeId || this.splitId === id) {
      this.splitId = null
    } else if (this.tabs.some((t) => t.id === id)) {
      this.splitId = id
    }

    this.applyVisibility()
    this.layout()
    this.emit()
  }

  /** The tab after the active one, which is what a bare toggle should grab. */
  splitWithNeighbour(): void {
    if (this.splitId !== null) {
      this.toggleSplitWith(null)
      return
    }

    const index = this.tabs.findIndex((t) => t.id === this.activeId)
    const neighbour = this.tabs[index + 1] ?? this.tabs[index - 1]
    if (neighbour) this.toggleSplitWith(neighbour.id)
  }

  /** Nudge the divider. Kept away from the edges so a pane cannot vanish. */
  adjustSplit(delta: number): void {
    if (this.splitId === null) return
    this.splitRatio = Math.min(0.8, Math.max(0.2, this.splitRatio + delta))
    this.layout()
  }

  splitTabId(): number | null {
    return this.splitId
  }

  /** Both panes are visible in split view; everything else is hidden. */
  private applyVisibility(): void {
    for (const tab of this.tabs) {
      tab.view.setVisible(tab.id === this.activeId || tab.id === this.splitId)
    }
  }

  state(): TabsState {
    const url = this.activeUrl()
    return {
      tabs: this.tabs.map((tab) => this.toState(tab)),
      // In strip order, so the chrome can walk tabs and groups together.
      groups: this.groupsInStripOrder(),
      activeTabId: this.activeId,
      splitTabId: this.splitId,
      bookmarked: url ? isBookmarked(url) : false
    }
  }

  refresh(): void {
    this.emit()
  }

  // --- sleeping tabs ---------------------------------------------------------

  /**
   * The address this tab stands for. A sleeping tab's own view is empty, so
   * asking it would return nothing — which would quietly drop the tab from the
   * saved session and from the reopen-closed list.
   */
  private urlOf(tab: Tab): string {
    return tab.asleep ? tab.sleepingUrl : tab.view.webContents.getURL()
  }

  /**
   * Put a tab to sleep: throw the page away and keep only what the strip needs
   * to draw it.
   *
   * The view is destroyed rather than hidden or throttled. A hidden page still
   * holds its DOM, its JavaScript heap and its images; throttling only slows its
   * timers down. Destroying the view is what actually returns the memory, at the
   * cost of reloading the page when you come back to it — which is the trade
   * every browser makes here.
   */
  sleepTab(id: number): void {
    const tab = this.tabs.find((t) => t.id === id)
    if (!tab || tab.asleep) return

    // Never the tab in front of you, never the one beside it in split view,
    // and never one that is making noise.
    if (tab.id === this.activeId || tab.id === this.splitId) return

    const wc = tab.view.webContents
    if (wc.isCurrentlyAudible()) return

    const url = wc.getURL()
    // Nothing to come back to, so nothing worth discarding.
    if (!url || url === 'about:blank') return

    tab.sleepingUrl = url
    tab.sleepingTitle = wc.getTitle()
    // Taken before the view is destroyed: this is what makes a woken tab
    // remember where it had been rather than starting over at this page.
    tab.sleepingEntries = wc.navigationHistory.getAllEntries()
    tab.sleepingIndex = wc.navigationHistory.getActiveIndex()
    tab.asleep = true

    this.replaceView(tab)
    this.layout()
    this.emit()
  }

  /**
   * Bring a sleeping tab back, history and all.
   *
   * `navigationHistory.restore` replays the entries into the fresh view and
   * loads the one that was in view, so Back and Forward still lead exactly
   * where they did. Verified against a destroyed-and-recreated view: the entry
   * count, the active index and both directions survive. Scroll position does
   * not — the page is genuinely reloaded, so it comes back at the top.
   */
  private wake(tab: Tab): void {
    if (!tab.asleep) return

    tab.asleep = false

    const url = tab.sleepingUrl
    const entries = tab.sleepingEntries
    const index = tab.sleepingIndex

    tab.sleepingUrl = ''
    tab.sleepingTitle = ''
    tab.sleepingEntries = []
    tab.sleepingIndex = 0

    const wc = tab.view.webContents

    if (entries.length > 0) {
      wc.navigationHistory
        .restore({ entries, index })
        // Back and Forward only become accurate once the entries are in.
        .then(() => this.emit())
        .catch(() => {
          // A page that refuses to load is still better than a blank tab.
          if (url) wc.loadURL(url)
        })
      return
    }

    if (url) wc.loadURL(url)
  }

  /** Wake a tab by id, for the menu. */
  wakeTab(id: number): void {
    const tab = this.tabs.find((t) => t.id === id)
    if (!tab || !tab.asleep) return

    this.wake(tab)
    this.applyVisibility()
    this.layout()
    this.emit()
  }

  /**
   * Swap a tab's destroyed view for a fresh empty one, so every other part of
   * the class can keep assuming a tab always has a view.
   */
  private replaceView(tab: Tab): void {
    const old = tab.view
    forgetTabBlocked(old.webContents.id)
    this.window.contentView.removeChildView(old)

    tab.view = new WebContentsView({
      webPreferences: {
        partition: tab.amnesia ? AMNESIA_PARTITION : PARTITION,
        preload: join(__dirname, '../preload/internal.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false,
        webSecurity: true
      }
    })

    this.wire(tab)
    attachContextMenu(tab.view.webContents, () => this, tab.amnesia)

    this.window.contentView.addChildView(tab.view)
    this.raiseChrome()
    tab.view.setVisible(false)

    // Destroyed last: the replacement is in place, so nothing sees a gap.
    old.webContents.close()
  }

  /**
   * Sleep anything that has not been looked at for a while. Run on a timer by
   * the window that owns this manager.
   */
  sleepIdleTabs(afterMinutes: number): void {
    const cutoff = Date.now() - afterMinutes * 60_000

    for (const tab of this.tabs) {
      if (tab.asleep || tab.lastActiveAt > cutoff) continue
      if (tab.id === this.activeId || tab.id === this.splitId) continue
      this.sleepTab(tab.id)
    }
  }

  // --- pinning and groups ----------------------------------------------------

  /**
   * Put the strip back into a legal order.
   *
   * Two rules, and every operation that moves a tab ends by restoring them:
   * pinned tabs come first, and a group's tabs are adjacent. A group is anchored
   * at its first member's position, so dragging one tab of a group to the front
   * brings the group with it rather than tearing it in half.
   */
  private normalise(): void {
    const pinned = this.tabs.filter((tab) => tab.pinned)
    const rest = this.tabs.filter((tab) => !tab.pinned)

    const ordered: Tab[] = []
    const placed = new Set<number>()

    for (const tab of rest) {
      if (placed.has(tab.id)) continue

      if (tab.groupId === null) {
        ordered.push(tab)
        placed.add(tab.id)
        continue
      }

      // First member of its group reached: pull the whole group in here.
      for (const member of rest) {
        if (member.groupId !== tab.groupId || placed.has(member.id)) continue
        ordered.push(member)
        placed.add(member.id)
      }
    }

    this.tabs = [...pinned, ...ordered]

    // A group with no tabs left is gone.
    const alive = new Set(this.tabs.map((tab) => tab.groupId).filter((id) => id !== null))
    for (const id of [...this.groups.keys()]) if (!alive.has(id)) this.groups.delete(id)
  }

  /** Groups in the order their first tab appears, which is how they are drawn. */
  private groupsInStripOrder(): TabGroup[] {
    const seen: TabGroup[] = []

    for (const tab of this.tabs) {
      if (tab.groupId === null) continue
      if (seen.some((group) => group.id === tab.groupId)) continue
      const group = this.groups.get(tab.groupId)
      if (group) seen.push(group)
    }

    return seen
  }

  /**
   * Pin or unpin. Pinning takes the tab out of any group — a pinned tab lives in
   * front of every group, so it cannot also be inside one.
   */
  setPinned(ids: number[], pinned: boolean): void {
    for (const id of ids) {
      const tab = this.tabs.find((t) => t.id === id)
      if (!tab) continue
      tab.pinned = pinned
      if (pinned) tab.groupId = null
    }

    this.normalise()
    this.layout()
    this.emit()
  }

  /** A new group holding the given tabs, placed where the first of them sits. */
  createGroup(ids: number[], name = '', colour?: TabGroupColour): number {
    const used = [...this.groups.values()].map((group) => group.colour)

    const group: TabGroup = {
      id: this.nextGroupId++,
      name,
      colour: colour ?? nextGroupColour(used),
      collapsed: false
    }

    this.groups.set(group.id, group)
    this.addToGroup(ids, group.id)
    return group.id
  }

  addToGroup(ids: number[], groupId: number): void {
    if (!this.groups.has(groupId)) return

    for (const id of ids) {
      const tab = this.tabs.find((t) => t.id === id)
      if (!tab) continue
      // Grouping a pinned tab unpins it rather than being quietly ignored.
      tab.pinned = false
      tab.groupId = groupId
    }

    this.normalise()
    this.layout()
    this.emit()
  }

  removeFromGroup(ids: number[]): void {
    for (const id of ids) {
      const tab = this.tabs.find((t) => t.id === id)
      if (tab) tab.groupId = null
    }

    this.normalise()
    this.emit()
  }

  updateGroup(groupId: number, changes: { name?: string; colour?: TabGroupColour; collapsed?: boolean }): void {
    const group = this.groups.get(groupId)
    if (!group) return

    if (changes.name !== undefined) group.name = changes.name.slice(0, 40)
    if (changes.colour !== undefined) group.colour = changes.colour
    if (changes.collapsed !== undefined) group.collapsed = changes.collapsed

    this.emit()
  }

  /** Dissolve the group; its tabs stay open and stay where they are. */
  ungroup(groupId: number): void {
    for (const tab of this.tabs) if (tab.groupId === groupId) tab.groupId = null
    this.groups.delete(groupId)
    this.normalise()
    this.emit()
  }

  /** Close every tab in the group. */
  closeGroup(groupId: number): void {
    for (const id of this.tabsInGroup(groupId)) this.closeTab(id)
  }

  tabsInGroup(groupId: number): number[] {
    return this.tabs.filter((tab) => tab.groupId === groupId).map((tab) => tab.id)
  }

  /** The group the active tab belongs to, if any. Used by the group shortcuts. */
  activeGroupId(): number | null {
    return this.tabs.find((tab) => tab.id === this.activeId)?.groupId ?? null
  }

  /** A new tab that lands inside the group rather than at the end of the strip. */
  newTabInGroup(groupId: number): void {
    if (!this.groups.has(groupId)) return

    const members = this.tabs.filter((tab) => tab.groupId === groupId)
    const last = members[members.length - 1]
    const index = last ? this.tabs.indexOf(last) + 1 : undefined

    this.createTab(HOME_URL, { activate: true, index, groupId })
  }

  private active(): Tab | undefined {
    return this.tabs.find((t) => t.id === this.activeId)
  }

  private toState(tab: Tab): TabState {
    const wc = tab.view.webContents

    // A sleeping tab has no page to ask, so the strip is drawn from what was
    // kept when it was put to sleep.
    if (tab.asleep) {
      return {
        id: tab.id,
        title: tab.sleepingTitle || 'New Tab',
        url: tab.sleepingUrl,
        favicon: tab.favicon,
        loading: false,
        canGoBack: tab.sleepingIndex > 0,
        canGoForward: tab.sleepingIndex < tab.sleepingEntries.length - 1,
        amnesia: tab.amnesia,
        compat: tab.compat,
        split: tab.id === this.splitId,
        installable: null,
        pinned: tab.pinned,
        groupId: tab.groupId,
        asleep: true
      }
    }

    return {
      id: tab.id,
      title: wc.getTitle() || 'New Tab',
      url: wc.getURL(),
      favicon: tab.favicon,
      loading: wc.isLoading(),
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
      amnesia: tab.amnesia,
      compat: tab.compat,
      split: tab.id === this.splitId,
      installable: tab.installable,
      pinned: tab.pinned,
      groupId: tab.groupId,
      asleep: false
    }
  }

  private emit(): void {
    this.onUpdate(this.state())
  }

  private wire(tab: Tab): void {
    const wc = tab.view.webContents
    const update = (): void => this.emit()

    // This tab gets around nine listeners from us, and the ad blocker adds its
    // own each time blocking is re-enabled. The default ceiling of ten is a
    // leak warning aimed at accidental duplicates, which these are not.
    wc.setMaxListeners(30)

    // Browser shortcuts, claimed before the page can act on them.
    wc.on('before-input-event', (event, input) => {
      const action = shortcutFor(input)
      if (!action) return
      event.preventDefault()
      this.onShortcut(action)
    })

    // The single gate on writing anything down. An amnesia tab never records.
    const remembers = (url: string): boolean => !tab.amnesia && shouldIndex(url)

    wc.on('did-start-loading', update)
    wc.on('did-navigate-in-page', update)
    wc.on('did-fail-load', update)

    wc.on('page-title-updated', (_event, title) => {
      if (remembers(wc.getURL())) updateTitle(wc.getURL(), title)
      this.emit()
    })

    wc.on('did-navigate', (_event, url) => {
      // A new page starts its blocked-request tally from zero.
      resetTabBlocked(wc.id)
      tab.installable = null
      if (remembers(url)) recordVisit(url, wc.getTitle())
      this.emit()
    })

    // Optional: give websites the same restrained scrollbars as the browser.
    wc.on('did-finish-load', () => {
      if (!getSettings().stylePageScrollbars) return
      wc.insertCSS(PAGE_SCROLLBAR_CSS).catch(() => undefined)
    })

    wc.on('did-finish-load', () => {
      if (!tab.wantsOmnibox || this.activeId !== tab.id) return

      // Twice: once now, and once after the page has had a moment to run its
      // own load handlers, which is where an autofocus would otherwise win.
      this.onShortcut('focus-omnibox')
      setTimeout(() => {
        if (tab.wantsOmnibox && this.activeId === tab.id) this.onShortcut('focus-omnibox')
      }, 150)
    })

    wc.on('focus', () => {
      if (!tab.wantsOmnibox) return

      // Past the grace window, focus on the page came from the user, and the
      // omnibox stops asking for it back.
      if (Date.now() > tab.omniboxGraceUntil) {
        tab.wantsOmnibox = false
        return
      }

      // Inside it, this is the load-time steal. Take the caret back — on the
      // next tick, so Chromium has finished the focus change it is announcing.
      if (this.activeId === tab.id) setTimeout(() => this.onShortcut('focus-omnibox'), 0)
    })

    // Compatibility Mode styling has to be reapplied after every navigation.
    // The tab can be closed mid-flight, so the failure path is handled here
    // rather than escaping as an unhandled rejection.
    wc.on('did-finish-load', () => {
      if (!tab.compat) return
      wc.insertCSS(IE6_CSS)
        .then((key) => (tab.compatKey = key))
        .catch(() => undefined)
    })

    // Once the page has settled, capture its text for the full-text index.
    wc.on('did-stop-loading', () => {
      this.emit()

      void detectInstallable(wc).then((found) => {
        if (wc.isDestroyed()) return
        tab.installable = found
        this.emit()
      })

      const url = wc.getURL()
      if (!remembers(url)) return

      void capturePageText(wc).then((text) => {
        if (text && !wc.isDestroyed() && wc.getURL() === url) {
          indexPageText(url, wc.getTitle(), text)
        }
      })
    })

    wc.on('page-favicon-updated', (_event, favicons) => {
      tab.favicon = favicons[0] ?? null
      if (tab.favicon && remembers(wc.getURL())) updateFavicon(wc.getURL(), tab.favicon)
      this.emit()
    })

    // target=_blank / window.open: open a real tab instead of a popup window.
    // A link opened from an amnesia tab stays in amnesia.
    wc.setWindowOpenHandler(({ url }) => {
      if (isAllowedUrl(url)) this.createTab(url, { amnesia: tab.amnesia })
      return { action: 'deny' }
    })

    // Anything we do not render ourselves (mailto:, tel:, custom schemes) is
    // handed to the OS rather than loaded.
    wc.on('will-navigate', (event, url) => {
      if (!isAllowedUrl(url)) {
        event.preventDefault()
        shell.openExternal(url)
      }
    })
  }
}

/**
 * Deny every permission request by default. Prompting the user is a later
 * milestone; until that UI exists, silently granting camera/mic/geolocation
 * would be worse than refusing.
 */
export function lockDownSession(): void {
  for (const partition of ALL_PARTITIONS) {
    const ses = session.fromPartition(partition)
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
    ses.setPermissionCheckHandler(() => false)
  }
}
