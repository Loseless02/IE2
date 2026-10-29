import { contextBridge, ipcRenderer } from 'electron'
import type { AudioFx, AudioFxPreset, AudioFxState } from '../shared/audiofx'
import type { Settings } from '../shared/settings'

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
