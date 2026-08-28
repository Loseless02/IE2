import { contextBridge, ipcRenderer } from 'electron'
import type {
  BrowserState,
  BookmarkEntry,
  ClosedTab,
  DownloadState,
  HistoryHit,
  MediaState,
  ScreenshotResult,
  Suggestion
} from '../shared/types'

/**
 * The only bridge between the chrome UI and the main process. Every entry is a
 * named operation with a fixed shape — no generic `invoke(channel, ...)` escape
 * hatch, so a compromised UI renderer cannot reach arbitrary IPC handlers.
 */
const api = {
  createTab: (url?: string): Promise<number> => ipcRenderer.invoke('tab:create', url),
  createAmnesiaTab: (): Promise<number> => ipcRenderer.invoke('tab:amnesia'),
  createTabAt: (url: string, index: number): Promise<number> =>
    ipcRenderer.invoke('tab:create-at', url, index),
  goHome: (): Promise<void> => ipcRenderer.invoke('nav:home'),
  copyLink: (): Promise<string | null> => ipcRenderer.invoke('page:copy-link'),
  screenshot: (): Promise<ScreenshotResult | null> => ipcRenderer.invoke('page:screenshot'),
  saveScreenshot: (): Promise<string | null> => ipcRenderer.invoke('page:screenshot-save'),
  pictureInPicture: (): Promise<string> => ipcRenderer.invoke('page:pip'),
  /** Find in page. Results arrive on onFindResult as Chromium counts them. */
  find: (text: string, options?: { forward?: boolean; findNext?: boolean }): Promise<boolean> =>
    ipcRenderer.invoke('page:find', text, options),
  stopFind: (): Promise<void> => ipcRenderer.invoke('page:find-stop'),
  onFindResult: (callback: (result: { matches: number; active: number }) => void): void => {
    ipcRenderer.on('browser:find-result', (_e, result) => callback(result))
  },
  onOpenFind: (callback: () => void): void => {
    ipcRenderer.on('browser:open-find', () => callback())
  },

  /** Reader mode: strip the page back to the article, or return to it. */
  readerMode: (): Promise<boolean> => ipcRenderer.invoke('page:reader'),
  media: (): Promise<MediaState | null> => ipcRenderer.invoke('page:media'),
  saveQr: (dataUrl: string, host: string): Promise<string | null> =>
    ipcRenderer.invoke('page:save-qr', dataUrl, host),
  controlMedia: (action: string): Promise<boolean> =>
    ipcRenderer.invoke('page:media-control', action),
  splitWith: (id: number | null): Promise<void> => ipcRenderer.invoke('tab:split', id),
  toggleSplit: (): Promise<void> => ipcRenderer.invoke('tab:split-toggle'),
  adjustSplit: (delta: number): Promise<void> => ipcRenderer.invoke('tab:split-adjust', delta),
  onPip: (callback: (result: string) => void): void => {
    ipcRenderer.on('browser:pip', (_event, result: string) => callback(result))
  },
  onScreenshot: (callback: (shot: ScreenshotResult) => void): void => {
    ipcRenderer.on('browser:screenshot', (_event, shot: ScreenshotResult) => callback(shot))
  },
  toggleCompat: (): Promise<void> => ipcRenderer.invoke('view:compat'),
  toggleAdblock: (): Promise<void> => ipcRenderer.invoke('adblock:toggle'),
  /** Turn blocking off, or back on, for the site in the active tab. */
  toggleSiteBlocking: (): Promise<boolean> => ipcRenderer.invoke('adblock:toggle-site'),
  cancelDownload: (id: number): Promise<void> => ipcRenderer.invoke('download:cancel', id),
  revealDownload: (id: number): Promise<void> => ipcRenderer.invoke('download:reveal', id),
  clearDownloads: (): Promise<void> => ipcRenderer.invoke('download:clear'),
  listDownloads: (): Promise<DownloadState[]> => ipcRenderer.invoke('download:list'),
  closeTab: (id: number): Promise<void> => ipcRenderer.invoke('tab:close', id),
  activateTab: (id: number): Promise<void> => ipcRenderer.invoke('tab:activate', id),
  /** Send one tab somewhere, without having to activate it first. */
  navigateTab: (id: number, url: string): Promise<void> =>
    ipcRenderer.invoke('tab:navigate', id, url),
  tabMenu: (id: number, selected: number[] = []): Promise<void> =>
    ipcRenderer.invoke('tab:menu', id, selected),

  /** Discard a background tab's page, or bring it back. */
  sleepTab: (id: number): Promise<void> => ipcRenderer.invoke('tab:sleep', id),
  wakeTab: (id: number): Promise<void> => ipcRenderer.invoke('tab:wake', id),

  /** Pinning and tab groups. */
  pinTabs: (ids: number[], pinned: boolean): Promise<void> =>
    ipcRenderer.invoke('tab:pin', ids, pinned),
  createGroup: (ids: number[], name?: string): Promise<number> =>
    ipcRenderer.invoke('tab:group-create', ids, name),
  addToGroup: (ids: number[], groupId: number): Promise<void> =>
    ipcRenderer.invoke('tab:group-add', ids, groupId),
  removeFromGroup: (ids: number[]): Promise<void> =>
    ipcRenderer.invoke('tab:group-remove', ids),
  updateGroup: (
    groupId: number,
    changes: { name?: string; colour?: string; collapsed?: boolean }
  ): Promise<void> => ipcRenderer.invoke('tab:group-update', groupId, changes),
  ungroup: (groupId: number): Promise<void> => ipcRenderer.invoke('tab:group-ungroup', groupId),
  closeGroup: (groupId: number): Promise<void> => ipcRenderer.invoke('tab:group-close', groupId),
  newTabInGroup: (groupId: number): Promise<void> =>
    ipcRenderer.invoke('tab:group-new-tab', groupId),
  moveTab: (id: number, toIndex: number): Promise<void> =>
    ipcRenderer.invoke('tab:move', id, toIndex),
  detachTab: (id: number): Promise<boolean> => ipcRenderer.invoke('tab:detach', id),
  closedTabs: (): Promise<ClosedTab[]> => ipcRenderer.invoke('tab:closed-list'),
  reopenTab: (id?: number): Promise<boolean> => ipcRenderer.invoke('tab:reopen', id),
  navigate: (input: string): Promise<void> => ipcRenderer.invoke('nav:go', input),
  back: (): Promise<void> => ipcRenderer.invoke('nav:back'),
  forward: (): Promise<void> => ipcRenderer.invoke('nav:forward'),
  reload: (): Promise<void> => ipcRenderer.invoke('nav:reload'),
  stop: (): Promise<void> => ipcRenderer.invoke('nav:stop'),
  toggleDevTools: (): Promise<void> => ipcRenderer.invoke('view:devtools'),
  setDropdownHeight: (px: number): Promise<void> => ipcRenderer.invoke('view:dropdown', px),

  getState: (): Promise<BrowserState | null> => ipcRenderer.invoke('browser:state'),
  onState: (callback: (state: BrowserState) => void): void => {
    ipcRenderer.on('browser:state', (_event, state: BrowserState) => callback(state))
  },
  onFocusOmnibox: (callback: () => void): void => {
    ipcRenderer.on('browser:focus-omnibox', () => callback())
  },
  onOpenPalette: (callback: () => void): void => {
    ipcRenderer.on('browser:open-palette', () => callback())
  },

  suggest: (input: string): Promise<Suggestion[]> => ipcRenderer.invoke('omni:suggest', input),
  /** Engine autocomplete, which arrives after the local results it belongs to. */
  onExtraSuggestions: (
    callback: (payload: { query: string; items: Suggestion[] }) => void
  ): void => {
    ipcRenderer.on('omni:suggestions-extra', (_e, payload) => callback(payload))
  },
  recentHistory: (limit?: number): Promise<HistoryHit[]> =>
    ipcRenderer.invoke('history:recent', limit),
  forgetUrl: (url: string): Promise<void> => ipcRenderer.invoke('history:forget', url),
  clearHistory: (): Promise<void> => ipcRenderer.invoke('history:clear'),

  toggleBookmark: (): Promise<void> => ipcRenderer.invoke('bookmark:toggle'),
  installApp: (): Promise<{ name: string; shortcut: string } | null> =>
    ipcRenderer.invoke('app:install'),
  listBookmarks: (): Promise<BookmarkEntry[]> => ipcRenderer.invoke('bookmark:list')
}

contextBridge.exposeInMainWorld('browser', api)

export type BrowserApi = typeof api
