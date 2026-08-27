import { Menu, clipboard, shell, type MenuItemConstructorOptions, type WebContents } from 'electron'
import type { TabManager } from './tabs'
import { isAllowedUrl } from './url'
import { togglePictureInPicture } from './pip'
import { groupColour } from '../shared/groups'

/**
 * Right-click menus for page content. Built per click from what was actually
 * clicked — a link, an image, editable text, or bare page.
 */
export function attachContextMenu(wc: WebContents, tabs: () => TabManager | null, amnesia: boolean): void {
  wc.on('context-menu', (_event, params) => {
    const manager = tabs()
    if (!manager) return

    const items: MenuItemConstructorOptions[] = []
    const link = params.linkURL

    if (link && isAllowedUrl(link)) {
      items.push(
        { label: 'Open link in new tab', click: () => manager.createTab(link, { activate: false, amnesia }) },
        { label: 'Open link in amnesia tab', click: () => manager.createTab(link, { amnesia: true }) },
        { label: 'Open link in new window', click: () => manager.openWindow(link) },
        { type: 'separator' },
        { label: 'Copy link address', click: () => clipboard.writeText(link) },
        { type: 'separator' }
      )
    }

    // Right-clicking the video itself is the most natural way to float it.
    if (params.mediaType === 'video') {
      items.push(
        { label: 'Picture in picture', click: () => void togglePictureInPicture(wc) },
        { type: 'separator' }
      )
    }

    if (params.mediaType === 'image' && params.srcURL) {
      items.push(
        { label: 'Open image in new tab', click: () => manager.createTab(params.srcURL, { amnesia }) },
        { label: 'Copy image address', click: () => clipboard.writeText(params.srcURL) },
        { label: 'Save image as…', click: () => wc.downloadURL(params.srcURL) },
        { type: 'separator' }
      )
    }

    if (params.isEditable) {
      items.push(
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        { type: 'separator' }
      )
    } else if (params.selectionText) {
      const text = params.selectionText.trim().slice(0, 40)
      items.push(
        { role: 'copy' },
        { label: `Search for “${text}”`, click: () => manager.createTab(params.selectionText, { amnesia }) },
        { type: 'separator' }
      )
    }

    if (items.length === 0) {
      items.push(
        { label: 'Back', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
        { label: 'Forward', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
        { label: 'Reload', click: () => wc.reload() },
        { type: 'separator' }
      )
    }

    items.push({
      label: 'Inspect element',
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
