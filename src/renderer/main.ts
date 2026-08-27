import { DEFAULT_SETTINGS } from '../shared/settings'
import { applyTheme } from './theme'
import { icon, setIcon } from './icons'
import qrcode from 'qrcode-generator'
import { EN } from '../shared/i18n'
import {
  BOOKMARKS_URL,
  HELP_URL,
  SETTINGS_URL,
  type BrowserState,
  type ClosedTab,
  type DownloadState,
  type MediaState,
  type Suggestion,
  type TabGroup,
  type TabState
} from '../shared/types'
import { GROUP_COLOUR_IDS, groupColour } from '../shared/groups'

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

const tabsEl = el('tabs')
const omnibox = el<HTMLInputElement>('omnibox')
const backBtn = el<HTMLButtonElement>('back')
const forwardBtn = el<HTMLButtonElement>('forward')
const reloadBtn = el<HTMLButtonElement>('reload')
const bookmarkBtn = el<HTMLButtonElement>('bookmark')
const compatBtn = el<HTMLButtonElement>('compat')
const amnesiaBtn = el<HTMLButtonElement>('amnesia')
const badge = el('badge')
const shieldBtn = el<HTMLButtonElement>('shield')
const downloadsPanel = el('downloads-panel')
const shieldPanel = el('shield-panel')
const shieldToggle = el<HTMLButtonElement>('shield-toggle')
const shieldToggleLabel = el('shield-toggle-label')
const shieldCounts = el('shield-counts')
const siteRow = el('shield-site')
const siteName = el('shield-site-name')
const siteToggle = el<HTMLButtonElement>('shield-site-toggle')
const shieldTop = el('shield-top')
const shieldFooter = el('shield-footer')
const dlList = el('dl-list')
const dlCount = el('dl-count')
const dropdown = el('dropdown')
const palette = el('palette')
const paletteInput = el<HTMLInputElement>('palette-input')
const paletteList = el('palette-list')
const omniboxWrap = el('omnibox-wrap')
const installBtn = el<HTMLButtonElement>('install')
const shotPanel = el('shot-panel')
const bookmarksPanel = el('bookmarks-panel')
const mediaPanel = el('media-panel')
const qrPanel = el('qr-panel')
const bmList = el('bm-list')
const shotPreview = el<HTMLImageElement>('shot-preview')
const shotInfo = el('shot-info')
const suggestionsEl = el('suggestions')
const groupPanel = el('group-panel')
const groupNameInput = el<HTMLInputElement>('group-name')
const groupColoursEl = el('group-colours')

let state: BrowserState = {
  tabs: [],
  activeTabId: null,
  bookmarked: false,
  groups: [],
  adblock: {
    enabled: false,
    available: false,
    page: 0,
    session: 0,
    lifetime: 0,
    top: [],
    site: '',
    siteOff: false
  },
  downloads: [],
  messages: { ...EN },
  splitTabId: null,
  settings: DEFAULT_SETTINGS
}
let suggestions: Suggestion[] = []
let selected = -1

/**
 * Tabs the user has ctrl-clicked. A command from the tab menu applies to all of
 * them; a plain click anywhere clears the set.
 */
let selectedTabs = new Set<number>()

/** Which group's chip has its panel open, if any. */
let openGroupId: number | null = null

/**
 * The tab currently being dragged. Its position is owned by the pointer, so
 * the FLIP pass skips it — otherwise every reorder would yank it back to the
 * slot it just left.
 */
let draggingId: number | null = null
let downloadsOpen = false
let shieldOpen = false
let paletteOpen = false
let shotOpen = false
let bookmarksOpen = false
let mediaOpen = false
let qrOpen = false
let mediaTimer: number | undefined

/**
 * Interface strings for the active language. The main process sends them with
 * every state push, so a translation edit shows up on the next render.
 */
let messages: Record<string, string> = { ...EN }

/** Translate a key, falling back to English and then to the key itself. */
function msg(key: string): string {
  return messages[key] ?? EN[key] ?? key
}

const nf = new Intl.NumberFormat()
let suggestTimer: number | undefined

/** Room for a favicon and its padding — the point where a tab stops shrinking. */
const TAB_MIN_WIDTH = 34

/** How far below the strip a tab must be dragged to become its own window. */
const TEAR_OUT_DISTANCE = 64
const TAB_MAX_WIDTH = 200

function activeTab(): TabState | undefined {
  return state.tabs.find((t) => t.id === state.activeTabId)
}

/**
 * Page-controlled strings (titles, URLs, favicon URLs, captured page text) land
 * here, so everything goes in via textContent / setAttribute — never innerHTML.
 */
/**
 * Tab nodes are kept between renders and keyed by tab id.
 *
 * Rebuilding the strip from scratch on every state push would restart every
 * transition, so nothing could ever animate. Instead nodes are created once,
 * updated in place, reordered, and only removed after their closing animation.
 */
const tabNodes = new Map<number, HTMLElement>()

/** Group chips, kept the same way and for the same reason. */
const groupNodes = new Map<number, HTMLElement>()

function buildGroupChip(group: TabGroup): HTMLElement {
  const chip = document.createElement('button')
  chip.className = 'group-chip'
  chip.dataset['group'] = String(group.id)

  const caret = document.createElement('span')
  caret.className = 'group-caret'
  caret.append(icon('forward'))
  chip.append(caret)

  const label = document.createElement('span')
  label.className = 'group-label'
  chip.append(label)

  // Click folds the group away, which is what a chip in a tab strip does
  // everywhere else. The panel is on right-click, where menus live.
  chip.addEventListener('mousedown', (event) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()

    const id = Number(chip.dataset['group'])
    const group = state.groups.find((g) => g.id === id)
    if (!group) return

    closeGroupPanel()
    void window.browser.updateGroup(id, { collapsed: !group.collapsed })
  })

  chip.addEventListener('contextmenu', (event) => {
    event.preventDefault()
    event.stopPropagation()

    const id = Number(chip.dataset['group'])
    if (openGroupId === id) closeGroupPanel()
    else openGroupPanel(id)
  })

  return chip
}

function updateGroupChip(chip: HTMLElement, group: TabGroup): void {
  chip.dataset['group'] = String(group.id)
  chip.style.setProperty('--group', groupColour(group.colour).fill)
  chip.style.setProperty('--group-text', groupColour(group.colour).text)

  const label = chip.querySelector('.group-label') as HTMLElement
  // An unnamed group is a bare coloured dot, exactly as wide as it needs to be.
  const named = group.name.trim().length > 0
  chip.classList.toggle('unnamed', !named)
  chip.classList.toggle('collapsed', group.collapsed)

  // Folded away, the chip is all that is left of the group, so it carries the
  // count — otherwise the tabs look closed rather than hidden.
  const count = state.tabs.filter((tab) => tab.groupId === group.id).length
  const text = group.collapsed ? `${group.name || ''} ${count}`.trim() : group.name
  if (label.textContent !== text) label.textContent = text

  chip.title = `${named ? group.name : 'Unnamed group'} — ${
    group.collapsed ? 'click to expand' : 'click to collapse'
  }, right-click for options`
}

function buildTabNode(tab: TabState): HTMLElement {
  const node = document.createElement('div')
  node.className = 'tab entering'
  node.dataset['id'] = String(tab.id)

  node.addEventListener('mousedown', (event) => {
    const id = Number(node.dataset['id'])

    if (event.button === 1) {
      window.browser.closeTab(id)
      return
    }
    if (event.button !== 0) return

    // Ctrl+click builds a selection instead of switching tabs, so several can
    // be grouped or closed in one go. Shift+click takes the run between them.
    if (event.ctrlKey || event.metaKey) {
      if (selectedTabs.has(id)) selectedTabs.delete(id)
      else selectedTabs.add(id)
      renderTabs()
      return
    }

    if (event.shiftKey && state.activeTabId !== null) {
      const ids = state.tabs.map((tab) => tab.id)
      const from = ids.indexOf(state.activeTabId)
      const to = ids.indexOf(id)
      if (from !== -1 && to !== -1) {
        for (const between of ids.slice(Math.min(from, to), Math.max(from, to) + 1)) {
          selectedTabs.add(between)
        }
        renderTabs()
        return
      }
    }

    selectedTabs.clear()
    closeGroupPanel()
    window.browser.activateTab(id)
    beginDrag(event, id, node)
  })

  node.addEventListener('contextmenu', (event) => {
    event.preventDefault()
    window.browser.tabMenu(Number(node.dataset['id']), [...selectedTabs])
  })

  const favicon = document.createElement('img')
  favicon.className = 'favicon'
  // A site that offers a broken icon falls back to the generic mark rather
  // than leaving a gap where every other tab has something.
  favicon.addEventListener('error', () => {
    favicon.hidden = true
    favicon.dataset['failed'] = favicon.src
    fallback.hidden = false
  })

  // Shown for pages with no icon of their own — our own ie2:// pages, and
  // anything that simply does not declare one.
  const fallback = document.createElement('span')
  fallback.className = 'favicon fallback'
  fallback.append(icon('globe'))

  const spinner = document.createElement('div')
  spinner.className = 'spinner'

  const title = document.createElement('span')
  title.className = 'title'

  const close = document.createElement('button')
  close.className = 'close'
  close.append(icon('close'))
  close.title = 'Close tab'
  // mousedown, not click: activating a tab moves focus into the page, which
  // cancels the pending click before it is ever delivered.
  close.addEventListener('mousedown', (event) => {
    event.stopPropagation()
    event.preventDefault()
    window.browser.closeTab(Number(node.dataset['id']))
  })

  node.append(spinner, favicon, fallback, title, close)

  // Let the entry animation run, then drop the class so it can be reused.
  requestAnimationFrame(() => node.classList.remove('entering'))

  return node
}

/** Page-controlled strings go in as text, never as markup. */
function updateTabNode(node: HTMLElement, tab: TabState): void {
  node.dataset['id'] = String(tab.id)
  node.classList.toggle('active', tab.id === state.activeTabId)
  node.classList.toggle('amnesia', tab.amnesia)
  node.classList.toggle('pinned', tab.pinned)
  node.classList.toggle('asleep', tab.asleep)
  node.classList.toggle('internal', tab.url.startsWith('ie2://'))
  node.classList.toggle('picked', selectedTabs.has(tab.id))

  // A grouped tab is tinted with its group's colour and knows whether it is at
  // either end of the run, so the group reads as one block.
  const group = tab.groupId !== null ? state.groups.find((g) => g.id === tab.groupId) : undefined
  node.classList.toggle('grouped', Boolean(group))

  if (group) {
    const order = state.tabs.filter((t) => t.groupId === group.id)
    node.classList.toggle('group-first', order[0]?.id === tab.id)
    node.classList.toggle('group-last', order[order.length - 1]?.id === tab.id)
    node.style.setProperty('--group', groupColour(group.colour).fill)
  } else {
    node.classList.remove('group-first', 'group-last')
    node.style.removeProperty('--group')
  }
  // In split view both the active tab and its companion are marked, so the
  // pairing is visible in the strip.
  const isPane = state.splitTabId !== null && (tab.split || tab.id === state.activeTabId)
  node.classList.toggle('split-pane', isPane)
  node.title = tab.asleep
    ? `${tab.title} — asleep, reloads when you return to it`
    : tab.amnesia
      ? `${tab.title} — not being recorded`
      : tab.title

  const spinner = node.querySelector('.spinner') as HTMLElement
  const icon = node.querySelector('img.favicon') as HTMLImageElement
  const fallback = node.querySelector('.favicon.fallback') as HTMLElement
  const title = node.querySelector('.title') as HTMLElement

  spinner.hidden = !tab.loading

  // The icon is only assigned when it actually changes — reassigning the same
  // src would restart the fetch — but whether it is *shown* is decided every
  // time. Tying the two together meant a tab that reloaded hid its icon while
  // loading and, since the src had not changed, never showed it again.
  const usable = Boolean(tab.favicon) && tab.favicon !== icon.dataset['failed']

  if (usable && icon.src !== tab.favicon) icon.src = tab.favicon as string

  const showIcon = !tab.loading && usable
  icon.hidden = !showIcon
  fallback.hidden = tab.loading || showIcon

  if (title.textContent !== tab.title) title.textContent = tab.title
}

function renderTabs(): void {
  // Where everything is now, so movement can be animated from here to there.
  const before = new Map<number, number>()
  for (const [id, node] of tabNodes) before.set(id, node.getBoundingClientRect().left)

  for (const [id, chip] of groupNodes) before.set(-id, chip.getBoundingClientRect().left)

  const wanted = new Set(state.tabs.map((t) => t.id))
  const wantedGroups = new Set(state.groups.map((g) => g.id))

  // A closed tab must not linger in the selection, where it would silently
  // widen the next command run from the tab menu.
  for (const id of [...selectedTabs]) if (!wanted.has(id)) selectedTabs.delete(id)

  // Groups that were dissolved or emptied.
  for (const [id, chip] of [...groupNodes]) {
    if (wantedGroups.has(id)) continue
    groupNodes.delete(id)
    chip.remove()
    if (openGroupId === id) closeGroupPanel()
  }

  // Tabs that have gone: animate them out, then take them out of the DOM.
  for (const [id, node] of [...tabNodes]) {
    if (wanted.has(id)) continue
    tabNodes.delete(id)
    node.classList.add('leaving')
    node.addEventListener('transitionend', () => node.remove(), { once: true })
    // Motion may be switched off, in which case no transition ever fires.
    window.setTimeout(() => node.remove(), 400)
  }

  for (const tab of state.tabs) {
    let node = tabNodes.get(tab.id)
    if (!node) {
      node = buildTabNode(tab)
      tabNodes.set(tab.id, node)
    }
    updateTabNode(node, tab)
  }

  for (const group of state.groups) {
    let chip = groupNodes.get(group.id)
    if (!chip) {
      chip = buildGroupChip(group)
      groupNodes.set(group.id, chip)
    }
    updateGroupChip(chip, group)
  }

  // Reorder to match the strip, leaving departing nodes where they are. A
  // group's chip goes in front of its first tab, which is what makes the run
  // read as one thing.
  const chipped = new Set<number>()

  for (const tab of state.tabs) {
    if (tab.groupId !== null && !chipped.has(tab.groupId)) {
      chipped.add(tab.groupId)
      const chip = groupNodes.get(tab.groupId)
      if (chip) tabsEl.append(chip)
    }

    const node = tabNodes.get(tab.id)
    if (!node) continue

    // A collapsed group keeps only its chip on screen; the tabs stay open.
    // A class rather than `hidden`, because `display: none` cannot be
    // transitioned — the tabs have to be able to slide shut.
    const group = tab.groupId !== null ? state.groups.find((g) => g.id === tab.groupId) : undefined
    node.classList.toggle('collapsed', Boolean(group?.collapsed))

    tabsEl.append(node)
  }

  layoutTabs()

  // FLIP: put each moved tab back where it was, then let it slide into place.
  for (const [id, node] of [...tabNodes, ...[...groupNodes].map(([gid, chip]) => [-gid, chip] as [number, HTMLElement])]) {
    if (id === draggingId) continue

    const from = before.get(id)
    if (from === undefined) continue

    const delta = from - node.getBoundingClientRect().left
    if (Math.abs(delta) < 1) continue

    node.classList.add('sliding')
    node.style.transform = `translateX(${delta}px)`

    requestAnimationFrame(() => {
      node.style.transform = ''
      window.setTimeout(() => node.classList.remove('sliding'), 220)
    })
  }
}

/**
 * A link dragged onto the tab strip opens as a new tab exactly where it was
 * dropped. Works for links from a page, and for anything dropped in from
 * outside the browser.
 */
function setupTabDrop(): void {
  const marker = document.createElement('div')
  marker.id = 'drop-marker'
  marker.hidden = true
  el('tabstrip').append(marker)

  const strip = el('tabstrip')

  /**
   * What a drop at this x would do.
   *
   * Over the middle of a tab, the link replaces that tab — dropping onto
   * something is a request to put the link *there*. Anywhere else in the strip
   * it opens a new tab at that slot, including past the last tab, where the
   * slot is simply the end.
   */
  type DropTarget = { kind: 'open'; index: number } | { kind: 'replace'; id: number }

  const targetAt = (x: number): DropTarget => {
    const tabs = [...tabsEl.querySelectorAll('.tab')] as HTMLElement[]

    for (let i = 0; i < tabs.length; i++) {
      const box = tabs[i].getBoundingClientRect()
      if (x < box.left || x > box.right) continue

      // The outer quarter at each end means "between these two tabs"; the
      // middle half means "this tab".
      const edge = box.width / 4
      if (x < box.left + edge) return { kind: 'open', index: i }
      if (x > box.right - edge) return { kind: 'open', index: i + 1 }
      return { kind: 'replace', id: Number(tabs[i].dataset['id']) }
    }

    // Not over any tab: find the slot it falls between, or the end of the strip.
    let index = tabs.length
    for (let i = 0; i < tabs.length; i++) {
      if (x < tabs[i].getBoundingClientRect().left) {
        index = i
        break
      }
    }
    return { kind: 'open', index }
  }

  const showTarget = (target: DropTarget): void => {
    for (const node of tabsEl.querySelectorAll('.tab')) node.classList.remove('drop-onto')

    if (target.kind === 'replace') {
      marker.hidden = true
      tabNodes.get(target.id)?.classList.add('drop-onto')
      return
    }

    const tabs = [...tabsEl.querySelectorAll('.tab')] as HTMLElement[]
    const box = strip.getBoundingClientRect()

    const edge =
      target.index < tabs.length
        ? tabs[target.index].getBoundingClientRect().left
        : (tabs[tabs.length - 1]?.getBoundingClientRect().right ?? box.left + 8)

    marker.hidden = false
    marker.style.left = `${edge - box.left - 1}px`
  }

  const clearTarget = (): void => {
    marker.hidden = true
    strip.classList.remove('dropping')
    for (const node of tabsEl.querySelectorAll('.tab')) node.classList.remove('drop-onto')
  }

  strip.addEventListener('dragover', (event) => {
    if (!event.dataTransfer) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'

    // The strip doubles as the title bar, and a window-drag region swallows
    // HTML5 drops: without this the whole empty stretch of the strip silently
    // refused links, and only the tabs themselves — which are already no-drag —
    // ever accepted one.
    strip.classList.add('dropping')
    showTarget(targetAt(event.clientX))
  })

  strip.addEventListener('dragleave', (event) => {
    // Leaving for a child element is not leaving the strip.
    if (event.relatedTarget && strip.contains(event.relatedTarget as Node)) return
    clearTarget()
  })

  strip.addEventListener('drop', (event) => {
    event.preventDefault()

    const target = targetAt(event.clientX)
    clearTarget()

    const data = event.dataTransfer
    if (!data) return

    // A dragged link arrives as text/uri-list; plain text is the fallback.
    const raw =
      data.getData('text/uri-list') || data.getData('text/plain') || data.getData('text')
    const url = raw.split(/\r?\n/).find((line) => line.trim() && !line.startsWith('#'))?.trim()
    if (!url) return

    if (target.kind === 'replace') window.browser.navigateTab(target.id, url)
    else window.browser.createTabAt(url, target.index)
  })

  document.addEventListener('dragend', clearTarget)
}

/**
 * Share the strip between however many tabs exist. Tabs shrink from their
 * preferred width down to a favicon-sized stub, so opening a twenty-first tab
 * never pushes the earlier ones out of reach.
 */
function layoutTabs(): void {
  const count = state.tabs.length
  if (count === 0) return

  const strip = tabsEl.parentElement as HTMLElement
  const styles = getComputedStyle(strip)
  const padding = parseFloat(styles.paddingLeft) + parseFloat(styles.paddingRight)
  const plus = el('new-tab').offsetWidth + 8

  // Pinned tabs are a fixed size and group chips size to their name, so neither
  // takes part in sharing out the remaining width — they only consume it.
  const collapsed = new Set(state.groups.filter((g) => g.collapsed).map((g) => g.id))
  const flexible = state.tabs.filter(
    (tab) => !tab.pinned && !(tab.groupId !== null && collapsed.has(tab.groupId))
  )

  const pinnedWidth = state.tabs.filter((tab) => tab.pinned).length * (TAB_MIN_WIDTH + 4)
  const chipWidth = [...groupNodes.values()].reduce((total, chip) => total + chip.offsetWidth + 4, 0)

  const available = strip.clientWidth - padding - plus - pinnedWidth - chipWidth
  const gaps = 4 * Math.max(0, flexible.length - 1)
  const ideal = flexible.length > 0 ? (available - gaps) / flexible.length : TAB_MAX_WIDTH
  const width = Math.max(TAB_MIN_WIDTH, Math.min(TAB_MAX_WIDTH, ideal))

  tabsEl.style.setProperty('--tab-width', `${Math.floor(width)}px`)

  // Below the floor the tabs cannot shrink further, so the strip scrolls and
  // is capped at the space actually available to it.
  const scrolling = ideal < TAB_MIN_WIDTH
  tabsEl.classList.toggle('scrolling', scrolling)
  tabsEl.style.maxWidth = scrolling ? `${Math.max(0, available)}px` : ''

  // Chips size themselves; only tabs shrink.
  for (const node of tabsEl.querySelectorAll('.tab')) {
    node.classList.toggle('compact', width < 110)
    node.classList.toggle('tiny', width < 66)
  }

  // However far the strip has scrolled, the tab in use stays on screen.
  if (scrolling) {
    tabsEl.querySelector('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }
}

/**
 * Drag a tab along the strip to reorder it. The tab under the pointer decides
 * the drop index, so it works the same whether tabs are wide or shrunk to
 * favicons.
 */
function beginDrag(start: MouseEvent, id: number, node: HTMLElement): void {
  let dragging = false
  let tearing = false
  let lastIndex = -1

  // Where inside the tab it was grabbed, so it stays under the same point of
  // the cursor rather than jumping so its edge meets the pointer.
  const grabOffset = start.clientX - node.getBoundingClientRect().left

  /**
   * Put the tab under the cursor.
   *
   * Recomputed from the layout position every time rather than accumulated,
   * because reordering re-lays-out the strip underneath a drag in progress —
   * an accumulated offset would drift further out with every swap.
   */
  const follow = (pointerX: number): void => {
    const applied = Number(node.dataset['dragX'] ?? 0)
    const layoutLeft = node.getBoundingClientRect().left - applied
    const offset = pointerX - grabOffset - layoutLeft

    node.dataset['dragX'] = String(offset)
    node.style.transform = `translateX(${offset}px) scale(1.04)`
  }

  /** How many tabs the pointer has passed, which is where it would land. */
  const indexAt = (pointerX: number): number => {
    const tabs = [...tabsEl.querySelectorAll('.tab')] as HTMLElement[]
    let index = 0

    for (const tab of tabs) {
      if (tab === node) continue
      const box = tab.getBoundingClientRect()
      if (pointerX > box.left + box.width / 2) index++
    }

    return index
  }

  const move = (event: MouseEvent): void => {
    const movedX = Math.abs(event.clientX - start.clientX)
    const movedY = event.clientY - start.clientY

    if (!dragging && movedX < 6 && movedY < TEAR_OUT_DISTANCE) return

    if (!dragging) {
      dragging = true
      draggingId = id
      node.classList.add('dragging')
    }

    // Dragged well below the strip: the tab is being pulled into its own
    // window, so stop reordering and show that intent.
    tearing = movedY >= TEAR_OUT_DISTANCE
    node.classList.toggle('tearing', tearing)

    follow(event.clientX)
    if (tearing) return

    // The gap the other tabs open up is the indicator — the strip reorders
    // live, so what you see is where it will be when you let go.
    const index = indexAt(event.clientX)
    if (index !== lastIndex) {
      lastIndex = index
      window.browser.moveTab(id, index)
    }
  }

  const end = (): void => {
    document.removeEventListener('mousemove', move)
    document.removeEventListener('mouseup', end)

    draggingId = null
    node.classList.remove('dragging', 'tearing')

    if (tearing) {
      void window.browser.detachTab(id)
      return
    }

    // Settle into the slot instead of snapping, so the drop reads as landing.
    node.classList.add('settling')
    node.style.transform = ''
    delete node.dataset['dragX']
    window.setTimeout(() => node.classList.remove('settling'), 200)
  }

  document.addEventListener('mousemove', move)
  document.addEventListener('mouseup', end)
}

// --- command palette --------------------------------------------------------

interface PaletteItem {
  /** Shown on the left, in small caps. */
  group: string
  label: string
  detail?: string
  favicon?: string | null
  keys?: string
  run: () => void
}

let paletteItems: PaletteItem[] = []
let paletteSelected = 0
let closedTabs: ClosedTab[] = []

/**
 * Subsequence match, the way command palettes usually behave: the typed letters
 * must appear in order but need not be adjacent, and matches at the start of a
 * word score higher than matches in the middle of one.
 */
function fuzzyScore(text: string, query: string): number {
  if (!query) return 1

  const haystack = text.toLowerCase()
  const needle = query.toLowerCase()

  let score = 0
  let from = 0

  for (const char of needle) {
    const at = haystack.indexOf(char, from)
    if (at === -1) return 0

    const previous = at > 0 ? haystack[at - 1] : ''
    score += at === 0 || previous === ' ' || previous === '/' || previous === '.' ? 3 : 1
    from = at + 1
  }

  // Shorter labels win ties, so commands float above long page titles.
  return score + Math.max(0, 20 - text.length) / 20
}

function buildPaletteItems(): PaletteItem[] {
  const tab = activeTab()

  const commands: PaletteItem[] = [
    { group: msg('palette.groupTabs'), label: msg('toolbar.newTab'), keys: 'Ctrl+T', run: () => window.browser.createTab() },
    {
      group: msg('palette.groupTabs'),
      label: 'New amnesia tab',
      detail: 'Nothing from this tab is written down',
      keys: 'Ctrl+Shift+N',
      run: () => window.browser.createAmnesiaTab()
    },
    {
      group: msg('palette.groupTabs'),
      label: 'Close tab',
      keys: 'Ctrl+W',
      run: () => {
        if (state.activeTabId !== null) window.browser.closeTab(state.activeTabId)
      }
    },
    {
      group: msg('palette.groupTabs'),
      label: msg('palette.reopenLast'),
      keys: 'Ctrl+Shift+T',
      run: () => window.browser.reopenTab()
    },
    { group: msg('palette.groupPage'), label: 'Reload', keys: 'Ctrl+R', run: () => window.browser.reload() },
    {
      group: msg('palette.groupPage'),
      label: state.bookmarked ? 'Remove bookmark' : 'Bookmark this page',
      keys: 'Ctrl+D',
      run: () => window.browser.toggleBookmark()
    },
    {
      group: msg('palette.groupPage'),
      label: tab?.compat ? 'Turn off Compatibility Mode' : 'Compatibility Mode (MSIE 6.0)',
      run: () => window.browser.toggleCompat()
    },
    {
      group: msg('palette.groupPage'),
      label: 'Install this site as an app',
      detail: tab?.installable ? tab.installable.name : 'This site does not offer one',
      run: () => {
        if (tab?.installable) void window.browser.installApp()
      }
    },
    {
      group: msg('palette.groupPrivacy'),
      label: state.adblock.enabled ? 'Turn blocking off' : 'Turn blocking on',
      detail: `${state.adblock.session} blocked this session`,
      run: () => window.browser.toggleAdblock()
    },
    { group: msg('palette.groupOpen'), label: 'Settings', run: () => window.browser.createTab(SETTINGS_URL) },
    { group: msg('palette.groupOpen'), label: 'Manual', run: () => window.browser.createTab(HELP_URL) },
    {
      group: msg('palette.groupOpen'),
      label: msg('toolbar.bookmarks'),
      run: () => window.browser.createTab(BOOKMARKS_URL)
    },
    {
      group: msg('palette.groupOpen'),
      label: 'Downloads',
      run: () => {
        downloadsOpen = true
        shieldOpen = false
        void refreshDownloads()
      }
    },
    ...(state.splitTabId !== null
      ? [
          {
            group: msg('palette.groupView'),
            label: msg('palette.splitOff'),
            keys: 'Ctrl+Shift+E',
            run: () => window.browser.splitWith(null)
          },
          {
            group: msg('palette.groupView'),
            label: msg('palette.widenLeft'),
            run: () => window.browser.adjustSplit(0.1)
          },
          {
            group: msg('palette.groupView'),
            label: msg('palette.widenRight'),
            run: () => window.browser.adjustSplit(-0.1)
          }
        ]
      : state.tabs
          .filter((other) => other.id !== state.activeTabId)
          .slice(0, 5)
          .map((other) => ({
            group: msg('palette.groupView'),
            label: `${msg('palette.split')} ${other.title}`,
            detail: other.url,
            favicon: other.favicon,
            run: () => window.browser.splitWith(other.id)
          }))),
    {
      group: msg('palette.groupPage'),
      label: msg('palette.pip'),
      detail: msg('toolbar.pip'),
      keys: 'Ctrl+Shift+I',
      run: () => void window.browser.pictureInPicture()
    },
    { group: msg('palette.groupView'), label: 'DevTools', keys: 'F12', run: () => window.browser.toggleDevTools() }
  ]

  const openTabs: PaletteItem[] = state.tabs
    .filter((t) => t.id !== state.activeTabId)
    .map((t) => ({
      group: msg('palette.groupSwitchTo'),
      label: t.title,
      detail: t.url,
      favicon: t.favicon,
      run: () => window.browser.activateTab(t.id)
    }))

  const reopen: PaletteItem[] = closedTabs.map((t) => ({
    group: msg('palette.groupReopen'),
    label: t.title,
    detail: t.url,
    favicon: t.favicon,
    run: () => window.browser.reopenTab(t.id)
  }))

  return [...commands, ...openTabs, ...reopen]
}

function renderPalette(query: string): void {
  const all = buildPaletteItems()

  if (query) {
    paletteItems = all
      .map((item) => ({
        item,
        score: Math.max(fuzzyScore(item.label, query), fuzzyScore(item.group, query) * 0.6)
      }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 12)
      .map((entry) => entry.item)
  } else {
    // With nothing typed, where you have been beats a list of every command:
    // a few open tabs, a few to bring back, then the commands themselves.
    const switchTo = msg('palette.groupSwitchTo')
    const reopen = msg('palette.groupReopen')
    const tabsFirst = all.filter((item) => item.group === switchTo).slice(0, 4)
    const reopenNext = all.filter((item) => item.group === reopen).slice(0, 3)
    const commands = all.filter((item) => item.group !== switchTo && item.group !== reopen)

    paletteItems = [...tabsFirst, ...reopenNext, ...commands].slice(0, 12)
  }

  if (paletteSelected >= paletteItems.length) paletteSelected = 0

  paletteList.replaceChildren()

  if (paletteItems.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'palette-empty'
    empty.textContent = msg('palette.empty')
    paletteList.append(empty)
  }

  paletteItems.forEach((item, index) => {
    const node = document.createElement('div')
    node.className = index === paletteSelected ? 'palette-item selected' : 'palette-item'

    const group = document.createElement('span')
    group.className = 'group'
    group.textContent = item.group
    node.append(group)

    const body = document.createElement('div')
    body.className = 'body'

    const label = document.createElement('div')
    label.className = 'label'

    if (item.favicon) {
      const icon = document.createElement('img')
      icon.className = 'favicon'
      icon.src = item.favicon
      icon.addEventListener('error', () => icon.remove())
      label.append(icon)
    }

    label.append(document.createTextNode(item.label))
    body.append(label)

    if (item.detail) {
      const detail = document.createElement('div')
      detail.className = 'detail'
      detail.textContent = item.detail
      body.append(detail)
    }

    node.append(body)

    if (item.keys) {
      const keys = document.createElement('span')
      keys.className = 'keys'
      keys.textContent = item.keys
      node.append(keys)
    }

    node.addEventListener('mousedown', (event) => {
      event.preventDefault()
      runPaletteItem(index)
    })

    paletteList.append(node)
  })

  syncPanels()
}

function runPaletteItem(index: number): void {
  const item = paletteItems[index]
  const typed = paletteInput.value.trim()

  closePalette()

  // Nothing matched, but something was typed: fall back to a web search.
  if (!item) {
    if (typed) window.browser.navigate(typed)
    return
  }

  item.run()
}

async function openPalette(): Promise<void> {
  closedTabs = await window.browser.closedTabs()
  paletteOpen = true
  downloadsOpen = false
  shieldOpen = false
  paletteSelected = 0
  paletteInput.value = ''
  renderPalette('')
  paletteInput.focus()
}

function closePalette(): void {
  paletteOpen = false
  paletteItems = []
  paletteInput.blur()
  syncPanels()
}

async function refreshDownloads(): Promise<void> {
  state = { ...state, downloads: await window.browser.listDownloads() }
  renderDownloads()
  syncPanels()
}

/**
 * A group's own controls: its name, its colour, and what can be done to it as a
 * whole. Anchored under the chip that opened it.
 */
function openGroupPanel(groupId: number): void {
  const group = state.groups.find((g) => g.id === groupId)
  if (!group) return

  openGroupId = groupId
  groupNameInput.value = group.name
  renderGroupColours(group)
  syncPanels()

  // The name is the first thing you want to type after making a group.
  groupNameInput.focus()
  groupNameInput.select()
}

function closeGroupPanel(): void {
  if (openGroupId === null) return
  openGroupId = null
  syncPanels()
}

function renderGroupColours(group: TabGroup): void {
  groupColoursEl.replaceChildren()

  for (const id of GROUP_COLOUR_IDS) {
    const swatch = document.createElement('button')
    swatch.className = group.colour === id ? 'group-swatch on' : 'group-swatch'
    swatch.style.background = groupColour(id).fill
    swatch.title = groupColour(id).name
    swatch.addEventListener('click', () => {
      void window.browser.updateGroup(group.id, { colour: id })
    })
    groupColoursEl.append(swatch)
  }
}

groupNameInput.addEventListener('input', () => {
  if (openGroupId === null) return
  void window.browser.updateGroup(openGroupId, { name: groupNameInput.value })
})

groupNameInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === 'Escape') {
    event.preventDefault()
    closeGroupPanel()
  }
})

el('group-new-tab').addEventListener('click', () => {
  if (openGroupId === null) return
  void window.browser.newTabInGroup(openGroupId)
  closeGroupPanel()
})

el('group-ungroup').addEventListener('click', () => {
  if (openGroupId === null) return
  void window.browser.ungroup(openGroupId)
  closeGroupPanel()
})

el('group-close').addEventListener('click', () => {
  if (openGroupId === null) return
  void window.browser.closeGroup(openGroupId)
  closeGroupPanel()
})

/**
 * A brief message under the toolbar. Actions that otherwise leave no trace —
 * copying an address, capturing a screenshot, finding no video to float —
 * say so here rather than only changing a tooltip nobody is hovering over.
 */
let toastTimer: number | undefined

function toast(text: string): void {
  const node = el('toast')
  node.textContent = text
  node.hidden = false
  node.classList.remove('leaving')

  window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => {
    node.classList.add('leaving')
    window.setTimeout(() => {
      node.hidden = true
      node.classList.remove('leaving')
    }, 220)
  }, 1800)
}

/** Line icons, drawn once. They take their colour from the button. */
let iconsDrawn = false

function drawIcons(): void {
  if (iconsDrawn) return
  iconsDrawn = true

  for (const [id, name] of [
    ['back', 'back'],
    ['forward', 'forward'],
    ['home', 'home'],
    ['new-tab', 'plus'],
    ['install', 'install'],
    ['copy-link', 'link'],
    ['screenshot', 'camera'],
    ['pip', 'pip'],
    ['split', 'split'],
    ['qr', 'qr'],
    ['media', 'music'],
    ['bookmarks', 'bookmark'],
    ['downloads', 'download'],
    ['shield', 'shield'],
    ['amnesia', 'incognito'],
    ['settings', 'settings'],
    ['devtools', 'devtools'],
    ['help', 'help'],
    ['media-back', 'back10'],
    ['media-forward', 'forward10']
  ] as [string, string][]) {
    setIcon(el(id), name)
  }
}

/** Labels that live in the HTML rather than being built per render. */
function applyStaticText(): void {
  drawIcons()
  el('back').title = msg('toolbar.back')
  el('forward').title = msg('toolbar.forward')
  el('home').title = msg('toolbar.home')
  el('new-tab').title = msg('toolbar.newTab')
  el('copy-link').title = msg('toolbar.copyLink')
  el('screenshot').title = `${msg('toolbar.screenshot')} (Ctrl+Shift+S)`
  el('pip').title = `${msg('toolbar.pip')} (Ctrl+Shift+I)`
  el('split').title = `${msg('toolbar.split')} (Ctrl+Shift+E)`
  el('bookmarks').title = msg('toolbar.bookmarks')
  el('media').title = msg('toolbar.media')
  el('qr').title = msg('toolbar.qr')
  el('bm-manage').textContent = msg('panel.manageAll')
  el('downloads').title = msg('toolbar.downloads')
  el('compat').title = msg('toolbar.compat')
  el('amnesia').title = msg('toolbar.amnesia')
  el('settings').title = msg('toolbar.settings')
  el('devtools').title = msg('toolbar.devtools')
  el('help').title = msg('toolbar.help')
  omnibox.placeholder = msg('toolbar.omniboxPlaceholder')

  paletteInput.placeholder = msg('palette.placeholder')
  el('palette-footer').textContent = msg('palette.hint')
  el('dropdown-footer').textContent = msg('omnibox.footer')

  el('dl-clear').textContent = msg('panel.clearFinished')
  el('shot-close').textContent = msg('panel.close')
  el('shot-save').textContent = msg('panel.downloadPng')
}

function renderToolbar(): void {
  const tab = activeTab()

  backBtn.disabled = !tab?.canGoBack
  forwardBtn.disabled = !tab?.canGoForward
  setIcon(reloadBtn, tab?.loading ? 'stop' : 'reload')
  reloadBtn.title = tab?.loading ? msg('toolbar.stop') : msg('toolbar.reload')

  bookmarkBtn.classList.toggle('on', state.bookmarked)
  setIcon(bookmarkBtn, 'star')
  bookmarkBtn.classList.toggle('filled', state.bookmarked)

  shieldBtn.classList.toggle('off', !state.adblock.enabled)
  shieldBtn.title = state.adblock.enabled
    ? `Blocking — ${state.adblock.session} stopped since launch. Click for details.`
    : 'Blocking off. Click for details.'

  const installable = tab?.installable ?? null
  installBtn.hidden = installable === null
  installBtn.title = installable
    ? `Install ${installable.name} as an app`
    : 'Install this site as an app'

  const splitBtn = el('split')
  const inSplit = state.splitTabId !== null
  splitBtn.classList.toggle('on', inSplit)
  splitBtn.title = inSplit
    ? msg('toolbar.splitOff')
    : state.tabs.length < 2
      ? msg('toolbar.splitNeedsTwo')
      : `${msg('toolbar.split')} (Ctrl+Shift+E)`

  compatBtn.classList.toggle('on', !!tab?.compat)
  amnesiaBtn.classList.toggle('on', !!tab?.amnesia)

  // State the browser is in, stated plainly, where the URL is.
  if (tab?.amnesia) {
    badge.hidden = false
    badge.className = ''
    badge.textContent = msg('tab.amnesiaBadge')
  } else if (tab?.compat) {
    badge.hidden = false
    badge.className = 'compat'
    badge.textContent = 'MSIE 6.0'
  } else {
    badge.hidden = true
  }

  // Never stomp on what the user is currently typing.
  if (document.activeElement !== omnibox) {
    omnibox.value = tab && tab.url !== 'about:blank' ? tab.url : ''
  }
}

function applySettings(): void {
  // Fall back rather than throw: one missing field should never blank the UI.
  const settings = state.settings ?? DEFAULT_SETTINGS
  const { accent, showDevToolsButton, showCompatButton, showAmnesiaButton, animations } = settings

  applyTheme({ theme: settings.theme, accent })
  document.documentElement.classList.toggle('no-motion', !animations)

  el('home').hidden = !settings.showHomeButton
  el('copy-link').hidden = !settings.showCopyLinkButton
  el('screenshot').hidden = !settings.showScreenshotButton
  el('pip').hidden = !settings.showPipButton
  el('split').hidden = !settings.showSplitButton
  el('bookmarks').hidden = !settings.showBookmarksButton
  el('media').hidden = !settings.showMediaButton
  el('qr').hidden = !settings.showQrButton
  document.documentElement.dataset['omnibox'] = settings.omniboxWidth

  el('devtools').hidden = !showDevToolsButton
  compatBtn.hidden = !showCompatButton
  amnesiaBtn.hidden = !showAmnesiaButton
}

function render(next: BrowserState | null): void {
  if (!next) return
  state = next
  if (next.messages) messages = next.messages
  applySettings()
  applyStaticText()
  renderTabs()
  renderToolbar()
  renderDownloads()
  renderShield()
  if (downloadsOpen || shieldOpen) syncPanels()
}

// Omnibox dropdown

/**
 * FTS5 hands back snippets with the matched terms wrapped in brackets. Split on
 * those markers and build the highlight as real nodes — the snippet is page
 * text and must never be parsed as markup.
 */
function renderSnippet(target: HTMLElement, snippet: string): void {
  for (const part of snippet.split(/(\[[^\]]*\])/g)) {
    if (!part) continue
    if (part.startsWith('[') && part.endsWith(']')) {
      const mark = document.createElement('mark')
      mark.textContent = part.slice(1, -1)
      target.append(mark)
    } else {
      target.append(document.createTextNode(part))
    }
  }
}

/** Which line icon stands for each kind of suggestion. */
const SUGGESTION_ICONS: Record<string, string> = {
  search: 'search',
  history: 'clock',
  url: 'globe',
  fulltext: 'text'
}

/**
 * Write the suggestion's text with the part you have not typed yet in bold, so
 * the eye lands on what each row would add. Page-controlled text throughout:
 * inserted as text nodes, never as markup.
 */
function renderCompletion(target: HTMLElement, text: string, typed: string): void {
  const prefix = typed.trim().toLowerCase()

  if (!prefix || !text.toLowerCase().startsWith(prefix)) {
    target.textContent = text
    return
  }

  target.append(document.createTextNode(text.slice(0, prefix.length)))
  const rest = document.createElement('b')
  rest.textContent = text.slice(prefix.length)
  target.append(rest)
}

function renderSuggestions(): void {
  suggestionsEl.replaceChildren()
  const typed = omnibox.value

  suggestions.forEach((item, index) => {
    const node = document.createElement('div')
    node.className = index === selected ? 'suggestion selected' : 'suggestion'

    node.append(icon(SUGGESTION_ICONS[item.kind] ?? 'globe'))

    const body = document.createElement('div')
    body.className = 'body'

    // One line, the way every other browser does it: what the row is, then a
    // dimmed note of where it comes from. The old layout gave a wrapping column
    // of capitals a third of the width and pushed the answer to the right.
    const primary = document.createElement('div')
    primary.className = 'primary'

    const title = document.createElement('span')
    title.className = 'title'
    renderCompletion(title, item.title || item.url, typed)
    primary.append(title)

    const note = document.createElement('span')
    note.className = 'note'
    // The first row explains itself ("Go to", the engine's name); the rest are
    // told apart by their icon, and history shows where it goes instead.
    note.textContent =
      item.kind === 'history' || item.kind === 'fulltext'
        ? item.url
        : index === 0 || item.kind !== 'search'
          ? item.label
          : ''
    if (note.textContent) primary.append(note)

    body.append(primary)

    // Only the browser's own trick — a match in the page's text — earns a
    // second line.
    if (item.snippet) {
      const secondary = document.createElement('div')
      secondary.className = 'secondary snippet'
      renderSnippet(secondary, item.snippet)
      body.append(secondary)
    }

    node.append(body)

    // mousedown, not click: the omnibox blur would tear the list down first.
    node.addEventListener('mousedown', (event) => {
      event.preventDefault()
      go(item.url)
    })

    suggestionsEl.append(node)
  })

  syncPanels()
}

/**
 * The dropdown and the downloads panel share one strip of space below the
 * toolbar, and the chrome view is grown to fit whichever is showing. The
 * omnibox wins when both want to be open.
 */
/**
 * Panels are popovers anchored to whatever opened them: the dropdown lines up
 * with the omnibox, the others hang under their toolbar button. The chrome view
 * is then grown by just enough to show the panel, so it never covers more of
 * the page than it needs.
 */
function place(panel: HTMLElement, anchor: HTMLElement, width: number, align: 'left' | 'right'): void {
  const margin = 8
  const box = anchor.getBoundingClientRect()
  const room = document.documentElement.clientWidth

  const finalWidth = Math.min(width, room - margin * 2)
  const left =
    align === 'left'
      ? Math.min(box.left, room - finalWidth - margin)
      : Math.max(margin, box.right - finalWidth)

  panel.style.left = `${Math.max(margin, left)}px`
  panel.style.width = `${finalWidth}px`
}

function syncPanels(): void {
  const showPalette = paletteOpen
  const showDropdown = !showPalette && suggestions.length > 0
  const showDownloads = downloadsOpen && !showDropdown && !showPalette
  const showShield = shieldOpen && !showDropdown && !showDownloads && !showPalette
  const showShot = shotOpen && !showDropdown && !showPalette
  const showBookmarks = bookmarksOpen && !showDropdown && !showPalette
  const showMedia = mediaOpen && !showDropdown && !showPalette
  const showQr = qrOpen && !showDropdown && !showPalette
  const showGroup = openGroupId !== null && !showPalette

  palette.hidden = !showPalette
  dropdown.hidden = !showDropdown
  downloadsPanel.hidden = !showDownloads
  shieldPanel.hidden = !showShield
  shotPanel.hidden = !showShot
  bookmarksPanel.hidden = !showBookmarks
  mediaPanel.hidden = !showMedia
  qrPanel.hidden = !showQr
  groupPanel.hidden = !showGroup

  let visible: HTMLElement | null = null

  if (showPalette) {
    place(palette, omniboxWrap, Math.min(omniboxWrap.offsetWidth, 620), 'left')
    visible = palette
  } else if (showDropdown) {
    // As wide as the omnibox, capped so it stays readable on a wide monitor.
    place(dropdown, omniboxWrap, Math.min(omniboxWrap.offsetWidth, 560), 'left')
    visible = dropdown
  } else if (showDownloads) {
    place(downloadsPanel, el('downloads'), 320, 'right')
    visible = downloadsPanel
  } else if (showShield) {
    place(shieldPanel, shieldBtn, 296, 'right')
    visible = shieldPanel
  } else if (showShot) {
    place(shotPanel, el('screenshot'), 340, 'right')
    visible = shotPanel
  } else if (showBookmarks) {
    place(bookmarksPanel, el('bookmarks'), 340, 'right')
    visible = bookmarksPanel
  } else if (showMedia) {
    place(mediaPanel, el('media'), 320, 'right')
    visible = mediaPanel
  } else if (showQr) {
    place(qrPanel, el('qr'), 260, 'right')
    visible = qrPanel
  }

  // The group panel hangs off its chip in the strip rather than the toolbar, so
  // it is placed on its own and measured together with whatever else is open.
  if (showGroup && openGroupId !== null) {
    const chip = groupNodes.get(openGroupId)
    if (chip) place(groupPanel, chip, 240, 'left')
  }

  // 78px of offset for the panel top, plus a little breathing room below it.
  const groupHeight = showGroup ? groupPanel.offsetHeight + 52 : 0
  const panelHeight = visible ? visible.offsetHeight + 86 : 0
  window.browser.setDropdownHeight(Math.max(panelHeight, groupHeight))
}

function countCard(n: number, label: string): HTMLElement {
  const card = document.createElement('div')
  card.className = 'count'

  const value = document.createElement('div')
  value.className = 'n'
  value.textContent = nf.format(n)
  card.append(value)

  const text = document.createElement('div')
  text.className = 'l'
  text.textContent = label
  card.append(text)

  return card
}

function renderShield(): void {
  const { enabled, available, page, session, lifetime, top, site, siteOff } = state.adblock

  shieldToggle.classList.toggle('off', !enabled)
  shieldToggleLabel.textContent = enabled ? msg('panel.on') : msg('panel.off')

  // Filter lists sometimes break a site outright. Turning the shield off
  // everywhere is too blunt an answer, so the site in front gets its own switch.
  siteRow.hidden = !site || !enabled
  if (site) {
    siteName.textContent = site
    siteToggle.textContent = siteOff ? msg('panel.siteOn') : msg('panel.siteOff')
    siteToggle.classList.toggle('warn', siteOff)
  }

  shieldCounts.replaceChildren(
    countCard(page, msg('panel.thisPage')),
    countCard(session, msg('panel.thisSession')),
    countCard(lifetime, msg('panel.allTime'))
  )

  shieldTop.replaceChildren()
  const busiest = top[0]?.count ?? 0

  for (const entry of top) {
    const row = document.createElement('div')
    row.className = 'offender'
    row.style.position = 'relative'

    // A bar behind each row, scaled to the worst offender.
    const bar = document.createElement('div')
    bar.className = 'bar'
    bar.style.width = `${busiest > 0 ? Math.round((entry.count / busiest) * 100) : 0}%`
    row.append(bar)

    const domain = document.createElement('span')
    domain.className = 'd'
    domain.style.position = 'relative'
    domain.textContent = entry.domain
    row.append(domain)

    const count = document.createElement('span')
    count.className = 'c'
    count.style.position = 'relative'
    count.textContent = nf.format(entry.count)
    row.append(count)

    shieldTop.append(row)
  }

  shieldFooter.textContent = !available
    ? 'Filter lists unavailable. Nothing is being blocked.'
    : siteOff
      ? msg('panel.siteExcused')
      : !enabled
        ? msg('panel.blockingOff')
        : top.length === 0
          ? msg('panel.nothingBlocked')
          : `${top.length} domains tried. None got through.`
}

function renderDownloads(): void {
  const items = state.downloads

  dlCount.hidden = items.every((d) => d.state !== 'progressing')
  dlCount.textContent = String(items.filter((d) => d.state === 'progressing').length)

  dlList.replaceChildren()

  if (items.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'download'
    const status = document.createElement('div')
    status.className = 'status'
    status.textContent = msg('panel.noDownloads')
    empty.append(status)
    dlList.append(empty)
    return
  }

  for (const item of items) {
    const node = document.createElement('div')
    node.className = item.state === 'progressing' || item.state === 'completed'
      ? 'download'
      : 'download failed'

    const row = document.createElement('div')
    row.className = 'row'

    const name = document.createElement('span')
    name.className = 'name'
    name.textContent = item.filename
    name.title = item.url
    row.append(name)

    const status = document.createElement('span')
    status.className = 'status'
    status.textContent = describe(item)
    row.append(status)

    if (item.state === 'progressing') {
      const cancel = document.createElement('button')
      cancel.className = 'act'
      cancel.textContent = msg('panel.cancel')
      cancel.addEventListener('click', () => window.browser.cancelDownload(item.id))
      row.append(cancel)
    } else if (item.state === 'completed') {
      const reveal = document.createElement('button')
      reveal.className = 'act'
      reveal.textContent = msg('panel.showInFolder')
      reveal.addEventListener('click', () => window.browser.revealDownload(item.id))
      row.append(reveal)
    }

    node.append(row)

    if (item.state === 'progressing' && item.total > 0) {
      const bar = document.createElement('div')
      bar.className = 'bar'
      const fill = document.createElement('div')
      fill.style.width = `${Math.round((item.received / item.total) * 100)}%`
      bar.append(fill)
      node.append(bar)
    }

    dlList.append(node)
  }
}

function describe(item: DownloadState): string {
  switch (item.state) {
    case 'completed':
      return size(item.received)
    case 'cancelled':
      return 'cancelled'
    case 'interrupted':
      return 'failed'
    default:
      return item.total > 0
        ? `${size(item.received)} of ${size(item.total)}`
        : size(item.received)
  }
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function closeDropdown(): void {
  suggestions = []
  selected = -1
  renderSuggestions()
}

function closePanels(): void {
  qrOpen = false
  bookmarksOpen = false
  stopMediaPolling()
  mediaOpen = false
  downloadsOpen = false
  shieldOpen = false
  paletteOpen = false
  shotOpen = false
  closeDropdown()
}

/** Show what was just captured, with the option to keep it as a file. */
function showScreenshot(shot: { preview: string; width: number; height: number; bytes: number }): void {
  shotPreview.src = shot.preview
  shotInfo.textContent = `${shot.width}×${shot.height} · ${Math.max(1, Math.round(shot.bytes / 1024))} KB · on your clipboard`
  shotOpen = true
  downloadsOpen = false
  shieldOpen = false
  syncPanels()
}

function requestSuggestions(): void {
  window.clearTimeout(suggestTimer)
  const query = omnibox.value

  suggestTimer = window.setTimeout(async () => {
    if (document.activeElement !== omnibox) return
    const results = await window.browser.suggest(query)
    // A newer keystroke may have landed while we were waiting.
    if (omnibox.value !== query || document.activeElement !== omnibox) return
    suggestions = results
    selected = results.length > 0 ? 0 : -1
    renderSuggestions()
  }, 80)
}

/**
 * Engine autocomplete arrives on its own schedule, after the local results are
 * already on screen. It goes above the page-text matches — those are the slow,
 * considered answers — and never disturbs a selection the user has moved.
 */
window.browser.onExtraSuggestions(({ query, items }) => {
  if (omnibox.value !== query || document.activeElement !== omnibox) return
  if (suggestions.length === 0) return

  const known = new Set(suggestions.map((item) => item.url))
  const fresh = items.filter((item) => !known.has(item.url))
  if (fresh.length === 0) return

  const chosen = selected >= 0 ? suggestions[selected]?.url : undefined
  const at = suggestions.findIndex((item) => item.kind === 'fulltext')
  const cut = at === -1 ? suggestions.length : at

  suggestions = [...suggestions.slice(0, cut), ...fresh, ...suggestions.slice(cut)]

  // Keep the highlight on whatever it was on, now that the list has grown.
  const moved = suggestions.findIndex((item) => item.url === chosen)
  selected = moved === -1 ? (suggestions.length > 0 ? 0 : -1) : moved

  renderSuggestions()
})

function go(input: string): void {
  window.browser.navigate(input)
  closeDropdown()
  omnibox.blur()
}

function moveSelection(delta: number): void {
  if (suggestions.length === 0) return
  selected = (selected + delta + suggestions.length) % suggestions.length
  renderSuggestions()
}

// Events

el('new-tab').addEventListener('click', () => window.browser.createTab())
backBtn.addEventListener('click', () => window.browser.back())
forwardBtn.addEventListener('click', () => window.browser.forward())
reloadBtn.addEventListener('click', () => {
  if (activeTab()?.loading) window.browser.stop()
  else window.browser.reload()
})
bookmarkBtn.addEventListener('click', () => window.browser.toggleBookmark())

installBtn.addEventListener('click', async () => {
  const result = await window.browser.installApp()
  if (result) {
    installBtn.title = `${result.name} installed — shortcut on your desktop`
    installBtn.classList.add('done')
    window.setTimeout(() => installBtn.classList.remove('done'), 2500)
  }
})
compatBtn.addEventListener('click', () => window.browser.toggleCompat())
shieldBtn.addEventListener('click', () => {
  shieldOpen = !shieldOpen
  if (shieldOpen) downloadsOpen = false
  syncPanels()
})

shieldToggle.addEventListener('click', () => window.browser.toggleAdblock())

siteToggle.addEventListener('click', async () => {
  const off = await window.browser.toggleSiteBlocking()
  toast(off ? msg('panel.siteExcused') : msg('panel.siteRestored'))
})

el('downloads').addEventListener('click', async () => {
  downloadsOpen = !downloadsOpen
  if (downloadsOpen) shieldOpen = false

  // Ask for the current list rather than relying on a push having arrived.
  if (downloadsOpen) {
    state = { ...state, downloads: await window.browser.listDownloads() }
    renderDownloads()
  }

  syncPanels()
})

el('dl-clear').addEventListener('click', () => window.browser.clearDownloads())
amnesiaBtn.addEventListener('click', () => window.browser.createAmnesiaTab())
el('devtools').addEventListener('click', () => window.browser.toggleDevTools())
el('help').addEventListener('click', () => window.browser.createTab(HELP_URL))
el('home').addEventListener('click', () => window.browser.goHome())

el('copy-link').addEventListener('click', async () => {
  const url = await window.browser.copyLink()
  toast(url ? msg('toolbar.copied') : msg('toolbar.copyNothing'))
})

el('screenshot').addEventListener('click', async () => {
  const shot = await window.browser.screenshot()
  if (shot) showScreenshot(shot)
})

el('shot-close').addEventListener('click', () => {
  shotOpen = false
  syncPanels()
})

el('shot-save').addEventListener('click', async () => {
  const saved = await window.browser.saveScreenshot()
  if (saved) {
    toast(msg('panel.saved'))
    shotOpen = false
    syncPanels()
  }
})

window.browser.onScreenshot(showScreenshot)

/** Says so on the button when a page has nothing to float. */
function reportPip(result: string): void {
  const button = el('pip')

  if (result === 'entered' || result === 'exited') {
    button.classList.toggle('on', result === 'entered')
    return
  }

  // Nothing happened, so say why instead of leaving the click unanswered.
  button.classList.add('warn')
  window.setTimeout(() => button.classList.remove('warn'), 1800)
  toast(result === 'no-video' ? msg('toolbar.pipNoVideo') : msg('toolbar.pipUnavailable'))
}

/** The most recent saves, for getting back somewhere quickly. */
async function showBookmarks(): Promise<void> {
  const saved = await window.browser.listBookmarks()
  bmList.replaceChildren()

  if (saved.length === 0) {
    const empty = document.createElement('div')
    empty.id = 'bm-empty'
    empty.textContent = msg('panel.noBookmarks')
    bmList.append(empty)
  }

  // Grouped the way they were filed, so an imported tree is recognisable.
  const folders = new Map<string, typeof saved>()
  for (const entry of saved.slice(0, 14)) {
    const folder = entry.folder?.trim() || ''
    folders.set(folder, [...(folders.get(folder) ?? []), entry])
  }

  for (const [folder, entries] of [...folders].sort(([a], [b]) => a.localeCompare(b))) {
    if (folder && folders.size > 1) {
      const heading = document.createElement('div')
      heading.className = 'bm-folder'
      // Only the last part: the full path is too long for a panel this wide.
      heading.textContent = folder.split('/').pop() ?? folder
      bmList.append(heading)
    }

    for (const entry of entries) {
      const item = document.createElement('button')
      item.className = 'bm-item'
      // One line, like every bookmark list: the address is worth a tooltip, not
      // a second row of small grey text under every entry.
      item.title = entry.url
      item.append(icon('globe'))

      const title = document.createElement('span')
      title.className = 't'
      title.textContent = entry.title || entry.url
      item.append(title)

      item.addEventListener('click', () => {
        window.browser.navigate(entry.url)
        bookmarksOpen = false
        syncPanels()
      })

      bmList.append(item)
    }
  }

  bookmarksOpen = true
  downloadsOpen = false
  shieldOpen = false
  shotOpen = false
  syncPanels()
}

/** Seconds as m:ss, the way a player shows them. */
function clock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0:00"
  const total = Math.floor(seconds)
  const mins = Math.floor(total / 60)
  const secs = total % 60
  if (mins < 60) return mins + ":" + String(secs).padStart(2, "0")
  const hours = Math.floor(mins / 60)
  return hours + ":" + String(mins % 60).padStart(2, "0") + ":" + String(secs).padStart(2, "0")
}

function renderMedia(media: MediaState | null): void {
  const hasMedia = Boolean(media && media.hasMedia)

  const empty = el("media-empty")
  empty.hidden = hasMedia
  empty.textContent = msg("panel.nothingPlaying")

  el("media-bar").hidden = !hasMedia
  el("media-time").hidden = !hasMedia
  el("media-title").hidden = !hasMedia
  el("media-artist").hidden = !hasMedia

  for (const id of ["media-back", "media-toggle", "media-forward", "media-mute"]) {
    el<HTMLButtonElement>(id).disabled = !hasMedia
  }

  const art = el<HTMLImageElement>("media-art")
  if (!media || !media.hasMedia || !media.artwork) {
    art.hidden = true
  } else if (art.src !== media.artwork) {
    art.src = media.artwork
    art.hidden = false
  }

  if (!media || !media.hasMedia) return

  el("media-title").textContent = media.title
  el("media-artist").textContent = media.artist
  setIcon(el("media-toggle"), media.playing ? "pause" : "play")
  setIcon(el("media-mute"), media.muted ? "mute" : "volume")

  // A stream has no duration, so there is no progress to show for it.
  const live = media.duration <= 0
  el("media-time").textContent = live
    ? msg("panel.live")
    : clock(media.position) + " / " + clock(media.duration)
  el("media-fill").style.width = live
    ? "100%"
    : Math.min(100, (media.position / media.duration) * 100) + "%"
}

async function refreshMedia(): Promise<void> {
  renderMedia(await window.browser.media())
  if (mediaOpen) syncPanels()
}

function startMediaPolling(): void {
  window.clearInterval(mediaTimer)
  // Once a second is enough for a progress bar, and it stops when the panel does.
  mediaTimer = window.setInterval(() => void refreshMedia(), 1000)
}

function stopMediaPolling(): void {
  window.clearInterval(mediaTimer)
  mediaTimer = undefined
}

/**
 * Draw the current address as a QR code.
 *
 * Painted module by module onto a canvas rather than injected as markup, which
 * also gives us the PNG for saving. Colours come from the theme so it stays
 * readable in light and dark — a scanner needs the contrast either way.
 */
function drawQr(url: string): void {
  const canvas = el<HTMLCanvasElement>('qr-canvas')
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  // Error correction M: survives a little dirt on the screen without bloating
  // the code. Version 0 lets the library pick the smallest that fits.
  const code = qrcode(0, 'M')
  code.addData(url)
  code.make()

  const count = code.getModuleCount()
  const quiet = 4
  const size = canvas.width
  const scale = size / (count + quiet * 2)

  const styles = getComputedStyle(document.documentElement)
  const light = styles.getPropertyValue('--bg-elevated').trim() || '#ffffff'
  const dark = styles.getPropertyValue('--text').trim() || '#000000'

  ctx.fillStyle = light
  ctx.fillRect(0, 0, size, size)
  ctx.fillStyle = dark

  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (!code.isDark(row, col)) continue
      ctx.fillRect(
        Math.round((col + quiet) * scale),
        Math.round((row + quiet) * scale),
        Math.ceil(scale),
        Math.ceil(scale)
      )
    }
  }
}

function showQr(): void {
  const url = activeTab()?.url ?? ''
  if (!url) return

  drawQr(url)
  el('qr-url').textContent = url
  el('qr-hint').textContent = msg('panel.qrHint')
  el('qr-save').textContent = msg('panel.savePng')

  qrOpen = true
  mediaOpen = false
  bookmarksOpen = false
  downloadsOpen = false
  shieldOpen = false
  shotOpen = false
  syncPanels()
}

el('qr').addEventListener('click', () => {
  if (qrOpen) {
    qrOpen = false
    syncPanels()
    return
  }
  showQr()
})

el('qr-save').addEventListener('click', async () => {
  const canvas = el<HTMLCanvasElement>('qr-canvas')
  let host = 'page'
  try {
    host = new URL(activeTab()?.url ?? '').hostname.replace(/^www\./, '') || 'page'
  } catch {
    // Keep the fallback.
  }

  const saved = await window.browser.saveQr(canvas.toDataURL('image/png'), host)
  if (saved) {
    el('qr-save').textContent = msg('common.copied')
    window.setTimeout(() => (el('qr-save').textContent = msg('panel.savePng')), 1200)
  }
})

el("media").addEventListener("click", async () => {
  if (mediaOpen) {
    mediaOpen = false
    stopMediaPolling()
    syncPanels()
    return
  }

  mediaOpen = true
  bookmarksOpen = false
  downloadsOpen = false
  shieldOpen = false
  shotOpen = false
  await refreshMedia()
  startMediaPolling()
  syncPanels()
})

for (const [id, action] of [
  ["media-toggle", "toggle"],
  ["media-back", "back"],
  ["media-forward", "forward"],
  ["media-mute", "mute"]
] as [string, string][]) {
  el(id).addEventListener("click", async () => {
    await window.browser.controlMedia(action)
    await refreshMedia()
  })
}

el('bookmarks').addEventListener('click', () => {
  if (bookmarksOpen) {
    bookmarksOpen = false
    syncPanels()
    return
  }
  void showBookmarks()
})

el('bm-manage').addEventListener('click', () => {
  bookmarksOpen = false
  syncPanels()
  window.browser.createTab(BOOKMARKS_URL)
})

el('split').addEventListener('click', () => window.browser.toggleSplit())

el('pip').addEventListener('click', async () => {
  reportPip(await window.browser.pictureInPicture())
})

window.browser.onPip(reportPip)
el('settings').addEventListener('click', () => window.browser.createTab(SETTINGS_URL))

omnibox.addEventListener('input', requestSuggestions)
omnibox.addEventListener('focus', () => {
  omnibox.select()
  requestSuggestions()
})
omnibox.addEventListener('blur', closeDropdown)

omnibox.addEventListener('keydown', (event) => {
  switch (event.key) {
    case 'Enter':
      go(selected >= 0 ? suggestions[selected].url : omnibox.value)
      break
    case 'ArrowDown':
      event.preventDefault()
      moveSelection(1)
      break
    case 'ArrowUp':
      event.preventDefault()
      moveSelection(-1)
      break
    case 'Escape':
      closePanels()
      omnibox.blur()
      renderToolbar()
      break
    default:
      return
  }
})

// Shortcuts are resolved in the main process, since page content holds focus
// most of the time. Ctrl+L needs a hand back here to put the caret in place.
paletteInput.addEventListener('input', () => {
  paletteSelected = 0
  renderPalette(paletteInput.value.trim())
})

paletteInput.addEventListener('keydown', (event) => {
  switch (event.key) {
    case 'ArrowDown':
      event.preventDefault()
      paletteSelected = (paletteSelected + 1) % Math.max(1, paletteItems.length)
      renderPalette(paletteInput.value.trim())
      break
    case 'ArrowUp':
      event.preventDefault()
      paletteSelected =
        (paletteSelected - 1 + Math.max(1, paletteItems.length)) % Math.max(1, paletteItems.length)
      renderPalette(paletteInput.value.trim())
      break
    case 'Enter':
      event.preventDefault()
      runPaletteItem(paletteSelected)
      break
    case 'Escape':
      event.preventDefault()
      closePalette()
      break
    default:
      break
  }
})

paletteInput.addEventListener('blur', () => {
  if (paletteOpen) closePalette()
})

window.browser.onOpenPalette(() => void openPalette())

/**
 * Focusing the omnibox has to survive the page that is loading behind it:
 * Chromium focuses a document when it finishes, which would take the caret
 * away. One retry shortly after covers that race.
 */
function focusOmnibox(): void {
  omnibox.focus()
  omnibox.select()

  window.setTimeout(() => {
    if (document.activeElement !== omnibox) {
      omnibox.focus()
      omnibox.select()
    }
  }, 120)
}

// Anywhere outside the panel and its chip dismisses it, like the other popovers.
document.addEventListener('mousedown', (event) => {
  if (openGroupId === null) return
  const target = event.target as Node
  if (groupPanel.contains(target)) return
  if ([...groupNodes.values()].some((chip) => chip.contains(target))) return
  closeGroupPanel()
})

window.browser.onFocusOmnibox(focusOmnibox)

// Resizing the window changes how much room each tab gets.
window.addEventListener('resize', () => {
  layoutTabs()
  syncPanels()
})

// Any click outside a panel or its own button dismisses whatever is open.
document.addEventListener('mousedown', (event) => {
  const target = event.target as HTMLElement
  if (target.closest('#dropdown, #downloads-panel, #shield-panel')) return
  if (target.closest('#downloads, #shield, #omnibox-wrap')) return
  if (!downloadsOpen && !shieldOpen && suggestions.length === 0) return

  closePanels()
})

// Focus moving into the page (a click on the web content) closes them too.
window.addEventListener('blur', () => closePanels())

drawIcons()
applyStaticText()
setupTabDrop()

window.browser.onState(render)
window.browser.getState().then(render)
