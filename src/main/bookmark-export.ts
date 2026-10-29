import { dialog } from 'electron'
import { writeFile } from 'node:fs/promises'
import { BOOKMARKS_BAR, type BookmarkEntry } from '../shared/types'
import { bookmarkFolders, listBookmarks } from './db'

/**
 * Bookmarks as a Netscape bookmark file — the format every browser imports,
 * so what is saved here can always leave. The bookmarks bar is marked as such,
 * which is how Chrome, Edge, Brave and Firefox know to put it in their own bar.
 */
export async function exportBookmarks(): Promise<number | null> {
  const stamp = new Date().toISOString().slice(0, 10)
  const result = await dialog.showSaveDialog({
    title: 'Export bookmarks',
    defaultPath: `IE2 bookmarks ${stamp}.html`,
    filters: [{ name: 'Bookmarks file', extensions: ['html'] }]
  })
  if (result.canceled || !result.filePath) return null

  const marks = listBookmarks()
  await writeFile(result.filePath, toNetscape(marks, bookmarkFolders()), 'utf8')
  return marks.length
}

function escape(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function toNetscape(marks: BookmarkEntry[], folders: string[]): string {
  const seconds = (ms: number): number => Math.floor(ms / 1000)
  const out: string[] = [
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    '<TITLE>Bookmarks</TITLE>',
    '<H1>Bookmarks</H1>',
    '<DL><p>'
  ]

  const writeFolder = (path: string, depth: number): void => {
    const pad = '    '.repeat(depth)

    for (const mark of marks.filter((m) => m.folder === path)) {
      out.push(
        `${pad}<DT><A HREF="${escape(mark.url)}" ADD_DATE="${seconds(mark.createdAt)}">${escape(
          mark.title || mark.url
        )}</A>`
      )
    }

    const children = folders.filter(
      (folder) => folder.startsWith(path ? `${path}/` : '') && !folder.slice(path ? path.length + 1 : 0).includes('/')
    )
    for (const child of children) {
      if (child === path) continue
      const name = child.split('/').pop() ?? child
      const bar = child === BOOKMARKS_BAR ? ' PERSONAL_TOOLBAR_FOLDER="true"' : ''
      out.push(`${pad}<DT><H3${bar}>${escape(name)}</H3>`)
      out.push(`${pad}<DL><p>`)
      writeFolder(child, depth + 1)
      out.push(`${pad}</DL><p>`)
    }
  }

  writeFolder('', 1)
  out.push('</DL><p>', '')
  return out.join('\n')
}
