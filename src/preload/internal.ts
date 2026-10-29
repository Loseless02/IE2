import { contextBridge, ipcRenderer } from 'electron'
import type {
  BookmarkEntry,
  HistoryHit,
  ImportResult,
  ImportSource,
  ReaderArticle,
  RecallStats,
  SitePermission,
  VaultStatus,
  Credential,
  CredentialSummary,
  UpdateState
} from '../shared/types'
import type { Settings } from '../shared/settings'
import { watchForLogins } from './passwords'
import { watchAudio } from './audiofx'

/**
 * Preload for tab views. It runs in every tab, including hostile pages, so it
 * exposes nothing at all unless the frame is one of our own `ie2://` pages.
 *
 * This check is a convenience, not the security boundary — the main process
 * independently verifies the sender's URL on every one of these channels.
 */
// Websites get no API at all — only the password manager's form watcher,
// which lives in this isolated world where the page cannot reach it.
if (window.location.protocol === 'https:' || window.location.protocol === 'http:') {
  watchForLogins()
  watchAudio()
}

if (window.location.protocol === 'ie2:') {
  const api = {
    /** Chromium and Electron versions, for the About section. */
    versions: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node
    },
    stats: (): Promise<RecallStats> => ipcRenderer.invoke('internal:stats'),
    recall: (query: string): Promise<HistoryHit[]> => ipcRenderer.invoke('internal:recall', query),
    recent: (limit?: number): Promise<HistoryHit[]> => ipcRenderer.invoke('internal:recent', limit),
    forget: (url: string): Promise<void> => ipcRenderer.invoke('internal:forget', url),
    forgetEverything: (alsoCookies = false): Promise<void> =>
      ipcRenderer.invoke('internal:forget-all', alsoCookies),

    /** Where you went, without what you read. */
    forgetVisits: (urls: string[]): Promise<number> =>
      ipcRenderer.invoke('internal:forget-visit', urls),
    forgetHistory: (): Promise<number> => ipcRenderer.invoke('internal:forget-history'),
    history: (
      query: string,
      limit: number,
      offset: number
    ): Promise<{ rows: HistoryHit[]; total: number }> =>
      ipcRenderer.invoke('internal:history', query, limit, offset),
    getSettings: (): Promise<Settings> => ipcRenderer.invoke('internal:settings-get'),
    setSetting: (key: string, value: unknown): Promise<Settings> =>
      ipcRenderer.invoke('internal:settings-set', key, value),
    resetSettings: (): Promise<Settings> => ipcRenderer.invoke('internal:settings-reset'),
    restart: (): Promise<void> => ipcRenderer.invoke('internal:restart'),

    /** Whether Windows currently opens links with IE2, and asking to change it. */
    isDefaultBrowser: (): Promise<boolean> => ipcRenderer.invoke('internal:default-browser'),
    makeDefaultBrowser: (): Promise<boolean> => ipcRenderer.invoke('internal:make-default'),

    /** The article reader mode extracted for this tab. */
    readerArticle: (): Promise<ReaderArticle | null> =>
      ipcRenderer.invoke('internal:reader-article'),

    /** The newest section of the changelog that shipped with this build. */
    changelog: (): Promise<{ version: string; lines: string[] }> =>
      ipcRenderer.invoke('internal:changelog'),

    /** Updates from the project's GitHub releases. */
    updateState: (): Promise<UpdateState> => ipcRenderer.invoke('internal:update-state'),
    checkForUpdate: (): Promise<UpdateState> => ipcRenderer.invoke('internal:update-check'),
    downloadUpdate: (): Promise<void> => ipcRenderer.invoke('internal:update-download'),
    installUpdate: (): Promise<void> => ipcRenderer.invoke('internal:update-install'),
    onUpdateState: (callback: (state: UpdateState) => void): void => {
      ipcRenderer.on('update:state', (_e, state: UpdateState) => callback(state))
    },
    copyText: (text: string): Promise<boolean> => ipcRenderer.invoke('internal:copy-text', text),
    languages: (): Promise<{ code: string; name: string; builtIn: boolean }[]> =>
      ipcRenderer.invoke('internal:languages'),
    addLanguage: (code: string, name: string): Promise<boolean> =>
      ipcRenderer.invoke('internal:language-add', code, name),
    removeLanguage: (code: string): Promise<void> =>
      ipcRenderer.invoke('internal:language-remove', code),
    messages: (language: string): Promise<Record<string, string>> =>
      ipcRenderer.invoke('internal:messages', language),
    localeEntries: (
      language: string
    ): Promise<{
      entries: { key: string; group: string; english: string; translated: string }[]
      progress: number
    }> => ipcRenderer.invoke('internal:locale-entries', language),
    setMessage: (language: string, key: string, value: string): Promise<void> =>
      ipcRenderer.invoke('internal:set-message', language, key, value),
    exportLocale: (language: string): Promise<string | null> =>
      ipcRenderer.invoke('internal:locale-export', language),
    importLocale: (language: string): Promise<number | null> =>
      ipcRenderer.invoke('internal:locale-import', language),
    updateFilterLists: (): Promise<boolean> => ipcRenderer.invoke('internal:update-lists'),
    listsUpdatedAt: (): Promise<number> => ipcRenderer.invoke('internal:lists-updated'),
    listBookmarks: (): Promise<BookmarkEntry[]> => ipcRenderer.invoke('internal:bookmarks'),
    removeBookmark: (url: string): Promise<void> =>
      ipcRenderer.invoke('internal:bookmark-remove', url),
    updateBookmark: (url: string, changes: { title?: string; folder?: string }): Promise<void> =>
      ipcRenderer.invoke('internal:bookmark-update', url, changes),
    bookmarkFolders: (): Promise<string[]> => ipcRenderer.invoke('internal:bookmark-folders'),
    createFolder: (path: string): Promise<string> => ipcRenderer.invoke('internal:folder-create', path),
    renameFolder: (from: string, to: string): Promise<void> =>
      ipcRenderer.invoke('internal:folder-rename', from, to),
    deleteFolder: (path: string, withBookmarks: boolean): Promise<number> =>
      ipcRenderer.invoke('internal:folder-delete', path, withBookmarks),
    exportBookmarks: (): Promise<number | null> => ipcRenderer.invoke('internal:bookmarks-export'),
    sitePermissions: (): Promise<SitePermission[]> => ipcRenderer.invoke('internal:permissions'),

    /** The vault. The main process answers these for ie2://passwords only. */
    vault: {
      status: (): Promise<VaultStatus> => ipcRenderer.invoke('vault:status'),
      create: (master: string): Promise<{ ok: boolean; error?: string }> =>
        ipcRenderer.invoke('vault:create', master),
      unlock: (master: string): Promise<{ ok: boolean; error?: string }> =>
        ipcRenderer.invoke('vault:unlock', master),
      lock: (): Promise<void> => ipcRenderer.invoke('vault:lock'),
      list: (): Promise<CredentialSummary[]> => ipcRenderer.invoke('vault:list'),
      reveal: (id: number): Promise<Credential | null> => ipcRenderer.invoke('vault:reveal', id),
      save: (entry: {
        id?: number
        url: string
        username: string
        password: string
        note?: string
      }): Promise<number | null> => ipcRenderer.invoke('vault:save', entry),
      remove: (id: number): Promise<void> => ipcRenderer.invoke('vault:delete', id),
      generate: (): Promise<string> => ipcRenderer.invoke('vault:generate'),
      change: (current: string, next: string): Promise<{ ok: boolean; error?: string }> =>
        ipcRenderer.invoke('vault:change', current, next),
      wipe: (): Promise<void> => ipcRenderer.invoke('vault:wipe'),
      neverList: (): Promise<string[]> => ipcRenderer.invoke('vault:never-list'),
      neverRemove: (origin: string): Promise<void> => ipcRenderer.invoke('vault:never-remove', origin),
      exportCsv: (master: string): Promise<{ ok: boolean; error?: string }> =>
        ipcRenderer.invoke('vault:export', master),
      importCsv: (): Promise<{ added: number; updated: number; skipped: number } | null> =>
        ipcRenderer.invoke('vault:import')
    },
    forgetPermission: (origin: string, permission: string): Promise<void> =>
      ipcRenderer.invoke('internal:permission-forget', origin, permission),
    closeSidebar: (): Promise<void> => ipcRenderer.invoke('internal:sidebar-close'),
    /** Drag the sidebar to this width; `done` keeps it for next time. */
    resizeSidebar: (width: number, done: boolean): Promise<void> =>
      ipcRenderer.invoke('internal:sidebar-resize', width, done),
    onBookmarksChanged: (callback: () => void): void => {
      ipcRenderer.on('ie2:bookmarks-changed', () => callback())
    },
    pickImage: (): Promise<string | null> => ipcRenderer.invoke('internal:pick-image'),
    pickFolder: (): Promise<{ folder: string; count: number } | null> =>
      ipcRenderer.invoke('internal:pick-folder'),
    scanForImport: (): Promise<ImportSource[]> => ipcRenderer.invoke('internal:import-scan'),
    runImport: (
      id: string,
      what: { bookmarks: boolean; history: boolean; searches: boolean; cookies?: boolean }
    ): Promise<ImportResult | null> => ipcRenderer.invoke('internal:import-run', id, what),
    /** `background` keeps the current tab in front, as a middle-click does. */
    open: (url: string, newTab?: boolean, background?: boolean): Promise<void> =>
      ipcRenderer.invoke('internal:open', url, newTab, background),

    listNeverRemember: (): Promise<string[]> => ipcRenderer.invoke('internal:never-list'),
    addNeverRemember: (domain: string): Promise<void> =>
      ipcRenderer.invoke('internal:never-add', domain),
    removeNeverRemember: (domain: string): Promise<void> =>
      ipcRenderer.invoke('internal:never-remove', domain),
    forgetSite: (domain: string): Promise<number> =>
      ipcRenderer.invoke('internal:forget-site', domain)
  }

  contextBridge.exposeInMainWorld('ie2', api)
}

export type InternalApi = {
  versions: { electron: string; chrome: string; node: string }
  stats: () => Promise<RecallStats>
  recall: (query: string) => Promise<HistoryHit[]>
  recent: (limit?: number) => Promise<HistoryHit[]>
  forget: (url: string) => Promise<void>
  forgetEverything: (alsoCookies?: boolean) => Promise<void>
  forgetVisits: (urls: string[]) => Promise<number>
  forgetHistory: () => Promise<number>
  history: (
    query: string,
    limit: number,
    offset: number
  ) => Promise<{ rows: HistoryHit[]; total: number }>
  getSettings: () => Promise<Settings>
  setSetting: (key: string, value: unknown) => Promise<Settings>
  resetSettings: () => Promise<Settings>
  restart: () => Promise<void>
  isDefaultBrowser: () => Promise<boolean>
  makeDefaultBrowser: () => Promise<boolean>
  readerArticle: () => Promise<ReaderArticle | null>
  changelog: () => Promise<{ version: string; lines: string[] }>
  updateState: () => Promise<UpdateState>
  checkForUpdate: () => Promise<UpdateState>
  downloadUpdate: () => Promise<void>
  installUpdate: () => Promise<void>
  onUpdateState: (callback: (state: UpdateState) => void) => void
  copyText: (text: string) => Promise<boolean>
  languages: () => Promise<{ code: string; name: string; builtIn: boolean }[]>
  addLanguage: (code: string, name: string) => Promise<boolean>
  removeLanguage: (code: string) => Promise<void>
  messages: (language: string) => Promise<Record<string, string>>
  localeEntries: (language: string) => Promise<{
    entries: { key: string; group: string; english: string; translated: string }[]
    progress: number
  }>
  setMessage: (language: string, key: string, value: string) => Promise<void>
  exportLocale: (language: string) => Promise<string | null>
  importLocale: (language: string) => Promise<number | null>
  updateFilterLists: () => Promise<boolean>
  listsUpdatedAt: () => Promise<number>
  listBookmarks: () => Promise<BookmarkEntry[]>
  removeBookmark: (url: string) => Promise<void>
  updateBookmark: (url: string, changes: { title?: string; folder?: string }) => Promise<void>
  bookmarkFolders: () => Promise<string[]>
  createFolder: (path: string) => Promise<string>
  renameFolder: (from: string, to: string) => Promise<void>
  deleteFolder: (path: string, withBookmarks: boolean) => Promise<number>
  exportBookmarks: () => Promise<number | null>
  sitePermissions: () => Promise<SitePermission[]>
  vault: {
    status: () => Promise<VaultStatus>
    create: (master: string) => Promise<{ ok: boolean; error?: string }>
    unlock: (master: string) => Promise<{ ok: boolean; error?: string }>
    lock: () => Promise<void>
    list: () => Promise<CredentialSummary[]>
    reveal: (id: number) => Promise<Credential | null>
    save: (entry: { id?: number; url: string; username: string; password: string; note?: string }) => Promise<number | null>
    remove: (id: number) => Promise<void>
    generate: () => Promise<string>
    change: (current: string, next: string) => Promise<{ ok: boolean; error?: string }>
    wipe: () => Promise<void>
    neverList: () => Promise<string[]>
    neverRemove: (origin: string) => Promise<void>
    exportCsv: (master: string) => Promise<{ ok: boolean; error?: string }>
    importCsv: () => Promise<{ added: number; updated: number; skipped: number } | null>
  }
  forgetPermission: (origin: string, permission: string) => Promise<void>
  closeSidebar: () => Promise<void>
  resizeSidebar: (width: number, done: boolean) => Promise<void>
  onBookmarksChanged: (callback: () => void) => void
  pickImage: () => Promise<string | null>
  pickFolder: () => Promise<{ folder: string; count: number } | null>
  scanForImport: () => Promise<ImportSource[]>
  runImport: (
    id: string,
    what: { bookmarks: boolean; history: boolean; searches: boolean; cookies?: boolean }
  ) => Promise<ImportResult | null>
  open: (url: string, newTab?: boolean, background?: boolean) => Promise<void>
  listNeverRemember: () => Promise<string[]>
  addNeverRemember: (domain: string) => Promise<void>
  removeNeverRemember: (domain: string) => Promise<void>
  forgetSite: (domain: string) => Promise<number>
}
