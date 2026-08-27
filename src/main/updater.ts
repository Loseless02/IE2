import { app } from 'electron'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { autoUpdater } from 'electron-updater'
import { getSettings } from './settings'
import type { UpdateState } from '../shared/types'

/**
 * Updates, from the project's own GitHub releases.
 *
 * The browser asks GitHub for the latest release, compares it with the running
 * version, and — if the user says so — downloads the installer and runs it on
 * quit. Everything is reported back to the interface so the whole thing is one
 * button rather than a manual download.
 *
 * Nothing about the user is sent: the request asks for a public release file
 * and the only comparison is between two version numbers. It is still a setting,
 * because an app that reaches the network on start-up should be something you
 * can switch off, and because the check is just as useful on a button.
 */

let state: UpdateState = { status: 'idle', version: '', notes: '', progress: 0 }

/** Told about every change, so the UI never has to poll. */
const listeners: ((state: UpdateState) => void)[] = []

function set(next: Partial<UpdateState>): void {
  state = { ...state, ...next }
  for (const listener of listeners) listener(state)
}

export function onUpdateState(listener: (state: UpdateState) => void): void {
  listeners.push(listener)
}

export function updateState(): UpdateState {
  return state
}

/**
 * A portable build is a single executable with nothing to install over, so
 * electron-updater cannot replace it. Saying so plainly beats a button that
 * fails for reasons the user cannot see.
 */
export function canSelfUpdate(): boolean {
  if (!app.isPackaged) return false
  return process.env['PORTABLE_EXECUTABLE_FILE'] === undefined
}

export function initUpdater(): void {
  // Downloading is a decision, not a default: a browser that quietly pulls
  // 120 MB down someone's connection has made that choice for them.
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => set({ status: 'checking' }))

  autoUpdater.on('update-available', (info) => {
    set({
      status: 'available',
      version: info.version,
      notes: typeof info.releaseNotes === 'string' ? info.releaseNotes : '',
      progress: 0
    })
  })

  autoUpdater.on('update-not-available', () => set({ status: 'current', progress: 0 }))

  autoUpdater.on('download-progress', (progress) => {
    set({ status: 'downloading', progress: Math.round(progress.percent) })
  })

  autoUpdater.on('update-downloaded', (info) => {
    set({ status: 'ready', version: info.version, progress: 100 })
  })

  autoUpdater.on('error', (error) => {
    // Offline, rate-limited, or no release yet. None of it is worth a dialog.
    set({ status: 'error', message: String(error?.message ?? error).slice(0, 200) })
  })

  if (!canSelfUpdate()) {
    set({ status: 'unsupported' })
    return
  }

  // A little after start, so it never competes with restoring the session.
  if (getSettings().autoUpdate) setTimeout(() => void check(), 8000)
}

/** Ask GitHub what the latest release is. Safe to call when it cannot work. */
export async function check(): Promise<UpdateState> {
  if (!canSelfUpdate()) {
    set({ status: 'unsupported' })
    return state
  }

  try {
    await autoUpdater.checkForUpdates()
  } catch (error) {
    set({ status: 'error', message: String(error).slice(0, 200) })
  }

  return state
}

export async function download(): Promise<void> {
  if (state.status !== 'available') return

  try {
    set({ status: 'downloading', progress: 0 })
    await autoUpdater.downloadUpdate()
  } catch (error) {
    set({ status: 'error', message: String(error).slice(0, 200) })
  }
}

/** Close every window and let the installer take over. */
export function installNow(): void {
  if (state.status !== 'ready') return
  autoUpdater.quitAndInstall()
}

/**
 * The newest section of CHANGELOG.md, for the "what's new" card.
 *
 * Read from the file that shipped with this build rather than from the network,
 * so it works offline and says what is actually installed — release notes
 * fetched from GitHub would describe whatever is newest there instead.
 */
export function latestChanges(): { version: string; lines: string[] } {
  const candidates = [
    join(process.resourcesPath ?? '', 'CHANGELOG.md'),
    join(app.getAppPath(), 'CHANGELOG.md'),
    join(app.getAppPath(), '..', 'CHANGELOG.md')
  ]

  for (const file of candidates) {
    try {
      const text = readFileSync(file, 'utf8')
      const match = text.match(/^## (\S+)\s*\n([\s\S]*?)(?=\n## |\s*$)/m)
      if (!match) continue

      const lines = match[2]
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith('- '))
        .map((line) => line.slice(2).trim())

      return { version: match[1], lines }
    } catch {
      // Try the next location.
    }
  }

  return { version: '', lines: [] }
}
