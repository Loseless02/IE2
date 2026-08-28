import type { HistoryHit, RecallStats } from '../shared/types'
import { IMAGE_FITS, toHex, type Settings } from '../shared/settings'
import { applyTheme } from './theme'
import { setIcon } from './icons'
import { confirmDialog } from './dialog'
import { BUILT_IN_WALLPAPERS } from '../shared/wallpapers'
import { buildLabel } from '../shared/build'
import { uiKey } from '../shared/i18n'

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

const input = el<HTMLInputElement>('recall-input')
const results = el('recall-results')
const statsEl = el('stats')
const recentList = el('recent-list')
const verdict = el('verdict')

let timer: number | undefined

/**
 * The page's wording. Its keys have been in the catalogue all along; the page
 * simply never asked for them, so it stayed English in every language.
 */
let messages: Record<string, string> = {}

function msg(key: string, fallback: string): string {
  return messages[key] ?? fallback
}

/**
 * For wording that lives here rather than in the catalogue file: the key comes
 * from the English text, exactly as the Settings page does it, so the tooltips
 * and the deadpan commentary can be translated too.
 */
function t(text: string): string {
  return messages[uiKey(text)] ?? text
}

const nf = new Intl.NumberFormat()

/** Placeholder mark for sites with no usable favicon. */
function dot(): HTMLElement {
  const span = document.createElement('span')
  span.className = 'favicon placeholder'
  return span
}

/** Keeps the card one line: drop www, and trim anything still too long. */
function shortHost(host: string | null): string {
  if (!host) return '—'
  const clean = host.replace(/^www\./, '')
  return clean.length > 18 ? `${clean.slice(0, 17)}…` : clean
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

/**
 * One figure on the new tab page. `hint` becomes the tooltip, which is where
 * anything estimated says so plainly.
 */
function statCard(
  value: string,
  label: string,
  hint?: string,
  onClick?: () => void
): HTMLElement {
  const card = document.createElement(onClick ? 'button' : 'div')
  card.className = onClick ? 'stat clickable' : 'stat'
  if (hint) card.title = hint

  const v = document.createElement('div')
  v.className = 'value'
  v.textContent = value
  card.append(v)

  const l = document.createElement('div')
  l.className = 'label'
  l.textContent = label
  card.append(l)

  if (onClick) card.addEventListener('click', onClick)

  return card
}

/**
 * Roughly how long the blocked requests would have taken to fetch. An estimate,
 * and labelled as one: a blocked request is not simply a fixed saving, but the
 * order of magnitude is honest and it is derived from a real count.
 */
const MS_PER_BLOCKED_REQUEST = 45

/** Likewise for bytes — an average third-party payload, not a measurement. */
const KB_PER_BLOCKED_REQUEST = 55

function duration(ms: number): string {
  if (ms < 1000) return '0s'
  const seconds = Math.round(ms / 1000)
  if (seconds < 90) return `${seconds}s`

  const minutes = Math.round(seconds / 60)
  if (minutes < 90) return `${minutes}m`

  const hours = minutes / 60
  return hours < 24 ? `${hours.toFixed(1)}h` : `${Math.round(hours / 24)}d`
}

function dataSize(kb: number): string {
  if (kb < 1024) return `${Math.round(kb)} KB`
  const mb = kb / 1024
  return mb < 1024 ? `${mb.toFixed(1)} MB` : `${(mb / 1024).toFixed(2)} GB`
}

function renderStats(stats: RecallStats): void {
  const days = stats.oldestVisit
    ? Math.max(1, Math.round((Date.now() - stats.oldestVisit) / 86_400_000))
    : 0

  const cards: HTMLElement[] = [
    statCard(nf.format(stats.pages), msg('home.pagesKept', 'pages kept'), t('Pages whose text is searchable here.')),
    statCard(nf.format(stats.words), msg('home.wordsRead', 'words read'), t('Estimated from the text captured, at about 5.5 characters a word.')),
    statCard(nf.format(stats.visits), msg('home.visitsLogged', 'visits logged'), t('Every time you opened a page, not just distinct pages.')),
    statCard(nf.format(stats.blocked), msg('home.adsDenied', 'ads denied a life'), t('Requests the blocker stopped, all time.')),
    statCard(
      nf.format(stats.blockedThirdParty),
      msg('home.trackersStopped', 'cross-site trackers stopped'),
      t('Of those, the ones calling a different site than the page you were on — the tracking requests.')
    ),
    statCard(
      duration(stats.blocked * MS_PER_BLOCKED_REQUEST),
      msg('home.timeSaved', 'time not spent loading'),
      `An estimate: about ${MS_PER_BLOCKED_REQUEST}ms per blocked request.`
    ),
    statCard(
      dataSize(stats.blocked * KB_PER_BLOCKED_REQUEST),
      msg('home.dataSaved', 'data not downloaded'),
      `An estimate: about ${KB_PER_BLOCKED_REQUEST}KB per blocked request.`
    ),
    statCard(
      nf.format(stats.cookies),
      msg('home.cookiesHeld', 'cookies sites are holding'),
      t('Cookies stored right now in the normal browsing session. Amnesia tabs keep their own, and throw them away.')
    ),
    statCard(nf.format(stats.searches), msg('home.searchesRemembered', 'searches remembered'), t('Distinct searches, including any imported from another browser.')),
    statCard(nf.format(stats.bookmarks), msg('home.bookmarks', 'bookmarks'), t('Saved pages. These survive Forget everything.'))
  ]

  if (stats.topHost) {
    // Pressable: it goes straight to the site.
    cards.push(
      statCard(
        shortHost(stats.topHost),
        msg('home.favourite', 'your favourite, apparently'),
        `Open ${stats.topHost} — visited ${stats.topHostVisits} times.`,
        () => window.ie2.open(`https://${stats.topHost}`)
      )
    )
  }

  statsEl.replaceChildren(...cards)
  verdict.textContent = pickVerdict(stats, days)
}

/** Deadpan commentary. Accurate, which is the unpleasant part. */
function pickVerdict(stats: RecallStats, days: number): string {
  if (stats.pages === 0) return t('Nothing recorded yet. Enjoy it while it lasts.')
  if (stats.words > 1_000_000) return `${nf.format(stats.words)} words in ${days} days. Retention: unverified.`
  if (stats.topHostVisits > 20 && stats.topHost)
    return `You have opened ${stats.topHost} ${stats.topHostVisits} times. No judgement. Some judgement.`
  return `Archived over ${days} ${days === 1 ? 'day' : 'days'}. Every word still here.`
}

function renderHits(
  target: HTMLElement,
  hits: HistoryHit[],
  emptyText: string,
  removable = false
): void {
  target.replaceChildren()

  const showEmpty = (): void => {
    const empty = document.createElement('div')
    empty.className = 'empty'
    empty.textContent = emptyText
    target.append(empty)
  }

  if (hits.length === 0) {
    showEmpty()
    return
  }

  for (const hit of hits) {
    const node = document.createElement('div')
    node.className = 'hit'
    node.addEventListener('click', () => window.ie2.open(hit.url))

    const head = document.createElement('div')
    head.className = 'head'

    // A favicon instead of the URL: every row stays the same height and the
    // card never has a long address spilling out of it.
    if (hit.favicon) {
      const icon = document.createElement('img')
      icon.className = 'favicon'
      icon.src = hit.favicon
      icon.addEventListener('error', () => icon.replaceWith(dot()))
      head.append(icon)
    } else {
      head.append(dot())
    }

    const title = document.createElement('div')
    title.className = 'title'
    title.textContent = hit.title || hostOf(hit.url)
    title.title = hit.url
    head.append(title)

    if (removable) {
      const remove = document.createElement('button')
      remove.className = 'hit-remove'
      remove.type = 'button'
      remove.textContent = '×'
      remove.title = t('Remove from history. What the page said is kept.')

      remove.addEventListener('click', async (event) => {
        // The row itself opens the page; the button must not.
        event.stopPropagation()
        remove.disabled = true

        await window.ie2.forgetVisits([hit.url])

        // A height has to be on the node before it can be animated to zero;
        // `auto` is not a value anything can transition from.
        node.style.maxHeight = `${node.offsetHeight}px`
        void node.offsetHeight
        node.classList.add('leaving')
        window.setTimeout(() => {
          node.remove()
          if (target.children.length === 0) showEmpty()
        }, 180)

        // The counts on this page describe the history that just changed.
        void window.ie2.stats().then(renderStats)
      })

      head.append(remove)
    }

    node.append(head)

    if (hit.snippet) {
      const snippet = document.createElement('div')
      snippet.className = 'snippet'
      // Captured page text: built as nodes, never parsed as markup.
      for (const part of hit.snippet.split(/(\[[^\]]*\])/g)) {
        if (!part) continue
        if (part.startsWith('[') && part.endsWith(']')) {
          const mark = document.createElement('mark')
          mark.textContent = part.slice(1, -1)
          snippet.append(mark)
        } else {
          snippet.append(document.createTextNode(part))
        }
      }
      node.append(snippet)
    }

    target.append(node)
  }
}

input.addEventListener('input', () => {
  window.clearTimeout(timer)
  const query = input.value.trim()

  if (!query) {
    results.replaceChildren()
    return
  }

  timer = window.setTimeout(async () => {
    const hits = await window.ie2.recall(query)
    if (input.value.trim() !== query) return
    renderHits(results, hits, msg('home.noMatch', 'Not in the archive. You never read this. Allegedly.'))
  }, 100)
})

el('recent-all').addEventListener('click', () => window.ie2.open('ie2://history'))

el('forget-all').addEventListener('click', async () => {
  const ok = await confirmDialog({
    title: 'Forget everything?',
    body: [
      'This deletes all browsing history and every page of captured text.',
      'It cannot be undone. Bookmarks are kept.'
    ],
    confirmLabel: 'Forget everything',
    danger: true
  })
  if (!ok) return

  await window.ie2.forgetEverything()
  await load()
})

async function load(): Promise<void> {
  const [stats, recent] = await Promise.all([window.ie2.stats(), window.ie2.recent(8)])
  renderStats(stats)
  renderHits(recentList, recent, msg('home.noHistory', 'No history yet. Suspiciously clean.'), true)
}

// The omnibox takes focus on a new tab, so this page must not steal it.
void load()


// --- appearance -------------------------------------------------------------

/**
 * Apply the user's new tab page choices: background, which blocks are shown,
 * and the card style. Called on load and whenever settings change elsewhere.
 */
/** Wording that lives in home.html rather than being built per render. */
function applyStaticText(): void {
  const set = (selector: string, key: string, fallback: string): void => {
    const node = document.querySelector(selector)
    if (node) node.textContent = msg(key, fallback)
  }

  set('.tagline', 'home.tagline', 'The browser that remembers. It was never asked to.')
  set('#recent h2', 'home.recent', 'Recently, against your better judgement')
  set('#recent-all', 'home.allHistory', 'All history')
  set('#forget-all', 'home.forgetAll', 'Forget everything')

  const recall = document.getElementById('recall-input') as HTMLInputElement | null
  if (recall) {
    recall.placeholder = msg(
      'home.recallPlaceholder',
      'Search the text of every page you have read'
    )
  }
}

function applyAppearance(settings: Settings): void {
  applyTheme(settings)
  applyStaticText()

  const wallpaper = el('wallpaper')
  const dim = el('wallpaper-dim')

  const usesImage =
    settings.homeBackground === 'image' ||
    settings.homeBackground === 'folder' ||
    settings.homeBackground === 'builtin'

  if (settings.homeBackground === 'colour') {
    wallpaper.style.background = toHex(settings.homeColour, '#16181c')
    wallpaper.style.backgroundImage = 'none'
  } else if (usesImage) {
    // A cache-busting query so folder mode picks a fresh image each new tab.
    wallpaper.style.background = 'var(--bg)'
    wallpaper.style.backgroundImage = `url("ie2://wallpaper/?t=${Date.now()}")`

    // Photos are not all the shape of the window, so how they are fitted is
    // the user's call rather than always cropping to fill.
    const fit = IMAGE_FITS[settings.homeImageFit] ?? IMAGE_FITS.fill
    wallpaper.style.backgroundSize = fit.size
    wallpaper.style.backgroundRepeat = fit.repeat
    wallpaper.style.backgroundPosition = settings.homeImagePosition
  } else {
    wallpaper.style.background = 'var(--bg)'
    wallpaper.style.backgroundImage = 'none'
  }

  dim.style.opacity = usesImage ? String((settings.homeDim ?? 0) / 100) : '0'
  document.body.classList.toggle('has-wallpaper', usesImage)
  document.body.classList.toggle('glass', settings.homeCardStyle === 'glass')

  const heading = document.querySelector('header') as HTMLElement | null
  if (heading) {
    const title = document.querySelector('h1') as HTMLElement | null
    if (title) title.textContent = settings.homeTitle
    heading.hidden = settings.homeTitle.trim().length === 0
  }

  el('recall').hidden = !settings.homeShowSearch
  el('stats').hidden = !settings.homeShowStats
  el('recent').hidden = !settings.homeShowRecent
  el('verdict').hidden = !settings.homeShowVerdict

  const clock = el('clock')
  clock.hidden = !settings.homeShowClock
  if (settings.homeShowClock) startClock()
}

let clockTimer: number | undefined

function startClock(): void {
  const tick = (): void => {
    const now = new Date()
    el('clock-time').textContent = now.toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit'
    })
    el('clock-date').textContent = now.toLocaleDateString(undefined, {
      weekday: 'long',
      day: 'numeric',
      month: 'long'
    })
  }

  tick()
  window.clearInterval(clockTimer)
  clockTimer = window.setInterval(tick, 20_000)
}

/* --- the customise sheet --------------------------------------------------
 *
 * Writes the same settings keys the Settings page does, so the two never
 * disagree; this one just puts them next to what they change.
 */

let current: Settings | null = null

setIcon(el('customise'), 'settings')
setIcon(el('sheet-close'), 'close')

for (const wallpaper of BUILT_IN_WALLPAPERS) {
  const button = document.createElement('button')
  button.className = 'wallpaper'
  button.dataset.file = wallpaper.file
  button.title = wallpaper.name

  const thumb = document.createElement('img')
  thumb.src = `ie2://wallpaper/${encodeURIComponent(wallpaper.file)}`
  thumb.alt = wallpaper.name
  thumb.loading = 'lazy'
  button.append(thumb)

  button.addEventListener('click', () => void save('homeBuiltin', wallpaper.file))
  el('opt-builtin').append(button)
}

// The fit choices come from the shared table, so the sheet and the Settings
// page can never drift apart on what the options are.
for (const [value, { label }] of Object.entries(IMAGE_FITS)) {
  const option = document.createElement('option')
  option.value = value
  option.textContent = label
  el('opt-fit').append(option)
}

function paintSheet(settings: Settings): void {
  current = settings

  el<HTMLInputElement>('opt-title').value = settings.homeTitle
  el<HTMLInputElement>('opt-colour').value = toHex(settings.homeColour, '#16181c')
  el<HTMLInputElement>('opt-dim').value = String(settings.homeDim)

  for (const button of document.querySelectorAll('#opt-background button')) {
    button.classList.toggle(
      'on',
      (button as HTMLElement).dataset.value === settings.homeBackground
    )
  }

  for (const button of document.querySelectorAll('#opt-card button')) {
    button.classList.toggle('on', (button as HTMLElement).dataset.value === settings.homeCardStyle)
  }

  const wallpapered =
    settings.homeBackground === 'image' ||
    settings.homeBackground === 'folder' ||
    settings.homeBackground === 'builtin'

  // Only the rows that apply to the chosen background are worth showing.
  el('row-colour').hidden = settings.homeBackground !== 'colour'
  el('row-image').hidden = settings.homeBackground !== 'image'
  el('row-builtin').hidden = settings.homeBackground !== 'builtin'

  for (const button of document.querySelectorAll('#opt-builtin .wallpaper')) {
    button.classList.toggle('on', (button as HTMLElement).dataset.file === settings.homeBuiltin)
  }
  el('row-folder').hidden = settings.homeBackground !== 'folder'
  el('row-dim').hidden = !wallpapered
  el('row-fit').hidden = !wallpapered
  // Position only matters when the image does not cover the window anyway.
  el('row-position').hidden = !wallpapered || settings.homeImageFit === 'stretch'

  el<HTMLSelectElement>('opt-fit').value = settings.homeImageFit
  el<HTMLSelectElement>('opt-position').value = settings.homeImagePosition

  el<HTMLButtonElement>('opt-pick-image').textContent = settings.homeImage
    ? settings.homeImage.split(/[\\/]/).pop() || 'Choose a file'
    : 'Choose a file'
  el<HTMLButtonElement>('opt-pick-folder').textContent = settings.homeFolder
    ? settings.homeFolder.split(/[\\/]/).pop() || 'Choose a folder'
    : 'Choose a folder'

  el<HTMLInputElement>('opt-search').checked = settings.homeShowSearch
  el<HTMLInputElement>('opt-stats').checked = settings.homeShowStats
  el<HTMLInputElement>('opt-recent').checked = settings.homeShowRecent
  el<HTMLInputElement>('opt-verdict').checked = settings.homeShowVerdict
  el<HTMLInputElement>('opt-clock').checked = settings.homeShowClock
}

/** Save one key and show the result immediately, without a reload. */
async function save(key: string, value: unknown): Promise<void> {
  const settings = await window.ie2.setSetting(key, value)
  applyAppearance(settings)
  paintSheet(settings)
}

/**
 * What changed, shown once after an update.
 *
 * The version whose notes have been read is stored, so this appears on the
 * first new tab after installing a new build and never again. A first install
 * has no previous version to compare with and is left alone — nobody needs
 * release notes for software they have not used yet.
 */
async function showWhatsNew(settings: Settings): Promise<void> {
  const current = buildLabel().split(' · ')[0]
  if (!current || settings.lastSeenVersion === current) return

  // Remember it either way, so a build with no changelog entry does not ask
  // again on every single new tab.
  await window.ie2.setSetting('lastSeenVersion', current)
  if (!settings.lastSeenVersion) return

  const { version, lines } = await window.ie2.changelog()
  if (lines.length === 0 || version !== current) return

  const card = document.createElement('section')
  card.id = 'whats-new'

  const heading = document.createElement('h2')
  heading.textContent = `${t('New in')} ${current}`
  card.append(heading)

  const list = document.createElement('ul')
  for (const line of lines.slice(0, 8)) {
    const item = document.createElement('li')
    item.textContent = line
    list.append(item)
  }
  card.append(list)

  const dismiss = document.createElement('button')
  dismiss.id = 'whats-new-close'
  dismiss.textContent = t('Got it')
  dismiss.addEventListener('click', () => card.remove())
  card.append(dismiss)

  document.querySelector('main')?.prepend(card)
}

/** Language can change in another window, so the catalogue is re-read on focus. */
window.addEventListener('focus', () => void load())

el('customise').addEventListener('click', () => {
  const sheet = el('sheet')
  sheet.hidden = !sheet.hidden
  if (!sheet.hidden && current) paintSheet(current)
})

el('sheet-close').addEventListener('click', () => (el('sheet').hidden = true))

// Clicking away closes it, but a click inside must not.
document.addEventListener('mousedown', (event) => {
  const sheet = el('sheet')
  if (sheet.hidden) return

  const target = event.target as Node
  if (!sheet.contains(target) && !el('customise').contains(target)) sheet.hidden = true
})

for (const button of document.querySelectorAll('#opt-background button')) {
  button.addEventListener('click', () => {
    void save('homeBackground', (button as HTMLElement).dataset.value)
  })
}

for (const button of document.querySelectorAll('#opt-card button')) {
  button.addEventListener('click', () => {
    void save('homeCardStyle', (button as HTMLElement).dataset.value)
  })
}

el<HTMLInputElement>('opt-title').addEventListener('change', (event) => {
  void save('homeTitle', (event.target as HTMLInputElement).value)
})

el<HTMLInputElement>('opt-colour').addEventListener('input', (event) => {
  void save('homeColour', (event.target as HTMLInputElement).value)
})

el<HTMLSelectElement>('opt-fit').addEventListener('change', (event) => {
  void save('homeImageFit', (event.target as HTMLSelectElement).value)
})

el<HTMLSelectElement>('opt-position').addEventListener('change', (event) => {
  void save('homeImagePosition', (event.target as HTMLSelectElement).value)
})

el<HTMLInputElement>('opt-dim').addEventListener('input', (event) => {
  void save('homeDim', Number((event.target as HTMLInputElement).value))
})

el('opt-pick-image').addEventListener('click', async () => {
  const path = await window.ie2.pickImage()
  if (path) await save('homeImage', path)
})

el('opt-pick-folder').addEventListener('click', async () => {
  const picked = await window.ie2.pickFolder()
  if (picked) await save('homeFolder', picked.folder)
})

for (const [id, key] of [
  ['opt-search', 'homeShowSearch'],
  ['opt-stats', 'homeShowStats'],
  ['opt-recent', 'homeShowRecent'],
  ['opt-verdict', 'homeShowVerdict'],
  ['opt-clock', 'homeShowClock']
] as [string, string][]) {
  el<HTMLInputElement>(id).addEventListener('change', (event) => {
    void save(key, (event.target as HTMLInputElement).checked)
  })
}

void window.ie2.getSettings().then(async (settings) => {
  messages = await window.ie2.messages(settings.language)
  applyAppearance(settings)
  paintSheet(settings)
  void showWhatsNew(settings)
})
