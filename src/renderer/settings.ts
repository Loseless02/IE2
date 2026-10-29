import {
  ACCENT_PRESETS,
  DEFAULT_SETTINGS,
  IMAGE_FITS,
  SEARCH_ENGINES,
  toHex,
  type Settings
} from '../shared/settings'
import { contrastOn, createColourPicker } from './colour'
import {
  CUSTOM_THEME_FIELDS,
  CUSTOM_THEME_ID,
  THEMES,
  resolveTheme,
  themeById,
  themesByMode
} from '../shared/themes'
import { BUILT_IN_WALLPAPERS } from '../shared/wallpapers'

import { applyTheme } from './theme'
import { icon } from './icons'
import { createSwitch } from './switch'
import { confirmDialog, promptDialog } from './dialog'
import { buildLabel } from '../shared/build'
import { uiKey } from '../shared/i18n'
import type { ImportSource, RecallStats, SitePermission, UpdateState } from '../shared/types'

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

const nav = el('nav')
const panels = el('panels')
const filter = el<HTMLInputElement>('filter')

let settings: Settings
let stats: RecallStats
let domains: string[] = []
let permissions: SitePermission[] = []
let sources: ImportSource[] = []
let languages: { code: string; name: string; builtIn: boolean }[] = []

const nf = new Intl.NumberFormat()

interface Section {
  id: string
  title: string
  icon: string
  build: () => HTMLElement[]
}

/**
 * The page's own wording, translated.
 *
 * Keys are derived from the English text, matching scripts/extract-ui-strings.js,
 * so the rows below stay readable English in the source while still going
 * through the catalogue. Anything untranslated falls back to what is written
 * here, which is what should happen.
 */
let messages: Record<string, string> = {}

function t(text: string): string {
  return messages[uiKey(text)] ?? text
}

// --- small builders ---------------------------------------------------------

function row(title: string, description: string, control: HTMLElement): HTMLElement {
  const node = document.createElement('div')
  node.className = 'row'

  const label = document.createElement('div')
  label.className = 'label'

  const b = document.createElement('b')
  b.textContent = t(title)
  label.append(b)

  if (description) {
    const span = document.createElement('span')
    span.textContent = t(description)
    label.append(span)
  }

  node.append(label)

  const wrap = document.createElement('div')
  wrap.className = 'control'
  wrap.append(control)
  node.append(wrap)

  return node
}

function group(...rows: HTMLElement[]): HTMLElement {
  const node = document.createElement('div')
  node.className = 'group'
  node.append(...rows)
  return node
}

function toggle(key: keyof Settings): HTMLElement {
  return createSwitch(Boolean(settings[key]), async (next) => {
    settings = await window.ie2.setSetting(key, next)
    applyTheme(settings)

    // Some switches decide whether other rows belong on screen at all.
    if (key === 'sleepTabs') rerender('performance')
  })
}

function select(key: keyof Settings, options: [string, string][]): HTMLElement {
  const node = document.createElement('select')

  for (const [value, label] of options) {
    const option = document.createElement('option')
    option.value = value
    option.textContent = label
    option.selected = settings[key] === value
    node.append(option)
  }

  node.addEventListener('change', async () => {
    settings = await window.ie2.setSetting(key, node.value)
    // Some choices change which controls belong on screen.
    if (key === 'homeBackground') rerender('newtab')

    // A new language has to reach the words already on screen. Nothing here
    // needs a restart: fetch the catalogue and draw the page again.
    if (key === 'language') {
      messages = await window.ie2.messages(settings.language)
      render()
    }
  })

  return node
}

function textInput(key: keyof Settings, placeholder: string): HTMLElement {
  const node = document.createElement('input')
  node.type = 'text'
  node.placeholder = placeholder
  node.value = String(settings[key] ?? '')

  node.addEventListener('change', async () => {
    settings = await window.ie2.setSetting(key, node.value)
    // Some choices change which controls belong on screen.
    if (key === 'homeBackground') rerender('newtab')
  })

  return node
}

/**
 * One row that carries the whole update flow: check, download, install.
 *
 * The button's label is whatever the next step is, so there is never a choice
 * to make about which control to press — the state decides.
 */
function updateRow(): HTMLElement {
  const status = document.createElement('span')
  status.className = 'static-value'

  const button = document.createElement('button')
  button.className = 'action'

  const wrap = document.createElement('div')
  wrap.className = 'stack'
  wrap.append(status, button)

  /**
   * Set when the user pressed Check: once the download it started finishes,
   * they are asked about restarting rather than left to notice the button
   * changed. A download that finishes with nobody waiting on it just waits.
   */
  let askWhenReady = false
  let asking = false

  /** The warning before restarting. Restarting is fine; losing typing is not. */
  const offerInstall = async (version: string): Promise<void> => {
    if (asking) return
    asking = true

    const ok = await confirmDialog({
      title: `${t('Restart to update to')} ${version}?`,
      body: [
        t('IE2 will close, install the update, and open again by itself. It takes a few seconds.'),
        t('Your tabs come back, and you stay signed in to sites. Bookmarks, history and settings are all kept. Amnesia tabs do not come back — that is what they are for.'),
        t('Anything typed into a page and not yet sent or saved — a message, a form, a document in a web app — will be lost. Finish those first.')
      ],
      confirmLabel: t('Restart now'),
      cancelLabel: t('Later')
    })

    asking = false
    if (ok) await window.ie2.installUpdate()
  }

  const paint = (state: UpdateState): void => {
    if (state.status === 'ready' && askWhenReady) {
      askWhenReady = false
      void offerInstall(state.version ?? '')
    }

    const labels: Record<UpdateState['status'], string> = {
      idle: t('Check for updates'),
      checking: `${t('Checking')}…`,
      current: t('Check again'),
      available: `${t('Download')} ${state.version}`,
      downloading: `${state.progress}%`,
      ready: t('Restart and install'),
      error: t('Try again'),
      unsupported: t('Check on GitHub')
    }

    const notes: Record<UpdateState['status'], string> = {
      idle: '',
      checking: t('Asking GitHub…'),
      current: t('You have the latest version.'),
      available: `${t('Version')} ${state.version} ${t('is available.')}`,
      downloading: t('Downloading…'),
      ready: `${t('Version')} ${state.version} ${t('is ready. It installs when you restart, or the next time you close IE2.')}`,
      error: state.message || t('Could not check.'),
      // A portable build is one file with nothing to install over.
      unsupported: t('This build cannot update itself. Download the new one.')
    }

    status.textContent = notes[state.status]
    button.textContent = labels[state.status]
    button.disabled = state.status === 'checking' || state.status === 'downloading'
  }

  button.addEventListener('click', async () => {
    const state = await window.ie2.updateState()

    if (state.status === 'unsupported') {
      window.ie2.open('https://github.com/Loseless02/IE2/releases/latest')
      return
    }
    if (state.status === 'available') {
      askWhenReady = true
      return void window.ie2.downloadUpdate()
    }
    if (state.status === 'ready') return void offerInstall(state.version ?? '')

    // Say so immediately. The check can take a few seconds against GitHub, and
    // a button that does nothing visible reads as a broken button. Anything it
    // finds downloads by itself, and the question comes when that is done.
    askWhenReady = true
    paint({ ...state, status: 'checking' })
    paint(await window.ie2.checkForUpdate())
  })

  // Progress arrives as it happens, so the row is live rather than a snapshot.
  window.ie2.onUpdateState(paint)
  void window.ie2.updateState().then(paint)

  return wrap
}

/**
 * Whether Windows opens links with IE2.
 *
 * The button cannot simply set it: Windows 10 and 11 refuse to let a program
 * make itself the default, so it registers what it can and opens the Settings
 * page where the choice actually lives. Saying that plainly beats a button that
 * appears to do nothing.
 */
function defaultBrowserRow(): HTMLElement {
  const status = document.createElement('span')
  status.className = 'static-value'

  const button = document.createElement('button')
  button.className = 'action'
  button.textContent = t('Make IE2 the default')

  const wrap = document.createElement('div')
  wrap.className = 'inline-control'
  wrap.append(status, button)

  const paint = (isDefault: boolean): void => {
    status.textContent = isDefault ? t('Currently the default') : ''
    button.hidden = isDefault
  }

  button.addEventListener('click', async () => {
    await window.ie2.makeDefaultBrowser()
    // Windows has to be asked by the user, so re-check when they come back.
    window.setTimeout(async () => paint(await window.ie2.isDefaultBrowser()), 1500)
  })

  void window.ie2.isDefaultBrowser().then(paint)
  window.addEventListener('focus', async () => paint(await window.ie2.isDefaultBrowser()))

  return wrap
}

/** The wallpapers that ship with the browser, shown rather than listed. */
function wallpaperGrid(): HTMLElement {
  const grid = document.createElement('div')
  grid.className = 'wallpaper-grid'

  for (const wallpaper of BUILT_IN_WALLPAPERS) {
    const button = document.createElement('button')
    button.className = settings.homeBuiltin === wallpaper.file ? 'wallpaper on' : 'wallpaper'
    button.title = wallpaper.name

    const thumb = document.createElement('img')
    // Served by ie2://wallpaper, which only answers for names it ships.
    thumb.src = `ie2://wallpaper/${encodeURIComponent(wallpaper.file)}`
    thumb.alt = wallpaper.name
    thumb.loading = 'lazy'
    button.append(thumb)

    const name = document.createElement('span')
    name.textContent = wallpaper.name
    button.append(name)

    button.addEventListener('click', async () => {
      settings = await window.ie2.setSetting('homeBuiltin', wallpaper.file)
      rerender('newtab')
    })

    grid.append(button)
  }

  return grid
}

/**
 * Accent colour: presets, the user's own saved swatches, and a full picker.
 * Choosing from the field updates the interface live; saving keeps the colour
 * beside the presets so switching back is one click.
 */
function accentPicker(): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'colour-block'

  const swatches = document.createElement('div')
  swatches.className = 'accents'

  const picker = createColourPicker({
    value: toHex(settings.accent),
    onChange: (hex) => applyAccentPreview(hex),
    onCommit: async (hex) => {
      settings = await window.ie2.setSetting('accent', hex)
      applyAccent()
      renderSwatches()
    }
  })

  const save = actionButton('Save this colour', false, async () => {
    const hex = toHex(settings.accent)
    if (settings.savedAccents.includes(hex)) return
    settings = await window.ie2.setSetting('savedAccents', [...settings.savedAccents, hex].slice(-12))
    renderSwatches()
  })
  save.classList.add('small')

  function renderSwatches(): void {
    swatches.replaceChildren()
    const current = toHex(settings.accent)

    const add = (hex: string, saved: boolean): void => {
      const swatch = document.createElement('button')
      swatch.style.background = hex
      swatch.title = saved ? `${hex} — right-click to remove` : hex
      swatch.className = current === hex ? 'on' : ''

      swatch.addEventListener('click', async () => {
        settings = await window.ie2.setSetting('accent', hex)
        picker.set(hex)
        applyAccent()
        renderSwatches()
      })

      if (saved) {
        const forget = async (): Promise<void> => {
          settings = await window.ie2.setSetting(
            'savedAccents',
            settings.savedAccents.filter((c) => c !== hex)
          )
          renderSwatches()
        }

        // A visible cross, because right-click was the only way to remove one
        // and nothing on screen said so.
        const remove = document.createElement('span')
        remove.className = 'swatch-remove'
        remove.textContent = '×'
        remove.title = t('Remove this colour')
        remove.style.color = contrastOn(hex)
        remove.addEventListener('click', (event) => {
          // Otherwise the click underneath also selects the colour being removed.
          event.stopPropagation()
          void forget()
        })

        swatch.addEventListener('contextmenu', (event) => {
          event.preventDefault()
          void forget()
        })

        swatch.append(remove)
      }

      swatches.append(swatch)
    }

    for (const hex of ACCENT_PRESETS) add(hex, false)
    for (const hex of settings.savedAccents) add(hex, true)
  }

  renderSwatches()
  wrap.append(swatches, picker.element, save)
  return wrap
}

/** Live preview while dragging — not persisted until the drag ends. */
function applyAccentPreview(hex: string): void {
  document.documentElement.style.setProperty('--accent', hex)
}

/**
 * The new tab page background: the theme, a flat colour, one image, or a random
 * image from a folder chosen through the OS dialog.
 */
function homeBackgroundGroup(): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'group'

  wrap.append(
    row(
      'Background',
      'What the new tab page shows behind everything else.',
      select('homeBackground', [
        ['theme', 'Theme colour'],
        ['colour', 'A colour I choose'],
        ['builtin', 'One that came with the browser'],
        ['image', 'One image'],
        ['folder', 'Random image from a folder']
      ])
    )
  )

  if (settings.homeBackground === 'colour') {
    const picker = createColourPicker({
      value: toHex(settings.homeColour, '#16181c'),
      onChange: () => undefined,
      onCommit: async (hex) => {
        settings = await window.ie2.setSetting('homeColour', hex)
      }
    })
    wrap.append(row('Colour', 'Used as a flat background, no image.', picker.element))
  }

  if (settings.homeBackground === 'image') {
    const status = document.createElement('div')
    status.className = 'path'
    status.textContent = settings.homeImage || 'No image chosen yet.'

    const pick = actionButton('Choose image…', false, async () => {
      const file = await window.ie2.pickImage()
      if (!file) return
      settings = await window.ie2.setSetting('homeImage', file)
      status.textContent = file
    })

    const control = document.createElement('div')
    control.className = 'stack'
    control.append(pick, status)
    wrap.append(row('Image', 'Shown on every new tab.', control))
  }

  if (settings.homeBackground === 'folder') {
    const status = document.createElement('div')
    status.className = 'path'
    status.textContent = settings.homeFolder || 'No folder chosen yet.'

    const pick = actionButton('Choose folder…', false, async () => {
      const picked = await window.ie2.pickFolder()
      if (!picked) return
      settings = await window.ie2.setSetting('homeFolder', picked.folder)
      status.textContent = `${picked.folder} — ${picked.count} image${picked.count === 1 ? '' : 's'}`
    })

    const control = document.createElement('div')
    control.className = 'stack'
    control.append(pick, status)
    wrap.append(row('Folder', 'A different image on every new tab.', control))
  }

  if (settings.homeBackground === 'builtin') {
    wrap.append(row('Wallpaper', 'The ones that ship with the browser.', wallpaperGrid()))
  }

  if (
    settings.homeBackground === 'builtin' ||
    settings.homeBackground === 'image' ||
    settings.homeBackground === 'folder'
  ) {
    wrap.append(
      row(
        'Fit',
        'How the image is sized against the window. Fill crops what does not fit; Fit shows all of it.',
        select(
          'homeImageFit',
          Object.entries(IMAGE_FITS).map(([id, { label }]) => [id, label] as [string, string])
        )
      )
    )

    if (settings.homeImageFit !== 'stretch') {
      wrap.append(
        row(
          'Position',
          'Where the image sits when it does not fill the window.',
          select('homeImagePosition', [
            ['center', 'Centre'],
            ['top', 'Top'],
            ['bottom', 'Bottom'],
            ['left', 'Left'],
            ['right', 'Right']
          ])
        )
      )
    }

    wrap.append(
      row(
        'Dim the wallpaper',
        'Keeps text readable over a busy image.',
        slider('homeDim', 0, 80, 5)
      )
    )
  }

  return wrap
}

/** Fetches fresh blocking rules on demand, and says how it went. */
function updateListsButton(): HTMLElement {
  const button = actionButton('Update now', false, async () => {
    button.textContent = t('Updating…')
    const ok = await window.ie2.updateFilterLists()
    button.textContent = ok ? 'Updated' : 'Could not reach the lists'
    window.setTimeout(() => (button.textContent = 'Update now'), 2000)
  }) as HTMLButtonElement

  return button
}

/**
 * The About section's prose. Written straight, which is the joke: every line is
 * true, and that is the part that should worry you.
 */
const ABOUT_PARAGRAPHS: [string, string][] = [
  [
    'What this is',
    'IE2 is a web browser named in tribute to Microsoft’s Internet Explorer, which spent a decade being the reason web developers drink and was finally retired in 2022. It is not that browser, it is not made by Microsoft, and Microsoft has had no involvement in it whatsoever. This one is built on Chromium, like almost everything else calling itself a browser, so the name is the only genuinely original engineering decision in the project.'
  ],
  [
    'Total recall',
    'Every page you read is captured — the body text, not just the address — and indexed so you can search what a page said rather than what it was called. Other browsers keep a list of places you have been. This one keeps the contents. It is the single feature here that no amount of extensions will give you elsewhere, and it is also, if you think about it for more than four seconds, a diary you did not agree to keep.'
  ],
  [
    'Amnesia tabs',
    'For when total recall was the wrong idea. Nothing is written down, the session is thrown away, and the tab is marked so you are never left guessing which mode you are in. Named honestly, unlike the industry standard, which implies a level of privacy from your employer, your network and your government that it has never once provided.'
  ],
  [
    'Shields',
    'Ads and trackers are blocked at the network layer using the same filter lists everyone else uses, plus the scriptlets that deal with ads served from the same place as the content. The counter on the new tab page tells you how many requests were stopped, converted into time and bandwidth you did not spend. Those two figures are estimates and say so when you hover them, which is more than most such counters will admit.'
  ],
  [
    'Compatibility Mode',
    'Renders any site in Comic Sans with outset grey buttons and pixelated images, while telling the server it is Internet Explorer 6. It is a period-accurate reconstruction of the browsing experience being commemorated here. It has no legitimate use. It is a button in your toolbar.'
  ],
  [
    'Everything else',
    'Tab groups, pinned tabs, split view, picture in picture, screenshots, QR codes, media controls, a command palette, twenty-three themes, a colour picker, translations you can edit inside the browser itself, and an import that takes your bookmarks and history off Chrome or Firefox without asking them nicely. All of it standard. All of it expected. None of it the reason this exists.'
  ],
  [
    'What it does not do',
    'It does not sync, because there is no server. It has no account, because there is nobody to have one with. Nothing here is uploaded, sold, or shared with a partner network, on the strength of the fact that no such arrangement was ever built rather than any promise about restraint. Every word this browser has ever kept about you is in one file on your own disk, and there is a button on the new tab page that deletes the lot.'
  ],
  [
    'Credits',
    'Chromium and Electron did the difficult parts. Ghostery supplies the filter lists. SQLite holds the archive. The remaining work — the part that decided to record everything you read and then put a cheerful counter on it — was done by one person who kept asking for one more feature and then had no one else to implement it. Released under the Apache License 2.0: take it, change it, sell it if you can, and keep the notice saying where it came from.'
  ]
]

function aboutStory(): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'about-story'

  for (const [heading, body] of ABOUT_PARAGRAPHS) {
    const section = document.createElement('section')

    const title = document.createElement('h3')
    title.textContent = t(heading)
    section.append(title)

    const text = document.createElement('p')
    text.textContent = t(body)
    section.append(text)

    wrap.append(section)
  }

  return wrap
}

function staticText(text: string): HTMLElement {
  const node = document.createElement('span')
  node.className = 'static-value'
  node.textContent = text
  return node
}

function versionLabel(): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'inline-control'

  const value = document.createElement('span')
  value.className = 'static-value'
  value.textContent = buildLabel()
  wrap.append(value)

  // Through the main process: internal pages sit in a session that refuses
  // every permission, clipboard included, so navigator.clipboard rejects here
  // and the old version reported success regardless.
  const copy = actionButton('Copy', false, async () => {
    const ok = await window.ie2.copyText(buildLabel())
    copy.textContent = ok ? t('Copied') : t('Could not copy')
    window.setTimeout(() => (copy.textContent = t('Copy')), 1200)
  })
  copy.classList.add('small')
  wrap.append(copy)

  return wrap
}

function slider(key: keyof Settings, min: number, max: number, step: number, unit = '%'): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'slider'

  const input = document.createElement('input')
  input.type = 'range'
  input.min = String(min)
  input.max = String(max)
  input.step = String(step)
  input.value = String(settings[key] ?? min)

  const value = document.createElement('span')
  value.textContent = `${input.value}${unit}`

  input.addEventListener('input', () => {
    value.textContent = `${input.value}${unit}`
  })
  input.addEventListener('change', async () => {
    settings = await window.ie2.setSetting(key, Number(input.value))
  })

  wrap.append(input, value)
  return wrap
}

function actionButton(label: string, danger: boolean, onClick: () => void): HTMLElement {
  const button = document.createElement('button')
  button.className = danger ? 'action danger' : 'action'
  button.textContent = t(label)
  button.addEventListener('click', onClick)
  return button
}

function applyAccent(): void {
  applyTheme(settings)
}

/**
 * Themes, grouped into dark and light. Choosing one repaints this page at once,
 * so the effect is visible where the choice is made.
 */
function themePicker(): HTMLElement {
  const node = document.createElement('select')
  const groups = themesByMode()

  for (const [label, entries] of [
    ['Dark', groups.dark],
    ['Light', groups.light]
  ] as [string, [string, { name: string }][]][]) {
    const group = document.createElement('optgroup')
    group.label = label

    for (const [id, theme] of entries) {
      const option = document.createElement('option')
      option.value = id
      option.textContent = theme.name
      option.selected = settings.theme === id
      group.append(option)
    }

    node.append(group)
  }

  node.addEventListener('change', async () => {
    settings = await window.ie2.setSetting('theme', node.value)
    applyTheme(settings)
  })

  // While the custom theme is on the list does not apply, so it steps aside;
  // the choice in it is kept for when the switch goes off again.
  if (!settings.useCustomTheme) return node
  const note = document.createElement('span')
  note.className = 'static-value'
  note.textContent = t('Your custom theme is on')
  return note
}

/**
 * The custom theme's on/off. On: the colour card below unlocks and paints the
 * interface. Off: the theme picked from the list comes back, and the custom
 * colours stay saved, locked, for next time.
 */
function customThemeSwitch(): HTMLElement {
  return createSwitch(settings.useCustomTheme, async (on) => {
    // Nothing customised yet: start from whatever is on screen right now.
    const untouched = CUSTOM_THEME_FIELDS.every(([key]) => !settings.customTheme[key])
    if (on && untouched) {
      settings = await window.ie2.setSetting('customTheme', { ...settings.customTheme, base: settings.theme })
    }
    settings = await window.ie2.setSetting('useCustomTheme', on)
    applyTheme(settings)
    rerender('appearance')
  })
}

/**
 * The custom theme's colours, one row each. Every change repaints the page at
 * once; Reset hands that one colour back to the theme it started from.
 */
function customThemeGroup(): HTMLElement {
  const wrap = document.createElement('div')
  // Always on the page, so it is easy to find; locked and greyed until the
  // custom theme is switched on.
  const locked = !settings.useCustomTheme
  wrap.className = locked ? 'group locked' : 'group'
  // inert: nothing inside can be clicked, typed into or tabbed to.
  wrap.inert = locked
  if (locked) wrap.title = t('Switch on Custom theme above to edit these')

  const save = async (changes: Partial<Settings['customTheme']>): Promise<void> => {
    settings = await window.ie2.setSetting('customTheme', { ...settings.customTheme, ...changes })
    applyTheme(settings)
  }

  const base = document.createElement('select')
  for (const [id, theme] of [...themesByMode().dark, ...themesByMode().light]) {
    base.add(new Option(theme.name, id, false, settings.customTheme.base === id))
  }
  base.addEventListener('change', async () => {
    await save({ base: base.value })
    rerender('appearance')
  })
  wrap.append(row('Start from', 'Colours you have not changed come from this theme.', base))

  const shown = resolveTheme(CUSTOM_THEME_ID, settings.customTheme).colours
  for (const [key, title, description] of CUSTOM_THEME_FIELDS) {
    const control = document.createElement('div')
    control.className = 'theme-colour'

    const input = document.createElement('input')
    input.type = 'color'
    input.value = shown[key]
    // Live while dragging around the picker, saved when it closes.
    input.addEventListener('input', () => {
      applyTheme({ ...settings, customTheme: { ...settings.customTheme, [key]: input.value } })
    })
    input.addEventListener('change', () => void save({ [key]: input.value }))

    const reset = document.createElement('button')
    reset.className = 'action'
    reset.textContent = t('Reset')
    reset.disabled = !settings.customTheme[key]
    reset.addEventListener('click', async () => {
      await save({ [key]: '' })
      input.value = themeById(settings.customTheme.base).colours[key]
      reset.disabled = true
    })
    input.addEventListener('change', () => (reset.disabled = false))

    control.append(input, reset)
    wrap.append(row(title, description, control))
  }

  return wrap
}

/** A custom theme as a file: what Export writes and Import reads. */
interface ThemeFile {
  ie2Theme: 1
  name: string
  theme: Settings['customTheme']
}

const THEME_KEYS = ['base', ...CUSTOM_THEME_FIELDS.map(([key]) => key)] as const

/** Only the colours a theme can hold, each a #rrggbb or empty; anything else in a file is dropped. */
function cleanTheme(value: unknown): Settings['customTheme'] | null {
  if (!value || typeof value !== 'object') return null
  const source = value as Record<string, unknown>
  const theme = { ...DEFAULT_SETTINGS.customTheme }
  for (const key of THEME_KEYS) {
    const each = source[key]
    if (key === 'base') {
      if (typeof each === 'string' && each in THEMES) theme.base = each
    } else if (typeof each === 'string' && /^#[0-9a-f]{6}$/i.test(each)) {
      theme[key] = each
    }
  }
  return theme
}

/**
 * Save the colours above under a name, put a saved one back, or share one as
 * a small file — and read such a file in.
 */
function savedThemesRow(): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'group saved-themes'

  const store = async (next: Settings['savedThemes']): Promise<void> => {
    settings = await window.ie2.setSetting('savedThemes', next)
    rerender('appearance')
  }

  const name = document.createElement('input')
  name.type = 'text'
  name.maxLength = 40
  name.spellcheck = false
  name.placeholder = t('Name this theme')
  const save = document.createElement('button')
  save.className = 'action'
  save.textContent = t('Save')
  const saveIt = (): void => {
    const label = name.value.trim()
    if (!label) return name.focus()
    const rest = settings.savedThemes.filter((each) => each.name !== label)
    void store([...rest, { name: label, theme: { ...settings.customTheme } }])
  }
  save.addEventListener('click', saveIt)
  name.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') saveIt()
  })

  const importButton = document.createElement('button')
  importButton.className = 'action'
  importButton.textContent = t('Import…')
  const file = document.createElement('input')
  file.type = 'file'
  file.accept = '.json,application/json'
  file.hidden = true
  importButton.addEventListener('click', () => file.click())
  file.addEventListener('change', async () => {
    const picked = file.files?.[0]
    file.value = ''
    if (!picked || picked.size > 64 * 1024) return
    try {
      const parsed = JSON.parse(await picked.text()) as Partial<ThemeFile>
      const theme = cleanTheme(parsed.theme)
      const label = String(parsed.name ?? picked.name.replace(/\.json$/i, '')).trim().slice(0, 40) || 'Imported'
      if (!theme) throw new Error('No theme in the file')
      settings = await window.ie2.setSetting('customTheme', theme)
      settings = await window.ie2.setSetting('useCustomTheme', true)
      applyTheme(settings)
      await store([...settings.savedThemes.filter((each) => each.name !== label), { name: label, theme }])
    } catch {
      importButton.textContent = t('Not a theme file')
      window.setTimeout(() => (importButton.textContent = t('Import…')), 2000)
    }
  })

  const top = document.createElement('div')
  top.className = 'saved-themes-new'
  top.append(name, save, importButton, file)
  wrap.append(row(t('Save this theme'), t('Keep these colours under a name, to come back to or share as a file.'), top))

  for (const saved of settings.savedThemes) {
    const actions = document.createElement('div')
    actions.className = 'saved-theme-actions'

    const swatches = document.createElement('span')
    swatches.className = 'saved-theme-swatches'
    const colours = resolveTheme(CUSTOM_THEME_ID, saved.theme).colours
    for (const colour of [colours.bg, colours.toolbar, colours.bgElevated, colours.text]) {
      const swatch = document.createElement('i')
      swatch.style.background = colour
      swatches.append(swatch)
    }

    const use = document.createElement('button')
    use.className = 'action'
    use.textContent = t('Use')
    use.addEventListener('click', async () => {
      settings = await window.ie2.setSetting('customTheme', { ...saved.theme })
      settings = await window.ie2.setSetting('useCustomTheme', true)
      applyTheme(settings)
      rerender('appearance')
    })

    const exportButton = document.createElement('button')
    exportButton.className = 'action'
    exportButton.textContent = t('Export')
    exportButton.addEventListener('click', () => {
      const body: ThemeFile = { ie2Theme: 1, name: saved.name, theme: saved.theme }
      const link = document.createElement('a')
      link.href = URL.createObjectURL(new Blob([JSON.stringify(body, null, 2)], { type: 'application/json' }))
      link.download = `${saved.name.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'theme'}.ie2theme.json`
      link.click()
      window.setTimeout(() => URL.revokeObjectURL(link.href), 10_000)
    })

    const remove = document.createElement('button')
    remove.className = 'action'
    remove.textContent = t('Delete')
    remove.addEventListener('click', () => void store(settings.savedThemes.filter((each) => each !== saved)))

    actions.append(swatches, use, exportButton, remove)
    wrap.append(row(saved.name, '', actions))
  }
  return wrap
}

/**
 * In-app confirmation, themed like the rest of the browser.
 *
 * The buttons are wired once, at load, and route to whichever request is
 * currently open. Attaching them per call left the dialog inert whenever it was
 * shown by anything other than the call that wired it.
 */
let pending: ((value: { ok: boolean; checked: boolean }) => void) | null = null

function closeSheet(ok: boolean): void {
  if (!pending) return
  const checked = el<HTMLInputElement>('modal-check').checked
  const resolve = pending
  pending = null
  el('modal').hidden = true
  resolve({ ok, checked })
}

el('modal-ok').addEventListener('click', () => closeSheet(true))
el('modal-cancel').addEventListener('click', () => closeSheet(false))

// Clicking away from the sheet, or pressing Escape, cancels.
el('modal').addEventListener('mousedown', (event) => {
  if (event.target === el('modal')) closeSheet(false)
})

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeSheet(false)
})

function confirmSheet(
  title: string,
  body: string,
  extra?: { label: string; checked: boolean }
): Promise<{ ok: boolean; checked: boolean }> {
  return new Promise((resolve) => {
    el('modal-title').textContent = title
    el('modal-body').textContent = body

    const extraWrap = el('modal-extra')
    const check = el<HTMLInputElement>('modal-check')
    extraWrap.hidden = !extra
    check.checked = extra ? extra.checked : false
    if (extra) el('modal-check-label').textContent = extra.label

    pending = resolve
    el('modal').hidden = false
    el('modal-cancel').focus()
  })
}

// --- sections ---------------------------------------------------------------

const SECTIONS: Section[] = [
  {
    id: 'general',
    title: 'Get started',
    icon: 'home',
    build: () => [
      group(
        row(
          'On startup',
          'What to show when the browser opens.',
          select('onStartup', [
            ['restore', 'Continue where you left off'],
            ['newtab', 'Open the new tab page']
          ])
        ),
        row('Home page', 'Loaded by new tabs and the home action.', textInput('homePage', 'ie2://home'))
      )
    ]
  },
  {
    id: 'import',
    title: 'Import',
    icon: 'install',
    build: () => [importGroup()]
  },
  {
    id: 'default',
    title: 'Default browser',
    icon: 'globe',
    build: () => [
      group(
        row(
          'Open links with IE2',
          'Windows will not let a program make itself the default, so this registers IE2 and opens the Windows page where you choose it. Look for IE2 under Web browser, and under .html and .pdf if you want those too.',
          defaultBrowserRow()
        )
      )
    ]
  },
  {
    id: 'search',
    title: 'Search engine',
    icon: 'qr',
    build: () => [
      group(
        row(
          'Search engine',
          'Used when what you type is not a web address.',
          select(
            'searchEngine',
            Object.entries(SEARCH_ENGINES).map(([id, e]) => [id, e.name] as [string, string])
          )
        ),
        row(
          'Suggest from this machine',
          'Your history, past searches and page text, matched as you type. Nothing leaves the machine.',
          toggle('searchSuggestions')
        ),
        row(
          'Suggest from the search engine',
          'The autocomplete list other browsers show. Off by default, and the only one of these two that sends what you type to anyone: the engine sees each keystroke before you press Enter.',
          toggle('searchAutocomplete')
        )
      )
    ]
  },
  {
    id: 'appearance',
    title: 'Appearance',
    icon: 'settings',
    build: () => [
      group(
        row(
          'Theme',
          'The whole interface: dark or light, and everything in between.',
          themePicker()
        ),
        row(
          'Custom theme',
          'Pick every colour yourself, in the card below. Off goes back to the theme chosen above.',
          customThemeSwitch()
        ),
        row(
          'Accent colour',
          "Highlights, switches and focus rings. Leave it unset to follow the theme's own accent.",
          accentPicker()
        ),
        row(
          'Interface font',
          'The typeface of the toolbar, menus and the browser’s own pages.',
          select('uiFont', [
            ['system', 'System (Segoe UI)'],
            ['bahnschrift', 'Bahnschrift'],
            ['georgia', 'Georgia'],
            ['mono', 'Cascadia Mono'],
            ['comic', 'Comic Sans']
          ])
        ),
        row(
          'Corners',
          'How round tabs, buttons, the address bar, panels and the page frame are.',
          select('corners', [
            ['square', 'Square'],
            ['normal', 'Normal'],
            ['round', 'Round']
          ])
        ),
        row(
          'Tab width',
          'How much room each tab takes before shrinking.',
          select('tabWidth', [
            ['comfortable', 'Comfortable'],
            ['compact', 'Compact']
          ])
        ),
        row(
          'Address bar width',
          'A full-width bar, or a narrower one centred in the toolbar.',
          select('omniboxWidth', [
            ['full', 'Full width'],
            ['medium', 'Medium'],
            ['narrow', 'Narrow']
          ])
        ),
        row(
          'Page frame',
          'A margin with rounded corners round the page, so it sits inside the browser like a card.',
          toggle('pageFrame')
        ),
        row('Animations', 'Panel and button motion. Off is instant.', toggle('animations')),
        row(
          'Restyle website scrollbars',
          'Applies the browser scrollbar style to pages you visit.',
          toggle('stylePageScrollbars')
        )
      ),
      customThemeGroup(),
      // Outside the locked card: using or importing a saved theme switches custom on.
      savedThemesRow(),
      group(
        row(
          'Bookmarks bar',
          'The row of bookmarks under the toolbar. The star saves pages into it.',
          select('bookmarksBar', [
            ['always', 'Always'],
            ['newtab', 'Only on the new tab page'],
            ['never', 'Never']
          ])
        ),
        row(
          'Toolbar order',
          'Press and hold a tool, then slide it along the toolbar to move it. Alt+Shift+Left/Right moves the focused one.',
          actionButton('Reset to default', false, async () => {
            settings = await window.ie2.setSetting('toolbarOrder', [])
          })
        ),
        row('Show home button', 'Goes to your home page.', toggle('showHomeButton')),
        row('Show copy-link button', "Copies the current page's address.", toggle('showCopyLinkButton')),
        row(
          'Show screenshot button',
          'Copies the visible page to the clipboard. Ctrl+Shift+S works either way.',
          toggle('showScreenshotButton')
        ),
        row('Show bookmarks button', 'Opens your saved pages.', toggle('showBookmarksButton')),
        row('Show QR button', "A QR code of the current page, to open it on a phone.", toggle('showQrButton')),
        row('Show Mood button', 'Rain, wind and thunder sounds, mixed the way you like.', toggle('showMoodButton')),
        row(
          'Show Public IP button',
          'The address websites see you coming from, for checking a VPN. Hidden until you click it.',
          toggle('showIpButton')
        ),
        row('Show Passwords button', 'Opens your saved logins.', toggle('showPasswordsButton')),
        row(
          'Show Audio effects button',
          'Slowed, reverb, nightcore and bass boost for whatever a tab is playing.',
          toggle('showFxButton')
        ),
        row(
          'Show Dark mode button',
          'Dark websites, with no white flash while they load. Can be switched off per site.',
          toggle('showDarkButton')
        ),
        row(
          'Show Extensions button',
          'Your Chrome extensions. Extensions you pin stay beside the address bar either way.',
          toggle('showExtensionsButton')
        ),
        row(
          'Show media button',
          'What the current tab is playing, with play, pause and seek.',
          toggle('showMediaButton')
        ),
        row(
          'Show split view button',
          'Shows two tabs side by side. Ctrl+Shift+E works either way.',
          toggle('showSplitButton')
        ),
        row(
          'Show picture-in-picture button',
          'Floats a video above your other windows. Ctrl+Shift+I works either way.',
          toggle('showPipButton')
        ),
        row('Show Compatibility Mode button', 'The IE6 button in the toolbar.', toggle('showCompatButton')),
        row('Show amnesia button', 'The ○ button in the toolbar.', toggle('showAmnesiaButton')),
        row('Show DevTools button', 'Off by default. F12 works either way.', toggle('showDevToolsButton'))
      )
    ]
  },
  {
    id: 'newtab',
    title: 'New tab page',
    icon: 'split',
    build: () => [
      homeBackgroundGroup(),
      group(
        row('Heading', 'The large text at the top. Leave empty to hide it.', textInput('homeTitle', 'IE2')),
        row('Recall search box', 'Search the text of everything you have read.', toggle('homeShowSearch')),
        row('Statistics', 'Pages kept, words read, ads denied a life.', toggle('homeShowStats')),
        row('Recent visits', 'The list of pages you were just looking at.', toggle('homeShowRecent')),
        row('Verdict line', 'The remark at the bottom about your habits.', toggle('homeShowVerdict')),
        row('Clock', 'Time and date above the search box.', toggle('homeShowClock')),
        row(
          'Card style',
          'Solid panels, or frosted glass over the wallpaper.',
          select('homeCardStyle', [
            ['solid', 'Solid'],
            ['glass', 'Glass']
          ])
        )
      )
    ]
  },
  {
    id: 'memory',
    title: 'Memory',
    icon: 'bookmark',
    build: () => [
      group(
        row('Record history', 'Off means no page is written down at all.', toggle('recordHistory')),
        row(
          'Capture page text',
          'The full-text archive that powers recall search.',
          toggle('captureText')
        ),
        row(
          'Count blocked requests in amnesia tabs',
          'Counts only, never which pages you opened.',
          toggle('countBlockedInAmnesia')
        )
      ),
      statsGroup(),
      neverRememberGroup()
    ]
  },
  {
    id: 'performance',
    title: 'Performance',
    icon: 'compat',
    build: () => [
      group(
        row(
          'Let idle tabs sleep',
          'A tab you have not looked at for a while has its page thrown away and its memory given back. The tab stays where it is and reloads when you return to it.',
          toggle('sleepTabs')
        ),
        ...(settings.sleepTabs
          ? [
              row(
                'Sleep after',
                'Minutes of not being looked at. The tab in front of you, its split-view companion, and anything playing sound are never touched.',
                slider('sleepAfterMinutes', 5, 120, 5, ' min')
              )
            ]
          : [])
      )
    ]
  },
  {
    id: 'shields',
    title: 'Shields',
    icon: 'shield',
    build: () => [
      group(
        row(
          'Filter lists',
          'Blocking rules are refreshed automatically twice a day. Fetch them now if a site started showing ads again.',
          updateListsButton()
        ),
        row('Block ads and trackers', 'Network-level, using Ghostery filter lists.', toggle('blockAds'))
      )
    ]
  },
  {
    id: 'privacy',
    title: 'Privacy and security',
    icon: 'incognito',
    build: () => [
      group(
        row(
          'Refuse camera, microphone, location and notifications',
          'Every site, without asking. Off, a site asks once and keeps your answer — change it with the lock in the address bar.',
          toggle('denyPermissions')
        ),
        row(
          'Clear cookies when forgetting everything',
          'Signs you out of sites as well as erasing history.',
          toggle('clearCookiesOnForget')
        )
      ),
      sitePermissionsGroup(),
      group(
        row(
          'Forget everything',
          'Deletes all history and captured page text. Bookmarks are kept.',
          actionButton('Forget everything', true, async () => {
            const answer = await confirmSheet(
              'Forget everything?',
              'This deletes all browsing history and every page of captured text.\nBookmarks are kept. This cannot be undone.',
              { label: 'Also clear cookies and sign me out of sites', checked: settings.clearCookiesOnForget }
            )
            if (!answer.ok) return
            await window.ie2.forgetEverything(answer.checked)
            await refresh()
          })
        )
      )
    ]
  },
  {
    id: 'downloads',
    title: 'Downloads',
    icon: 'download',
    build: () => [
      group(
        row(
          'Ask where to save each file',
          'Off saves straight to your downloads folder.',
          toggle('askWhereToSave')
        )
      )
    ]
  },
  {
    id: 'language',
    title: 'Language',
    icon: 'help',
    build: () => [
      group(
        row(
          'Interface language',
          'English is the source. Anything untranslated stays in English.',
          select('language', languages.map((l) => [l.code, l.name] as [string, string]))
        ),
        row(
          'Add a language',
          'Any language you like. It appears here and in the translation editor straight away — translations are data, not code, so nothing needs rebuilding.',
          actionButton('Add a language', false, async () => {
            const answer = await promptDialog({
              title: 'Add a language',
              body: ['A two-letter code, and the name to show in this list.'],
              fields: [
                { name: 'code', label: 'Code', placeholder: 'de', maxLength: 5 },
                { name: 'name', label: 'Name', placeholder: 'Deutsch (German)', maxLength: 40 }
              ]
            })
            if (!answer) return

            const added = await window.ie2.addLanguage(answer.code, answer.name)
            if (!added) {
              await confirmDialog({
                title: 'That code was not accepted',
                body: [
                  'Use a two-letter code such as de, fr or es — optionally with a region, like pt-br.',
                  'Codes the browser already ships with cannot be added again.'
                ],
                confirmLabel: 'Right'
              })
              return
            }

            languages = await window.ie2.languages()
            rerender('language')
          })
        ),
        row(
          'Translate the interface',
          'Type your own wording for any string in the browser. It saves as you type and needs no rebuild.',
          actionButton('Open the translation editor', false, () =>
            window.ie2.open('ie2://translate')
          )
        )
      )
    ]
  },
  {
    id: 'about',
    title: 'About',
    icon: 'help',
    build: () => [
      group(
        row('Version', 'Which build is running, so you never have to guess.', versionLabel()),
        row(
          'Engine',
          'The Chromium and Node versions underneath.',
          staticText(`Electron ${window.ie2.versions?.electron ?? '—'} · Chromium ${window.ie2.versions?.chrome ?? '—'}`)
        ),
        row(
          'Updates',
          'Checks this project’s GitHub releases and installs the new version for you.',
          updateRow()
        ),
        row(
          'Automatic update check',
          'Ask GitHub for the latest release when the browser starts. Only version numbers are compared — nothing about you is sent. With this off, the button above still works.',
          toggle('autoUpdate')
        ),
        row(
          'Install updates automatically',
          'When the check at startup finds a new version, download it and restart into it straight away — your tabs come back. Off, it only tells you.',
          toggle('autoInstallUpdates')
        ),
        row(
          'Restart the browser',
          'Settings apply as you change them, so this is rarely needed. Open tabs are restored if that is your startup setting.',
          actionButton('Restart now', false, async () => {
            const ok = await confirmDialog({
              title: 'Restart IE2?',
              body: ['Every window closes and the browser starts again.'],
              confirmLabel: 'Restart'
            })
            if (ok) await window.ie2.restart()
          })
        )
      ),
      aboutStory()
    ]
  },
  {
    id: 'reset',
    title: 'Reset settings',
    icon: 'reload',
    build: () => [
      group(
        row(
          'Restore defaults',
          'Settings only. History, bookmarks and installed apps are untouched.',
          actionButton('Reset settings', true, async () => {
            const answer = await confirmSheet(
              'Reset all settings?',
              'Every setting returns to its default. Your history, bookmarks and installed apps are not affected.'
            )
            if (!answer.ok) return
            settings = await window.ie2.resetSettings()
            applyAccent()
            render()
          })
        )
      )
    ]
  }
]

/**
 * One row per profile found on this machine, with a checkbox per data type.
 * Importing is additive and repeatable — the same profile can be imported
 * twice without duplicating anything.
 */
function importGroup(): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'group'

  if (sources.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'empty'
    empty.textContent =
      'No other browsers found. Chrome, Brave, Edge, Vivaldi, Opera, Chromium and Firefox are checked.'
    wrap.append(empty)
    return wrap
  }

  const note = document.createElement('div')
  note.className = 'empty'
  note.textContent =
    'Close the other browser first — a running browser locks its history file. Importing twice is safe: nothing is duplicated.'
  wrap.append(note)

  for (const source of sources) {
    const node = document.createElement('div')
    node.className = 'row'

    const label = document.createElement('div')
    label.className = 'label'

    const name = document.createElement('b')
    name.textContent = `${source.browser} — ${source.profile}`
    label.append(name)

    const what = document.createElement('span')
    what.textContent = 'Choose what to bring across:'
    label.append(what)

    // One checkbox per kind of data, so importing bookmarks does not also
    // drag in ten years of history.
    const picks = document.createElement('div')
    picks.className = 'import-picks'
    const pick = (text: string, on: boolean, available: boolean, why = ''): HTMLInputElement => {
      const item = document.createElement('label')
      item.className = available ? 'pick' : 'pick unavailable'
      const box = document.createElement('input')
      box.type = 'checkbox'
      box.checked = on && available
      box.disabled = !available
      item.append(box, document.createTextNode(t(text)))
      if (why) item.title = why
      picks.append(item)
      return box
    }

    const wantBookmarks = pick('Bookmarks', true, source.hasBookmarks)
    const wantHistory = pick('Browsing history', true, source.hasHistory)
    const wantSearches = pick('Past searches', true, source.hasHistory && source.browser !== 'Firefox')
    const wantCookies = pick(
      'Cookies (stay signed in)',
      false,
      source.hasCookies,
      source.hasCookies
        ? 'Cookies carry your logins. Anyone using this IE2 profile is signed in wherever you were.'
        : 'Chrome, Edge, Brave and other Chromium browsers lock their cookies so no other program can read them.'
    )
    label.append(picks)

    if (source.hasCookies) {
      const warn = document.createElement('span')
      warn.className = 'import-warn'
      warn.textContent = t(
        'Cookies are as good as passwords: anyone using this profile is signed in wherever you were. Some sites may still ask you to sign in again.'
      )
      warn.hidden = true
      wantCookies.addEventListener('change', () => (warn.hidden = !wantCookies.checked))
      label.append(warn)
    }

    node.append(label)

    const control = document.createElement('div')
    control.className = 'control'

    const button = document.createElement('button')
    button.className = 'action'
    button.textContent = t('Import')

    button.addEventListener('click', async () => {
      const choice = {
        bookmarks: wantBookmarks.checked,
        history: wantHistory.checked,
        searches: wantSearches.checked,
        cookies: wantCookies.checked
      }
      if (!Object.values(choice).some(Boolean)) {
        what.textContent = t('Tick at least one thing to import.')
        return
      }

      button.disabled = true
      button.textContent = t('Importing…')

      try {
        const result = await window.ie2.runImport(source.id, choice)
        if (!result) throw new Error('refused')

        what.textContent =
          [
            choice.history ? `${result.history} pages` : '',
            choice.bookmarks ? `${result.bookmarks} bookmarks` : '',
            choice.searches ? `${result.searches} past searches` : '',
            choice.cookies ? `${result.cookies} cookies` : ''
          ]
            .filter(Boolean)
            .join(', ')
            .replace(/^/, 'Imported ') + (result.skipped > 0 ? ` — ${result.skipped} entries skipped` : '')
        button.textContent = t('Imported')

        const fresh = await window.ie2.stats()
        stats = fresh
      } catch {
        what.textContent = t('Import failed. Close the other browser and try again.')
        button.textContent = t('Import')
        button.disabled = false
      }
    })

    control.append(button)
    node.append(control)
    wrap.append(node)
  }

  return wrap
}

function statsGroup(): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'group'

  const grid = document.createElement('div')
  grid.className = 'stats'

  const cards: [string, string][] = [
    [nf.format(stats.pages), 'pages kept'],
    [nf.format(stats.words), 'words of page text'],
    [nf.format(stats.visits), 'visits logged'],
    [nf.format(stats.blocked), 'requests blocked']
  ]

  for (const [value, label] of cards) {
    const card = document.createElement('div')
    card.className = 'stat'
    const b = document.createElement('b')
    b.textContent = value
    const span = document.createElement('span')
    span.textContent = label
    card.append(b, span)
    grid.append(card)
  }

  wrap.append(grid)
  return wrap
}

const PERMISSION_LABELS: Record<string, string> = {
  camera: 'Camera',
  microphone: 'Microphone',
  location: 'Location',
  notifications: 'Notifications',
  clipboard: 'Clipboard'
}

/** Every answer a site was given, each one removable so the site asks again. */
function sitePermissionsGroup(): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'group'
  wrap.append(
    row(
      'Site permissions',
      'What sites were allowed or refused. Remove one and the site asks again next time.',
      document.createElement('span')
    )
  )

  const list = document.createElement('div')
  list.className = permissions.length > 0 ? 'domains' : 'empty'
  if (permissions.length === 0) {
    list.textContent = t('No site has asked for anything yet.')
  }
  for (const entry of permissions) {
    const chip = document.createElement('span')
    chip.className = entry.allow ? 'chip' : 'chip refused'
    chip.append(
      document.createTextNode(
        `${entry.origin.replace(/^https?:\/\//, '')} · ${PERMISSION_LABELS[entry.permission] ?? entry.permission} · ${
          entry.allow ? 'allowed' : 'blocked'
        }`
      )
    )
    const remove = document.createElement('button')
    remove.append(icon('close'))
    remove.title = 'Forget this answer'
    remove.addEventListener('click', async () => {
      await window.ie2.forgetPermission(entry.origin, entry.permission)
      await refresh()
    })
    chip.append(remove)
    list.append(chip)
  }
  wrap.append(list)
  return wrap
}

function neverRememberGroup(): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'group'

  const head = row(
    'Never remember these sites',
    'Pages on these domains and their subdomains are never recorded.',
    document.createElement('span')
  )
  wrap.append(head)

  const list = document.createElement('div')
  list.className = domains.length > 0 ? 'domains' : 'empty'

  if (domains.length === 0) {
    list.textContent = t('Nothing excluded. Everything is fair game.')
  } else {
    for (const domain of domains) {
      const chip = document.createElement('span')
      chip.className = 'chip'
      chip.append(document.createTextNode(domain))

      const remove = document.createElement('button')
      remove.append(icon('close'))
      remove.title = `Stop excluding ${domain}`
      remove.addEventListener('click', async () => {
        await window.ie2.removeNeverRemember(domain)
        await refresh()
      })

      chip.append(remove)
      list.append(chip)
    }
  }

  wrap.append(list)

  const addRow = document.createElement('div')
  addRow.className = 'addrow'

  const input = document.createElement('input')
  input.type = 'text'
  input.placeholder = 'example.com'

  const add = actionButton('Add domain', false, async () => {
    if (!input.value.trim()) return
    await window.ie2.addNeverRemember(input.value.trim())
    input.value = ''
    await refresh()
  })

  const forget = actionButton('Forget a site’s history…', true, async () => {
    const value = input.value.trim()
    if (!value) {
      input.focus()
      return
    }
    const answer = await confirmSheet(
      `Forget ${value}?`,
      'Deletes the history and captured text for this domain and its subdomains. Bookmarks are kept.'
    )
    if (!answer.ok) return
    await window.ie2.forgetSite(value)
    input.value = ''
    await refresh()
  })

  addRow.append(input, add, forget)
  wrap.append(addRow)

  return wrap
}

// --- rendering --------------------------------------------------------------

/**
 * Some choices change which controls belong on screen — picking a wallpaper
 * folder needs a folder button that flat colour does not. Rebuild, then put the
 * reader back where they were.
 */
function rerender(anchor?: string): void {
  const y = window.scrollY
  render()
  if (anchor) document.getElementById(anchor)?.scrollIntoView({ block: 'start' })
  else window.scrollTo(0, y)
}

function render(): void {
  nav.replaceChildren()
  panels.replaceChildren()

  for (const section of SECTIONS) {
    const button = document.createElement('button')
    // Line icons rather than glyphs: they follow the theme colour and look the
    // same on every machine.
    const mark = document.createElement('span')
    mark.className = 'ico'
    mark.append(icon(section.icon))
    button.append(mark, document.createTextNode(t(section.title)))
    button.addEventListener('click', () => {
      document.getElementById(section.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
    nav.append(button)

    if (section.id === 'reset') {
      const sep = document.createElement('div')
      sep.className = 'sep'
      nav.insertBefore(sep, button)
    }

    const node = document.createElement('section')
    node.id = section.id

    const heading = document.createElement('h2')
    heading.textContent = t(section.title)
    node.append(heading, ...section.build())

    panels.append(node)
  }

  markActiveOnScroll()
  applyFilter()
}

/** Highlights whichever section is currently on screen. */
function markActiveOnScroll(): void {
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        const index = SECTIONS.findIndex((s) => s.id === entry.target.id)
        for (const [i, button] of [...nav.querySelectorAll('button')].entries()) {
          button.classList.toggle('active', i === index)
        }
      }
    },
    { rootMargin: '-80px 0px -70% 0px' }
  )

  for (const section of SECTIONS) {
    const node = document.getElementById(section.id)
    if (node) observer.observe(node)
  }
}

function applyFilter(): void {
  const query = filter.value.trim().toLowerCase()

  for (const section of panels.querySelectorAll('section')) {
    if (!query) {
      section.hidden = false
      for (const r of section.querySelectorAll('.row')) (r as HTMLElement).hidden = false
      continue
    }

    let anyVisible = false
    for (const r of section.querySelectorAll('.row')) {
      const match = (r.textContent ?? '').toLowerCase().includes(query)
      ;(r as HTMLElement).hidden = !match
      anyVisible = anyVisible || match
    }

    const titleMatch = (section.querySelector('h2')?.textContent ?? '').toLowerCase().includes(query)
    section.hidden = !anyVisible && !titleMatch
  }
}

filter.addEventListener('input', applyFilter)

/**
 * The sidebar's version. It was written into the HTML by hand and had been
 * saying v0.1.0 for several releases; it comes from the build stamp now, like
 * the one in About.
 */
function applyVersion(): void {
  el('version').textContent = `v${buildLabel().split(' · ')[0]}`
}

async function refresh(): Promise<void> {
  ;[settings, stats, domains, sources, permissions] = await Promise.all([
    window.ie2.getSettings(),
    window.ie2.stats(),
    window.ie2.listNeverRemember(),
    window.ie2.scanForImport(),
    window.ie2.sitePermissions()
  ])
  languages = await window.ie2.languages()
  messages = await window.ie2.messages(settings.language)
  applyVersion()
  applyAccent()
  render()
}

// A failed call must not cost the whole page. Before this, one rejected IPC
// during start-up left Settings showing nothing but its search box.
void refresh().catch((error) => {
  console.error('settings: could not load everything', error)
  try {
    render()
  } catch (renderError) {
    console.error('settings: render failed', renderError)
  }
})
