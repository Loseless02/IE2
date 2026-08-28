/**
 * Every translatable string in the interface.
 *
 * English is the source of truth: a translation is an overlay on top of it, so a
 * missing or empty entry falls back to English rather than showing a key. New
 * strings therefore ship working, translated later.
 *
 * Translations live in `%APPDATA%/internet-explorer-2/locales/<code>.json` and
 * are editable from `ie2://translate` — no rebuild involved.
 */
import { EN_SETTINGS } from './i18n-settings'

export const LANGUAGES = {
  en: { name: 'English', endonym: 'English' },
  tr: { name: 'Turkish', endonym: 'Türkçe' }
} as const

export type LanguageId = keyof typeof LANGUAGES

/** Groups only order the translation editor; they are not part of the key. */
export const MESSAGE_GROUPS: Record<string, string> = {
  toolbar: 'Toolbar and tabs',
  panel: 'Panels',
  palette: 'Command palette',
  home: 'New tab page',
  settings: 'Settings',
  ui: 'Settings page wording',
  common: 'Common'
}

export const EN: Record<string, string> = {
  // --- toolbar and tabs ------------------------------------------------------
  'toolbar.back': 'Back',
  'toolbar.forward': 'Forward',
  'toolbar.reload': 'Reload',
  'toolbar.stop': 'Stop',
  'toolbar.home': 'Home',
  'toolbar.newTab': 'New tab',
  'toolbar.closeTab': 'Close tab',
  'toolbar.bookmark': 'Bookmark this page',
  'toolbar.bookmarked': 'Remove bookmark',
  'toolbar.install': 'Install this site as an app',
  'toolbar.copyLink': "Copy this page's address",
  'toolbar.copied': 'Address copied',
  'toolbar.copyNothing': 'No address to copy',
  'toolbar.screenshot': 'Screenshot',
  'toolbar.pip': 'Picture in picture',
  'toolbar.reader': 'Reader mode — just the article',
  'toolbar.readerNothing': 'No article on this page',
  'toolbar.split': 'Split view',
  'toolbar.splitOff': 'Leave split view',
  'toolbar.splitNeedsTwo': 'Open a second tab first',
  'toolbar.pipNoVideo': 'No video on this page',
  'toolbar.pipUnavailable': 'This page has nothing that can float',
  'toolbar.downloads': 'Downloads',
  'toolbar.bookmarks': 'Bookmarks',
  'toolbar.history': 'History',
  'toolbar.media': 'What is playing',
  'toolbar.qr': 'QR code for this page',
  'panel.qrHint': 'Point a phone camera at this to open the page there.',
  'panel.savePng': 'Save PNG',
  'panel.nothingPlaying': 'Nothing is playing on this page.',
  'panel.live': 'Live',
  'panel.manageAll': 'Manage all',
  'panel.noBookmarks': 'Nothing saved yet. The star button keeps a page.',
  'toolbar.shield': 'Blocking ads and trackers',
  'toolbar.shieldOff': 'Blocking off',
  'toolbar.compat': 'Compatibility Mode',
  'toolbar.amnesia': 'New amnesia tab',
  'toolbar.settings': 'Settings',
  'toolbar.devtools': 'DevTools',
  'toolbar.help': 'What does any of this do?',
  'toolbar.omniboxPlaceholder': 'Search the web — or anything you have already read',
  'tab.notRecorded': 'not being recorded',
  'tab.amnesiaBadge': 'Amnesia',

  // --- panels ----------------------------------------------------------------
  'panel.blocking': 'Blocking',
  'panel.on': 'On',
  'panel.off': 'Off',
  'panel.thisPage': 'this page',
  'panel.thisSession': 'this session',
  'panel.allTime': 'all time',
  'panel.nothingBlocked': 'Nothing blocked yet. Give it a news site.',
  'panel.blockingOff': 'Blocking is off. The web is showing you its true self.',
  'panel.downloads': 'Downloads',
  'panel.clearFinished': 'Clear finished',
  'panel.noDownloads': 'Nothing downloaded yet. Restraint, or an empty life.',
  'panel.cancel': 'Cancel',
  'panel.showInFolder': 'Show in folder',
  'panel.screenshotCopied': 'Screenshot copied',
  'panel.downloadPng': 'Download PNG',
  'panel.onClipboard': 'on your clipboard',
  'panel.saved': 'Saved',
  'panel.siteOff': 'Turn off here',
  'panel.siteOn': 'Turn back on',
  'panel.siteExcused': 'Blocking off for this site',
  'panel.siteRestored': 'Blocking back on for this site',
  'panel.close': 'Close',
  'omnibox.search': 'Search',
  'omnibox.goTo': 'Go to',
  'omnibox.visited': 'Visited',
  'omnibox.inPageText': 'In page text',
  'omnibox.searchedBefore': 'Searched before',
  'omnibox.suggests': 'suggests',
  'omnibox.footer': 'IE2 remembers every page you read. On purpose.',
  'find.placeholder': 'Find in page',
  'find.previous': 'Previous match',
  'find.next': 'Next match',
  'find.none': 'No matches',

  // --- command palette -------------------------------------------------------
  'palette.placeholder': 'Type a command, or search your open tabs',
  'palette.hint': '↑↓ to move · Enter to run · Esc to close',
  'palette.groupTabs': 'Tabs',
  'palette.groupPage': 'Page',
  'palette.groupPrivacy': 'Privacy',
  'palette.groupOpen': 'Open',
  'palette.groupView': 'View',
  'palette.groupSwitchTo': 'Switch to',
  'palette.groupReopen': 'Reopen',
  'palette.reopenLast': 'Reopen last closed tab',
  'palette.pip': 'Picture in picture',
  'palette.split': 'Split view with',
  'palette.splitOff': 'Leave split view',
  'palette.widenLeft': 'Widen the left pane',
  'palette.widenRight': 'Widen the right pane',
  'palette.empty': 'Nothing matches. Press Enter to search the web for it instead.',

  // --- new tab page ----------------------------------------------------------
  'home.tagline': 'The browser that remembers. It was never asked to.',
  'home.recallPlaceholder': 'Search the text of every page you have read',
  'home.recent': 'Recently, against your better judgement',
  'home.forgetAll': 'Forget everything',
  'home.allHistory': 'All history',
  'home.noHistory': 'No history yet. Suspiciously clean.',
  'home.noMatch': 'Not in the archive. You never read this. Allegedly.',
  'home.pagesKept': 'pages kept',
  'home.wordsRead': 'words read',
  'home.visitsLogged': 'visits logged',
  'home.adsDenied': 'ads denied a life',
  'home.trackersStopped': 'cross-site trackers stopped',
  'home.timeSaved': 'time not spent loading',
  'home.dataSaved': 'data not downloaded',
  'home.cookiesHeld': 'cookies sites are holding',
  'home.searchesRemembered': 'searches remembered',
  'home.bookmarks': 'bookmarks',
  'home.favourite': 'your favourite, apparently',

  // --- settings --------------------------------------------------------------
  'settings.title': 'Settings',
  'settings.filter': 'Search settings',
  'settings.getStarted': 'Get started',
  'settings.import': 'Import',
  'settings.searchEngine': 'Search engine',
  'settings.appearance': 'Appearance',
  'settings.newTabPage': 'New tab page',
  'settings.memory': 'Memory',
  'settings.shields': 'Shields',
  'settings.privacy': 'Privacy and security',
  'settings.downloadsSection': 'Downloads',
  'settings.language': 'Language',
  'settings.about': 'About',
  'settings.reset': 'Reset settings',
  'settings.theme': 'Theme',
  'settings.accent': 'Accent colour',
  'settings.saveColour': 'Save this colour',
  'settings.translate': 'Translate the interface',
  'settings.translateHint': 'Type your own wording for any part of the browser.',
  'settings.openTranslator': 'Open the translation editor',

  // --- common ---------------------------------------------------------------
  'common.on': 'On',
  'common.off': 'Off',
  'common.cancel': 'Cancel',
  'common.confirm': 'Confirm',
  'common.save': 'Save',
  'common.copy': 'Copy',
  'common.copied': 'Copied',
  'common.remove': 'Remove',
  'common.choose': 'Choose…',
  'common.none': 'None',

  // The Settings page's own rows, extracted from the page rather than written
  // out again here; see scripts/extract-ui-strings.js.
  ...EN_SETTINGS
}

/**
 * The catalogue key for a piece of English interface text.
 *
 * Pages whose wording lives in the page rather than in this file — the Settings
 * page and the new tab page, mostly — look their strings up by content, so the
 * source stays readable English while still going through the catalogue. The
 * same derivation runs in scripts/extract-ui-strings.js, which is what puts
 * those strings in front of the translator.
 */
export function uiKey(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 44)
    .replace(/-$/, '')

  // Two different strings can slug to the same thing once truncated, so the
  // full text decides the suffix.
  let hash = 0
  for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) >>> 0

  return `ui.${slug}-${hash.toString(36).slice(0, 4)}`
}

/** Keys in catalogue order, for the translation editor. */
export function messageKeys(): string[] {
  return Object.keys(EN)
}

export function groupOf(key: string): string {
  const prefix = key.split('.')[0]
  if (prefix === 'omnibox' || prefix === 'tab' || prefix === 'find') return 'panel'
  return MESSAGE_GROUPS[prefix] ? prefix : 'common'
}

/**
 * Build a lookup for a locale: the English source with any translated entries
 * laid over it. Empty strings are ignored so a half-finished translation never
 * shows blanks.
 */
export function resolve(overlay: Record<string, string> | undefined): Record<string, string> {
  if (!overlay) return { ...EN }

  const out = { ...EN }
  for (const [key, value] of Object.entries(overlay)) {
    if (typeof value === 'string' && value.trim() !== '') out[key] = value
  }
  return out
}

/** How much of a locale is done, as a percentage of the catalogue. */
export function completeness(overlay: Record<string, string> | undefined): number {
  if (!overlay) return 0
  const total = messageKeys().length
  const done = messageKeys().filter((key) => (overlay[key] ?? '').trim() !== '').length
  return Math.round((done / total) * 100)
}
