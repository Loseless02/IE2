import { applyTheme } from './theme'
import { icon } from './icons'
import type { BookmarkEntry } from '../shared/types'

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

const listEl = el('list')
const filterEl = el<HTMLInputElement>('filter')
const countEl = el('count')

let bookmarks: BookmarkEntry[] = []

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

/** Grouped by the folder they came from, so an imported tree stays legible. */
function grouped(entries: BookmarkEntry[]): Map<string, BookmarkEntry[]> {
  const out = new Map<string, BookmarkEntry[]>()

  for (const entry of entries) {
    const folder = entry.folder?.trim() || 'Unsorted'
    const list = out.get(folder) ?? []
    list.push(entry)
    out.set(folder, list)
  }

  return new Map([...out].sort(([a], [b]) => a.localeCompare(b)))
}

function render(): void {
  const needle = filterEl.value.trim().toLowerCase()

  const visible = bookmarks.filter(
    (entry) =>
      !needle ||
      entry.title.toLowerCase().includes(needle) ||
      entry.url.toLowerCase().includes(needle) ||
      (entry.folder ?? '').toLowerCase().includes(needle)
  )

  countEl.textContent =
    visible.length === bookmarks.length
      ? `${bookmarks.length} saved`
      : `${visible.length} of ${bookmarks.length}`

  listEl.replaceChildren()

  if (visible.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'empty'
    empty.textContent = bookmarks.length === 0
      ? 'Nothing saved yet. The star button in the toolbar keeps a page.'
      : 'No bookmark matches that.'
    listEl.append(empty)
    return
  }

  for (const [folder, entries] of grouped(visible)) {
    const heading = document.createElement('h2')
    heading.textContent = folder
    const badge = document.createElement('span')
    badge.className = 'folder-count'
    badge.textContent = String(entries.length)
    heading.append(badge)
    listEl.append(heading)

    for (const entry of entries) {
      const row = document.createElement('div')
      row.className = 'bookmark'

      const open = document.createElement('button')
      open.className = 'open'
      open.addEventListener('click', () => window.ie2.open(entry.url))

      const title = document.createElement('span')
      title.className = 'title'
      // Page-controlled text: inserted as text, never markup.
      title.textContent = entry.title || hostOf(entry.url)
      open.append(title)

      const url = document.createElement('span')
      url.className = 'url'
      url.textContent = entry.url
      open.append(url)

      row.append(open)

      const remove = document.createElement('button')
      remove.className = 'remove'
      remove.append(icon('close'))
      remove.title = 'Remove this bookmark'
      remove.addEventListener('click', async () => {
        await window.ie2.removeBookmark(entry.url)
        bookmarks = bookmarks.filter((b) => b.url !== entry.url)
        render()
      })
      row.append(remove)

      listEl.append(row)
    }
  }
}

filterEl.addEventListener('input', render)

async function load(): Promise<void> {
  applyTheme(await window.ie2.getSettings())
  bookmarks = await window.ie2.listBookmarks()
  render()
}

void load()
