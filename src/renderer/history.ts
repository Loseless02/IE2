import { applyTheme } from './theme'
import { confirmDialog } from './dialog'
import { icon } from './icons'
import type { HistoryHit } from '../shared/types'

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

const listEl = el('list')
const filterEl = el<HTMLInputElement>('filter')
const countEl = el('count')
const moreBtn = el<HTMLButtonElement>('more')
const selectionBar = el('selection')
const selectionCount = el('selection-count')

/**
 * A page at a time. A year of browsing is tens of thousands of rows, and
 * building that many nodes at once locks the page up for seconds.
 */
const PAGE = 200

let rows: HistoryHit[] = []
let total = 0
let query = ''
let timer = 0

/** URLs ticked for removal. Survives a re-render; cleared by anything else. */
const selected = new Set<string>()

const dateFormat = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric'
})

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' })

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

/** Today and yesterday are named; anything older gets its date. */
function dayLabel(at: number): string {
  const date = new Date(at)
  const start = new Date()
  start.setHours(0, 0, 0, 0)

  const days = Math.floor((start.getTime() - date.getTime()) / 86_400_000)

  if (days < 0) return 'Today'
  if (days === 0) return 'Today'
  if (days === 1) return 'Yesterday'
  return dateFormat.format(date)
}

function dayKey(at: number): string {
  const date = new Date(at)
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
}

function renderSelection(): void {
  selectionBar.hidden = selected.size === 0
  selectionCount.textContent = `${selected.size} selected`
}

function render(): void {
  countEl.textContent = query
    ? `${total} matching`
    : `${total} ${total === 1 ? 'page' : 'pages'}`

  listEl.replaceChildren()

  if (rows.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'empty'
    empty.textContent = query
      ? 'Nothing in the history matches that.'
      : 'No history. Either new, or very careful.'
    listEl.append(empty)
    moreBtn.hidden = true
    return
  }

  let currentDay = ''

  for (const hit of rows) {
    const key = dayKey(hit.lastVisit)

    if (key !== currentDay) {
      currentDay = key

      const heading = document.createElement('h2')
      heading.textContent = dayLabel(hit.lastVisit)

      // Ticking a whole day at once, which is how most of this gets used.
      const all = document.createElement('button')
      all.className = 'day-select'
      all.type = 'button'
      all.textContent = 'Select all'
      all.dataset['day'] = key
      all.addEventListener('click', () => {
        for (const row of rows) {
          if (dayKey(row.lastVisit) === key) selected.add(row.url)
        }
        render()
      })

      heading.append(all)
      listEl.append(heading)
    }

    listEl.append(buildRow(hit))
  }

  moreBtn.hidden = rows.length >= total
  moreBtn.textContent = `Show more (${total - rows.length} left)`
  renderSelection()
}

function buildRow(hit: HistoryHit): HTMLElement {
  const row = document.createElement('div')
  row.className = 'entry'
  row.classList.toggle('picked', selected.has(hit.url))

  const tick = document.createElement('input')
  tick.type = 'checkbox'
  tick.className = 'tick'
  tick.checked = selected.has(hit.url)
  tick.addEventListener('change', () => {
    if (tick.checked) selected.add(hit.url)
    else selected.delete(hit.url)
    row.classList.toggle('picked', tick.checked)
    renderSelection()
  })
  row.append(tick)

  const open = document.createElement('button')
  open.className = 'open'
  open.type = 'button'
  open.addEventListener('click', () => window.ie2.open(hit.url))

  if (hit.favicon) {
    const img = document.createElement('img')
    img.className = 'favicon'
    img.src = hit.favicon
    img.addEventListener('error', () => img.remove())
    open.append(img)
  }

  const text = document.createElement('span')
  text.className = 'text'

  const title = document.createElement('span')
  title.className = 'title'
  // Page-controlled text: inserted as text, never markup.
  title.textContent = hit.title || hostOf(hit.url)
  text.append(title)

  const url = document.createElement('span')
  url.className = 'url'
  url.textContent = hit.url
  text.append(url)

  open.append(text)

  const time = document.createElement('span')
  time.className = 'time'
  time.textContent = hit.lastVisit ? timeFormat.format(new Date(hit.lastVisit)) : ''
  open.append(time)

  row.append(open)

  const remove = document.createElement('button')
  remove.className = 'remove'
  remove.type = 'button'
  remove.append(icon('close'))
  remove.title = 'Remove from history. What the page said is kept.'
  remove.addEventListener('click', () => void drop([hit.url]))
  row.append(remove)

  return row
}

/** Take pages out of the history and off the page, without reloading it. */
async function drop(urls: string[]): Promise<void> {
  await window.ie2.forgetVisits(urls)

  const gone = new Set(urls)
  rows = rows.filter((row) => !gone.has(row.url))
  total = Math.max(0, total - urls.length)
  for (const url of urls) selected.delete(url)

  render()
}

filterEl.addEventListener('input', () => {
  window.clearTimeout(timer)
  timer = window.setTimeout(() => void load(filterEl.value.trim()), 120)
})

moreBtn.addEventListener('click', async () => {
  moreBtn.disabled = true
  const page = await window.ie2.history(query, PAGE, rows.length)
  rows = [...rows, ...page.rows]
  total = page.total
  moreBtn.disabled = false
  render()
})

el('selection-remove').addEventListener('click', () => void drop([...selected]))

el('selection-clear').addEventListener('click', () => {
  selected.clear()
  render()
})

el('forget-history').addEventListener('click', async () => {
  const ok = await confirmDialog({
    title: 'Forget your history?',
    body: [
      'Every page leaves the history list, the new tab page and the address suggestions.',
      'The text of those pages is kept, so recall still finds them. Bookmarks are kept.',
      'To delete the text as well, use Forget everything on the new tab page.'
    ],
    confirmLabel: 'Forget history',
    danger: true
  })
  if (!ok) return

  await window.ie2.forgetHistory()
  selected.clear()
  await load(query)
})

async function load(next = ''): Promise<void> {
  query = next
  const page = await window.ie2.history(query, PAGE, 0)
  rows = page.rows
  total = page.total
  render()
}

async function start(): Promise<void> {
  applyTheme(await window.ie2.getSettings())
  await load()
}

void start()
