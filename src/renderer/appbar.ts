import { applyTheme } from './theme'
import { setIcon } from './icons'
import { createFxPanel } from './fxpanel'
import { createExtPanel } from './extpanel'
import { cleanFx, isNeutral, type AudioFxPreset } from '../shared/audiofx'
import type { Settings } from '../shared/settings'

/**
 * The title bar of an installed web app: back, reload, the page's title, the
 * audio effects and extensions — the tools that make sense in a single-site
 * window.
 */

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

/** Each tool's panel, by the id of its button. */
const PANELS = { fx: 'fx-panel', extensions: 'ext-panel' } as const
type Tool = keyof typeof PANELS

let presets: AudioFxPreset[] = []
let open: Tool | null = null

setIcon(el('back'), 'back')
setIcon(el('reload'), 'reload')
setIcon(el('fx'), 'fx')
setIcon(el('extensions'), 'puzzle')
setIcon(el('open'), 'link')

let toastTimer: number | undefined
function toast(text: string): void {
  const node = el('toast')
  node.textContent = text
  node.hidden = false
  window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => (node.hidden = true), 1800)
  layout()
}

/** The bar grows over the page while the panel or a message needs the room. */
function layout(): void {
  const needed = open ? el(PANELS[open]).offsetHeight + 16 : el('toast').hidden ? 0 : 44
  void window.appbar.setHeight(needed)
}

const fxPanel = createFxPanel(el('fx-panel'), {
  get: () => window.appbar.audioFx(),
  set: (fx, remember) => window.appbar.setAudioFx(fx, remember),
  presets: () => presets,
  savePresets: (next) => {
    presets = next
    void window.appbar.saveAudioPresets(next)
  },
  toast,
  resized: layout,
  changed: (state) => el('fx').classList.toggle('on', Boolean(state && !isNeutral(state.fx)))
})

const extPanel = createExtPanel(el('ext-panel'), {
  list: () => window.appbar.extensions(),
  click: (id, anchor) => void window.appbar.clickExtension(id, anchor),
  menu: (id) => void window.appbar.extensionMenu(id),
  store: () => void window.appbar.openExtensionStore(),
  anchor: () => el('extensions'),
  close: () => setOpen(null),
  resized: layout
})

function setOpen(next: Tool | null): void {
  open = next
  for (const [tool, panel] of Object.entries(PANELS)) {
    el(panel).hidden = tool !== next
    el(tool).classList.toggle('active', tool === next)
  }
  layout()
}

el('fx').addEventListener('click', async () => {
  if (open === 'fx') return setOpen(null)
  await fxPanel.open()
  setOpen('fx')
})

el('extensions').addEventListener('click', async () => {
  if (open === 'extensions') return setOpen(null)
  await extPanel.open()
  setOpen('extensions')
})

// A badge changing while the list is open.
window.appbar.onExtensionsChanged((list) => {
  if (open === 'extensions') extPanel.draw(list)
})

el('back').addEventListener('click', () => void window.appbar.back())
el('reload').addEventListener('click', () => void window.appbar.reload())
el('open').addEventListener('click', () => void window.appbar.openInBrowser())

// A click anywhere but the panel, or on the page itself, closes it.
document.addEventListener('mousedown', (event) => {
  const target = event.target as HTMLElement
  if (open && !target.closest(`#${open}, #${PANELS[open]}`)) setOpen(null)
})
window.addEventListener('blur', () => {
  if (open) setOpen(null)
})

window.appbar.onState((state) => {
  el<HTMLButtonElement>('back').disabled = !state.canGoBack
  setIcon(el('reload'), state.loading ? 'stop' : 'reload')
  // The page's own title: text, never markup.
  el('title').textContent = state.title
  const icon = el<HTMLImageElement>('icon')
  if (state.favicon && icon.src !== state.favicon) icon.src = state.favicon
  icon.hidden = !state.favicon
  void fxPanel.refresh()
})
el<HTMLImageElement>('icon').addEventListener('error', () => (el('icon').hidden = true))

window.appbar.onAudioFxChanged(() => void fxPanel.refresh())

function applySettings(settings: Settings): void {
  applyTheme(settings)
  presets = (Array.isArray(settings.audioPresets) ? settings.audioPresets : []).map((preset) => ({
    ...cleanFx(preset),
    name: String(preset?.name ?? 'Preset').slice(0, 30)
  }))
}

window.appbar.onSettings(applySettings)
void window.appbar.settings().then(applySettings)
