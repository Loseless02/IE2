import { app } from 'electron'
import { DatabaseSync } from 'node:sqlite'
import { copyFileSync, existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { ImportPayload, ImportSource } from '../shared/types'

/**
 * Reading another browser's profile: bookmarks are JSON, history is SQLite.
 * Both are read-only operations on files the user already owns, and the source
 * browser must be closed or its database is locked — so everything is copied to
 * a scratch directory first and the copy is what gets opened.
 */

interface ChromiumBookmarkNode {
  type?: string
  name?: string
  url?: string
  date_added?: string
  children?: ChromiumBookmarkNode[]
}

/** Chromium timestamps: microseconds since 1601-01-01. */
const CHROMIUM_EPOCH_OFFSET_MS = 11_644_473_600_000

function chromiumTime(value: string | number | undefined): number {
  const micro = Number(value ?? 0)
  if (!micro) return 0
  return Math.round(micro / 1000 - CHROMIUM_EPOCH_OFFSET_MS)
}

// --- discovery --------------------------------------------------------------

interface Candidate {
  browser: string
  userData: string
  kind: 'chromium' | 'firefox'
}

function candidates(): Candidate[] {
  const local = process.env['LOCALAPPDATA'] ?? ''
  const roaming = process.env['APPDATA'] ?? ''

  return [
    { browser: 'Google Chrome', userData: join(local, 'Google/Chrome/User Data'), kind: 'chromium' },
    { browser: 'Brave', userData: join(local, 'BraveSoftware/Brave-Browser/User Data'), kind: 'chromium' },
    { browser: 'Microsoft Edge', userData: join(local, 'Microsoft/Edge/User Data'), kind: 'chromium' },
    { browser: 'Vivaldi', userData: join(local, 'Vivaldi/User Data'), kind: 'chromium' },
    { browser: 'Chromium', userData: join(local, 'Chromium/User Data'), kind: 'chromium' },
    { browser: 'Opera', userData: join(roaming, 'Opera Software/Opera Stable'), kind: 'chromium' },
    { browser: 'Firefox', userData: join(roaming, 'Mozilla/Firefox/Profiles'), kind: 'firefox' }
  ]
}

/** Every profile we can find, with a rough idea of what is inside it. */
export function scanForProfiles(): ImportSource[] {
  const found: ImportSource[] = []

  for (const candidate of candidates()) {
    if (!existsSync(candidate.userData)) continue

    if (candidate.kind === 'firefox') {
      for (const entry of safeReaddir(candidate.userData)) {
        const dir = join(candidate.userData, entry)
        if (!existsSync(join(dir, 'places.sqlite'))) continue
        found.push({
          id: dir,
          browser: 'Firefox',
          profile: entry.replace(/^\w+\./, ''),
          hasBookmarks: true,
          hasHistory: true
        })
      }
      continue
    }

    // Chromium keeps one directory per profile, plus a lot of unrelated ones.
    for (const entry of safeReaddir(candidate.userData)) {
      if (entry !== 'Default' && !entry.startsWith('Profile ')) continue

      const dir = join(candidate.userData, entry)
      const hasBookmarks = existsSync(join(dir, 'Bookmarks'))
      const hasHistory = existsSync(join(dir, 'History'))
      if (!hasBookmarks && !hasHistory) continue

      found.push({
        id: dir,
        browser: candidate.browser,
        profile: profileLabel(dir, entry),
        hasBookmarks,
        hasHistory
      })
    }

    // Opera keeps its profile at the top level rather than in subdirectories.
    if (candidate.browser === 'Opera' && existsSync(join(candidate.userData, 'Bookmarks'))) {
      found.push({
        id: candidate.userData,
        browser: 'Opera',
        profile: 'Default',
        hasBookmarks: true,
        hasHistory: existsSync(join(candidate.userData, 'History'))
      })
    }
  }

  return found
}

/** Chromium stores the display name of a profile in its Preferences file. */
function profileLabel(dir: string, fallback: string): string {
  try {
    const prefs = JSON.parse(readFileSync(join(dir, 'Preferences'), 'utf8')) as {
      profile?: { name?: string }
    }
    return prefs.profile?.name || fallback
  } catch {
    return fallback
  }
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir).filter((entry) => {
      try {
        return statSync(join(dir, entry)).isDirectory()
      } catch {
        return false
      }
    })
  } catch {
    return []
  }
}

// --- reading ----------------------------------------------------------------

/**
 * Open a copy, never the original: the source browser may be running, and
 * SQLite will refuse a locked file. The write-ahead log is copied too, or the
 * most recent history would be missing.
 */
function openCopy(source: string, label: string): { db: DatabaseSync; cleanup: () => void } | null {
  if (!existsSync(source)) return null

  const scratch = join(app.getPath('temp'), `ie2-import-${label}-${Date.now()}`)

  try {
    copyFileSync(source, scratch)
    for (const suffix of ['-wal', '-shm']) {
      if (existsSync(source + suffix)) copyFileSync(source + suffix, scratch + suffix)
    }

    const db = new DatabaseSync(scratch, { readOnly: true })
    return {
      db,
      cleanup: () => {
        try {
          db.close()
        } catch {
          // Already closed.
        }
        for (const suffix of ['', '-wal', '-shm']) {
          try {
            rmSync(scratch + suffix, { force: true })
          } catch {
            // Nothing to clean.
          }
        }
      }
    }
  } catch {
    return null
  }
}

function readChromiumBookmarks(dir: string): ImportPayload['bookmarks'] {
  const file = join(dir, 'Bookmarks')
  if (!existsSync(file)) return []

  let parsed: { roots?: Record<string, ChromiumBookmarkNode> }
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return []
  }

  const out: ImportPayload['bookmarks'] = []

  // The folder path is built on the way down. A node contributes its own name
  // to its children, never to itself, or every root would appear twice.
  const walk = (node: ChromiumBookmarkNode, folder: string): void => {
    if (node.type === 'url' && node.url) {
      out.push({
        url: node.url,
        title: node.name ?? '',
        folder,
        createdAt: chromiumTime(node.date_added) || Date.now()
      })
      return
    }

    const childFolder = node.name ? joinFolder(folder, node.name) : folder
    for (const child of node.children ?? []) walk(child, childFolder)
  }

  for (const [key, root] of Object.entries(parsed.roots ?? {})) {
    if (typeof root !== 'object' || root === null) continue
    const named = { ...root, name: root.name || defaultRootName(key) }
    walk(named, '')
  }

  return out
}

function readChromiumHistory(dir: string): {
  history: ImportPayload['history']
  searches: ImportPayload['searches']
} {
  const opened = openCopy(join(dir, 'History'), 'history')
  if (!opened) return { history: [], searches: [] }

  try {
    // Chromium stores microseconds since 1601, which overflows a JavaScript
    // number — 1.3e16 is past Number.MAX_SAFE_INTEGER and node:sqlite refuses
    // to convert it. Doing the arithmetic in SQL keeps it an exact integer and
    // hands back plain milliseconds.
    const rows = opened.db
      .prepare(
        `SELECT url, title, visit_count AS visits,
                (last_visit_time / 1000) - ${CHROMIUM_EPOCH_OFFSET_MS} AS ms
         FROM urls WHERE hidden = 0 ORDER BY last_visit_time DESC LIMIT 20000`
      )
      .all() as unknown as { url: string; title: string; visits: number; ms: number }[]

    const history = rows.map((row) => ({
      url: row.url,
      title: row.title ?? '',
      visits: Math.max(1, row.visits ?? 1),
      lastVisit: row.ms > 0 ? row.ms : Date.now()
    }))

    let searches: ImportPayload['searches'] = []
    try {
      const terms = opened.db
        .prepare(
          `SELECT term, COUNT(*) AS n FROM keyword_search_terms
           GROUP BY lower_term ORDER BY n DESC LIMIT 5000`
        )
        .all() as unknown as { term: string; n: number }[]
      searches = terms.map((row) => ({ term: row.term, count: row.n }))
    } catch {
      // Older schema without keyword_search_terms.
    }

    return { history, searches }
  } catch {
    return { history: [], searches: [] }
  } finally {
    opened.cleanup()
  }
}

function readFirefox(dir: string): ImportPayload {
  const opened = openCopy(join(dir, 'places.sqlite'), 'places')
  if (!opened) return { bookmarks: [], history: [], searches: [] }

  try {
    // Same treatment as Chromium: convert in SQL rather than in JavaScript.
    const history = (
      opened.db
        .prepare(
          `SELECT url, title, visit_count AS visits, (last_visit_date / 1000) AS ms
           FROM moz_places WHERE hidden = 0 AND url LIKE 'http%'
           ORDER BY last_visit_date DESC LIMIT 20000`
        )
        .all() as unknown as { url: string; title: string; visits: number; ms: number }[]
    ).map((row) => ({
      url: row.url,
      title: row.title ?? '',
      visits: Math.max(1, row.visits ?? 1),
      lastVisit: row.ms > 0 ? row.ms : Date.now()
    }))

    const bookmarks = (
      opened.db
        .prepare(
          `SELECT p.url AS url, COALESCE(b.title, p.title) AS title, (b.dateAdded / 1000) AS ms,
                  (SELECT title FROM moz_bookmarks WHERE id = b.parent) AS folder
           FROM moz_bookmarks b JOIN moz_places p ON p.id = b.fk
           WHERE b.type = 1 AND p.url LIKE 'http%'`
        )
        .all() as unknown as { url: string; title: string; ms: number; folder: string | null }[]
    ).map((row) => ({
      url: row.url,
      title: row.title ?? '',
      folder: row.folder ?? 'Imported',
      createdAt: row.ms > 0 ? row.ms : Date.now()
    }))

    return { bookmarks, history, searches: [] }
  } catch {
    return { bookmarks: [], history: [], searches: [] }
  } finally {
    opened.cleanup()
  }
}

/** Everything importable from one profile, read but not yet written. */
export function readProfile(id: string): ImportPayload {
  if (existsSync(join(id, 'places.sqlite'))) return readFirefox(id)

  const { history, searches } = readChromiumHistory(id)
  return { bookmarks: readChromiumBookmarks(id), history, searches }
}

function joinFolder(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name
}

/** Chromium's roots are keyed, not named, in older profiles. */
function defaultRootName(key: string): string {
  if (key === 'bookmark_bar') return 'Bookmarks bar'
  if (key === 'other') return 'Other bookmarks'
  if (key === 'synced') return 'Mobile bookmarks'
  return key
}
