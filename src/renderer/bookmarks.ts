import { applyTheme } from './theme'
import { icon } from './icons'
import { BOOKMARKS_BAR, BOOKMARKS_URL, type BookmarkEntry } from '../shared/types'

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

const treeEl = el('tree')
const filterEl = el<HTMLInputElement>('filter')
const countEl = el('count')
const noteEl = el('note')

/** Docked beside the page rather than open in a tab of its own. */
const asSidebar = new URLSearchParams(location.search).has('sidebar')
document.body.classList.toggle('sidebar', asSidebar)

let bookmarks: BookmarkEntry[] = []
let folders: string[] = []

/** Folders the user folded away, remembered between visits. */
const FOLDED_KEY = 'ie2.bookmarks.folded'
let folded = new Set<string>()
try {
  folded = new Set(JSON.parse(localStorage.getItem(FOLDED_KEY) ?? '[]') as string[])
} catch {
  // A missing or unreadable entry just means nothing is folded.
}

function saveFolded(): void {
  try {
    localStorage.setItem(FOLDED_KEY, JSON.stringify([...folded]))
  } catch {
    // Not worth failing over.
  }
}

/** Which folder row is being renamed, or asking to be deleted. */
let renaming: string | null = null
let confirmingDelete: string | null = null
/** Which bookmark's name is being edited. */
let editingUrl: string | null = null

let noteTimer: number | undefined
function note(text: string): void {
  noteEl.textContent = text
  window.clearTimeout(noteTimer)
  noteTimer = window.setTimeout(() => (noteEl.textContent = ''), 2600)
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

const nameOf = (path: string): string => path.split('/').pop() ?? path

/** "New folder", or "New folder 2" and so on if that one exists. */
function freshFolder(parent: string): string {
  const base = parent ? `${parent}/New folder` : 'New folder'
  let path = base
  for (let n = 2; folders.includes(path); n++) path = `${base} ${n}`
  return path
}
const parentOf = (path: string): string =>
  path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''

interface FolderNode {
  path: string
  children: FolderNode[]
  marks: BookmarkEntry[]
}

/**
 * The folder tree, built from the folder paths. The root holds the top-level
 * folders and anything unfiled. The bookmarks bar always comes first.
 */
function buildTree(marks: BookmarkEntry[], paths: string[]): FolderNode {
  const nodes = new Map<string, FolderNode>()
  const node = (path: string): FolderNode => {
    let found = nodes.get(path)
    if (!found) {
      found = { path, children: [], marks: [] }
      nodes.set(path, found)
      if (path) node(parentOf(path)).children.push(found)
    }
    return found
  }

  const root = node('')
  for (const path of paths) node(path)
  for (const mark of marks) node(mark.folder).marks.push(mark)

  const order = (a: FolderNode, b: FolderNode): number => {
    if (a.path === BOOKMARKS_BAR) return -1
    if (b.path === BOOKMARKS_BAR) return 1
    return nameOf(a.path).localeCompare(nameOf(b.path))
  }
  for (const each of nodes.values()) {
    each.children.sort(order)
    each.marks.sort((a, b) => a.createdAt - b.createdAt)
  }
  return root
}

function count(node: FolderNode): number {
  return node.marks.length + node.children.reduce((total, child) => total + count(child), 0)
}

// --- drag and drop ---------------------------------------------------------

const BOOKMARK_TYPE = 'application/x-ie2-bookmark'
const FOLDER_TYPE = 'application/x-ie2-folder'

/** Moving something into a folder, whichever kind of thing it is. */
async function dropInto(folder: string, data: DataTransfer): Promise<void> {
  const url = data.getData(BOOKMARK_TYPE)
  if (url) {
    await window.ie2.updateBookmark(url, { folder })
    note(`Moved to ${folder ? folder.split('/').join(' › ') : 'Unfiled'}`)
    return
  }

  const from = data.getData(FOLDER_TYPE)
  if (!from || from === folder || folder.startsWith(`${from}/`) || parentOf(from) === folder) return
  await window.ie2.renameFolder(from, folder ? `${folder}/${nameOf(from)}` : nameOf(from))
  note(`Moved ${nameOf(from)}`)
}

function makeDropTarget(target: HTMLElement, folder: string): void {
  target.addEventListener('dragover', (event) => {
    const types = event.dataTransfer?.types ?? []
    if (!types.includes(BOOKMARK_TYPE) && !types.includes(FOLDER_TYPE)) return
    event.preventDefault()
    event.stopPropagation()
    target.classList.add('drop')
  })
  target.addEventListener('dragleave', () => target.classList.remove('drop'))
  target.addEventListener('drop', (event) => {
    event.preventDefault()
    event.stopPropagation()
    target.classList.remove('drop')
    if (event.dataTransfer) void dropInto(folder, event.dataTransfer)
  })
}

// --- rendering -------------------------------------------------------------

function textButton(label: string, className: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button')
  button.className = className
  button.textContent = label
  button.addEventListener('click', (event) => {
    event.stopPropagation()
    onClick()
  })
  return button
}

function iconButton(name: string, title: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button')
  button.className = 'icon-btn'
  button.title = title
  button.append(icon(name))
  button.addEventListener('click', (event) => {
    event.stopPropagation()
    onClick()
  })
  return button
}

/** A text field that commits on Enter or leaving it, and gives up on Escape. */
function inlineInput(value: string, commit: (text: string) => void, cancel: () => void): HTMLInputElement {
  const input = document.createElement('input')
  input.type = 'text'
  input.className = 'inline'
  input.value = value
  input.spellcheck = false
  let done = false
  const finish = (save: boolean): void => {
    if (done) return
    done = true
    if (save && input.value.trim()) commit(input.value.trim())
    else cancel()
  }
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') finish(true)
    else if (event.key === 'Escape') finish(false)
  })
  input.addEventListener('blur', () => finish(true))
  input.addEventListener('click', (event) => event.stopPropagation())
  requestAnimationFrame(() => {
    input.focus()
    input.select()
  })
  return input
}

function renderMark(entry: BookmarkEntry): HTMLElement {
  const row = document.createElement('div')
  row.className = 'bookmark'
  row.draggable = editingUrl !== entry.url
  row.title = entry.url

  row.addEventListener('dragstart', (event) => {
    event.dataTransfer?.setData(BOOKMARK_TYPE, entry.url)
    event.dataTransfer?.setData('text/uri-list', entry.url)
    row.classList.add('dragging')
  })
  row.addEventListener('dragend', () => row.classList.remove('dragging'))

  const favicon = entry.favicon ? document.createElement('img') : null
  if (favicon && entry.favicon) {
    favicon.className = 'favicon'
    favicon.alt = ''
    favicon.src = entry.favicon
    favicon.addEventListener('error', () => favicon.replaceWith(icon('globe')))
  }
  row.append(favicon ?? icon('globe'))

  if (editingUrl === entry.url) {
    row.append(
      inlineInput(
        entry.title || hostOf(entry.url),
        async (title) => {
          editingUrl = null
          await window.ie2.updateBookmark(entry.url, { title })
        },
        () => {
          editingUrl = null
          render()
        }
      )
    )
    return row
  }

  const text = document.createElement('div')
  text.className = 'text'
  const title = document.createElement('span')
  title.className = 'title'
  // Page-controlled text: inserted as text, never markup.
  title.textContent = entry.title || hostOf(entry.url)
  text.append(title)
  const url = document.createElement('span')
  url.className = 'url'
  url.textContent = hostOf(entry.url)
  text.append(url)
  row.append(text)

  row.addEventListener('mouseup', (event) => {
    if (event.button !== 0 && event.button !== 1) return
    if ((event.target as HTMLElement).closest('button, input')) return
    void window.ie2.open(entry.url, event.button === 1 || event.ctrlKey || event.metaKey)
  })

  const tools = document.createElement('span')
  tools.className = 'tools'
  tools.append(
    iconButton('text', 'Rename', () => {
      editingUrl = entry.url
      render()
    }),
    iconButton('close', 'Remove this bookmark', async () => {
      await window.ie2.removeBookmark(entry.url)
      note('Bookmark removed')
    })
  )
  row.append(tools)
  return row
}

function renderFolder(node: FolderNode, filtering: boolean): HTMLElement {
  const section = document.createElement('section')
  section.className = 'folder'
  const open = filtering || !folded.has(node.path)
  section.classList.toggle('folded', !open)

  const head = document.createElement('div')
  head.className = 'folder-head'
  head.draggable = node.path !== BOOKMARKS_BAR && renaming !== node.path
  head.addEventListener('dragstart', (event) => {
    event.dataTransfer?.setData(FOLDER_TYPE, node.path)
  })
  makeDropTarget(head, node.path)

  const caret = icon('forward')
  caret.classList.add('caret')
  head.append(caret, icon('folder'))

  if (renaming === node.path) {
    head.append(
      inlineInput(
        nameOf(node.path),
        async (name) => {
          renaming = null
          const parent = parentOf(node.path)
          const clean = name.replace(/\//g, ' ')
          await window.ie2.renameFolder(node.path, parent ? `${parent}/${clean}` : clean)
        },
        () => {
          renaming = null
          render()
        }
      )
    )
  } else {
    const name = document.createElement('span')
    name.className = 'name'
    name.textContent = nameOf(node.path)
    head.append(name)

    const badge = document.createElement('span')
    badge.className = 'folder-count'
    badge.textContent = String(count(node))
    head.append(badge)

    const tools = document.createElement('span')
    tools.className = 'tools'
    tools.append(
      iconButton('plus', 'New folder inside', async () => {
        const made = await window.ie2.createFolder(freshFolder(node.path))
        folded.delete(node.path)
        saveFolded()
        renaming = made
        await load()
      })
    )
    if (node.path !== BOOKMARKS_BAR) {
      tools.append(
        iconButton('text', 'Rename', () => {
          renaming = node.path
          render()
        }),
        iconButton('close', 'Delete this folder', () => {
          confirmingDelete = node.path
          render()
        })
      )
    }
    head.append(tools)
  }

  head.addEventListener('click', () => {
    if (filtering || renaming === node.path) return
    if (folded.has(node.path)) folded.delete(node.path)
    else folded.add(node.path)
    saveFolded()
    render()
  })
  section.append(head)

  if (confirmingDelete === node.path) {
    const ask = document.createElement('div')
    ask.className = 'confirm'
    const inside = count(node)
    const text = document.createElement('span')
    text.textContent =
      inside === 0 ? `Delete "${nameOf(node.path)}"?` : `Delete "${nameOf(node.path)}" and its ${inside} bookmarks?`
    ask.append(text)
    if (inside > 0) {
      ask.append(
        textButton('Keep the bookmarks', '', async () => {
          confirmingDelete = null
          await window.ie2.deleteFolder(node.path, false)
          note(`Folder deleted; its bookmarks moved up a level`)
        })
      )
    }
    ask.append(
      textButton(inside > 0 ? 'Delete all' : 'Delete', 'danger', async () => {
        confirmingDelete = null
        await window.ie2.deleteFolder(node.path, true)
        note('Folder deleted')
      }),
      textButton('Cancel', '', () => {
        confirmingDelete = null
        render()
      })
    )
    section.append(ask)
  }

  if (open) {
    const body = document.createElement('div')
    body.className = 'folder-body'
    for (const child of node.children) body.append(renderFolder(child, filtering))
    for (const mark of node.marks) body.append(renderMark(mark))
    if (node.children.length === 0 && node.marks.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'empty small'
      empty.textContent = 'Empty — drag bookmarks here.'
      body.append(empty)
    }
    section.append(body)
  }

  return section
}

/** Drop a folder's empty branches when searching, so only matches show. */
function prune(node: FolderNode): FolderNode | null {
  const children = node.children.map(prune).filter((child): child is FolderNode => child !== null)
  if (children.length === 0 && node.marks.length === 0 && node.path) return null
  return { ...node, children }
}

function render(): void {
  const needle = filterEl.value.trim().toLowerCase()
  const visible = bookmarks.filter(
    (entry) =>
      !needle ||
      entry.title.toLowerCase().includes(needle) ||
      entry.url.toLowerCase().includes(needle) ||
      entry.folder.toLowerCase().includes(needle)
  )

  countEl.textContent =
    visible.length === bookmarks.length
      ? `${bookmarks.length} saved`
      : `${visible.length} of ${bookmarks.length}`

  treeEl.replaceChildren()

  if (bookmarks.length === 0 && folders.length <= 1) {
    const empty = document.createElement('div')
    empty.className = 'empty'
    empty.textContent = 'Nothing saved yet. The star in the address bar keeps a page.'
    treeEl.append(empty)
  }

  const full = buildTree(visible, needle ? [] : folders)
  const root = needle ? prune(full) : full
  if (!root) {
    const empty = document.createElement('div')
    empty.className = 'empty'
    empty.textContent = 'No bookmark matches that.'
    treeEl.append(empty)
    return
  }

  for (const child of root.children) treeEl.append(renderFolder(child, Boolean(needle)))

  // Unfiled bookmarks sit at the root, under a heading that is also a drop target.
  if (root.marks.length > 0 || !needle) {
    const loose = document.createElement('section')
    loose.className = 'folder unfiled'
    const head = document.createElement('div')
    head.className = 'folder-head static'
    head.append(icon('bookmark'))
    const name = document.createElement('span')
    name.className = 'name'
    name.textContent = 'Unfiled'
    head.append(name)
    makeDropTarget(head, '')
    loose.append(head)
    const body = document.createElement('div')
    body.className = 'folder-body'
    for (const mark of root.marks) body.append(renderMark(mark))
    loose.append(body)
    if (root.marks.length > 0 || bookmarks.length > 0) treeEl.append(loose)
  }
}

filterEl.addEventListener('input', render)

el('new-folder').addEventListener('click', async () => {
  renaming = await window.ie2.createFolder(freshFolder(''))
  await load()
})

el('export').addEventListener('click', async () => {
  const exported = await window.ie2.exportBookmarks()
  if (exported !== null) note(`Exported ${exported} bookmarks`)
})

const sidePage = el('side-page')
sidePage.append(icon('forward'))
sidePage.addEventListener('click', () => void window.ie2.open(BOOKMARKS_URL, true))

const sideClose = el('side-close')
sideClose.append(icon('close'))
sideClose.addEventListener('click', () => void window.ie2.closeSidebar())

async function load(): Promise<void> {
  applyTheme(await window.ie2.getSettings())
  ;[bookmarks, folders] = await Promise.all([window.ie2.listBookmarks(), window.ie2.bookmarkFolders()])
  render()
}

// The star, the bar and other windows change bookmarks too.
window.ie2.onBookmarksChanged(() => void load())
void load()
