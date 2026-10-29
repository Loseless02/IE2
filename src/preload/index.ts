import { contextBridge, ipcRenderer } from 'electron'
import type {
  BrowserState,
  BookmarkEntry,
  ClosedTab,
  DownloadState,
  HistoryHit,
  MediaState,
  PasswordOffer,
  PasswordsForPage,
  PermissionRequest,
  PublicIp,
  SitePermission,
  ScreenshotResult,
  Suggestion,
  ExtensionInfo,
  ExtensionInstallRequest
} from '../shared/types'
import type { AudioFx, AudioFxPreset, AudioFxState } from '../shared/audiofx'

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
  /**
   * A tab dragged out of its strip. Hover reports where the pointer is, in
   * screen coordinates, so another window can show where it would land; drop
   * moves it there, or into a window of its own.
   */
  hoverTab: (x: number, y: number): Promise<void> => ipcRenderer.invoke('tab:drag-hover', x, y),
  dropTab: (id: number, x: number, y: number): Promise<boolean> =>
    ipcRenderer.invoke('tab:drop', id, x, y),
  /** A tab from another window is over this strip at x (null: it left). */
  onTabHover: (callback: (x: number | null) => void): void => {
    ipcRenderer.on('browser:tab-hover', (_e, x: number | null) => callback(x))
  },
  setDropIndex: (index: number): Promise<void> => ipcRenderer.invoke('tab:drop-index', index),
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
  listBookmarks: (): Promise<BookmarkEntry[]> => ipcRenderer.invoke('bookmark:list'),
  /** Save the page if it is not saved yet, and get what the star's editor shows. */
  editBookmark: (): Promise<{ entry: BookmarkEntry; folders: string[]; created: boolean } | null> =>
    ipcRenderer.invoke('bookmark:edit'),
  saveBookmark: (url: string, changes: { title?: string; folder?: string }): Promise<void> =>
    ipcRenderer.invoke('bookmark:save', url, changes),
  removeBookmark: (url: string): Promise<void> => ipcRenderer.invoke('bookmark:remove', url),
  bookmarkFolders: (): Promise<string[]> => ipcRenderer.invoke('bookmark:folders'),
  toggleSidebar: (): Promise<void> => ipcRenderer.invoke('sidebar:toggle'),
  /** The opening animation: whether to play it, and that it has finished. */
  booting: (): Promise<boolean> => ipcRenderer.invoke('view:booting'),
  booted: (): Promise<void> => ipcRenderer.invoke('view:booted'),
  /** Asks an IP-check service; only called when the Public IP panel opens. */
  publicIp: (): Promise<PublicIp> => ipcRenderer.invoke('net:public-ip'),

  /** Chrome extensions, as the toolbar in front shows them. */
  extensions: (): Promise<ExtensionInfo[]> => ipcRenderer.invoke('ext:list'),
  onExtensionsChanged: (callback: (list: ExtensionInfo[]) => void): void => {
    ipcRenderer.on('ext:changed', (_event, list: ExtensionInfo[]) => callback(list))
  },
  /** Its button was clicked; the popup hangs from `anchor`, in window coordinates. */
  clickExtension: (id: string, anchor: { x: number; y: number; width: number; height: number }): Promise<void> =>
    ipcRenderer.invoke('ext:click', id, anchor),
  extensionMenu: (id: string): Promise<void> => ipcRenderer.invoke('ext:menu', id),
  pinExtension: (id: string, pinned: boolean): Promise<void> => ipcRenderer.invoke('ext:pin', id, pinned),
  openExtensionStore: (): Promise<void> => ipcRenderer.invoke('ext:store'),
  /** The store asking to add an extension, and the question going away. */
  onExtensionInstallPrompt: (callback: (request: ExtensionInstallRequest) => void): void => {
    ipcRenderer.on('ext:install-prompt', (_event, request: ExtensionInstallRequest) => callback(request))
  },
  onExtensionInstallDone: (callback: (requestId: number) => void): void => {
    ipcRenderer.on('ext:install-done', (_event, requestId: number) => callback(requestId))
  },
  answerExtensionInstall: (requestId: number, allow: boolean): Promise<void> =>
    ipcRenderer.invoke('ext:install-answer', requestId, allow),

  /** Audio effects for whatever the tab in front is playing. */
  audioFx: (): Promise<AudioFxState | null> => ipcRenderer.invoke('fx:get'),
  setAudioFx: (fx: AudioFx, remember: boolean): Promise<AudioFxState | null> =>
    ipcRenderer.invoke('fx:set', fx, remember),
  onAudioFxChanged: (callback: () => void): void => {
    ipcRenderer.on('browser:fx-changed', () => callback())
  },
  saveAudioPresets: (presets: AudioFxPreset[]): Promise<void> =>
    ipcRenderer.invoke('settings:set', 'audioPresets', presets),

  /** The password manager, as the toolbar sees it: never a password itself. */
  onPasswordOffer: (callback: (offer: PasswordOffer) => void): void => {
    ipcRenderer.on('browser:password-offer', (_e, offer: PasswordOffer) => callback(offer))
  },
  onPasswordsChanged: (callback: () => void): void => {
    ipcRenderer.on('browser:passwords-changed', () => callback())
  },
  answerPasswordOffer: (
    choice: 'save' | 'never' | 'dismiss',
    master?: string
  ): Promise<{ ok: boolean; error?: string; updated?: boolean }> =>
    ipcRenderer.invoke('pw:offer-answer', choice, master),
  passwordsForPage: (): Promise<PasswordsForPage | null> => ipcRenderer.invoke('pw:for-page'),
  fillPassword: (id: number): Promise<boolean> => ipcRenderer.invoke('pw:fill', id),
  unlockPasswords: (master: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('pw:unlock', master),
  /** A site asking for the camera, location and the like. */
  onPermissionRequest: (callback: (request: PermissionRequest) => void): void => {
    ipcRenderer.on('browser:permission-request', (_e, request: PermissionRequest) => callback(request))
  },
  answerPermission: (id: number, allow: boolean, remember: boolean): Promise<void> =>
    ipcRenderer.invoke('permission:answer', id, allow, remember),
  pendingPermissions: (): Promise<PermissionRequest[]> => ipcRenderer.invoke('permission:pending'),
  sitePermissions: (origin: string): Promise<SitePermission[]> =>
    ipcRenderer.invoke('permission:site', origin),
  setSitePermission: (origin: string, permission: string, allow: boolean | null): Promise<void> =>
    ipcRenderer.invoke('permission:set', origin, permission, allow),
  /** The toolbar tools in the order they were dragged into. */
  setDarkMode: (on: boolean): Promise<void> => ipcRenderer.invoke('settings:set', 'darkMode', on),
  /** The sites dark mode is switched off for. */
  setDarkModeOff: (sites: string[]): Promise<void> => ipcRenderer.invoke('settings:set', 'darkModeOff', sites),
  setToolbarOrder: (order: string[]): Promise<void> =>
    ipcRenderer.invoke('settings:set', 'toolbarOrder', order),
  /** Ctrl+D, caught wherever the focus was. */
  onEditBookmark: (callback: () => void): void => {
    ipcRenderer.on('browser:edit-bookmark', () => callback())
  },
  onBookmarksChanged: (callback: () => void): void => {
    ipcRenderer.on('browser:bookmarks-changed', () => callback())
  }
}

contextBridge.exposeInMainWorld('browser', api)

export type BrowserApi = typeof api
