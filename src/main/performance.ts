import { app } from 'electron'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PerformanceStats, StartupRecord } from '../shared/types'
import { getSettings } from './settings'

/**
 * How fast the browser starts, and how much memory it holds, measured on every
 * launch — so performance mode can be judged by numbers rather than by feel.
 *
 * A start-up is timed from the moment the process started to the moment the
 * first window's toolbar has loaded and can be used. What happens before
 * IE2's own code runs — Windows loading and checking the program — is
 * included, because process uptime counts from the process starting.
 */

const KEEP = 100
const MEMORY_AFTER_MS = 30_000

const filePath = (): string => join(app.getPath('userData'), 'performance.json')

function load(): StartupRecord[] {
  try {
    const value = JSON.parse(readFileSync(filePath(), 'utf8')) as { startups?: StartupRecord[] }
    return Array.isArray(value.startups) ? value.startups : []
  } catch {
    return []
  }
}

function save(startups: StartupRecord[]): void {
  try {
    writeFileSync(filePath(), JSON.stringify({ startups: startups.slice(-KEEP) }))
  } catch {
    // A measurement lost is not worth failing over.
  }
}

/** Every process IE2 runs, added up: what Task Manager would show for it. */
export function memoryInUseMB(): number {
  const kb = app.getAppMetrics().reduce((sum, metric) => sum + (metric.memory?.workingSetSize ?? 0), 0)
  return Math.round(kb / 1024)
}

let recorded = false

/**
 * The first window of this launch is ready. Called once; later windows are
 * not a start-up. The memory figure follows half a minute later, once the
 * restored tabs have had time to load — or not, in performance mode.
 */
export function recordStartup(tabs: number): void {
  if (recorded) return
  recorded = true

  const record: StartupRecord = {
    at: Date.now(),
    ms: Math.round(process.uptime() * 1000),
    performanceMode: getSettings().performanceMode,
    tabs,
    version: app.getVersion()
  }
  save([...load(), record])

  setTimeout(() => {
    const startups = load()
    const mine = startups.find((entry) => entry.at === record.at)
    if (!mine) return
    mine.memoryMB = memoryInUseMB()
    save(startups)
  }, MEMORY_AFTER_MS).unref?.()
}

function average(values: number[]): number | null {
  return values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : null
}

/** How long the last update took to install, from the update window's own timing. */
function lastUpdate(): { seconds: number; at: number } | null {
  const file = join(app.getPath('userData'), 'update-timing.json')
  try {
    const { seconds } = JSON.parse(readFileSync(file, 'utf8')) as { seconds?: number }
    return typeof seconds === 'number' ? { seconds, at: statSync(file).mtimeMs } : null
  } catch {
    return null
  }
}

export function performanceStats(): PerformanceStats {
  const startups = load()
  const byTime = [...startups].sort((a, b) => a.ms - b.ms)
  const side = (on: boolean): PerformanceStats['normal'] => {
    const runs = startups.filter((entry) => entry.performanceMode === on)
    return {
      starts: runs.length,
      averageMs: average(runs.map((entry) => entry.ms)),
      averageMemoryMB: average(runs.flatMap((entry) => (entry.memoryMB ? [entry.memoryMB] : [])))
    }
  }

  return {
    last: startups[startups.length - 1] ?? null,
    fastest: byTime[0] ?? null,
    slowest: byTime[byTime.length - 1] ?? null,
    normal: side(false),
    performance: side(true),
    memoryNowMB: memoryInUseMB(),
    lastUpdate: lastUpdate()
  }
}

/** Start the comparison over, after changing what performance mode does. */
export function clearPerformanceStats(): void {
  save([])
}
