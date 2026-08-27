import { session, shell, type DownloadItem } from 'electron'
import { ALL_PARTITIONS } from './partitions'
import type { DownloadState } from '../shared/types'

interface Entry {
  id: number
  item: DownloadItem
  /** Kept because DownloadItem stops answering once it is destroyed. */
  last: DownloadState
}

let nextId = 1
const entries: Entry[] = []
let notify: (() => void) | null = null

/**
 * Downloads for every session. Electron's default behaviour is kept: no save
 * path is set, so Chromium shows the system save dialog and the user picks the
 * destination. The browser never writes a file somewhere the user did not name.
 */
export function initDownloads(onChange: () => void): void {
  notify = onChange

  for (const partition of ALL_PARTITIONS) {
    session.fromPartition(partition).on('will-download', (_event, item) => {
      const id = nextId++
      const entry: Entry = { id, item, last: snapshot(id, item, 'progressing') }
      entries.unshift(entry)

      item.on('updated', (_e, reason) => {
        entry.last = snapshot(entry.id, item, reason === 'interrupted' ? 'interrupted' : 'progressing')
        notify?.()
      })

      item.once('done', (_e, outcome) => {
        entry.last = snapshot(entry.id, item, outcome)
        // A cancelled dialog reports 'cancelled' with no path; drop those so the
        // list only shows downloads that actually started.
        if (outcome === 'cancelled' && entry.last.received === 0) {
          const index = entries.indexOf(entry)
          if (index !== -1) entries.splice(index, 1)
        }
        notify?.()
      })

      notify?.()
    })
  }
}

export function listDownloads(): DownloadState[] {
  return entries.slice(0, 20).map((e) => e.last)
}

/** Downloads still running. Used for the toolbar indicator. */
export function activeDownloads(): number {
  return entries.filter((e) => e.last.state === 'progressing').length
}

export function cancelDownload(id: number): void {
  const entry = entries.find((e) => e.id === id)
  if (entry && entry.last.state === 'progressing') entry.item.cancel()
}

/** Reveal in the file manager. Never opens the file itself. */
export function revealDownload(id: number): void {
  const entry = entries.find((e) => e.id === id)
  if (entry && entry.last.state === 'completed') shell.showItemInFolder(entry.last.path)
}

export function clearFinishedDownloads(): void {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].last.state !== 'progressing') entries.splice(i, 1)
  }
  notify?.()
}

function snapshot(id: number, item: DownloadItem, state: DownloadState['state']): DownloadState {
  return {
    id,
    filename: item.getFilename(),
    path: item.getSavePath(),
    url: item.getURL(),
    received: item.getReceivedBytes(),
    total: item.getTotalBytes(),
    state,
    paused: item.isPaused()
  }
}
