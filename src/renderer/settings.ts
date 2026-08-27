import {
  ACCENT_PRESETS,
  IMAGE_FITS,
  SEARCH_ENGINES,
  toHex,
  type Settings
} from '../shared/settings'
import { contrastOn, createColourPicker } from './colour'
import { themesByMode } from '../shared/themes'
import { BUILT_IN_WALLPAPERS } from '../shared/wallpapers'

import { applyTheme } from './theme'
import { icon } from './icons'
import { confirmDialog, promptDialog } from './dialog'
import { buildLabel } from '../shared/build'
import { uiKey } from '../shared/i18n'
import type { ImportSource, RecallStats, UpdateState } from '../shared/types'

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

const nav = el('nav')
const panels = el('panels')
const filter = el<HTMLInputElement>('filter')

let settings: Settings
let stats: RecallStats
let domains: string[] = []
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
  const button = document.createElement('button')
  button.className = settings[key] ? 'switch on' : 'switch'
  button.setAttribute('role', 'switch')
  button.setAttribute('aria-checked', String(Boolean(settings[key])))

  button.addEventListener('click', async () => {
    const next = !settings[key]
    button.classList.toggle('on', next)
    button.setAttribute('aria-checked', String(next))
    settings = await window.ie2.setSetting(key, next)
    applyTheme(settings)

    // Some switches decide whether other rows belong on screen at all.
    if (key === 'sleepTabs') rerender('performance')
  })

  return button
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

  const paint = (state: UpdateState): void => {
    const labels: Record<UpdateState['status'], string> = {
      idle: t('Check for updates'),
      checking: t('Checking…'),
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
      ready: `${t('Version')} ${state.version} ${t('is ready to install.')}`,
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
    if (state.status === 'available') return void window.ie2.downloadUpdate()
    if (state.status === 'ready') return void window.ie2.installUpdate()

    paint(await window.ie2.checkForUpdate())
  })

  // Progress arrives as it happens, so the row is live rather than a snapshot.
  window.ie2.onUpdateState(paint)
  void window.ie2.updateState().then(paint)

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
        swatch.addEventListener('contextmenu', async (event) => {
          event.preventDefault()
          settings = await window.ie2.setSetting(
            'savedAccents',
            settings.savedAccents.filter((c) => c !== hex)
          )
          renderSwatches()
        })

        const mark = document.createElement('span')
        mark.className = 'saved-dot'
        mark.style.background = contrastOn(hex)
        swatch.append(mark)
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
  wrap.className = 'stack'

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

function slider(key: keyof Settings, min: number, max: number, step: number): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'slider'

  const input = document.createElement('input')
  input.type = 'range'
  input.min = String(min)
  input.max = String(max)
  input.step = String(step)
  input.value = String(settings[key] ?? min)

  const value = document.createElement('span')
  value.textContent = `${input.value}%`

  input.addEventListener('input', () => {
    value.textContent = `${input.value}%`
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

  return node
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
        row('Theme', 'The whole interface: dark or light, and everything in between.', themePicker()),
        row(
          'Accent colour',
          "Highlights, switches and focus rings. Leave it unset to follow the theme's own accent.",
          accentPicker()
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
        row('Animations', 'Panel and button motion. Off is instant.', toggle('animations')),
        row(
          'Restyle website scrollbars',
          'Applies the browser scrollbar style to pages you visit.',
          toggle('stylePageScrollbars')
        )
      ),
      group(
        row('Show home button', 'Goes to your home page.', toggle('showHomeButton')),
        row('Show copy-link button', "Copies the current page's address.", toggle('showCopyLinkButton')),
        row(
          'Show screenshot button',
          'Copies the visible page to the clipboard. Ctrl+Shift+S works either way.',
          toggle('showScreenshotButton')
        ),
        row('Show bookmarks button', 'Opens your saved pages.', toggle('showBookmarksButton')),
        row('Show QR button', "A QR code of the current page, to open it on a phone.", toggle('showQrButton')),
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
                slider('sleepAfterMinutes', 5, 120, 5)
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
          'Deny camera, microphone and location',
          'Every site, no prompt. Turning this off does nothing yet — the prompt UI does not exist.',
          toggle('denyPermissions')
        ),
        row(
          'Clear cookies when forgetting everything',
          'Signs you out of sites as well as erasing history.',
          toggle('clearCookiesOnForget')
        )
      ),
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
      aboutStory(),
      group(
        row('Version', 'Which build is running, so you never have to guess.', versionLabel()),
        row(
          'Engine',
          'The Chromium and Node versions underneath.',
          staticText(`Electron ${window.ie2.versions?.electron ?? '—'} · Chromium ${window.ie2.versions?.chrome ?? '—'}`)
        ),
        updateRow(),
        row(
          'Automatic update check',
          'Ask GitHub for the latest release when the browser starts. Only version numbers are compared — nothing about you is sent. With this off, the button above still works.',
          toggle('autoUpdate')
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
      )
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
    what.textContent = [
      source.hasBookmarks ? 'bookmarks' : null,
      source.hasHistory ? 'history and past searches' : null
    ]
      .filter(Boolean)
      .join(', ')
    label.append(what)

    node.append(label)

    const control = document.createElement('div')
    control.className = 'control'

    const button = document.createElement('button')
    button.className = 'action'
    button.textContent = t('Import')

    button.addEventListener('click', async () => {
      button.disabled = true
      button.textContent = t('Importing…')

      try {
        const result = await window.ie2.runImport(source.id, {
          bookmarks: source.hasBookmarks,
          history: source.hasHistory,
          searches: source.hasHistory
        })

        what.textContent =
          `Imported ${result.history} pages, ${result.bookmarks} bookmarks, ` +
          `${result.searches} past searches` +
          (result.skipped > 0 ? ` — ${result.skipped} entries skipped` : '')
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
  ;[settings, stats, domains, sources] = await Promise.all([
    window.ie2.getSettings(),
    window.ie2.stats(),
    window.ie2.listNeverRemember(),
    window.ie2.scanForImport()
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
