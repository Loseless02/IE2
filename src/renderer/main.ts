import { DEFAULT_SETTINGS } from '../shared/settings'
import { applyTheme } from './theme'
import { icon, setIcon } from './icons'
import qrcode from 'qrcode-generator'
import { EN } from '../shared/i18n'
import {
  BOOKMARKS_BAR,
  BOOKMARKS_URL,
  HELP_URL,
  HISTORY_URL,
  HOME_URL,
  PASSWORDS_URL,
  SETTINGS_URL,
  type BookmarkEntry,
  type BrowserState,
  type ClosedTab,
  type DownloadState,
  type MediaState,
  type PasswordOffer,
  type PasswordsForPage,
  type PermissionKind,
  type PermissionRequest,
  type PublicIp,
  type SitePermission,
  type Suggestion,
  type TabGroup,
  type TabState
} from '../shared/types'
import { GROUP_COLOUR_IDS, groupColour } from '../shared/groups'
import { cleanFx, isNeutral, type AudioFxPreset } from '../shared/audiofx'
import { createFxPanel } from './fxpanel'
import { setSwitch } from './switch'
import {
  PRESETS as MOOD_PRESETS,
  getMood,
  liveLevel,
  moodLayers,
  playMood,
  setAnimate as setMoodAnimate,
  setLevel as setMoodLevel,
  setMaster as setMoodMaster,
  setPreset as setMoodPreset,
  setSleepTimer,
  setThunderRate,
  sleepEndsAt,
  stopMood,
  thunderNow
} from './mood'

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
const bmEditPanel = el('bm-edit-panel')
const mediaPanel = el('media-panel')
const qrPanel = el('qr-panel')
const barEl = el('bookmarks-bar')
const barFolderPanel = el('bar-folder-panel')
const shotPreview = el<HTMLImageElement>('shot-preview')
const shotInfo = el('shot-info')
const suggestionsEl = el('suggestions')
const findBar = el('find-bar')
const findInput = el<HTMLInputElement>('find-input')
const findCount = el('find-count')
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
  settings: DEFAULT_SETTINGS,
  sidebarOpen: false,
  bookmarksBarShown: false
}
let suggestions: Suggestion[] = []
let selected = -1

/**
 * The engine's autocomplete from the last answer. Local results come back per
 * keystroke without it, so carrying the ones that still match keeps the list
 * from shrinking and regrowing every time a key is pressed.
 */
let engineExtras: Suggestion[] = []

/**
 * The tallest the dropdown has been since it opened. The chrome view is only
 * ever grown while typing, never shrunk: resizing it repaints the whole strip,
 * and doing that on every keystroke is what made the list flash.
 */
let dropdownFloor = 0

/** The last edit added text, rather than deleting it. */
let lastInsert = false

/** When the omnibox was last typed in, so a focus bounce does not select it. */
let lastTypedAt = 0

/** Typed into since the address was last shown; cleared by going or giving up. */
let omniboxDirty = false
let omniboxTabId: number | null = null
let omniboxUrl = ''

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
let bmEditOpen = false
let ipOpen = false
/** The audio effects panel, and the presets saved for it. */
let fxOpen = false
let fxPresets: AudioFxPreset[] = []
/** The password manager's panel under the key. */
let pwOpen = false
/** The lock's panel: what the site in front may use. */
let siteOpen = false
/** Questions from sites, oldest first. One is shown at a time. */
let permQueue: PermissionRequest[] = []
let moodOpen = false
/** The tab and address the key in the omnibox was last worked out for. */
let lastPasswordTab: number | null = null
let lastPasswordUrl = ''
/** The toolbar tool whose tooltip is showing. */
let tipFor: HTMLElement | null = null
/** The page the star's editor is editing. */
let bmEditUrl = ''
/** The bookmarks bar folder whose list is open, if any. */
let barFolder: string | null = null
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

  // Drop the class two frames on, not one: the first frame's callbacks run
  // before the browser has ever drawn the tab in its starting state, so
  // removing it there meant nothing to animate from — and no animation.
  requestAnimationFrame(() => requestAnimationFrame(() => node.classList.remove('entering')))

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

  // Tabs that have gone slide out where they stand while the rest wait; only
  // then does the gap close. Closing tab 3 used to set every tab moving at
  // once, because the strip re-shared its width the moment the tab was gone.
  for (const [id, node] of [...tabNodes]) {
    if (wanted.has(id)) continue
    tabNodes.delete(id)
    node.classList.add('leaving')
    window.setTimeout(() => {
      node.classList.add('gone')
      layoutTabs()
    }, 150)
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

  // A tab dragged here from another window: mark the slot between tabs it
  // would land in, and tell the main process, which does the actual move.
  window.browser.onTabHover((x) => {
    if (x === null) {
      clearTarget()
      return
    }

    const tabs = [...tabsEl.querySelectorAll('.tab:not(.leaving)')] as HTMLElement[]
    const index = tabs.filter((tab) => {
      const box = tab.getBoundingClientRect()
      return x > box.left + box.width / 2
    }).length

    showTarget({ kind: 'open', index })
    void window.browser.setDropIndex(index)
  })
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

  // A tab still sliding out keeps its share until it has gone, so nothing
  // around it moves while it leaves.
  const departing = tabsEl.querySelectorAll('.tab.leaving:not(.gone)').length
  const sharing = flexible.length + departing

  const available = strip.clientWidth - padding - plus - pinnedWidth - chipWidth
  const gaps = 4 * Math.max(0, sharing - 1)
  const ideal = sharing > 0 ? (available - gaps) / sharing : TAB_MAX_WIDTH
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

  /**
   * Where the pointer is on screen while the tab is outside the strip, sent at
   * most once a frame. Another window's strip under it shows a drop marker.
   */
  let hoverQueued = false
  let hoverAt = { x: 0, y: 0 }
  const hover = (event: MouseEvent): void => {
    hoverAt = { x: event.screenX, y: event.screenY }
    if (hoverQueued) return
    hoverQueued = true
    requestAnimationFrame(() => {
      hoverQueued = false
      void window.browser.hoverTab(hoverAt.x, hoverAt.y)
    })
  }

  const move = (event: MouseEvent): void => {
    const movedX = Math.abs(event.clientX - start.clientX)
    const movedY = event.clientY - start.clientY
    // Past any edge of this window — towards another one, most likely.
    const outside =
      event.clientX < 0 || event.clientX > window.innerWidth || event.clientY < 0

    if (!dragging && movedX < 6 && movedY < TEAR_OUT_DISTANCE && !outside) return

    if (!dragging) {
      dragging = true
      draggingId = id
      node.classList.add('dragging')
    }

    // Dragged well below the strip or out of the window: the tab is leaving,
    // for another window's strip or a window of its own, so stop reordering.
    const wasTearing = tearing
    tearing = movedY >= TEAR_OUT_DISTANCE || outside
    node.classList.toggle('tearing', tearing)

    follow(event.clientX)

    // Coming back also reports once, which clears any marker left in another window.
    if (tearing || wasTearing) hover(event)
    if (tearing) return

    // The gap the other tabs open up is the indicator — the strip reorders
    // live, so what you see is where it will be when you let go.
    const index = indexAt(event.clientX)
    if (index !== lastIndex) {
      lastIndex = index
      window.browser.moveTab(id, index)
    }
  }

  // Settle into the slot instead of snapping, so the drop reads as landing.
  const settle = (): void => {
    node.classList.add('settling')
    node.style.transform = ''
    delete node.dataset['dragX']
    window.setTimeout(() => node.classList.remove('settling'), 200)
  }

  const end = (event: MouseEvent): void => {
    document.removeEventListener('mousemove', move)
    document.removeEventListener('mouseup', end)

    draggingId = null
    node.classList.remove('dragging', 'tearing')

    if (tearing) {
      // Refused (a lone tab dropped on nothing): it goes back where it was.
      void window.browser.dropTab(id, event.screenX, event.screenY).then((moved) => {
        if (!moved) settle()
      })
      return
    }

    settle()
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
      label: msg('find.placeholder'),
      keys: 'Ctrl+F',
      run: () => openFind()
    },
    {
      group: msg('palette.groupPage'),
      label: state.bookmarked ? 'Edit bookmark' : 'Bookmark this page',
      keys: 'Ctrl+D',
      run: () => void openBookmarkEditor()
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
      label: msg('toolbar.history'),
      run: () => window.browser.createTab(HISTORY_URL)
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
    ['reader', 'text'],
    ['pip', 'pip'],
    ['split', 'split'],
    ['qr', 'qr'],
    ['media', 'music'],
    ['mood', 'mood'],
    ['fx', 'fx'],
    ['site-perms', 'lock'],
    ['pw-key', 'key'],
    ['passwords', 'key'],
    ['ip', 'ip'],
    ['bookmarks', 'bookmark'],
    ['downloads', 'download'],
    ['shield', 'shield'],
    ['amnesia', 'incognito'],
    ['settings', 'settings'],
    ['devtools', 'devtools'],
    ['help', 'help'],
    ['find-prev', 'up'],
    ['find-next', 'down'],
    ['find-close', 'close'],
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

  findInput.placeholder = msg('find.placeholder')
  el('find-prev').title = `${msg('find.previous')} (Shift+Enter)`
  el('find-next').title = `${msg('find.next')} (Enter)`
  el('find-close').title = `${msg('panel.close')} (Esc)`

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
  bookmarkBtn.title = state.bookmarked ? 'Edit this bookmark (Ctrl+D)' : 'Bookmark this page (Ctrl+D)'

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
  el('bookmarks').classList.toggle('on', state.sidebarOpen)
  // Coming into view: let its items arrive, once.
  if (barEl.hidden && state.bookmarksBarShown) {
    barEl.classList.add('arrive')
    window.setTimeout(() => barEl.classList.remove('arrive'), 500)
  }
  barEl.hidden = !state.bookmarksBarShown
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

  // Never stomp on what the user is typing — but a different tab, or a page
  // that moved on, always shows its own address. Checking focus alone left a
  // stale address behind whenever the page took focus from the omnibox.
  const typing = document.activeElement === omnibox && document.hasFocus()
  if (state.activeTabId !== omniboxTabId) {
    omniboxTabId = state.activeTabId
    omniboxDirty = false
  } else if ((tab?.url ?? '') !== omniboxUrl && !typing) {
    // Typed, left unsent, and then the page went somewhere: show where it went.
    omniboxDirty = false
  }
  omniboxUrl = tab?.url ?? ''
  if (!omniboxDirty) {
    // The new tab page reads as empty, ready to type into.
    const shown = !tab || tab.url === 'about:blank' || tab.url.replace(/\/$/, '') === HOME_URL ? '' : tab.url
    if (omnibox.value !== shown) {
      omnibox.value = shown
      if (document.activeElement === omnibox && document.hasFocus()) omnibox.select()
    }
  }
}

function applySettings(): void {
  // Fall back rather than throw: one missing field should never blank the UI.
  const settings = state.settings ?? DEFAULT_SETTINGS
  const { accent, showDevToolsButton, showCompatButton, showAmnesiaButton, animations } = settings

  applyTheme({
    theme: settings.theme,
    accent,
    customTheme: settings.customTheme,
    useCustomTheme: settings.useCustomTheme
  })
  document.documentElement.classList.toggle('no-motion', !animations)

  el('home').hidden = !settings.showHomeButton
  el('copy-link').hidden = !settings.showCopyLinkButton
  el('screenshot').hidden = !settings.showScreenshotButton
  el('pip').hidden = !settings.showPipButton
  el('split').hidden = !settings.showSplitButton
  el('bookmarks').hidden = !settings.showBookmarksButton
  applyToolbarOrder(settings.toolbarOrder ?? [])
  el('media').hidden = !settings.showMediaButton
  el('qr').hidden = !settings.showQrButton
  el('mood').hidden = !settings.showMoodButton
  el('ip').hidden = !settings.showIpButton
  el('passwords').hidden = !settings.showPasswordsButton
  el('fx').hidden = !settings.showFxButton
  fxPresets = (Array.isArray(settings.audioPresets) ? settings.audioPresets : []).map((preset) => ({
    ...cleanFx(preset),
    name: String(preset?.name ?? 'Preset').slice(0, 30)
  }))
  document.documentElement.dataset['omnibox'] = settings.omniboxWidth

  el('devtools').hidden = !showDevToolsButton
  compatBtn.hidden = !showCompatButton
  amnesiaBtn.hidden = !showAmnesiaButton
}

function render(next: BrowserState | null): void {
  if (!next) return

  // A count describes one page. Switching tabs, or navigating the one in front,
  // leaves it describing something nobody is looking at, so the search is
  // dropped and the field left ready to run again on what is now there.
  const nextUrl = next.tabs.find((tab) => tab.id === next.activeTabId)?.url ?? ''
  if (findOpen && (next.activeTabId !== state.activeTabId || nextUrl !== findPageUrl)) resetFind()
  findPageUrl = nextUrl

  state = next
  if (next.messages) messages = next.messages
  applySettings()
  applyStaticText()
  renderTabs()
  renderToolbar()
  renderDownloads()
  renderShield()
  applyToolStates()
  void refreshSitePermissions()
  if (next.activeTabId !== lastPasswordTab || activeTab()?.url !== lastPasswordUrl) {
    lastPasswordTab = next.activeTabId
    lastPasswordUrl = activeTab()?.url ?? ''
    void refreshPasswordKey()
    void refreshFx()
  }
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
  const typed = typedText()

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
  const showBookmarks = bmEditOpen && !showDropdown && !showPalette
  const showBarFolder = barFolder !== null && !showDropdown && !showPalette
  const showIp = ipOpen && !showDropdown && !showPalette
  const showMood = moodOpen && !showDropdown && !showPalette
  const showSite = siteOpen && !showDropdown && !showPalette
  const showPw = pwOpen && !showDropdown && !showPalette
  const showFx = fxOpen && !showDropdown && !showPalette
  // A site's question stays up until it is answered, whatever else opens.
  const showPerm = permQueue.length > 0 && !showPalette && !showDropdown
  const showMedia = mediaOpen && !showDropdown && !showPalette
  const showQr = qrOpen && !showDropdown && !showPalette
  const showGroup = openGroupId !== null && !showPalette

  // The find bar is not part of the popover set: it stays put while the omnibox
  // dropdown or a panel opens over the same strip, because closing it would
  // throw away the search Chromium is still holding on the page.
  findBar.hidden = !findOpen

  // The empty tab strip is the window's title bar, and a press on a title bar
  // never reaches the page — so a popover could not be dismissed there. While
  // one is open the strip stops dragging the window, and the first press on it
  // closes the popover like a press anywhere else.
  const anyOpen =
    showDropdown || showDownloads || showShield || showShot || showBookmarks ||
    showMedia || showQr || showGroup || showBarFolder || showIp || showMood || showSite || showPerm || showPw || showFx
  document.documentElement.classList.toggle('popover-open', anyOpen)

  palette.hidden = !showPalette
  dropdown.hidden = !showDropdown
  downloadsPanel.hidden = !showDownloads
  shieldPanel.hidden = !showShield
  shotPanel.hidden = !showShot
  bmEditPanel.hidden = !showBookmarks
  barFolderPanel.hidden = !showBarFolder
  el('ip-panel').hidden = !showIp
  el('mood-panel').hidden = !showMood
  el('site-panel').hidden = !showSite
  el('pw-panel').hidden = !showPw
  el('fx-panel').hidden = !showFx
  el('perm-panel').hidden = !showPerm
  if (!showIp) maskIp()
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
    place(bmEditPanel, bookmarkBtn, 340, 'right')
    visible = bmEditPanel
  } else if (showFx) {
    place(el('fx-panel'), el('fx'), 330, 'right')
    visible = el('fx-panel')
  } else if (showPw) {
    place(el('pw-panel'), el('pw-key').hidden ? bookmarkBtn : el('pw-key'), 340, 'right')
    visible = el('pw-panel')
  } else if (showSite) {
    place(el('site-panel'), sitePermsBtn, 280, 'left')
    visible = el('site-panel')
  } else if (showIp) {
    place(el('ip-panel'), el('ip'), 300, 'right')
    visible = el('ip-panel')
  } else if (showMood) {
    place(el('mood-panel'), el('mood'), 470, 'right')
    visible = el('mood-panel')
  } else if (showBarFolder && barFolder !== null) {
    const anchor = barEl.querySelector<HTMLElement>(`[data-folder="${CSS.escape(barFolder)}"]`)
    place(barFolderPanel, anchor ?? barEl, 300, 'left')
    visible = barFolderPanel
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

  if (findOpen) place(findBar, el('toolbar'), 340, 'right')

  // 78px of offset for the panel top, plus a little breathing room below it.
  const groupHeight = showGroup ? groupPanel.offsetHeight + 52 : 0
  let panelHeight = visible ? visible.offsetHeight + 86 : 0
  if (visible === dropdown) {
    panelHeight = Math.max(panelHeight, dropdownFloor)
    dropdownFloor = panelHeight
  }
  const findHeight = findOpen ? findBar.offsetHeight + 86 : 0
  const tipHeight = tipFor ? el('tip').offsetHeight + 86 : 0
  if (showPerm) place(el('perm-panel'), omniboxWrap, 360, 'left')
  const permHeight = showPerm ? el('perm-panel').offsetHeight + 86 : 0
  window.browser.setDropdownHeight(Math.max(panelHeight, groupHeight, findHeight, tipHeight, permHeight))
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

  setSwitch(shieldToggle, enabled)
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
  engineExtras = []
  selected = -1
  dropdownFloor = 0
  renderSuggestions()
}

function closePanels(): void {
  qrOpen = false
  bmEditOpen = false
  // The folder's button was drawn as open; draw it closed again.
  if (barFolder !== null) {
    barFolder = null
    renderBookmarksBar()
  }
  ipOpen = false
  moodOpen = false
  siteOpen = false
  pwOpen = false
  fxOpen = false
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

/**
 * What the user actually typed: the omnibox's text minus an inline completion
 * still selected at its end.
 */
function typedText(): string {
  const { value, selectionStart, selectionEnd } = omnibox
  if (selectionStart !== null && selectionEnd === value.length && selectionStart < selectionEnd && inlineShown) {
    return value.slice(0, selectionStart)
  }
  return value
}

/** An inline completion is on screen, selected after what was typed. */
let inlineShown = false

/** What the suggestions on screen were worked out for. */
let suggestionsFor = ''

/**
 * Finish the address in place: "y" shows as "youtube.com" with "outube.com"
 * selected, so Enter goes there and the next key simply types over it.
 */
function showInline(query: string, completion: string): void {
  omnibox.value = query + completion.slice(query.length)
  omnibox.setSelectionRange(query.length, omnibox.value.length, 'backward')
  inlineShown = true
}

function requestSuggestions(): void {
  window.clearTimeout(suggestTimer)
  const query = typedText()

  suggestTimer = window.setTimeout(async () => {
    if (document.activeElement !== omnibox) return
    let results = await window.browser.suggest(query)
    // A newer keystroke may have landed while we were waiting.
    if (typedText() !== query || document.activeElement !== omnibox) return

    // Engine phrases from the previous keystroke that still extend what is
    // typed stay put until the engine answers for this one.
    const typed = query.trim().toLowerCase()
    engineExtras = engineExtras.filter((item) => item.title.toLowerCase().startsWith(typed))

    // Inline completion only follows typing forward: after Backspace the user
    // is removing it, so it is offered as the second row instead of filled in.
    const first = results[0]
    if (first?.inline) {
      const fits = query === query.trimStart() && first.inline.toLowerCase().startsWith(query.toLowerCase())
      if (fits && lastInsert) showInline(query, first.inline)
      else results = [...results.slice(1, 2), first, ...results.slice(2)]
    }

    suggestions = withExtras(results, engineExtras)
    suggestionsFor = query
    selected = suggestions.length > 0 ? 0 : -1
    if (suggestions.length === 0) dropdownFloor = 0
    renderSuggestions()
  }, 80)
}

/**
 * Engine autocomplete goes above the page-text matches — those are the slow,
 * considered answers — and after everything else.
 */
function withExtras(list: Suggestion[], extras: Suggestion[]): Suggestion[] {
  const known = new Set(list.map((item) => item.url))
  const fresh = extras.filter((item) => !known.has(item.url))
  if (list.length === 0 || fresh.length === 0) return list

  const at = list.findIndex((item) => item.kind === 'fulltext')
  const cut = at === -1 ? list.length : at
  return [...list.slice(0, cut), ...fresh, ...list.slice(cut)]
}

/**
 * Engine autocomplete arrives on its own schedule, after the local results are
 * already on screen. It replaces the phrases carried over from the last
 * keystroke and never disturbs a selection the user has moved.
 */
window.browser.onExtraSuggestions(({ query, items }) => {
  if (typedText() !== query || document.activeElement !== omnibox) return
  if (suggestions.length === 0) return

  const chosen = selected >= 0 ? suggestions[selected]?.url : undefined
  const carried = new Set(engineExtras)

  engineExtras = items
  suggestions = withExtras(
    suggestions.filter((item) => !carried.has(item)),
    items
  )

  // Keep the highlight on whatever it was on, now that the list has changed.
  const moved = suggestions.findIndex((item) => item.url === chosen)
  selected = moved === -1 ? (suggestions.length > 0 ? 0 : -1) : moved

  renderSuggestions()
})

function go(input: string): void {
  lastTypedAt = 0
  omniboxDirty = false
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

el('reader').addEventListener('click', async () => {
  const ok = await window.browser.readerMode()
  if (!ok) toast(msg('toolbar.readerNothing'))
})

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
  bmEditOpen = false
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
  bmEditOpen = false
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

// --- bookmarks: the star's editor and the bar under the toolbar -------------

const bmTitleInput = el<HTMLInputElement>('bm-edit-title')
const bmFolderSelect = el<HTMLSelectElement>('bm-edit-folder')
const bmNewFolderRow = el('bm-new-folder-row')
const bmNewFolderInput = el<HTMLInputElement>('bm-new-folder')

/** The folder select's "make a new one" entry, which no real path can equal. */
const NEW_FOLDER = '\u0000new'

/** Everything saved, as last fetched, for the bar and its folders. */
let allBookmarks: BookmarkEntry[] = []
let allFolders: string[] = []

/** The folder picked before "New folder…", which the new one goes inside. */
let bmParentFolder = BOOKMARKS_BAR

/** "Bookmarks bar/Dev" reads as "Bookmarks bar › Dev". */
function folderLabel(path: string): string {
  return path ? path.split('/').join(' › ') : 'Unfiled'
}

/** The page's own icon when history has one, the generic mark otherwise. */
function bookmarkIcon(entry: BookmarkEntry): Element {
  if (!entry.favicon) return icon('globe')
  const image = document.createElement('img')
  image.alt = ''
  image.src = entry.favicon
  image.addEventListener('error', () => image.replaceWith(icon('globe')))
  return image
}

/** Plain click opens here; middle or Ctrl+click opens a new tab. */
function openBookmark(url: string, event: MouseEvent): void {
  if (event.button === 1 || event.ctrlKey || event.metaKey) window.browser.createTab(url)
  else window.browser.navigate(url)
}

function fillFolderSelect(current: string): void {
  bmFolderSelect.replaceChildren()

  for (const path of allFolders) {
    const depth = path.split('/').length - 1
    const name = path.split('/').pop() ?? path
    // Nested folders are indented under their parent, so the tree is visible.
    bmFolderSelect.add(new Option(`${' '.repeat(depth)}${name}`, path, false, path === current))
  }
  bmFolderSelect.add(new Option('Unfiled', '', false, current === ''))
  bmFolderSelect.add(new Option('New folder…', NEW_FOLDER))
}

/**
 * The star. Saves the page straight into the bookmarks bar if it is not saved
 * yet, and opens the editor either way: it says where the page went, and lets
 * the name and the folder be changed on the spot.
 */
async function openBookmarkEditor(): Promise<void> {
  const result = await window.browser.editBookmark()
  if (!result) {
    toast('There is nothing on this page to bookmark.')
    return
  }

  const { entry, folders, created } = result
  allFolders = folders
  bmEditUrl = entry.url
  bmParentFolder = entry.folder || BOOKMARKS_BAR

  el('bm-edit-heading').textContent = created
    ? `Saved to ${folderLabel(entry.folder)}`
    : 'Edit bookmark'
  bmTitleInput.value = entry.title
  fillFolderSelect(entry.folder)
  bmNewFolderRow.hidden = true
  bmNewFolderInput.value = ''

  closeToolsExcept('bookmark')
  bmEditOpen = true
  syncPanels()
  bmTitleInput.focus()
  bmTitleInput.select()
}

/** Where the editor says the page should go, or null while a new folder is unnamed. */
function chosenFolder(): string | null {
  if (bmFolderSelect.value !== NEW_FOLDER) return bmFolderSelect.value
  const name = bmNewFolderInput.value.replace(/\//g, ' ').trim()
  if (!name) return null
  return bmParentFolder ? `${bmParentFolder}/${name}` : name
}

/** Edits are kept as they are made, so closing the editor never loses one. */
async function saveBookmarkEdit(): Promise<string | null> {
  if (!bmEditUrl) return null
  const folder = chosenFolder()
  if (folder === null) return null

  await window.browser.saveBookmark(bmEditUrl, {
    title: bmTitleInput.value.trim() || bmEditUrl,
    folder
  })
  return folder
}

async function finishBookmarkEdit(): Promise<void> {
  const folder = await saveBookmarkEdit()
  if (bmFolderSelect.value === NEW_FOLDER && folder === null) {
    bmNewFolderInput.focus()
    return
  }
  bmEditOpen = false
  syncPanels()
  if (folder !== null) toast(`Saved to ${folderLabel(folder)}`)
}

bookmarkBtn.addEventListener('click', () => void openBookmarkEditor())
window.browser.onEditBookmark(() => void openBookmarkEditor())

bmTitleInput.addEventListener('change', () => void saveBookmarkEdit())
bmNewFolderInput.addEventListener('change', () => void saveBookmarkEdit())

bmFolderSelect.addEventListener('change', async () => {
  const making = bmFolderSelect.value === NEW_FOLDER
  bmNewFolderRow.hidden = !making
  syncPanels()

  if (making) {
    bmNewFolderInput.placeholder = `Inside ${folderLabel(bmParentFolder)}`
    bmNewFolderInput.focus()
    return
  }

  bmParentFolder = bmFolderSelect.value
  const folder = await saveBookmarkEdit()
  if (folder !== null) el('bm-edit-heading').textContent = `Saved to ${folderLabel(folder)}`
})

for (const input of [bmTitleInput, bmNewFolderInput, bmFolderSelect]) {
  input.addEventListener('keydown', (event) => {
    const key = (event as KeyboardEvent).key
    if (key === 'Enter') {
      event.preventDefault()
      void finishBookmarkEdit()
    } else if (key === 'Escape') {
      event.preventDefault()
      bmEditOpen = false
      syncPanels()
    }
  })
}

el('bm-edit-done').addEventListener('click', () => void finishBookmarkEdit())

el('bm-edit-remove').addEventListener('click', async () => {
  if (!bmEditUrl) return
  await window.browser.removeBookmark(bmEditUrl)
  bmEditUrl = ''
  bmEditOpen = false
  syncPanels()
  toast('Bookmark removed')
})

el('bm-edit-all').addEventListener('click', async () => {
  await saveBookmarkEdit()
  bmEditOpen = false
  syncPanels()
  if (!state.sidebarOpen) void window.browser.toggleSidebar()
})

/** What is filed directly in the bar, and the folders inside it. */
function renderBookmarksBar(): void {
  barEl.replaceChildren()

  const prefix = `${BOOKMARKS_BAR}/`
  const inBar = allBookmarks
    .filter((entry) => entry.folder === BOOKMARKS_BAR)
    .sort((a, b) => a.createdAt - b.createdAt)

  const subfolders = [
    ...new Set(
      [...allFolders, ...allBookmarks.map((entry) => entry.folder)]
        .filter((path) => path.startsWith(prefix))
        .map((path) => path.slice(prefix.length).split('/')[0])
    )
  ].sort((a, b) => a.localeCompare(b))

  // Folders first, the way every other browser's bar puts them.
  for (const name of subfolders) {
    const path = prefix + name
    const button = document.createElement('button')
    button.className = barFolder === path ? 'bar-item folder open' : 'bar-item folder'
    button.dataset['folder'] = path
    button.title = name
    button.append(icon('folder'))
    const label = document.createElement('span')
    label.className = 't'
    label.textContent = name
    button.append(label)
    button.addEventListener('click', () => toggleBarFolder(path))
    barEl.append(button)
  }

  for (const entry of inBar) {
    const button = document.createElement('button')
    button.className = 'bar-item'
    // Page-controlled text: set as text, never markup.
    button.title = `${entry.title || entry.url}\n${entry.url}`
    button.append(bookmarkIcon(entry))
    const label = document.createElement('span')
    label.className = 't'
    label.textContent = entry.title || entry.url
    button.append(label)
    button.addEventListener('mouseup', (event) => {
      if (event.button === 0 || event.button === 1) openBookmark(entry.url, event)
    })
    barEl.append(button)
  }

  if (inBar.length === 0 && subfolders.length === 0) {
    const empty = document.createElement('span')
    empty.className = 'bar-empty'
    empty.textContent = 'Pages you save with the star appear here.'
    barEl.append(empty)
  }

  const spacer = document.createElement('span')
  spacer.className = 'bar-spacer'
  barEl.append(spacer)

  // Everything outside the bar — imports, other folders — is one click away too.
  if (allBookmarks.some((entry) => entry.folder !== BOOKMARKS_BAR && !entry.folder.startsWith(prefix))) {
    const others = document.createElement('button')
    others.className = 'bar-item folder'
    others.title = 'Every bookmark, in the sidebar'
    others.append(icon('folder'))
    const label = document.createElement('span')
    label.className = 't'
    label.textContent = 'All bookmarks'
    others.append(label)
    others.addEventListener('click', () => void window.browser.toggleSidebar())
    barEl.append(others)
  }
}

/** A wheel over the bar scrolls it sideways, since it only scrolls that way. */
barEl.addEventListener(
  'wheel',
  (event) => {
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return
    barEl.scrollLeft += event.deltaY
    event.preventDefault()
  },
  { passive: false }
)

function toggleBarFolder(path: string): void {
  barFolder = barFolder === path ? null : path
  if (barFolder) renderBarFolder(barFolder)
  renderBookmarksBar()
  syncPanels()
}

/** A bar folder's contents, subfolders under their own headings. */
function renderBarFolder(path: string): void {
  barFolderPanel.replaceChildren()

  const inside = allBookmarks.filter(
    (entry) => entry.folder === path || entry.folder.startsWith(`${path}/`)
  )

  if (inside.length === 0) {
    const empty = document.createElement('div')
    empty.id = 'bm-empty'
    empty.textContent = 'Nothing in this folder yet.'
    barFolderPanel.append(empty)
    return
  }

  const byFolder = new Map<string, BookmarkEntry[]>()
  for (const entry of inside) byFolder.set(entry.folder, [...(byFolder.get(entry.folder) ?? []), entry])

  for (const [folder, entries] of [...byFolder].sort(([a], [b]) => a.localeCompare(b))) {
    if (folder !== path) {
      const heading = document.createElement('div')
      heading.className = 'bm-folder'
      heading.append(icon('folder'))
      heading.append(document.createTextNode(folder.slice(path.length + 1).split('/').join(' › ')))
      barFolderPanel.append(heading)
    }

    for (const entry of entries) {
      const item = document.createElement('button')
      item.className = 'bm-item'
      item.title = entry.url
      item.append(bookmarkIcon(entry))
      const title = document.createElement('span')
      title.className = 't'
      title.textContent = entry.title || entry.url
      item.append(title)
      item.addEventListener('mouseup', (event) => {
        if (event.button !== 0 && event.button !== 1) return
        openBookmark(entry.url, event)
        barFolder = null
        renderBookmarksBar()
        syncPanels()
      })
      barFolderPanel.append(item)
    }
  }
}

async function refreshBookmarks(): Promise<void> {
  ;[allBookmarks, allFolders] = await Promise.all([
    window.browser.listBookmarks(),
    window.browser.bookmarkFolders()
  ])
  renderBookmarksBar()
  if (barFolder) renderBarFolder(barFolder)
}

window.browser.onBookmarksChanged(() => void refreshBookmarks())
void refreshBookmarks()

el('bookmarks').addEventListener('click', () => void window.browser.toggleSidebar())

el('split').addEventListener('click', () => window.browser.toggleSplit())

el('pip').addEventListener('click', async () => {
  reportPip(await window.browser.pictureInPicture())
})

window.browser.onPip(reportPip)
el('settings').addEventListener('click', () => window.browser.createTab(SETTINGS_URL))

omnibox.addEventListener('input', (event) => {
  lastTypedAt = Date.now()
  omniboxDirty = true
  inlineShown = false
  lastInsert = (event as InputEvent).inputType?.startsWith('insert') ?? true
  requestSuggestions()
})
omnibox.addEventListener('focus', () => {
  if (!typingRecently()) omnibox.select()
  requestSuggestions()
})
omnibox.addEventListener('blur', closeDropdown)

omnibox.addEventListener('keydown', (event) => {
  switch (event.key) {
    case 'Enter': {
      // The list may still be for an earlier keystroke — typing fast and
      // pressing Enter used to open whatever was first for a word since
      // replaced. Then what was typed is what counts.
      const current = suggestionsFor === typedText()
      go(current && selected >= 0 && suggestions[selected] ? suggestions[selected].url : typedText())
      break
    }
    case 'ArrowDown':
      event.preventDefault()
      moveSelection(1)
      break
    case 'ArrowUp':
      event.preventDefault()
      moveSelection(-1)
      break
    case 'Escape':
      // First press dismisses the suggestions and keeps what was typed; the
      // second gives the address back and leaves the field.
      if (suggestions.length > 0) {
        window.clearTimeout(suggestTimer)
        closeDropdown()
        break
      }
      closePanels()
      lastTypedAt = 0
      omniboxDirty = false
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
 * Find in page (Ctrl+F).
 *
 * Chromium does the searching, the highlighting and the scrolling; all this
 * does is drive `findInPage` and show the counts it sends back. The counts
 * arrive on an event rather than as a return value — Chromium refines them as
 * it walks the document — so the last message for a query wins.
 */
let findOpen = false

/** Matches for what is currently typed, as Chromium last reported them. */
let findMatches = 0
let findActive = 0

/** The page the counts belong to, so a navigation can invalidate them. */
let findPageUrl = ''

function renderFindCount(): void {
  const query = findInput.value
  const has = findMatches > 0

  findCount.textContent = !query ? '' : has ? `${findActive}/${findMatches}` : msg('find.none')
  findCount.classList.toggle('empty', Boolean(query) && !has)
  findBar.classList.toggle('no-match', Boolean(query) && !has)

  const dead = !query || !has
  el<HTMLButtonElement>('find-prev').disabled = dead
  el<HTMLButtonElement>('find-next').disabled = dead
}

/** Drop the highlight and the counts, keeping the bar and whatever is typed. */
function resetFind(): void {
  findMatches = 0
  findActive = 0
  void window.browser.stopFind()
  renderFindCount()
}

function runFind(findNext: boolean, forward = true): void {
  const query = findInput.value

  if (!query) {
    resetFind()
    return
  }

  void window.browser.find(query, { forward, findNext })
}

function openFind(): void {
  const wasOpen = findOpen
  findOpen = true
  syncPanels()

  // Ctrl+F on an already-open bar selects what is there, the way every other
  // browser does, so a second search can be typed straight over the first.
  findInput.focus()
  findInput.select()

  if (!wasOpen && findInput.value) runFind(false)
}

function closeFind(): void {
  if (!findOpen) return
  findOpen = false
  findMatches = 0
  findActive = 0
  void window.browser.stopFind()
  syncPanels()
}

findInput.addEventListener('input', () => {
  // A changed query starts over rather than stepping on from the last match.
  runFind(false)
  if (!findInput.value) renderFindCount()
})

findInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault()
    runFind(true, !event.shiftKey)
  } else if (event.key === 'Escape') {
    event.preventDefault()
    closeFind()
  }
})

el('find-prev').addEventListener('click', () => {
  runFind(true, false)
  findInput.focus()
})

el('find-next').addEventListener('click', () => {
  runFind(true, true)
  findInput.focus()
})

el('find-close').addEventListener('click', closeFind)

window.browser.onOpenFind(openFind)

window.browser.onFindResult((result) => {
  findMatches = result.matches
  findActive = result.active
  renderFindCount()
})

/**
 * Focusing the omnibox has to survive the page that is loading behind it:
 * Chromium focuses a document when it finishes, which would take the caret
 * away. One retry shortly after covers that race.
 */
function focusOmnibox(): void {
  omnibox.focus()
  // A page that grabs focus while it loads sends the caret back here mid-word;
  // selecting then would let the next key wipe out everything typed so far.
  if (!typingRecently()) omnibox.select()

  window.setTimeout(() => {
    if (document.activeElement !== omnibox) {
      omnibox.focus()
      if (!typingRecently()) omnibox.select()
    }
  }, 120)
}

/** Typed into within the last few seconds — longer than a new tab's load. */
function typingRecently(): boolean {
  return Date.now() - lastTypedAt < 3000
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

/** Each toolbar tool's popover, keyed by the id of the button that opens it. */
const TOOL_PANELS: Record<string, string> = {
  downloads: 'downloads-panel',
  shield: 'shield-panel',
  screenshot: 'shot-panel',
  bookmark: 'bm-edit-panel',
  media: 'media-panel',
  qr: 'qr-panel',
  ip: 'ip-panel',
  mood: 'mood-panel',
  'site-perms': 'site-panel',
  'pw-key': 'pw-panel',
  fx: 'fx-panel'
}

/** Close every tool popover except the one belonging to `keep`, if given. */
function closeToolsExcept(keep: string | null): void {
  if (keep !== 'downloads') downloadsOpen = false
  if (keep !== 'shield') shieldOpen = false
  if (keep !== 'screenshot') shotOpen = false
  if (keep !== 'bookmark') bmEditOpen = false
  if (keep !== 'bar-folder' && barFolder !== null) {
    barFolder = null
    renderBookmarksBar()
  }
  if (keep !== 'qr') qrOpen = false
  if (keep !== 'ip') ipOpen = false
  if (keep !== 'site-perms') siteOpen = false
  if (keep !== 'pw-key') pwOpen = false
  if (keep !== 'fx') fxOpen = false
  if (keep !== 'mood') moodOpen = false
  if (keep !== 'media' && mediaOpen) {
    mediaOpen = false
    stopMediaPolling()
  }
  syncPanels()
}

// One popover at a time. A click inside the open one leaves it alone; on its
// own button, that button's handler toggles it; anywhere else — another tool,
// the omnibox, an empty stretch of toolbar — closes it.
document.addEventListener('mousedown', (event) => {
  const target = event.target as HTMLElement
  const panels = Object.values(TOOL_PANELS).map((id) => `#${id}`).join(', ')
  if (target.closest(`#dropdown, #bar-folder-panel, ${panels}`)) return

  // A bar folder's own button toggles its list in its click handler.
  if (target.closest('.bar-item.folder[data-folder]')) {
    closeToolsExcept('bar-folder')
    return
  }

  const button = target.closest(Object.keys(TOOL_PANELS).map((id) => `#${id}`).join(', '))
  if (button) {
    closeToolsExcept(button.id)
    return
  }

  if (target.closest('#omnibox-wrap')) {
    closeToolsExcept(null)
    return
  }

  closePanels()
})

// Focus moving into the page (a click on the web content) closes them too.
window.addEventListener('blur', () => closePanels())

// --- site permissions --------------------------------------------------------

const PERMISSION_TEXT: Record<PermissionKind, { label: string; asks: string; icon: string }> = {
  camera: { label: 'Camera', asks: 'use your camera', icon: 'camera' },
  microphone: { label: 'Microphone', asks: 'use your microphone', icon: 'mic' },
  location: { label: 'Location', asks: 'know your location', icon: 'pin' },
  notifications: { label: 'Notifications', asks: 'show notifications', icon: 'bell' },
  clipboard: { label: 'Clipboard', asks: 'see what you copied', icon: 'copy' }
}


function hostOf(origin: string): string {
  try {
    return new URL(origin).host
  } catch {
    return origin
  }
}

function renderPermPrompt(): void {
  const request = permQueue[0]
  if (!request) return

  const icons = el('perm-icons')
  icons.replaceChildren(...request.kinds.map((kind) => icon(PERMISSION_TEXT[kind].icon)))

  const asks = request.kinds.map((kind) => PERMISSION_TEXT[kind].asks)
  const joined = asks.length > 1 ? `${asks.slice(0, -1).join(', ')} and ${asks[asks.length - 1]}` : asks[0]
  // The host is the page's, so it goes in as text.
  el('perm-text').textContent = `${hostOf(request.origin)} wants to ${joined}`

  el('perm-remember-row').hidden = request.amnesia
  el('perm-amnesia').hidden = !request.amnesia
  el<HTMLInputElement>('perm-remember').checked = true
}

window.browser.onPermissionRequest((request) => {
  permQueue = [...permQueue, request]
  renderPermPrompt()
  syncPanels()
})
void window.browser.pendingPermissions().then((requests) => {
  permQueue = [...requests]
  renderPermPrompt()
  syncPanels()
})

async function answerPermission(allow: boolean): Promise<void> {
  const request = permQueue[0]
  if (!request) return
  permQueue = permQueue.slice(1)
  await window.browser.answerPermission(
    request.id,
    allow,
    request.amnesia || el<HTMLInputElement>('perm-remember').checked
  )
  renderPermPrompt()
  syncPanels()
  void refreshSitePermissions(true)
}

el('perm-allow').addEventListener('click', () => void answerPermission(true))
el('perm-block').addEventListener('click', () => void answerPermission(false))

// --- the lock in the address bar ---

const sitePermsBtn = el<HTMLButtonElement>('site-perms')
let siteOrigin = ''
let siteDecisions: SitePermission[] = []

function activeOrigin(): string {
  try {
    const url = new URL(activeTab()?.url ?? '')
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : ''
  } catch {
    return ''
  }
}

/** Fetch the active site's decisions when the site changes, or when asked to. */
async function refreshSitePermissions(force = false): Promise<void> {
  const origin = activeOrigin()
  if (!force && origin === siteOrigin) return
  siteOrigin = origin
  siteDecisions = origin ? await window.browser.sitePermissions(origin) : []
  if (origin !== siteOrigin) return

  sitePermsBtn.hidden = !origin
  // Lit while the site holds something it was allowed, so it is visible at a glance.
  sitePermsBtn.classList.toggle('granted', siteDecisions.some((decision) => decision.allow))
  sitePermsBtn.title = siteDecisions.some((decision) => decision.allow)
    ? `${hostOf(origin)} may use: ${siteDecisions
        .filter((decision) => decision.allow)
        .map((decision) => PERMISSION_TEXT[decision.permission as PermissionKind]?.label ?? decision.permission)
        .join(', ')}`
    : 'What this site may use'
  if (siteOpen) renderSitePanel()
}

function renderSitePanel(): void {
  el('site-origin').textContent = hostOf(siteOrigin)
  const list = el('site-list')
  list.replaceChildren()

  for (const kind of Object.keys(PERMISSION_TEXT) as PermissionKind[]) {
    const decision = siteDecisions.find((entry) => entry.permission === kind)
    const row = document.createElement('label')
    row.className = 'site-row'
    row.append(icon(PERMISSION_TEXT[kind].icon))

    const name = document.createElement('span')
    name.textContent = PERMISSION_TEXT[kind].label
    row.append(name)

    const choice = document.createElement('select')
    choice.add(new Option('Ask', 'ask', false, !decision))
    choice.add(new Option('Allow', 'allow', false, decision?.allow === true))
    choice.add(new Option('Block', 'block', false, decision?.allow === false))
    choice.addEventListener('change', async () => {
      const allow = choice.value === 'ask' ? null : choice.value === 'allow'
      await window.browser.setSitePermission(siteOrigin, kind, allow)
      await refreshSitePermissions(true)
      toast(allow === null ? 'It will ask again next time' : 'Saved — reload the page if it is already open')
    })
    row.append(choice)
    list.append(row)
  }
}

sitePermsBtn.addEventListener('click', async () => {
  if (siteOpen) {
    siteOpen = false
    syncPanels()
    return
  }
  closeToolsExcept('site-perms')
  await refreshSitePermissions(true)
  siteOpen = true
  renderSitePanel()
  syncPanels()
})

// --- passwords ---------------------------------------------------------------

const pwKey = el<HTMLButtonElement>('pw-key')
const pwMaster = el<HTMLInputElement>('pw-master')
const pwMasterAgain = el<HTMLInputElement>('pw-master-again')

/** What the panel is doing: offering to keep a login, or filling one in. */
let pwMode: 'offer' | 'fill' = 'fill'
let pwOffer: PasswordOffer | null = null
let pwPage: PasswordsForPage | null = null

function pwHost(origin: string): string {
  try {
    return new URL(origin).host
  } catch {
    return origin
  }
}

/** The key in the address bar: there when this site has logins saved. */
async function refreshPasswordKey(): Promise<void> {
  pwPage = await window.browser.passwordsForPage()
  const has = (pwPage?.count ?? 0) > 0
  pwKey.hidden = !has
  pwKey.classList.toggle('ready', has && Boolean(pwPage?.hasForm))
  pwKey.title = has
    ? `${pwPage?.count} saved login${pwPage?.count === 1 ? '' : 's'} for ${pwHost(pwPage?.origin ?? '')}`
    : ''
  if (pwOpen && pwMode === 'fill') renderPasswordPanel()
}

function showMasterRow(vault: 'missing' | 'locked' | 'unlocked'): void {
  const row = el('pw-master-row')
  row.hidden = vault === 'unlocked'
  pwMasterAgain.hidden = vault !== 'missing'
  el('pw-master-hint').textContent =
    vault === 'missing'
      ? 'Choose a master password. It locks every saved password and cannot be recovered. At least 8 characters.'
      : 'Unlock with your master password.'
  el('pw-error').textContent = ''
}

function renderPasswordPanel(): void {
  const accounts = el('pw-accounts')
  accounts.replaceChildren()
  pwMaster.value = ''
  pwMasterAgain.value = ''

  if (pwMode === 'offer' && pwOffer) {
    const host = pwHost(pwOffer.origin)
    el('pw-title').textContent = pwOffer.update ? 'Update saved password?' : 'Save password?'
    // The username came from the page, so it goes in as text.
    el('pw-who').textContent = pwOffer.username ? `${pwOffer.username} on ${host}` : host
    showMasterRow(pwOffer.vault)
    el('pw-never').hidden = pwOffer.update
    el('pw-manage').hidden = true
    el('pw-later').hidden = false
    el('pw-go').textContent = pwOffer.update ? 'Update' : 'Save'
    return
  }

  const page = pwPage
  el('pw-title').textContent = 'Saved logins'
  el('pw-who').textContent = page ? pwHost(page.origin) : ''
  el('pw-never').hidden = true
  el('pw-manage').hidden = false
  el('pw-later').hidden = true

  if (!page || page.vault !== 'unlocked') {
    showMasterRow(page?.vault === 'missing' ? 'missing' : 'locked')
    el('pw-go').textContent = 'Unlock'
    el('pw-go').hidden = page?.vault === 'missing'
    return
  }

  el('pw-master-row').hidden = true
  el('pw-go').hidden = true
  for (const account of page.accounts) {
    const item = document.createElement('button')
    item.className = 'bm-item'
    item.append(icon('key'))
    const name = document.createElement('span')
    name.className = 't'
    name.textContent = account.username || '(no username)'
    item.append(name)
    item.addEventListener('click', async () => {
      const filled = await window.browser.fillPassword(account.id)
      pwOpen = false
      syncPanels()
      toast(filled ? 'Filled in' : 'This page has no login form to fill')
    })
    accounts.append(item)
  }
}

function openPasswordPanel(mode: 'offer' | 'fill'): void {
  pwMode = mode
  closeToolsExcept('pw-key')
  pwOpen = true
  el('pw-go').hidden = false
  renderPasswordPanel()
  syncPanels()
  if (!el('pw-master-row').hidden) pwMaster.focus()
}

window.browser.onPasswordOffer((offer) => {
  pwOffer = offer
  openPasswordPanel('offer')
})
window.browser.onPasswordsChanged(() => void refreshPasswordKey())

pwKey.addEventListener('click', async () => {
  if (pwOpen) {
    pwOpen = false
    syncPanels()
    return
  }
  await refreshPasswordKey()
  openPasswordPanel('fill')
})

async function passwordGo(): Promise<void> {
  const master = pwMaster.value

  if (pwMode === 'offer' && pwOffer) {
    if (pwOffer.vault === 'missing' && master !== pwMasterAgain.value) {
      el('pw-error').textContent = 'The two do not match.'
      return
    }
    const result = await window.browser.answerPasswordOffer('save', master || undefined)
    if (!result.ok) {
      el('pw-error').textContent = result.error ?? ''
      pwMaster.value = ''
      return
    }
    pwOffer = null
    pwOpen = false
    syncPanels()
    toast(result.updated ? 'Password updated' : 'Password saved')
    void refreshPasswordKey()
    return
  }

  const result = await window.browser.unlockPasswords(master)
  if (!result.ok) {
    el('pw-error').textContent = result.error ?? ''
    pwMaster.value = ''
    return
  }
  await refreshPasswordKey()
  renderPasswordPanel()
  syncPanels()
}

el('pw-go').addEventListener('click', () => void passwordGo())
for (const input of [pwMaster, pwMasterAgain]) {
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void passwordGo()
    if (event.key === 'Escape') {
      pwOpen = false
      syncPanels()
    }
  })
}

el('pw-later').addEventListener('click', () => {
  void window.browser.answerPasswordOffer('dismiss')
  pwOffer = null
  pwOpen = false
  syncPanels()
})

el('pw-never').addEventListener('click', () => {
  void window.browser.answerPasswordOffer('never')
  pwOffer = null
  pwOpen = false
  syncPanels()
  toast('IE2 will not offer to save passwords on this site')
})

el('pw-manage').addEventListener('click', () => {
  pwOpen = false
  syncPanels()
  window.browser.createTab(PASSWORDS_URL)
})

el('passwords').addEventListener('click', () => window.browser.createTab(PASSWORDS_URL))

// --- audio effects ---------------------------------------------------------

const fxPanel = createFxPanel(el('fx-panel'), {
  get: () => window.browser.audioFx(),
  set: (fx, remember) => window.browser.setAudioFx(fx, remember),
  presets: () => fxPresets,
  savePresets: (presets) => {
    fxPresets = presets
    void window.browser.saveAudioPresets(presets)
  },
  toast,
  resized: () => syncPanels(),
  changed: (fxState) => el('fx').classList.toggle('on', Boolean(fxState && !isNeutral(fxState.fx)))
})

async function refreshFx(): Promise<void> {
  await fxPanel.refresh()
}

el('fx').addEventListener('click', async () => {
  if (fxOpen) {
    fxOpen = false
    syncPanels()
    return
  }
  closeToolsExcept('fx')
  await fxPanel.open()
  fxOpen = true
  syncPanels()
})

window.browser.onAudioFxChanged(() => void refreshFx())

// --- Public IP -------------------------------------------------------------

let ipFound: PublicIp | null = null

/**
 * Masked again every time the panel goes away, however it goes — so opening it
 * with someone looking over a shoulder never shows the address by surprise.
 */
function maskIp(): void {
  el('ip-reveal').classList.add('masked')
  el('ip-hint').hidden = false
}

function renderIp(): void {
  const v4 = el('ip-v4')
  const v6 = el('ip-v6')
  if (!ipFound) {
    v4.textContent = 'Checking…'
    v6.textContent = ''
    el('ip-country').textContent = ''
    el('ip-when').textContent = ''
    return
  }
  v4.textContent = ipFound.v4 ?? (ipFound.failed ? 'Could not check — offline?' : 'None')
  v6.textContent = ipFound.v6 ?? 'None'
  el('ip-country').textContent = ipFound.country ? countryName(ipFound.country) : 'Unknown'
  el('ip-when').textContent = ipFound.failed
    ? ''
    : `Checked ${new Date(ipFound.checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
}

/** "TR" reads as "Türkiye (TR)", in the browser's own language list. */
function countryName(code: string): string {
  try {
    const name = new Intl.DisplayNames([navigator.language, 'en'], { type: 'region' }).of(code)
    return name && name !== code ? `${name} (${code})` : code
  } catch {
    return code
  }
}

async function checkIp(): Promise<void> {
  ipFound = null
  renderIp()
  syncPanels()
  ipFound = await window.browser.publicIp()
  renderIp()
  syncPanels()
}

el('ip').addEventListener('click', () => {
  if (ipOpen) {
    ipOpen = false
    syncPanels()
    return
  }
  closeToolsExcept('ip')
  ipOpen = true
  maskIp()
  void checkIp()
})

el('ip-reveal').addEventListener('click', () => {
  const masked = el('ip-reveal').classList.toggle('masked')
  el('ip-hint').hidden = !masked
})

el('ip-refresh').addEventListener('click', () => void checkIp())

el('ip-copy').addEventListener('click', async () => {
  const address = ipFound?.v4 ?? ipFound?.v6
  if (!address) return
  await navigator.clipboard.writeText(address)
  toast('Address copied')
})

// --- Mood ------------------------------------------------------------------

const moodMixer = el('mood-mixer')
const moodMeters = new Map<string, HTMLElement>()
let moodBuilt = false

function renderMoodControls(): void {
  const mood = getMood()
  el('mood-play').textContent = mood.playing ? 'Stop' : 'Play'
  el('mood-animate').setAttribute('aria-pressed', String(mood.animate))
  el('mood').classList.toggle('on', mood.playing)
  el<HTMLInputElement>('mood-master').value = String(mood.master)
  el<HTMLInputElement>('mood-rate').value = String(mood.thunderRate)

  for (const input of moodMixer.querySelectorAll<HTMLInputElement>('input[data-layer]')) {
    input.value = String(mood.levels[input.dataset['layer'] ?? ''] ?? 0)
  }

  const ends = sleepEndsAt()
  el('mood-timer-left').textContent =
    mood.playing && ends ? `stops at ${new Date(ends).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''
}

/** One vertical slider per layer, with its live level shaded behind it. */
async function buildMoodPanel(): Promise<void> {
  if (moodBuilt) return
  moodBuilt = true

  const preset = el<HTMLSelectElement>('mood-preset')
  preset.add(new Option('Presets…', ''))
  for (const name of Object.keys(MOOD_PRESETS)) preset.add(new Option(name, name))
  preset.addEventListener('change', () => {
    if (!preset.value) return
    setMoodPreset(preset.value)
    preset.value = ''
    renderMoodControls()
  })

  for (const layer of await moodLayers()) {
    const channel = document.createElement('div')
    channel.className = 'mood-ch'

    const track = document.createElement('div')
    track.className = 'mood-track'
    const meter = document.createElement('div')
    meter.className = 'mood-meter'
    const input = document.createElement('input')
    input.type = 'range'
    input.min = '0'
    input.max = '1'
    input.step = '0.01'
    input.dataset['layer'] = layer.id
    input.setAttribute('aria-label', layer.name)
    input.addEventListener('input', () => setMoodLevel(layer.id, Number(input.value)))
    track.append(meter, input)

    const name = document.createElement('div')
    name.className = 'mood-name'
    name.textContent = layer.name

    channel.append(track, name)
    moodMixer.append(channel)
    moodMeters.set(layer.id, meter)
  }

  renderMoodControls()
  syncPanels()
}

// The shaded level behind each slider follows Animate's drift while open.
window.setInterval(() => {
  if (!moodOpen) return
  for (const [id, meter] of moodMeters) meter.style.height = `${liveLevel(id) * 100}%`
}, 150)

el('mood').addEventListener('click', () => {
  if (moodOpen) {
    moodOpen = false
    syncPanels()
    return
  }
  closeToolsExcept('mood')
  moodOpen = true
  syncPanels()
  void buildMoodPanel().then(renderMoodControls)
})

el('mood-play').addEventListener('click', async () => {
  if (getMood().playing) stopMood()
  else await playMood()
  renderMoodControls()
})

el('mood-animate').addEventListener('click', () => {
  setMoodAnimate(!getMood().animate)
  renderMoodControls()
})

el('mood-thunder').addEventListener('click', async () => {
  await thunderNow()
  renderMoodControls()
})

el<HTMLInputElement>('mood-master').addEventListener('input', (event) =>
  setMoodMaster(Number((event.target as HTMLInputElement).value))
)
el<HTMLInputElement>('mood-rate').addEventListener('input', (event) =>
  setThunderRate(Number((event.target as HTMLInputElement).value))
)
el<HTMLSelectElement>('mood-timer').addEventListener('change', (event) => {
  setSleepTimer(Number((event.target as HTMLSelectElement).value), () => {
    el<HTMLSelectElement>('mood-timer').value = '0'
    renderMoodControls()
  })
  renderMoodControls()
})

// --- toolbar: what each tool is for, when it cannot be used, and its order --

interface ToolInfo {
  name: string
  purpose: string
  keys?: string
}

/** Shown when the pointer rests on a tool: what it is, and what it does. */
const TOOL_INFO: Record<string, ToolInfo> = {
  'copy-link': { name: 'Copy link', purpose: "Copies this page's address to the clipboard." },
  screenshot: {
    name: 'Screenshot',
    purpose: 'Captures what is on screen and copies it, ready to paste or save.',
    keys: 'Ctrl+Shift+S'
  },
  reader: { name: 'Reader mode', purpose: 'Strips the page down to just the article.' },
  pip: {
    name: 'Picture in picture',
    purpose: "Floats this page's video above your other windows.",
    keys: 'Ctrl+Shift+I'
  },
  split: { name: 'Split view', purpose: 'Shows this tab and the next one side by side.', keys: 'Ctrl+Shift+E' },
  qr: { name: 'QR code', purpose: 'Shows this page as a code your phone camera can open.' },
  media: { name: 'Now playing', purpose: 'Play, pause and skip whatever this tab is playing.' },
  mood: { name: 'Mood', purpose: 'Rain, wind and thunder in the background, mixed the way you like.' },
  fx: {
    name: 'Audio effects',
    purpose: 'Slowed, reverb, nightcore: change the speed, pitch, reverb and bass of what this tab plays.'
  },
  ip: { name: 'Public IP', purpose: 'The address websites see you coming from. Hidden until you reveal it.' },
  passwords: { name: 'Passwords', purpose: 'Saved logins, locked behind your master password.' },
  bookmarks: { name: 'Bookmarks', purpose: 'Opens every bookmark in a sidebar beside the page.' },
  downloads: { name: 'Downloads', purpose: 'Files you downloaded, and the ones still coming.' },
  shield: { name: 'Blocking', purpose: 'Ads and trackers stopped on this page, and a switch for this site.' },
  compat: { name: 'Compatibility Mode', purpose: 'Reloads the page pretending to be Internet Explorer 6.' },
  amnesia: { name: 'Amnesia tab', purpose: 'Opens a tab that writes nothing down.', keys: 'Ctrl+Shift+N' },
  devtools: { name: 'DevTools', purpose: 'Chromium developer tools for this page.', keys: 'F12' },
  settings: { name: 'Settings', purpose: 'Everything about how IE2 behaves and looks.' },
  help: { name: 'Manual', purpose: 'What every button does, and what it writes down.' }
}

/** The tools after the address bar, which can be dragged into any order. */
const REORDERABLE = Object.keys(TOOL_INFO)

/** Why a tool cannot be used on this page right now, or null when it can. */
function unavailableReason(id: string): string | null {
  const tab = activeTab()
  const url = tab?.url ?? ''
  const blank = !url || url === 'about:blank'
  const internal = blank || url.startsWith('ie2://')

  switch (id) {
    case 'copy-link':
      return blank ? 'This tab has no address yet.' : null
    case 'reader':
      return internal ? 'Works on articles from the web, not on browser pages.' : null
    case 'pip':
      return internal ? 'Needs a web page with a video on it.' : null
    case 'fx':
      return internal ? 'Works on sound and video playing on websites.' : null
    case 'qr':
      return internal ? 'Browser pages cannot be opened on a phone.' : null
    case 'split':
      return state.splitTabId === null && state.tabs.length < 2 ? 'Open a second tab first.' : null
    case 'compat':
      return internal ? 'Only websites can be shown the old way.' : null
    case 'screenshot':
      return blank ? 'Nothing on screen to capture yet.' : null
    default:
      return null
  }
}

/**
 * Grey out what cannot be used on this page — still visible, so it is not
 * mistaken for gone, and still answering a click with the reason. The native
 * tooltip is replaced by the fuller one below, so its text moves to the
 * accessible name.
 */
function applyToolStates(): void {
  for (const id of REORDERABLE) {
    const button = document.getElementById(id)
    if (!button) continue

    if (button.title) {
      button.setAttribute('aria-label', button.title)
      button.removeAttribute('title')
    }

    const reason = unavailableReason(id)
    button.classList.toggle('unavailable', reason !== null)
    button.setAttribute('aria-disabled', String(reason !== null))
    button.dataset['reason'] = reason ?? ''
  }
  if (tipFor) showTip(tipFor)
}

// A greyed-out tool says why instead of doing nothing.
el('toolbar').addEventListener(
  'click',
  (event) => {
    const button = (event.target as HTMLElement).closest('button')
    if (!button || button.getAttribute('aria-disabled') !== 'true') return
    event.stopImmediatePropagation()
    event.preventDefault()
    toast(button.dataset['reason'] || 'Not available here')
  },
  true
)

// --- the tooltip ---

const tip = el('tip')
let tipTimer: number | undefined

function showTip(button: HTMLElement): void {
  const info = TOOL_INFO[button.id]
  if (!info) return
  tipFor = button

  el('tip-name').textContent = info.keys ? `${info.name}  ·  ${info.keys}` : info.name
  el('tip-purpose').textContent = info.purpose
  const reason = button.dataset['reason'] ?? ''
  el('tip-reason').textContent = reason ? `Not available here: ${reason}` : ''
  el('tip-reason').hidden = !reason

  tip.hidden = false
  const box = button.getBoundingClientRect()
  const room = document.documentElement.clientWidth
  const width = Math.min(260, room - 16)
  tip.style.width = `${width}px`
  tip.style.left = `${Math.max(8, Math.min(room - width - 8, box.left + box.width / 2 - width / 2))}px`
  syncPanels()
}

function hideTip(): void {
  window.clearTimeout(tipTimer)
  if (!tipFor) return
  tipFor = null
  tip.hidden = true
  syncPanels()
}

for (const id of REORDERABLE) {
  const button = document.getElementById(id)
  if (!button) continue
  button.addEventListener('mouseenter', () => {
    window.clearTimeout(tipTimer)
    // Moving along the toolbar with one tip already up switches straight away.
    tipTimer = window.setTimeout(() => showTip(button), tipFor ? 0 : 450)
  })
  button.addEventListener('mouseleave', hideTip)
  button.addEventListener('mousedown', hideTip)
}

// --- reordering ---

function currentOrder(): string[] {
  return [...el('toolbar').children].map((node) => node.id).filter((id) => REORDERABLE.includes(id))
}

/** Put the tools in the saved order. Tools the order does not mention go last. */
function applyToolbarOrder(order: string[]): void {
  const known = order.filter((id) => REORDERABLE.includes(id) && document.getElementById(id))
  const wanted = [...known, ...currentOrder().filter((id) => !known.includes(id))]
  if (wanted.join() === currentOrder().join()) return

  const toolbar = el('toolbar')
  for (const id of wanted) toolbar.append(el(id))
}

function saveToolbarOrder(): void {
  void window.browser.setToolbarOrder(currentOrder())
}

/** Where the dragged tool belongs for a pointer at x: before the first tool whose middle is past it. */
function dropBefore(dragged: HTMLElement, x: number): HTMLElement | null {
  for (const id of currentOrder()) {
    const other = el(id)
    if (other === dragged || other.hidden) continue
    const box = other.getBoundingClientRect()
    if (x < box.left + box.width / 2) return other
  }
  return null
}

let suppressToolClick = false

/**
 * Press and hold a tool, then slide it along the toolbar. A plain click still
 * just uses the tool: the hold is what tells the two apart.
 */
el('toolbar').addEventListener('mousedown', (start) => {
  if (start.button !== 0) return
  const button = (start.target as HTMLElement).closest('button')
  if (!button || !REORDERABLE.includes(button.id)) return

  let lifted = false
  const timer = window.setTimeout(() => {
    lifted = true
    hideTip()
    closePanels()
    button.classList.add('lifted')
    document.documentElement.classList.add('reordering')
  }, 350)

  const move = (event: MouseEvent): void => {
    if (!lifted) {
      if (Math.abs(event.clientX - start.clientX) > 4 || Math.abs(event.clientY - start.clientY) > 4) {
        stop()
      }
      return
    }

    const before = dropBefore(button, event.clientX)
    const last = el(currentOrder().slice(-1)[0])
    if (before === button.nextElementSibling || (before === null && button === last)) return
    if (before) before.before(button)
    else last.after(button)
  }

  const stop = (): void => {
    window.clearTimeout(timer)
    document.removeEventListener('mousemove', move)
    document.removeEventListener('mouseup', stop)
    if (!lifted) return

    button.classList.remove('lifted')
    document.documentElement.classList.remove('reordering')
    // The release lands as a click on the tool; it was a move, not a use.
    suppressToolClick = true
    window.setTimeout(() => (suppressToolClick = false), 0)
    saveToolbarOrder()
  }

  document.addEventListener('mousemove', move)
  document.addEventListener('mouseup', stop)
})

el('toolbar').addEventListener(
  'click',
  (event) => {
    if (!suppressToolClick) return
    event.stopImmediatePropagation()
    event.preventDefault()
  },
  true
)

// The same without a mouse: Alt+Shift+Left or Right moves the focused tool.
el('toolbar').addEventListener('keydown', (event) => {
  if (!event.altKey || !event.shiftKey) return
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
  const button = (event.target as HTMLElement).closest('button')
  if (!button || !REORDERABLE.includes(button.id)) return

  event.preventDefault()
  const order = currentOrder().filter((id) => !el(id).hidden)
  const at = order.indexOf(button.id)
  const to = order[at + (event.key === 'ArrowLeft' ? -1 : 1)]
  if (!to) return
  if (event.key === 'ArrowLeft') el(to).before(button)
  else el(to).after(button)
  button.focus()
  saveToolbarOrder()
})

drawIcons()
applyStaticText()
setupTabDrop()

// The opening animation: the main process has already made this view cover
// the window. Play, fade, and hand the window back.
void window.browser.booting().then((booting) => {
  if (!booting) return
  const boot = el('boot')
  boot.hidden = false
  window.setTimeout(() => boot.classList.add('leaving'), 1050)
  window.setTimeout(() => {
    boot.hidden = true
    void window.browser.booted()
  }, 1400)
})

window.browser.onState(render)
window.browser.getState().then(render)
