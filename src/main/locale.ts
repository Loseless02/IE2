import { app, dialog } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { EN, LANGUAGES, completeness, messageKeys, resolve, type LanguageId } from '../shared/i18n'
import tr from '../shared/locales/tr.json'

/**
 * Translations as data, not code.
 *
 * Each language is one JSON file of key → text under userData/locales. The
 * translation editor writes to them directly, so a translation can be finished,
 * corrected or shared without touching the source or rebuilding.
 *
 * There are two layers. The ones below ship inside the build, so everybody who
 * installs the browser gets them; anything the user writes in the editor is
 * saved to their own file and laid on top. That is what makes a finished
 * translation reach other people at all — before this, a translation only
 * existed on the machine it was typed on.
 */
const SHIPPED: Record<string, Record<string, string>> = { tr }

const overlays = new Map<string, Record<string, string>>()

function localeDir(): string {
  const dir = join(app.getPath('userData'), 'locales')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function localeFile(language: string): string {
  // Language codes come from our own list, but this is a filesystem path, so
  // anything unexpected is refused rather than joined.
  const safe = /^[a-z]{2}(-[a-z]{2})?$/i.test(language) ? language.toLowerCase() : 'en'
  return join(localeDir(), `${safe}.json`)
}

/**
 * Languages added by the user, beyond the ones the browser ships with.
 *
 * A translation is just a JSON file of key → text, so there is no reason a new
 * language should need a new build: the code and name are recorded here and the
 * translation editor treats it like any other.
 */
function languagesFile(): string {
  return join(localeDir(), 'languages.json')
}

function customLanguages(): Record<string, string> {
  try {
    const file = languagesFile()
    if (!existsSync(file)) return {}

    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
    if (!parsed || typeof parsed !== 'object') return {}

    const out: Record<string, string> = {}
    for (const [code, name] of Object.entries(parsed as Record<string, unknown>)) {
      // Same shape as a built-in code, and a name that is plainly a name.
      if (!/^[a-z]{2}(-[a-z]{2})?$/i.test(code)) continue
      if (typeof name !== 'string' || name.trim() === '') continue
      if (code in LANGUAGES) continue
      out[code.toLowerCase()] = name.trim().slice(0, 40)
    }
    return out
  } catch {
    return {}
  }
}

/** Every language on offer: the ones we ship, then the user's own. */
export function listLanguages(): { code: string; name: string; builtIn: boolean }[] {
  const built = Object.entries(LANGUAGES).map(([code, meta]) => ({
    code,
    name: `${meta.endonym} (${meta.name})`,
    builtIn: true
  }))

  const custom = Object.entries(customLanguages()).map(([code, name]) => ({
    code,
    name,
    builtIn: false
  }))

  return [...built, ...custom]
}

export function addLanguage(code: string, name: string): boolean {
  const clean = code.trim().toLowerCase()
  if (!/^[a-z]{2}(-[a-z]{2})?$/.test(clean)) return false
  if (clean in LANGUAGES) return false
  if (!name.trim()) return false

  const languages = customLanguages()
  languages[clean] = name.trim().slice(0, 40)

  try {
    writeFileSync(languagesFile(), JSON.stringify(languages, null, 2), 'utf8')
    return true
  } catch (error) {
    console.error('locale: could not add language', error)
    return false
  }
}

export function removeLanguage(code: string): void {
  const languages = customLanguages()
  delete languages[code.trim().toLowerCase()]

  try {
    writeFileSync(languagesFile(), JSON.stringify(languages, null, 2), 'utf8')
    overlays.delete(code)
  } catch (error) {
    console.error('locale: could not remove language', error)
  }
}

/** Keep only known keys holding strings, so a stray file cannot inject anything. */
function sanitise(source: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!source || typeof source !== 'object') return out

  for (const key of messageKeys()) {
    const value = (source as Record<string, unknown>)[key]
    if (typeof value === 'string' && value.trim() !== '') out[key] = value
  }

  return out
}

export function loadLocale(language: string): Record<string, string> {
  const cached = overlays.get(language)
  if (cached) return cached

  // What shipped with the build, then whatever this user has written over it.
  let overlay: Record<string, string> = sanitise(SHIPPED[language.toLowerCase()])

  try {
    const file = localeFile(language)
    if (existsSync(file)) {
      overlay = { ...overlay, ...sanitise(JSON.parse(readFileSync(file, 'utf8'))) }
    }
  } catch {
    // A corrupt file leaves the shipped translation in place rather than
    // dropping the language back to English.
  }

  overlays.set(language, overlay)
  return overlay
}

/** The full string table a renderer should use for this language. */
export function messagesFor(language: string): Record<string, string> {
  return language === 'en' ? { ...EN } : resolve(loadLocale(language))
}

export function setMessage(language: string, key: string, value: string): void {
  if (language === 'en') return
  if (!messageKeys().includes(key)) return

  const overlay = loadLocale(language)
  if (value.trim() === '') delete overlay[key]
  else overlay[key] = value

  persist(language, overlay)
}

/** Everything the editor needs: the source text and the current translation. */
export function localeEntries(language: string): {
  entries: { key: string; group: string; english: string; translated: string }[]
  progress: number
} {
  const overlay = loadLocale(language)

  return {
    entries: messageKeys().map((key) => ({
      key,
      group: key.split('.')[0],
      english: EN[key],
      translated: overlay[key] ?? ''
    })),
    progress: completeness(overlay)
  }
}

function persist(language: string, overlay: Record<string, string>): void {
  try {
    writeFileSync(localeFile(language), JSON.stringify(overlay, null, 2), 'utf8')
    overlays.set(language, overlay)
  } catch (error) {
    console.error('locale: could not save', error)
  }
}

/** Hand the whole translation to the user as a file they can keep or share. */
export async function exportLocale(language: string): Promise<string | null> {
  const result = await dialog.showSaveDialog({
    title: 'Export translation',
    defaultPath: join(app.getPath('downloads'), `ie2-${language}.json`),
    filters: [{ name: 'JSON', extensions: ['json'] }]
  })
  if (result.canceled || !result.filePath) return null

  try {
    writeFileSync(result.filePath, JSON.stringify(loadLocale(language), null, 2), 'utf8')
    return result.filePath
  } catch {
    return null
  }
}

/** Take a translation file back in, merging it over whatever is there. */
export async function importLocale(language: string): Promise<number | null> {
  const result = await dialog.showOpenDialog({
    title: 'Import translation',
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }]
  })
  if (result.canceled || !result.filePaths[0]) return null

  try {
    const parsed = JSON.parse(readFileSync(result.filePaths[0], 'utf8')) as Record<string, unknown>
    const overlay = loadLocale(language)
    let added = 0

    for (const key of messageKeys()) {
      const value = parsed[key]
      if (typeof value === 'string' && value.trim() !== '') {
        overlay[key] = value
        added++
      }
    }

    persist(language, overlay)
    return added
  } catch {
    return null
  }
}

export function isKnownLanguage(value: string): value is LanguageId {
  return value === 'en' || value === 'tr'
}
