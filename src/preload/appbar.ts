import { contextBridge, ipcRenderer } from 'electron'
import type { AudioFx, AudioFxPreset, AudioFxState } from '../shared/audiofx'
import type { Settings } from '../shared/settings'
import type { ExtensionInfo } from '../shared/types'

/** What the title bar of an installed app shows about its page. */
export interface AppBarState {
  title: string
  url: string
  favicon: string | null
  canGoBack: boolean
  canGoForward: boolean
  loading: boolean
}

/**
 * The bridge for an installed app's title bar: the few things it can do to its
 * own window and page, and nothing else.
 */
const api = {
  state: (): Promise<AppBarState | null> => ipcRenderer.invoke('appbar:state'),
  onState: (callback: (state: AppBarState) => void): void => {
    ipcRenderer.on('appbar:state', (_event, state: AppBarState) => callback(state))
  },
  back: (): Promise<void> => ipcRenderer.invoke('appbar:back'),
  forward: (): Promise<void> => ipcRenderer.invoke('appbar:forward'),
  reload: (): Promise<void> => ipcRenderer.invoke('appbar:reload'),
  /** Open the page in a normal browser tab. */
  openInBrowser: (): Promise<void> => ipcRenderer.invoke('appbar:open-in-browser'),
  /** Grow the bar over the page so a panel has room, or shrink it back. */
  setHeight: (extra: number): Promise<void> => ipcRenderer.invoke('appbar:height', extra),

  settings: (): Promise<Settings> => ipcRenderer.invoke('settings:get'),
  onSettings: (callback: (settings: Settings) => void): void => {
    ipcRenderer.on('browser:settings', (_event, settings: Settings) => callback(settings))
  },

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

  audioFx: (): Promise<AudioFxState | null> => ipcRenderer.invoke('fx:get'),
  setAudioFx: (fx: AudioFx, remember: boolean): Promise<AudioFxState | null> =>
    ipcRenderer.invoke('fx:set', fx, remember),
  onAudioFxChanged: (callback: () => void): void => {
    ipcRenderer.on('browser:fx-changed', () => callback())
  },
  saveAudioPresets: (presets: AudioFxPreset[]): Promise<void> =>
    ipcRenderer.invoke('settings:set', 'audioPresets', presets)
}

contextBridge.exposeInMainWorld('appbar', api)

export type AppBarApi = typeof api
