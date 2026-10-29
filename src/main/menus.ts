import { Menu, clipboard, shell, type MenuItemConstructorOptions, type WebContents } from 'electron'
import type { TabManager } from './tabs'
import { isAllowedUrl } from './url'
import { togglePictureInPicture } from './pip'
import { groupColour } from '../shared/groups'
import { searchUrlFor } from '../shared/settings'
import { getSettings } from './settings'
import { extensionMenuItems } from './extensions'

/** Query parameters that only exist to track who clicked what. */
const TRACKING = /^(utm_\w+|fbclid|gclid|dclid|gbraid|wbraid|yclid|msclkid|mc_cid|mc_eid|igshid|si|ref_src|ref_url|_hsenc|_hsmi|mkt_tok|vero_id|oly_\w+|spm|scm)$/i

/** The same address without its tracking parameters. */
function cleanLink(url: string): string {
  try {
    const parsed = new URL(url)
    for (const key of [...parsed.searchParams.keys()]) if (TRACKING.test(key)) parsed.searchParams.delete(key)
    return parsed.toString()
  } catch {
    return url
  }
}

/** A link that opens the page scrolled to, and highlighting, the selected text. */
function highlightLink(page: string, text: string): string {
  const base = page.split('#')[0]
  const words = text.replace(/\s+/g, ' ').trim()
  // Long selections are linked by their first and last few words.
  const fragment =
    words.length > 80
      ? `${encodeURIComponent(words.split(' ').slice(0, 4).join(' '))},${encodeURIComponent(words.split(' ').slice(-4).join(' '))}`
      : encodeURIComponent(words)
  return `${base}#:~:text=${fragment}`
}

/**
 * Right-click menus for page content. Built per click from what was actually
 * clicked — a link, an image, editable text, or bare page.
 */
export function attachContextMenu(wc: WebContents, tabs: () => TabManager | null, amnesia: boolean): void {
  wc.on('context-menu', (_event, params) => {
    const manager = tabs()
    if (!manager) return

    const items: MenuItemConstructorOptions[] = []
    const section = (...entries: MenuItemConstructorOptions[]): void => {
      if (items.length > 0 && entries.length > 0) items.push({ type: 'separator' })
      items.push(...entries)
    }
    const search = (query: string): string => searchUrlFor(getSettings().searchEngine, query)
    const link = params.linkURL

    if (link && isAllowedUrl(link)) {
      section(
        { label: 'Open link in new tab', click: () => manager.createTab(link, { activate: false, amnesia }) },
        { label: 'Open link in new window', click: () => manager.openWindow(link) },
        { label: 'Open link in amnesia tab', click: () => manager.createTab(link, { amnesia: true }) },
        {
          label: 'Open link in split view',
          click: () => manager.toggleSplitWith(manager.createTab(link, { activate: false, amnesia }))
        }
      )
      section(
        { label: 'Save link as…', click: () => wc.downloadURL(link) },
        { label: 'Copy link address', click: () => clipboard.writeText(link) },
        { label: 'Copy clean link', click: () => clipboard.writeText(cleanLink(link)) },
        ...(params.linkText.trim()
          ? [{ label: 'Copy link text', click: () => clipboard.writeText(params.linkText.trim()) }]
          : [])
      )
    }

    if (params.mediaType === 'image' && params.srcURL) {
      const src = params.srcURL
      const web = /^https?:/i.test(src)
      section(
        ...(web ? [{ label: 'Open image in new tab', click: () => manager.createTab(src, { activate: false, amnesia }) }] : []),
        { label: 'Save image as…', click: () => wc.downloadURL(src) },
        { label: 'Copy image', click: () => wc.copyImageAt(params.x, params.y) },
        ...(web ? [{ label: 'Copy image address', click: () => clipboard.writeText(src) }] : [])
      )
    }

    // Right-clicking the video itself is the most natural way to float it.
    if (params.mediaType === 'video' || params.mediaType === 'audio') {
      const src = params.srcURL
      const web = /^https?:/i.test(src)
      section(
        ...(params.mediaType === 'video'
          ? [{ label: 'Picture in picture', click: () => void togglePictureInPicture(wc) }]
          : []),
        ...(web
          ? [
              { label: `Open ${params.mediaType} in new tab`, click: () => manager.createTab(src, { activate: false, amnesia }) },
              { label: `Save ${params.mediaType} as…`, click: () => wc.downloadURL(src) },
              { label: `Copy ${params.mediaType} address`, click: () => clipboard.writeText(src) }
            ]
          : [])
      )
    }

    if (params.isEditable) {
      // Spelling first, where the eye already is.
      if (params.misspelledWord) {
        section(
          ...params.dictionarySuggestions.slice(0, 5).map((word) => ({
            label: word,
            click: () => wc.replaceMisspelling(word)
          })),
          {
            label: 'Add to dictionary',
            click: () => wc.session.addWordToSpellCheckerDictionary(params.misspelledWord)
          }
        )
      }
      section(
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { label: 'Paste as plain text', role: 'pasteAndMatchStyle' },
        { role: 'selectAll' }
      )
    } else if (params.selectionText.trim()) {
      const selection = params.selectionText.trim()
      const short = selection.length > 32 ? `${selection.slice(0, 32)}…` : selection
      section(
        { role: 'copy' },
        { label: `Search for “${short}”`, click: () => manager.createTab(search(selection), { amnesia }) },
        ...(isAllowedUrl(params.pageURL)
          ? [
              {
                label: 'Copy link to highlight',
                click: () => clipboard.writeText(highlightLink(params.pageURL, selection))
              }
            ]
          : [])
      )
    }

    // Bare page: the page's own commands.
    if (items.length === 0) {
      section(
        { label: 'Back', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
        { label: 'Forward', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
        { label: 'Reload', click: () => wc.reload() }
      )
      section(
        { label: 'Save page as…', click: () => wc.downloadURL(wc.getURL()) },
        { label: 'Print…', click: () => wc.print() },
        { label: 'Copy page address', click: () => clipboard.writeText(wc.getURL()) },
        { label: 'Select all', role: 'selectAll' }
      )
      if (isAllowedUrl(wc.getURL())) {
        section({ label: 'View page source', click: () => manager.createTab(`view-source:${wc.getURL()}`, { amnesia }) })
      }
    }

    // Items extensions added, as in Chrome: above Inspect.
    if (!amnesia) section(...extensionMenuItems(wc, params))

    section({
      label: 'Inspect',
      click: () => wc.inspectElement(params.x, params.y)
    })
    Menu.buildFromTemplate(items).popup()
  })

  // Middle-click-style link handling for downloads initiated by the page.
  wc.session.on('will-download', () => undefined)
}

/** Right-click menu for a tab in the strip. */
/**
 * The tab strip's own menu.
 *
 * `selected` is however many tabs the user ctrl-clicked. Every command that can
 * sensibly act on several does; the rest act on the tab that was right-clicked.
 */
export function showTabMenu(manager: TabManager, tabId: number, selected: number[] = []): void {
  const snapshot = manager.state()
  const state = snapshot.tabs.find((t) => t.id === tabId)
  if (!state) return

  // Right-clicking a tab outside the selection acts on that tab alone, which is
  // what every other browser does and what the pointer implies.
  const targets = selected.includes(tabId) && selected.length > 1 ? selected : [tabId]
  const many = targets.length > 1
  const noun = many ? `${targets.length} tabs` : 'tab'

  const groups = snapshot.groups
  const inGroup = state.groupId !== null

  const groupItems: MenuItemConstructorOptions[] = [
    {
      label: 'New group',
      click: () => manager.createGroup(targets)
    },
    ...(groups.length > 0 ? [{ type: 'separator' } as MenuItemConstructorOptions] : []),
    ...groups.map((group) => ({
      label: group.name || `${groupColour(group.colour).name} group`,
      // Already all in that group? Then there is nothing to add.
      enabled: !targets.every((id) => snapshot.tabs.find((t) => t.id === id)?.groupId === group.id),
      click: () => manager.addToGroup(targets, group.id)
    }))
  ]

  const items: MenuItemConstructorOptions[] = [
    { label: 'New tab to the right', click: () => manager.createTab(undefined, { activate: true }) },
    { type: 'separator' },
    {
      label: state.pinned ? `Unpin ${noun}` : `Pin ${noun}`,
      click: () => manager.setPinned(targets, !state.pinned)
    },
    {
      label: state.asleep ? 'Wake this tab' : `Put ${noun} to sleep`,
      // The tab in front of you is the one tab that cannot be discarded.
      enabled: state.asleep || targets.some((id) => id !== snapshot.activeTabId),
      click: () =>
        state.asleep
          ? manager.wakeTab(tabId)
          : targets.forEach((id) => manager.sleepTab(id))
    },
    { label: `Add ${many ? 'tabs' : 'tab'} to group`, submenu: groupItems },
    ...(inGroup
      ? [
          {
            label: `Remove ${many ? 'tabs' : 'tab'} from group`,
            click: () => manager.removeFromGroup(targets)
          }
        ]
      : []),
    { type: 'separator' },
    { label: 'Reload', click: () => manager.reloadTab(tabId) },
    { label: 'Duplicate', click: () => manager.createTab(state.url, { amnesia: state.amnesia }) },
    {
      label: state.split ? 'Remove from split view' : 'Show beside the current tab',
      enabled: state.split || tabId !== manager.state().activeTabId,
      click: () => manager.toggleSplitWith(tabId)
    },
    {
      label: 'Open in new window',
      enabled: state.url.length > 0 && state.url !== 'about:blank',
      click: () => manager.openWindow(state.url)
    },
    { type: 'separator' },
    { label: 'Copy address', click: () => clipboard.writeText(state.url) },
    {
      label: 'Open in your default browser',
      enabled: /^https?:/.test(state.url),
      // Only real web pages make sense outside this browser.
      click: () => shell.openExternal(state.url)
    },
    { type: 'separator' },
    { label: many ? `Close ${targets.length} tabs` : 'Close tab', click: () => targets.forEach((id) => manager.closeTab(id)) },
    { label: 'Close other tabs', click: () => manager.closeOthers(tabId) },
    { label: 'Close tabs to the right', click: () => manager.closeToTheRight(tabId) }
  ]

  Menu.buildFromTemplate(items).popup()
}
