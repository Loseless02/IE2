import { DEFAULT_SETTINGS, type Settings } from '../shared/settings'
import { readSetting, writeSetting } from './db'

let cache: Settings = { ...DEFAULT_SETTINGS }
const listeners: ((settings: Settings) => void)[] = []

/**
 * Settings live in the same database as everything else, one row per key, and
 * are cached in memory because they are consulted on every navigation.
 * Unknown or corrupt values fall back to the default rather than throwing.
 */
export function loadSettings(): void {
  const next = { ...DEFAULT_SETTINGS }

  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
    const stored = readSetting(key)
    if (stored === undefined) continue

    try {
      const parsed = JSON.parse(stored)
      if (typeof parsed === typeof DEFAULT_SETTINGS[key]) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(next as any)[key] = parsed
      }
    } catch {
      // Keep the default.
    }
  }

  cache = next
}

export function getSettings(): Settings {
  return cache
}

export function setSetting(key: keyof Settings, value: Settings[keyof Settings]): Settings {
  if (!(key in DEFAULT_SETTINGS)) return cache
  if (typeof value !== typeof DEFAULT_SETTINGS[key]) return cache

  cache = { ...cache, [key]: value }
  writeSetting(key, JSON.stringify(value))
  for (const listener of listeners) listener(cache)
  return cache
}

export function resetSettings(): Settings {
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
    writeSetting(key, JSON.stringify(DEFAULT_SETTINGS[key]))
  }
  cache = { ...DEFAULT_SETTINGS }
  for (const listener of listeners) listener(cache)
  return cache
}

export function onSettingsChanged(listener: (settings: Settings) => void): void {
  listeners.push(listener)
}
