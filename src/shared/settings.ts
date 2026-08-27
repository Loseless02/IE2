/** Search engines the omnibox can hand a query to. */
export const SEARCH_ENGINES = {
  duckduckgo: { name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=' },
  google: { name: 'Google', url: 'https://www.google.com/search?q=' },
  brave: { name: 'Brave Search', url: 'https://search.brave.com/search?q=' },
  bing: { name: 'Bing', url: 'https://www.bing.com/search?q=' },
  yandex: { name: 'Yandex', url: 'https://yandex.com/search/?text=' },
  yahoo: { name: 'Yahoo', url: 'https://search.yahoo.com/search?p=' },
  startpage: { name: 'Startpage', url: 'https://www.startpage.com/sp/search?query=' },
  ecosia: { name: 'Ecosia', url: 'https://www.ecosia.org/search?q=' },
  mojeek: { name: 'Mojeek', url: 'https://www.mojeek.com/search?q=' },
  wikipedia: { name: 'Wikipedia', url: 'https://en.wikipedia.org/w/index.php?search=' }
} as const

export type SearchEngineId = keyof typeof SEARCH_ENGINES

/** Starting points for the accent colour. Any hex value is allowed too. */
export const ACCENT_PRESETS = [
  '#4f8cff',
  '#7d5bd6',
  '#3fb984',
  '#e0a32e',
  '#e0567c',
  '#3bb8c4',
  '#8a94a6'
] as const

/** Kept so older stored values ('blue', 'violet', …) still resolve. */
const LEGACY_ACCENTS: Record<string, string> = {
  blue: '#4f8cff',
  violet: '#7d5bd6',
  green: '#3fb984',
  amber: '#e0a32e',
  rose: '#e0567c',
  cyan: '#3bb8c4',
  slate: '#8a94a6'
}

/** Normalise anything stored or typed into a `#rrggbb` string. */
export function toHex(value: string, fallback = '#4f8cff'): string {
  const text = String(value ?? '').trim().toLowerCase()
  if (LEGACY_ACCENTS[text]) return LEGACY_ACCENTS[text]

  const withHash = text.startsWith('#') ? text : `#${text}`
  if (/^#[0-9a-f]{6}$/.test(withHash)) return withHash

  // Three-digit shorthand, as people often type it.
  if (/^#[0-9a-f]{3}$/.test(withHash)) {
    const [, r, g, b] = withHash
    return `#${r}${r}${g}${g}${b}${b}`
  }

  return fallback
}

/** How the new tab page paints its background. */
export type HomeBackground = 'theme' | 'colour' | 'builtin' | 'image' | 'folder'

/**
 * How a wallpaper is fitted to the window.
 *
 * - `fill` covers the window, cropping whatever does not fit. Good for photos.
 * - `fit` shows the whole image, leaving bare ground around it.
 * - `stretch` distorts the image to the exact window shape.
 * - `actual` uses the image's own size, centred.
 * - `tile` repeats it at its own size.
 */
export type HomeImageFit = 'fill' | 'fit' | 'stretch' | 'actual' | 'tile'

/** CSS `background-size` for each fit, and whether it repeats. */
export const IMAGE_FITS: Record<HomeImageFit, { label: string; size: string; repeat: string }> = {
  fill: { label: 'Fill', size: 'cover', repeat: 'no-repeat' },
  fit: { label: 'Fit', size: 'contain', repeat: 'no-repeat' },
  stretch: { label: 'Stretch', size: '100% 100%', repeat: 'no-repeat' },
  actual: { label: 'Actual size', size: 'auto', repeat: 'no-repeat' },
  tile: { label: 'Tile', size: 'auto', repeat: 'repeat' }
}

/**
 * Everything the user can change. One flat object: it is persisted as JSON per
 * key, sent to every renderer on change, and typed in one place.
 */
export interface Settings {
  // Search
  searchEngine: SearchEngineId
  searchSuggestions: boolean
  /**
   * Ask the search engine for autocomplete while typing. Off by default: it
   * sends what you type to the engine before you press Enter.
   */
  searchAutocomplete: boolean

  /** Interface language. English is the source; others are overlays. */
  language: string

  // Appearance
  /** Interface theme id; see shared/themes.ts. */
  theme: string
  /** Accent override. Empty means "whatever the theme prefers". */
  accent: string
  savedAccents: string[]
  tabWidth: 'comfortable' | 'compact'
  omniboxWidth: 'narrow' | 'medium' | 'full'
  showDevToolsButton: boolean
  showHomeButton: boolean
  showCopyLinkButton: boolean
  showScreenshotButton: boolean
  showPipButton: boolean
  showSplitButton: boolean
  showBookmarksButton: boolean
  showMediaButton: boolean
  showQrButton: boolean
  showCompatButton: boolean
  showAmnesiaButton: boolean
  animations: boolean
  stylePageScrollbars: boolean

  // Startup
  onStartup: 'restore' | 'newtab'
  homePage: string

  // New tab page
  homeBackground: HomeBackground
  /** Used when homeBackground is 'colour'. */
  homeColour: string
  /** Absolute path to a single image, used when homeBackground is 'image'. */
  homeImage: string
  /** File name of a wallpaper that ships with the browser; see shared/wallpapers.ts. */
  homeBuiltin: string
  /** Folder to pick a random image from, used when homeBackground is 'folder'. */
  homeFolder: string
  /** How a wallpaper is sized against the window; see {@link HomeImageFit}. */
  homeImageFit: HomeImageFit
  /** Where a wallpaper sits when it does not fill the window. */
  homeImagePosition: 'center' | 'top' | 'bottom' | 'left' | 'right'
  /** How much the wallpaper is dimmed so text stays readable, 0–80. */
  homeDim: number
  homeShowSearch: boolean
  homeShowStats: boolean
  homeShowRecent: boolean
  homeShowVerdict: boolean
  homeShowClock: boolean
  homeCardStyle: 'solid' | 'glass'
  homeTitle: string

  // Memory — the browser's whole point, so it is all optional
  captureText: boolean
  captureLimit: number
  recordHistory: boolean
  countBlockedInAmnesia: boolean

  /**
   * Discard background tabs that have not been looked at for a while, giving
   * their memory back. They reload when returned to.
   */
  sleepTabs: boolean
  /** Idle minutes before a background tab is discarded. */
  sleepAfterMinutes: number

  /**
   * Check the project's GitHub releases for a newer version on start-up. Only
   * version numbers are compared; nothing about the user is sent. Off means the
   * check only happens when the button in Settings is pressed.
   */
  autoUpdate: boolean
  /**
   * The version whose release notes have already been shown, so "what's new"
   * appears exactly once after an update rather than on every launch.
   */
  lastSeenVersion: string

  // Shields
  blockAds: boolean

  // Downloads
  askWhereToSave: boolean

  // Privacy
  clearCookiesOnForget: boolean
  denyPermissions: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  searchEngine: 'duckduckgo',
  searchSuggestions: true,
  searchAutocomplete: false,

  language: 'en',
  theme: 'ie2-dark',
  accent: '',
  savedAccents: [],
  tabWidth: 'comfortable',
  omniboxWidth: 'full',
  showDevToolsButton: false,
  showHomeButton: true,
  showCopyLinkButton: true,
  showScreenshotButton: true,
  showPipButton: true,
  showSplitButton: true,
  showBookmarksButton: true,
  showMediaButton: true,
  showQrButton: true,
  showCompatButton: true,
  showAmnesiaButton: true,
  animations: true,
  stylePageScrollbars: true,

  onStartup: 'restore',
  homePage: 'ie2://home',

  homeBackground: 'theme',
  homeColour: '#16181c',
  homeImage: '',
  homeBuiltin: 'desmumtz11.jpg',
  homeFolder: '',
  homeImageFit: 'fill',
  homeImagePosition: 'center',
  homeDim: 35,
  homeShowSearch: true,
  homeShowStats: true,
  homeShowRecent: true,
  homeShowVerdict: true,
  homeShowClock: false,
  homeCardStyle: 'solid',
  homeTitle: 'IE2',

  captureText: true,
  captureLimit: 300_000,
  recordHistory: true,
  countBlockedInAmnesia: true,

  sleepTabs: true,
  sleepAfterMinutes: 30,

  autoUpdate: true,
  lastSeenVersion: '',

  blockAds: true,

  askWhereToSave: true,

  clearCookiesOnForget: false,
  denyPermissions: true
}

export function searchUrlFor(engine: SearchEngineId, query: string): string {
  const entry = SEARCH_ENGINES[engine] ?? SEARCH_ENGINES.duckduckgo
  return entry.url + encodeURIComponent(query)
}
