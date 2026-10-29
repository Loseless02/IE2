import { DatabaseSync } from 'node:sqlite'
import { app } from 'electron'
import { join } from 'node:path'
import {
  BOOKMARKS_BAR,
  type HistoryHit,
  type BookmarkEntry,
  type ImportPayload,
  type ImportResult,
  type RecallStats,
  type SitePermission
} from '../shared/types'

let db: DatabaseSync

/**
 * On-disk store for history, full-text page contents, bookmarks and the last
 * session's tabs. Lives in userData so it survives reinstalls of the app code.
 *
 * `pages` holds one row per URL (the canonical record). `pages_fts` is an FTS5
 * index over the captured body text, keyed by the same URL. `visits` is the
 * append-only log used for recency and visit counts.
 */
export function initDb(): void {
  db = new DatabaseSync(join(app.getPath('userData'), 'browser.db'))

  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')

  db.exec(`
    CREATE TABLE IF NOT EXISTS pages (
      url         TEXT PRIMARY KEY,
      title       TEXT NOT NULL DEFAULT '',
      favicon     TEXT,
      visit_count INTEGER NOT NULL DEFAULT 0,
      last_visit  INTEGER NOT NULL,
      captured_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS visits (
      id  INTEGER PRIMARY KEY,
      url TEXT NOT NULL,
      ts  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_visits_ts ON visits(ts DESC);

    CREATE TABLE IF NOT EXISTS bookmarks (
      url        TEXT PRIMARY KEY,
      title      TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS session_tabs (
      position INTEGER PRIMARY KEY,
      url      TEXT NOT NULL,
      active   INTEGER NOT NULL DEFAULT 0,
      pinned   INTEGER NOT NULL DEFAULT 0,
      group_id INTEGER
    );

    CREATE TABLE IF NOT EXISTS tab_groups (
      id       INTEGER PRIMARY KEY,
      name     TEXT NOT NULL DEFAULT '',
      colour   TEXT NOT NULL DEFAULT 'grey',
      position INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS never_remember (
      domain     TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS adblock_off (
      domain     TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS search_terms (
      term  TEXT PRIMARY KEY,
      count INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS counters (
      name  TEXT PRIMARY KEY,
      value INTEGER NOT NULL DEFAULT 0
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
      url UNINDEXED,
      title,
      body,
      tokenize = 'porter unicode61'
    );
  `)

  migrate()
  loadNeverRemember()
  loadAdblockOff()
}

/**
 * Additive migrations only. Each one checks for its own column so that a
 * database created by an older build keeps working.
 */
function migrate(): void {
  const columns = db.prepare('PRAGMA table_info(bookmarks)').all() as unknown as { name: string }[]
  if (!columns.some((c) => c.name === 'folder')) {
    db.exec("ALTER TABLE bookmarks ADD COLUMN folder TEXT NOT NULL DEFAULT ''")
  }

  // A folder only existed while something was filed in it; creating one ahead
  // of filing anything needs somewhere to keep it.
  db.exec(`
    CREATE TABLE IF NOT EXISTS bookmark_folders (
      path       TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    )
  `)

  // Pinning and grouping arrived after session_tabs existed, so a database from
  // an earlier build has neither column and every query naming them would fail.
  const session = db
    .prepare('PRAGMA table_info(session_tabs)')
    .all() as unknown as { name: string }[]

  if (!session.some((c) => c.name === 'pinned')) {
    db.exec('ALTER TABLE session_tabs ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0')
  }
  if (!session.some((c) => c.name === 'group_id')) {
    db.exec('ALTER TABLE session_tabs ADD COLUMN group_id INTEGER')
  }
}

/**
 * Write an imported profile into our own tables. Everything is upserted, so
 * importing the same browser twice does not duplicate anything: visit counts
 * take the larger value and timestamps take the more recent one.
 */
export function importProfile(payload: ImportPayload): ImportResult {
  const result: ImportResult = { bookmarks: 0, history: 0, searches: 0, skipped: 0, cookies: 0 }

  const insertPage = db.prepare(
    `INSERT INTO pages (url, title, visit_count, last_visit)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(url) DO UPDATE SET
       visit_count = MAX(pages.visit_count, excluded.visit_count),
       last_visit  = MAX(pages.last_visit, excluded.last_visit),
       title       = CASE WHEN excluded.title <> '' THEN excluded.title ELSE pages.title END`
  )
  const insertVisit = db.prepare('INSERT INTO visits (url, ts) VALUES (?, ?)')
  const insertBookmark = db.prepare(
    `INSERT INTO bookmarks (url, title, folder, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(url) DO UPDATE SET
       title  = CASE WHEN excluded.title <> '' THEN excluded.title ELSE bookmarks.title END,
       folder = excluded.folder`
  )
  const insertTerm = db.prepare(
    `INSERT INTO search_terms (term, count) VALUES (?, ?)
     ON CONFLICT(term) DO UPDATE SET count = search_terms.count + excluded.count`
  )

  db.exec('BEGIN')
  try {
    for (const page of payload.history) {
      if (!isImportableUrl(page.url)) {
        result.skipped++
        continue
      }
      insertPage.run(page.url, page.title, page.visits, page.lastVisit)
      insertVisit.run(page.url, page.lastVisit)
      result.history++
    }

    for (const mark of payload.bookmarks) {
      if (!isImportableUrl(mark.url)) {
        result.skipped++
        continue
      }
      insertBookmark.run(mark.url, mark.title, mark.folder, mark.createdAt)
      result.bookmarks++
    }

    for (const search of payload.searches) {
      const term = search.term.trim()
      if (!term || term.length > 200) continue
      insertTerm.run(term, search.count)
      result.searches++
    }

    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }

  return result
}

/** Only real web pages come across — no javascript:, file: or internal URLs. */
function isImportableUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

/** Past searches, offered in the omnibox alongside history. */
export function searchTerms(query: string, limit = 3): { term: string; count: number }[] {
  return db
    .prepare(
      `SELECT term, count FROM search_terms
       WHERE term LIKE ? ORDER BY count DESC, term ASC LIMIT ?`
    )
    .all(`${query}%`, limit) as unknown as { term: string; count: number }[]
}

export function countSearchTerms(): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM search_terms').get() as unknown as { n: number }
  return row.n
}

export function recordVisit(url: string, title: string): void {
  const now = Date.now()
  db.prepare('INSERT INTO visits (url, ts) VALUES (?, ?)').run(url, now)
  db.prepare(
    `INSERT INTO pages (url, title, visit_count, last_visit)
     VALUES (?, ?, 1, ?)
     ON CONFLICT(url) DO UPDATE SET
       visit_count = visit_count + 1,
       last_visit  = excluded.last_visit,
       title       = CASE WHEN excluded.title <> '' THEN excluded.title ELSE pages.title END`
  ).run(url, title, now)
}

export function updateTitle(url: string, title: string): void {
  if (!title) return
  db.prepare('UPDATE pages SET title = ? WHERE url = ?').run(title, url)
}

export function updateFavicon(url: string, favicon: string): void {
  db.prepare('UPDATE pages SET favicon = ? WHERE url = ?').run(favicon, url)
}

/** Replace the indexed body text for a URL. One FTS row per URL, always. */
export function indexPageText(url: string, title: string, body: string): void {
  db.prepare('DELETE FROM pages_fts WHERE url = ?').run(url)
  db.prepare('INSERT INTO pages_fts (url, title, body) VALUES (?, ?, ?)').run(url, title, body)
  db.prepare('UPDATE pages SET captured_at = ? WHERE url = ?').run(Date.now(), url)
}

/**
 * The point of the whole thing: search the text of pages you have actually
 * read, not just their titles. Ranked by FTS relevance, nudged by recency.
 */
export function searchFullText(query: string, limit = 8): HistoryHit[] {
  const match = toMatchQuery(query)
  if (!match) return []

  try {
    return db
      .prepare(
        `SELECT f.url                        AS url,
                COALESCE(p.title, f.title)   AS title,
                p.favicon                    AS favicon,
                COALESCE(p.last_visit, 0)    AS lastVisit,
                snippet(pages_fts, 2, '[', ']', '…', 12) AS snippet
         FROM pages_fts f
         LEFT JOIN pages p ON p.url = f.url
         WHERE pages_fts MATCH ?
         ORDER BY bm25(pages_fts, 0.0, 4.0, 1.0) - (COALESCE(p.last_visit, 0) / 1e13)
         LIMIT ?`
      )
      .all(match, limit) as unknown as HistoryHit[]
  } catch {
    // Malformed FTS expression (stray quote, bare operator) — treat as no hits.
    return []
  }
}

/** Classic title/URL prefix matching, for the top of the suggestion list. */
export function searchHistory(query: string, limit = 4): HistoryHit[] {
  const like = `%${query}%`
  return db
    .prepare(
      `SELECT url, title, favicon, last_visit AS lastVisit, NULL AS snippet
       FROM pages
       WHERE url LIKE ? OR title LIKE ?
       ORDER BY visit_count DESC, last_visit DESC
       LIMIT ?`
    )
    .all(like, like, limit) as unknown as HistoryHit[]
}

/**
 * The history page's list: every recorded page, newest first, optionally
 * filtered. Paged rather than loaded whole — a year of browsing is tens of
 * thousands of rows and building that many DOM nodes locks the page up.
 */
export function historyPage(query: string, limit: number, offset: number): HistoryHit[] {
  if (!query.trim()) {
    return db
      .prepare(
        `SELECT url, title, favicon, last_visit AS lastVisit, NULL AS snippet
         FROM pages ORDER BY last_visit DESC LIMIT ? OFFSET ?`
      )
      .all(limit, offset) as unknown as HistoryHit[]
  }

  const like = `%${query.trim()}%`
  return db
    .prepare(
      `SELECT url, title, favicon, last_visit AS lastVisit, NULL AS snippet
       FROM pages
       WHERE url LIKE ? OR title LIKE ?
       ORDER BY last_visit DESC LIMIT ? OFFSET ?`
    )
    .all(like, like, limit, offset) as unknown as HistoryHit[]
}

/** How many pages the history page is paging through. */
export function historyCount(query: string): number {
  if (!query.trim()) {
    return (db.prepare('SELECT COUNT(*) AS n FROM pages').get() as unknown as { n: number }).n
  }

  const like = `%${query.trim()}%`
  return (
    db
      .prepare('SELECT COUNT(*) AS n FROM pages WHERE url LIKE ? OR title LIKE ?')
      .get(like, like) as unknown as { n: number }
  ).n
}

export function recentHistory(limit = 100): HistoryHit[] {
  return db
    .prepare(
      `SELECT url, title, favicon, last_visit AS lastVisit, NULL AS snippet
       FROM pages ORDER BY last_visit DESC LIMIT ?`
    )
    .all(limit) as unknown as HistoryHit[]
}

// Never-remember list

/**
 * Domains the browser refuses to record, kept in memory because `shouldIndex`
 * is consulted on every navigation and every page load.
 */
let neverRemember = new Set<string>()

function loadNeverRemember(): void {
  const rows = db.prepare('SELECT domain FROM never_remember').all() as unknown as {
    domain: string
  }[]
  neverRemember = new Set(rows.map((r) => r.domain))
}

export function addNeverRemember(domain: string): void {
  const clean = normalizeDomain(domain)
  if (!clean) return
  db.prepare('INSERT OR IGNORE INTO never_remember (domain, created_at) VALUES (?, ?)').run(
    clean,
    Date.now()
  )
  loadNeverRemember()
}

export function removeNeverRemember(domain: string): void {
  db.prepare('DELETE FROM never_remember WHERE domain = ?').run(domain)
  loadNeverRemember()
}

export function listNeverRemember(): string[] {
  return [...neverRemember].sort()
}

/** Matches the host itself and any subdomain of it. */
export function isNeverRemembered(hostname: string): boolean {
  if (neverRemember.size === 0) return false

  const host = hostname.toLowerCase()
  if (neverRemember.has(host)) return true

  const labels = host.split('.')
  for (let i = 1; i < labels.length - 1; i++) {
    if (neverRemember.has(labels.slice(i).join('.'))) return true
  }
  return false
}

/**
 * Sites the user has turned blocking off for. Kept in memory for the same
 * reason as {@link neverRemember}: it is consulted on every single request.
 */
let adblockOff = new Set<string>()

function loadAdblockOff(): void {
  const rows = db.prepare('SELECT domain FROM adblock_off').all() as unknown as {
    domain: string
  }[]
  adblockOff = new Set(rows.map((r) => r.domain))
}

export function setAdblockOff(domain: string, off: boolean): void {
  const clean = normalizeDomain(domain)
  if (!clean) return

  if (off) {
    db.prepare('INSERT OR IGNORE INTO adblock_off (domain, created_at) VALUES (?, ?)').run(
      clean,
      Date.now()
    )
  } else {
    db.prepare('DELETE FROM adblock_off WHERE domain = ?').run(clean)
  }

  loadAdblockOff()
}

export function listAdblockOff(): string[] {
  return [...adblockOff].sort()
}

/** Matches the host itself and any subdomain of it. */
export function isAdblockOff(hostname: string): boolean {
  if (adblockOff.size === 0) return false

  const host = hostname.toLowerCase()
  if (adblockOff.has(host)) return true

  const labels = host.split('.')
  for (let i = 1; i < labels.length - 1; i++) {
    if (adblockOff.has(labels.slice(i).join('.'))) return true
  }
  return false
}

/** Purge everything already recorded for one domain and its subdomains. */
export function forgetSite(domain: string): number {
  const clean = normalizeDomain(domain)
  if (!clean) return 0

  const urls = (db.prepare('SELECT url FROM pages').all() as unknown as { url: string }[])
    .map((r) => r.url)
    .filter((url) => {
      try {
        const host = new URL(url).hostname.toLowerCase()
        return host === clean || host.endsWith(`.${clean}`)
      } catch {
        return false
      }
    })

  for (const url of urls) forgetUrl(url)
  return urls.length
}

function normalizeDomain(input: string): string {
  let text = input.trim().toLowerCase()
  if (!text) return ''

  // Accept a pasted URL as well as a bare hostname.
  if (text.includes('://')) {
    try {
      text = new URL(text).hostname
    } catch {
      return ''
    }
  }

  text = text.replace(/^www\./, '').split('/')[0].split(':')[0]
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(text) ? text : ''
}

export function readSetting(key: string): string | undefined {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as unknown as
    | { value: string }
    | undefined
  return row?.value
}

export function writeSetting(key: string, value: string): void {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, value)
}

/** Lifetime count of blocked requests. Survives "forget everything". */
/** Add to any named lifetime counter. */
export function bumpCounter(name: string, by: number): void {
  if (by <= 0) return
  db.prepare(
    `INSERT INTO counters (name, value) VALUES (?, ?)
     ON CONFLICT(name) DO UPDATE SET value = value + excluded.value`
  ).run(name, by)
}

export function counterValue(name: string): number {
  const row = db.prepare('SELECT value FROM counters WHERE name = ?').get(name) as unknown as
    | { value: number }
    | undefined
  return row?.value ?? 0
}

export function bumpBlockedCount(by: number): void {
  db.prepare(
    `INSERT INTO counters (name, value) VALUES ('blocked', ?)
     ON CONFLICT(name) DO UPDATE SET value = value + excluded.value`
  ).run(by)
}

export function blockedCount(): number {
  const row = db.prepare("SELECT value FROM counters WHERE name = 'blocked'").get() as unknown as
    | { value: number }
    | undefined
  return row?.value ?? 0
}

/**
 * Aggregate numbers for the new tab page. Word count is estimated from the
 * indexed body text rather than counted token by token — close enough for a
 * figure whose only job is to make you uncomfortable.
 */
export function recallStats(): RecallStats {
  // Pages whose history was cleared but whose text was kept are still pages
  // this browser can recall, so both tables count towards the total.
  const pages = db
    .prepare('SELECT COUNT(*) AS n FROM (SELECT url FROM pages UNION SELECT url FROM pages_fts)')
    .get() as unknown as { n: number }
  const visits = db.prepare('SELECT COUNT(*) AS n FROM visits').get() as unknown as { n: number }
  const chars = db.prepare('SELECT COALESCE(SUM(LENGTH(body)), 0) AS n FROM pages_fts').get() as unknown as {
    n: number
  }
  const oldest = db.prepare('SELECT MIN(ts) AS ts FROM visits').get() as unknown as {
    ts: number | null
  }

  const top = db
    .prepare(
      `SELECT url, SUM(visit_count) AS n FROM pages
       GROUP BY substr(url, 1, instr(substr(url, 9), '/') + 8)
       ORDER BY n DESC LIMIT 1`
    )
    .get() as unknown as { url: string; n: number } | undefined

  let topHost: string | null = null
  if (top) {
    try {
      topHost = new URL(top.url).hostname
    } catch {
      topHost = null
    }
  }

  return {
    pages: pages.n,
    visits: visits.n,
    words: Math.round(chars.n / 5.5),
    topHost,
    topHostVisits: top?.n ?? 0,
    oldestVisit: oldest.ts,
    blocked: blockedCount(),
    blockedThirdParty: counterValue('blocked_thirdparty'),
    // Filled in by the caller, which has access to the browsing session.
    cookies: 0,
    searches: countSearchTerms(),
    bookmarks: bookmarkCount()
  }
}

// Bookmarks

export function addBookmark(url: string, title: string, folder = BOOKMARKS_BAR): void {
  db.prepare(
    `INSERT INTO bookmarks (url, title, folder, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(url) DO UPDATE SET title = excluded.title`
  ).run(url, title, cleanFolder(folder), Date.now())
}

/** One bookmark, or null if the address is not saved. */
export function getBookmark(url: string): BookmarkEntry | null {
  const row = db
    .prepare(
      `SELECT b.url, b.title, b.created_at AS createdAt, COALESCE(b.folder, '') AS folder,
              p.favicon AS favicon
       FROM bookmarks b LEFT JOIN pages p ON p.url = b.url
       WHERE b.url = ?`
    )
    .get(url) as unknown as BookmarkEntry | undefined
  return row ?? null
}

export function updateBookmark(url: string, changes: { title?: string; folder?: string }): void {
  if (changes.title !== undefined) {
    db.prepare('UPDATE bookmarks SET title = ? WHERE url = ?').run(changes.title.slice(0, 500), url)
  }
  if (changes.folder !== undefined) {
    // Filed into a folder, the folder now exists in its own right, so moving
    // the bookmark out again later does not make the folder vanish with it.
    const folder = createBookmarkFolder(changes.folder)
    db.prepare('UPDATE bookmarks SET folder = ? WHERE url = ?').run(folder, url)
  }
}

/** "a / b/ /c" becomes "a/b/c": no empty segments, no stray spaces. */
function cleanFolder(path: string): string {
  return String(path ?? '')
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean)
    .join('/')
    .slice(0, 300)
}

/**
 * Every folder that exists, whether something is filed in it or it was made
 * empty, with the parents of nested folders listed too.
 */
export function bookmarkFolders(): string[] {
  const used = db
    .prepare("SELECT DISTINCT folder FROM bookmarks WHERE folder <> ''")
    .all() as unknown as { folder: string }[]
  const made = db.prepare('SELECT path FROM bookmark_folders').all() as unknown as { path: string }[]

  const all = new Set<string>([BOOKMARKS_BAR])
  for (const path of [...used.map((row) => row.folder), ...made.map((row) => row.path)]) {
    const parts = path.split('/')
    for (let i = 1; i <= parts.length; i++) all.add(parts.slice(0, i).join('/'))
  }
  return [...all].sort((a, b) => a.localeCompare(b))
}

export function createBookmarkFolder(path: string): string {
  const clean = cleanFolder(path)
  if (clean) {
    db.prepare('INSERT OR IGNORE INTO bookmark_folders (path, created_at) VALUES (?, ?)').run(
      clean,
      Date.now()
    )
  }
  return clean
}

/** Bookmarks and made folders at or under `path`. */
function folderContents(path: string): { marks: { url: string; folder: string }[]; made: string[] } {
  const marks = db
    .prepare('SELECT url, folder FROM bookmarks WHERE folder = ? OR folder LIKE ?')
    .all(path, `${path}/%`) as unknown as { url: string; folder: string }[]
  const made = (
    db
      .prepare('SELECT path FROM bookmark_folders WHERE path = ? OR path LIKE ?')
      .all(path, `${path}/%`) as unknown as { path: string }[]
  ).map((row) => row.path)
  return { marks, made }
}

/** Rename or move a folder, carrying everything inside it along. */
export function renameBookmarkFolder(from: string, to: string): void {
  const source = cleanFolder(from)
  const target = cleanFolder(to)
  if (!source || !target || source === target || target.startsWith(`${source}/`)) return

  const moved = (path: string): string => `${target}${path.slice(source.length)}`
  const { marks, made } = folderContents(source)

  db.exec('BEGIN')
  try {
    const setFolder = db.prepare('UPDATE bookmarks SET folder = ? WHERE url = ?')
    for (const mark of marks) setFolder.run(moved(mark.folder), mark.url)

    db.prepare('DELETE FROM bookmark_folders WHERE path = ? OR path LIKE ?').run(source, `${source}/%`)
    const insert = db.prepare('INSERT OR IGNORE INTO bookmark_folders (path, created_at) VALUES (?, ?)')
    for (const path of [source, ...made]) insert.run(moved(path), Date.now())

    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

/**
 * Remove a folder. Its bookmarks either go with it or move up into its parent,
 * keeping any subfolders' shape — so tidying up never loses anything saved
 * unless that was asked for.
 */
export function deleteBookmarkFolder(path: string, withBookmarks: boolean): number {
  const source = cleanFolder(path)
  if (!source) return 0

  const parent = source.includes('/') ? source.slice(0, source.lastIndexOf('/')) : ''
  const { marks } = folderContents(source)

  db.exec('BEGIN')
  try {
    if (withBookmarks) {
      db.prepare('DELETE FROM bookmarks WHERE folder = ? OR folder LIKE ?').run(source, `${source}/%`)
    } else {
      const setFolder = db.prepare('UPDATE bookmarks SET folder = ? WHERE url = ?')
      for (const mark of marks) {
        const rest = mark.folder.slice(source.length + 1)
        setFolder.run([parent, rest].filter(Boolean).join('/'), mark.url)
      }
    }
    db.prepare('DELETE FROM bookmark_folders WHERE path = ? OR path LIKE ?').run(source, `${source}/%`)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  return marks.length
}

export function removeBookmark(url: string): void {
  db.prepare('DELETE FROM bookmarks WHERE url = ?').run(url)
}

export function isBookmarked(url: string): boolean {
  return db.prepare('SELECT 1 FROM bookmarks WHERE url = ?').get(url) !== undefined
}

export function bookmarkCount(): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM bookmarks').get() as unknown as { n: number }
  return row.n
}

export function listBookmarks(): BookmarkEntry[] {
  return db
    .prepare(
      `SELECT b.url, b.title, b.created_at AS createdAt, COALESCE(b.folder, '') AS folder,
              p.favicon AS favicon
       FROM bookmarks b LEFT JOIN pages p ON p.url = b.url
       ORDER BY b.created_at DESC`
    )
    .all() as unknown as BookmarkEntry[]
}

// Session restore

export interface SessionTab {
  url: string
  pinned: boolean
  groupId: number | null
}

export interface SessionGroup {
  id: number
  name: string
  colour: string
}

export function saveSession(
  tabs: SessionTab[],
  activeIndex: number,
  groups: SessionGroup[] = []
): void {
  db.exec('DELETE FROM session_tabs')
  db.exec('DELETE FROM tab_groups')

  const insert = db.prepare(
    'INSERT INTO session_tabs (position, url, active, pinned, group_id) VALUES (?, ?, ?, ?, ?)'
  )
  tabs.forEach((tab, i) =>
    insert.run(i, tab.url, i === activeIndex ? 1 : 0, tab.pinned ? 1 : 0, tab.groupId)
  )

  const insertGroup = db.prepare(
    'INSERT INTO tab_groups (id, name, colour, position) VALUES (?, ?, ?, ?)'
  )
  groups.forEach((group, i) => insertGroup.run(group.id, group.name, group.colour, i))
}

export function loadSession(): {
  tabs: SessionTab[]
  groups: SessionGroup[]
  activeIndex: number
} {
  const rows = db
    .prepare('SELECT url, active, pinned, group_id AS groupId FROM session_tabs ORDER BY position')
    .all() as unknown as {
    url: string
    active: number
    pinned: number
    groupId: number | null
  }[]

  const groups = db
    .prepare('SELECT id, name, colour FROM tab_groups ORDER BY position')
    .all() as unknown as SessionGroup[]

  return {
    tabs: rows.map((row) => ({
      url: row.url,
      pinned: row.pinned === 1,
      groupId: row.groupId
    })),
    groups,
    activeIndex: Math.max(0, rows.findIndex((row) => row.active === 1))
  }
}

/** Forget a single page: history rows, indexed text, the lot. */
export function forgetUrl(url: string): void {
  db.prepare('DELETE FROM visits WHERE url = ?').run(url)
  db.prepare('DELETE FROM pages WHERE url = ?').run(url)
  db.prepare('DELETE FROM pages_fts WHERE url = ?').run(url)
}

/**
 * Forget where you went, but not what you read.
 *
 * The record of the visit goes — the page leaves the history list, the new tab
 * page and the address suggestions — while the indexed text stays, so recall
 * still finds the page by something written on it. The two are separate tables
 * precisely so this can be one without being the other.
 */
export function forgetVisit(url: string): void {
  db.prepare('DELETE FROM visits WHERE url = ?').run(url)
  db.prepare('DELETE FROM pages WHERE url = ?').run(url)
}

/** The same, for everything at once. */
export function clearHistoryOnly(): number {
  const count = (db.prepare('SELECT COUNT(*) AS n FROM pages').get() as unknown as { n: number }).n
  db.exec('DELETE FROM visits; DELETE FROM pages;')
  return count
}

export function clearAllHistory(): void {
  db.exec('DELETE FROM visits; DELETE FROM pages; DELETE FROM pages_fts;')
}

export function closeDb(): void {
  db?.close()
}

/**
 * Turn free-typed text into a safe FTS5 expression: quote every token so that
 * user input can never be read as FTS operators, and prefix-match the last
 * token so results appear while still typing.
 */
function toMatchQuery(input: string): string {
  const tokens = input
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1)

  if (tokens.length === 0) return ''

  return tokens.map((t, i) => (i === tokens.length - 1 ? `"${t}"*` : `"${t}"`)).join(' AND ')
}

// Site permissions


function ensurePermissionsTable(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS site_permissions (
      origin     TEXT NOT NULL,
      permission TEXT NOT NULL,
      allow      INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (origin, permission)
    )
  `)
}

export function sitePermission(origin: string, permission: string): boolean | null {
  ensurePermissionsTable()
  const row = db
    .prepare('SELECT allow FROM site_permissions WHERE origin = ? AND permission = ?')
    .get(origin, permission) as unknown as { allow: number } | undefined
  return row ? row.allow === 1 : null
}

export function setSitePermission(origin: string, permission: string, allow: boolean | null): void {
  ensurePermissionsTable()
  if (allow === null) {
    db.prepare('DELETE FROM site_permissions WHERE origin = ? AND permission = ?').run(origin, permission)
    return
  }
  db.prepare(
    `INSERT INTO site_permissions (origin, permission, allow, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(origin, permission) DO UPDATE SET allow = excluded.allow, updated_at = excluded.updated_at`
  ).run(origin, permission, allow ? 1 : 0, Date.now())
}

export function listSitePermissions(origin?: string): SitePermission[] {
  ensurePermissionsTable()
  const rows = (
    origin
      ? db
          .prepare('SELECT origin, permission, allow, updated_at FROM site_permissions WHERE origin = ?')
          .all(origin)
      : db.prepare('SELECT origin, permission, allow, updated_at FROM site_permissions ORDER BY origin').all()
  ) as unknown as { origin: string; permission: string; allow: number; updated_at: number }[]
  return rows.map((row) => ({
    origin: row.origin,
    permission: row.permission,
    allow: row.allow === 1,
    updatedAt: row.updated_at
  }))
}

// Password vault — only ciphertext is stored; see vault.ts for the keys.

function ensureVaultTables(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS vault_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS credentials (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      origin     TEXT NOT NULL,
      blob       TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_used  INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_credentials_origin ON credentials(origin);
    CREATE TABLE IF NOT EXISTS password_never (
      origin     TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    );
  `)
}

export function vaultMeta(key: string): string | null {
  ensureVaultTables()
  const row = db.prepare('SELECT value FROM vault_meta WHERE key = ?').get(key) as unknown as
    | { value: string }
    | undefined
  return row?.value ?? null
}

export function setVaultMeta(key: string, value: string | null): void {
  ensureVaultTables()
  if (value === null) db.prepare('DELETE FROM vault_meta WHERE key = ?').run(key)
  else db.prepare('INSERT INTO vault_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
}

export interface CredentialRow {
  id: number
  origin: string
  blob: string
  createdAt: number
  updatedAt: number
  lastUsed: number
}

export function credentialRows(origin?: string): CredentialRow[] {
  ensureVaultTables()
  const sql = `SELECT id, origin, blob, created_at AS createdAt, updated_at AS updatedAt, last_used AS lastUsed
               FROM credentials ${origin ? 'WHERE origin = ?' : ''} ORDER BY origin, id`
  return (origin ? db.prepare(sql).all(origin) : db.prepare(sql).all()) as unknown as CredentialRow[]
}

export function credentialRow(id: number): CredentialRow | null {
  ensureVaultTables()
  const row = db
    .prepare(
      `SELECT id, origin, blob, created_at AS createdAt, updated_at AS updatedAt, last_used AS lastUsed
       FROM credentials WHERE id = ?`
    )
    .get(id) as unknown as CredentialRow | undefined
  return row ?? null
}

export function credentialCount(origin?: string): number {
  ensureVaultTables()
  const row = (
    origin
      ? db.prepare('SELECT COUNT(*) AS n FROM credentials WHERE origin = ?').get(origin)
      : db.prepare('SELECT COUNT(*) AS n FROM credentials').get()
  ) as unknown as { n: number }
  return row.n
}

export function insertCredential(origin: string, blob: string): number {
  ensureVaultTables()
  const now = Date.now()
  const result = db
    .prepare('INSERT INTO credentials (origin, blob, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(origin, blob, now, now)
  return Number(result.lastInsertRowid)
}

export function updateCredentialRow(id: number, origin: string, blob: string): void {
  ensureVaultTables()
  db.prepare('UPDATE credentials SET origin = ?, blob = ?, updated_at = ? WHERE id = ?').run(origin, blob, Date.now(), id)
}

export function touchCredential(id: number): void {
  ensureVaultTables()
  db.prepare('UPDATE credentials SET last_used = ? WHERE id = ?').run(Date.now(), id)
}

export function deleteCredentialRow(id: number): void {
  ensureVaultTables()
  db.prepare('DELETE FROM credentials WHERE id = ?').run(id)
}

/** Every saved login and the vault's key material: what "forgot my master password" means. */
export function wipeVault(): void {
  ensureVaultTables()
  db.exec('DELETE FROM credentials; DELETE FROM vault_meta;')
}

/** Re-encrypt every row at once, or none of them. */
export function replaceCredentialBlobs(rows: { id: number; blob: string }[], meta: Record<string, string>): void {
  ensureVaultTables()
  db.exec('BEGIN')
  try {
    const update = db.prepare('UPDATE credentials SET blob = ? WHERE id = ?')
    for (const row of rows) update.run(row.blob, row.id)
    for (const [key, value] of Object.entries(meta)) setVaultMeta(key, value)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function neverSaveOrigins(): string[] {
  ensureVaultTables()
  return (db.prepare('SELECT origin FROM password_never ORDER BY origin').all() as unknown as { origin: string }[]).map(
    (row) => row.origin
  )
}

export function setNeverSave(origin: string, never: boolean): void {
  ensureVaultTables()
  if (never) db.prepare('INSERT OR IGNORE INTO password_never (origin, created_at) VALUES (?, ?)').run(origin, Date.now())
  else db.prepare('DELETE FROM password_never WHERE origin = ?').run(origin)
}

// Audio effects remembered per site

export function fxForSite(origin: string): string | null {
  db.exec('CREATE TABLE IF NOT EXISTS fx_sites (origin TEXT PRIMARY KEY, settings TEXT NOT NULL)')
  const row = db.prepare('SELECT settings FROM fx_sites WHERE origin = ?').get(origin) as unknown as
    | { settings: string }
    | undefined
  return row?.settings ?? null
}

export function setFxForSite(origin: string, settings: string | null): void {
  db.exec('CREATE TABLE IF NOT EXISTS fx_sites (origin TEXT PRIMARY KEY, settings TEXT NOT NULL)')
  if (settings === null) db.prepare('DELETE FROM fx_sites WHERE origin = ?').run(origin)
  else
    db.prepare(
      'INSERT INTO fx_sites (origin, settings) VALUES (?, ?) ON CONFLICT(origin) DO UPDATE SET settings = excluded.settings'
    ).run(origin, settings)
}
