import type { Settings } from './settings'
import type { TabGroupColour } from './groups'

export interface TabState {
  id: number
  title: string
  url: string
  favicon: string | null
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  /** Nothing about this tab is written down. */
  amnesia: boolean
  /** Pretending to be Internet Explorer 6, with the typography to match. */
  compat: boolean
  /** Shown beside the active tab in split view. */
  split: boolean
  /** Set when the page declares itself installable through a web manifest. */
  installable: InstallableApp | null
  /**
   * Pinned tabs sit at the front of the strip, keep only their favicon, and
   * survive quitting the browser. They are never carried by a group.
   */
  pinned: boolean
  /** The group this tab belongs to, or null. */
  groupId: number | null
  /**
   * The page has been discarded to give its memory back. The tab is still
   * there; it reloads when you return to it.
   */
  asleep: boolean
}

/** A named, coloured run of adjacent tabs. */
export interface TabGroup {
  id: number
  name: string
  colour: TabGroupColour
  /** Collapsed groups show only their chip; the tabs stay open. */
  collapsed: boolean
}

export interface InstallableApp {
  name: string
  startUrl: string
  iconUrl: string | null
  /**
   * Every icon the site offers, best first. Sites disagree about where a usable
   * one lives — manifest, touch icon, favicon — so installing works through the
   * list until one decodes rather than betting on a single guess.
   */
  iconUrls?: string[]
  origin: string
}

/** What the tab layer knows on its own. */
export interface TabsState {
  tabs: TabState[]
  /** In strip order — a group's tabs are always adjacent. */
  groups: TabGroup[]
  activeTabId: number | null
  /** The tab sharing the window with the active one, if any. */
  splitTabId: number | null
  bookmarked: boolean
}

/** What the chrome UI receives: tab state plus everything around it. */
export interface AdblockState {
  enabled: boolean
  /** False when the filter lists could not be loaded at all. */
  available: boolean
  /** Blocked on the current page since it last navigated. */
  page: number
  /** Blocked since the browser started. */
  session: number
  /** Blocked ever, across every session. */
  lifetime: number
  /** Busiest offenders this session, most persistent first. */
  top: { domain: string; count: number }[]
  /** Host of the page in the active tab, or empty when there is none. */
  site: string
  /** Whether the user has excused that host from blocking. */
  siteOff: boolean
}

export interface BrowserState extends TabsState {
  /** Interface strings for the active language, English where untranslated. */
  messages: Record<string, string>
  adblock: AdblockState
  downloads: DownloadState[]
  settings: Settings
  /** Whether this window's bookmarks sidebar is open. */
  sidebarOpen: boolean
  /** Whether the bookmarks bar is showing, which depends on the tab in front. */
  bookmarksBarShown: boolean
}

export interface HistoryHit {
  url: string
  title: string
  favicon: string | null
  lastVisit: number
  /** FTS snippet with the matched terms bracketed; null for title/URL matches. */
  snippet: string | null
}

export interface BookmarkEntry {
  url: string
  title: string
  createdAt: number
  /** Folder path, e.g. "Bookmarks bar/Dev". Empty for an unfiled bookmark. */
  folder: string
  /** The page's icon as last seen in history, if it has been visited. */
  favicon?: string | null
}

/** What a site can ask for and be allowed or refused, one decision each. */
export type PermissionKind = 'camera' | 'microphone' | 'location' | 'notifications' | 'clipboard'

/** A site asking for something, waiting on the user. */
export interface PermissionRequest {
  id: number
  origin: string
  kinds: PermissionKind[]
  /** From an amnesia tab: the answer is never written down. */
  amnesia: boolean
}

/** A decision a site was given and the browser remembers. */
export interface SitePermission {
  origin: string
  permission: string
  allow: boolean
  updatedAt: number
}

/** The password vault, as far as anything outside it may know. */
export interface VaultStatus {
  /** A master password has been set. */
  exists: boolean
  unlocked: boolean
  count: number
  lockMinutes: number
}

/** A saved login without its password, for lists and pickers. */
export interface CredentialSummary {
  id: number
  origin: string
  username: string
  updatedAt: number
  lastUsed: number
}

export interface Credential extends CredentialSummary {
  password: string
  note: string
}

/**
 * The browser noticed a login being submitted and offers to keep it. The
 * password itself stays in the main process; the chrome is only told enough to
 * ask the question.
 */
export interface PasswordOffer {
  origin: string
  username: string
  /** Same site and username already saved with a different password. */
  update: boolean
  vault: 'missing' | 'locked' | 'unlocked'
}

/** Saved logins the page in front could use. */
export interface PasswordsForPage {
  origin: string
  count: number
  vault: 'missing' | 'locked' | 'unlocked'
  accounts: CredentialSummary[]
  /** The page has a login form on it right now. */
  hasForm: boolean
}

/** What the Public IP tool found. Either address may be missing. */
export interface PublicIp {
  v4: string | null
  v6: string | null
  /** Two-letter country code the address is registered to, if known. */
  country: string | null
  checkedAt: number
  /** Neither address could be fetched — offline, most likely. */
  failed: boolean
}

/** Where the star files a page, and what the bar under the toolbar shows. */
export const BOOKMARKS_BAR = 'Bookmarks bar'

export interface Suggestion extends HistoryHit {
  kind: 'search' | 'url' | 'history' | 'fulltext' | 'bookmark'
  label: string
  /**
   * Set on a first row that finishes what was typed — "youtube.com" for "y" —
   * so the omnibox can fill in the rest, selected, the way other browsers do.
   */
  inline?: string
}

export interface DownloadState {
  id: number
  filename: string
  path: string
  url: string
  received: number
  total: number
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted'
  paused: boolean
}

/** Numbers the new tab page uses to quietly judge you. */
export interface RecallStats {
  pages: number
  visits: number
  words: number
  topHost: string | null
  topHostVisits: number
  oldestVisit: number | null
  /** Lifetime blocked requests. Kept even when history is cleared. */
  blocked: number
  /**
   * Blocked requests that were going to a different site than the page you were
   * on — the cross-site tracking calls, specifically.
   */
  blockedThirdParty: number
  /** Cookies websites currently have stored in the browsing session. */
  cookies: number
  /** Distinct searches remembered, including any imported from another browser. */
  searches: number
  /** Bookmarks saved. */
  bookmarks: number
}

/** What the updater is doing, as the interface needs to show it. */
export interface UpdateState {
  status:
    | 'idle'
    | 'checking'
    | 'current'
    | 'available'
    | 'downloading'
    | 'ready'
    | 'error'
    | 'unsupported'
  /** The version on offer, when there is one. */
  version: string
  /** Release notes as published on GitHub. */
  notes: string
  /** Download progress, 0–100. */
  progress: number
  message?: string
}

/**
 * A piece of an article, as reader mode rebuilds it.
 *
 * Text and image addresses only — never markup. The reader page renders these
 * with `textContent`, so nothing from the page can execute there.
 */
export type ReaderBlock =
  | { type: 'heading'; text: string; level: number }
  | { type: 'paragraph'; text: string }
  | { type: 'quote'; text: string }
  | { type: 'code'; text: string }
  | { type: 'item'; text: string }
  | { type: 'image'; src: string; text: string }

export interface ReaderArticle {
  url: string
  title: string
  byline: string
  /** ISO date, when the page declared one. */
  published: string
  /** Estimated reading time in minutes. */
  minutes: number
  blocks: ReaderBlock[]
}

export interface MediaState {
  hasMedia: boolean
  title: string
  artist: string
  artwork: string | null
  playing: boolean
  muted: boolean
  /** Seconds. Zero duration means a live stream. */
  position: number
  duration: number
}

export interface ScreenshotResult {
  /** Small data URL for the panel preview, not the full image. */
  preview: string
  width: number
  height: number
  bytes: number
  suggested: string
}

export interface ClosedTab {
  id: number
  url: string
  title: string
  favicon: string | null
  closedAt: number
}

export interface ImportSource {
  /** Absolute path to the profile directory; also the handle used to import. */
  id: string
  browser: string
  profile: string
  hasBookmarks: boolean
  hasHistory: boolean
  /**
   * Firefox only. Chrome, Edge, Brave and the rest lock their cookies to
   * themselves with App-Bound Encryption, so no other program can read them.
   */
  hasCookies: boolean
}

export interface ImportPayload {
  bookmarks: { url: string; title: string; folder: string; createdAt: number }[]
  history: { url: string; title: string; visits: number; lastVisit: number }[]
  searches: { term: string; count: number }[]
}

export interface ImportResult {
  bookmarks: number
  history: number
  searches: number
  skipped: number
  cookies: number
}

export const HOME_URL = 'ie2://home'
export const HELP_URL = 'ie2://help'
export const BOOKMARKS_URL = 'ie2://bookmarks'
export const HISTORY_URL = 'ie2://history'
export const READER_URL = 'ie2://reader'
export const SETTINGS_URL = 'ie2://settings'
export const PASSWORDS_URL = 'ie2://passwords'

/** Tab strip height. Doubles as the draggable title bar / window-control area. */
export const TITLEBAR_HEIGHT = 40

/** Width reserved on the right of the tab strip for the native window buttons. */
export const WINDOW_CONTROLS_WIDTH = 140

/** Height of the browser chrome when the suggestion dropdown is closed. */
export const CHROME_HEIGHT = 84

/** Extra height of the chrome while the bookmarks bar is shown. */
export const BOOKMARKS_BAR_HEIGHT = 32

/** Width of the bookmarks sidebar docked on the right of the page. */
export const SIDEBAR_WIDTH = 320

/** Largest the omnibox dropdown may grow before it scrolls internally. */
export const DROPDOWN_MAX_HEIGHT = 420
