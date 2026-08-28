import { DatabaseSync } from 'node:sqlite'
import { app } from 'electron'
import { join } from 'node:path'
import type {
  HistoryHit,
  BookmarkEntry,
  ImportPayload,
  ImportResult,
  RecallStats
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
  const result: ImportResult = { bookmarks: 0, history: 0, searches: 0, skipped: 0 }

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

export function addBookmark(url: string, title: string): void {
  db.prepare(
    `INSERT INTO bookmarks (url, title, created_at) VALUES (?, ?, ?)
     ON CONFLICT(url) DO UPDATE SET title = excluded.title`
  ).run(url, title, Date.now())
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
      `SELECT url, title, created_at AS createdAt, COALESCE(folder, '') AS folder
       FROM bookmarks ORDER BY created_at DESC`
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
