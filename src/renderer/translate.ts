import { MESSAGE_GROUPS } from '../shared/i18n'
import { applyTheme } from './theme'

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

const rowsEl = el('rows')
const filterEl = el<HTMLInputElement>('filter')
const onlyMissingEl = el<HTMLInputElement>('only-missing')
const languageEl = el<HTMLSelectElement>('language')
const statusEl = el('status')

interface Entry {
  key: string
  group: string
  english: string
  translated: string
}

let entries: Entry[] = []
let language = 'tr'
let saveTimer: number | undefined

/** Debounced so typing does not write a file on every keystroke. */
function queueSave(key: string, value: string, input: HTMLTextAreaElement): void {
  window.clearTimeout(saveTimer)
  input.classList.add('pending')

  saveTimer = window.setTimeout(async () => {
    await window.ie2.setMessage(language, key, value)
    input.classList.remove('pending')
    input.classList.add('saved')
    window.setTimeout(() => input.classList.remove('saved'), 900)

    const entry = entries.find((e) => e.key === key)
    if (entry) entry.translated = value
    updateProgress()
    statusEl.textContent = 'Saved. Open pages pick it up as they render.'
  }, 400)
}

function updateProgress(): void {
  const done = entries.filter((e) => e.translated.trim() !== '').length
  const percent = entries.length === 0 ? 0 : Math.round((done / entries.length) * 100)

  el('progress-fill').style.width = `${percent}%`
  el('progress-text').textContent = `${done} of ${entries.length} · ${percent}%`
}

function render(): void {
  const needle = filterEl.value.trim().toLowerCase()
  const onlyMissing = onlyMissingEl.checked

  const visible = entries.filter((entry) => {
    if (onlyMissing && entry.translated.trim() !== '') return false
    if (!needle) return true
    return (
      entry.english.toLowerCase().includes(needle) ||
      entry.key.toLowerCase().includes(needle) ||
      entry.translated.toLowerCase().includes(needle)
    )
  })

  rowsEl.replaceChildren()

  let lastGroup = ''
  for (const entry of visible) {
    if (entry.group !== lastGroup) {
      lastGroup = entry.group
      const heading = document.createElement('h2')
      heading.textContent = MESSAGE_GROUPS[entry.group] ?? entry.group
      rowsEl.append(heading)
    }

    const row = document.createElement('div')
    row.className = 'trow'

    const left = document.createElement('div')
    left.className = 'source'

    const english = document.createElement('div')
    english.className = 'english'
    english.textContent = entry.english
    left.append(english)

    const key = document.createElement('code')
    key.textContent = entry.key
    left.append(key)

    // A textarea rather than an input: some strings are long sentences.
    const input = document.createElement('textarea')
    input.rows = 1
    input.spellcheck = false
    input.value = entry.translated
    input.placeholder = entry.english
    input.addEventListener('input', () => {
      input.style.height = 'auto'
      input.style.height = `${input.scrollHeight}px`
      queueSave(entry.key, input.value, input)
    })

    row.append(left, input)
    rowsEl.append(row)
  }

  if (visible.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'empty'
    empty.textContent = onlyMissing ? 'Nothing left untranslated here.' : 'No strings match that.'
    rowsEl.append(empty)
  }

  updateProgress()
}

async function load(): Promise<void> {
  const settings = await window.ie2.getSettings()
  applyTheme(settings)

  // Whatever the browser ships with, plus any language the user has added.
  const languages = await window.ie2.languages()

  languageEl.replaceChildren()
  for (const entry of languages) {
    if (entry.code === 'en') continue // The source is not translated into itself.
    const option = document.createElement('option')
    option.value = entry.code
    option.textContent = entry.name
    option.selected = entry.code === language
    languageEl.append(option)
  }

  // A language may have been removed since this page was last open.
  if (!languages.some((entry) => entry.code === language)) {
    language = languageEl.options[0]?.value ?? 'tr'
    languageEl.value = language
  }

  const chosen = languages.find((entry) => entry.code === language)

  const data = await window.ie2.localeEntries(language)
  entries = data.entries
  render()

  statusEl.textContent =
    settings.language === language
      ? 'This is your current interface language, so changes show immediately.'
      : `Switch the interface to ${chosen?.name ?? language} in Settings to see it applied.`
}

languageEl.addEventListener('change', async () => {
  language = languageEl.value
  await load()
})

filterEl.addEventListener('input', render)
onlyMissingEl.addEventListener('change', render)

el('export').addEventListener('click', async () => {
  const path = await window.ie2.exportLocale(language)
  statusEl.textContent = path ? `Exported to ${path}` : 'Export cancelled.'
})

el('import').addEventListener('click', async () => {
  const added = await window.ie2.importLocale(language)
  if (added === null) {
    statusEl.textContent = 'Import cancelled, or the file was not a translation.'
    return
  }
  statusEl.textContent = `Imported ${added} strings.`
  await load()
})

void load()
