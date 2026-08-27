import { contextBridge, ipcRenderer } from 'electron'
import type {
  BookmarkEntry,
  HistoryHit,
  ImportResult,
  ImportSource,
  RecallStats,
  UpdateState
} from '../shared/types'
import type { Settings } from '../shared/settings'

/**
 * Preload for tab views. It runs in every tab, including hostile pages, so it
 * exposes nothing at all unless the frame is one of our own `ie2://` pages.
 *
 * This check is a convenience, not the security boundary — the main process
 * independently verifies the sender's URL on every one of these channels.
 */
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
    getSettings: (): Promise<Settings> => ipcRenderer.invoke('internal:settings-get'),
    setSetting: (key: string, value: unknown): Promise<Settings> =>
      ipcRenderer.invoke('internal:settings-set', key, value),
    resetSettings: (): Promise<Settings> => ipcRenderer.invoke('internal:settings-reset'),
    restart: (): Promise<void> => ipcRenderer.invoke('internal:restart'),

    /** Whether Windows currently opens links with IE2, and asking to change it. */
    isDefaultBrowser: (): Promise<boolean> => ipcRenderer.invoke('internal:default-browser'),
    makeDefaultBrowser: (): Promise<boolean> => ipcRenderer.invoke('internal:make-default'),

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
    pickImage: (): Promise<string | null> => ipcRenderer.invoke('internal:pick-image'),
    pickFolder: (): Promise<{ folder: string; count: number } | null> =>
      ipcRenderer.invoke('internal:pick-folder'),
    scanForImport: (): Promise<ImportSource[]> => ipcRenderer.invoke('internal:import-scan'),
    runImport: (
      id: string,
      what: { bookmarks: boolean; history: boolean; searches: boolean }
    ): Promise<ImportResult> => ipcRenderer.invoke('internal:import-run', id, what),
    open: (url: string): Promise<void> => ipcRenderer.invoke('internal:open', url),

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
  getSettings: () => Promise<Settings>
  setSetting: (key: string, value: unknown) => Promise<Settings>
  resetSettings: () => Promise<Settings>
  restart: () => Promise<void>
  isDefaultBrowser: () => Promise<boolean>
  makeDefaultBrowser: () => Promise<boolean>
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
  pickImage: () => Promise<string | null>
  pickFolder: () => Promise<{ folder: string; count: number } | null>
  scanForImport: () => Promise<ImportSource[]>
  runImport: (
    id: string,
    what: { bookmarks: boolean; history: boolean; searches: boolean }
  ) => Promise<ImportResult>
  open: (url: string) => Promise<void>
  listNeverRemember: () => Promise<string[]>
  addNeverRemember: (domain: string) => Promise<void>
  removeNeverRemember: (domain: string) => Promise<void>
  forgetSite: (domain: string) => Promise<number>
}
