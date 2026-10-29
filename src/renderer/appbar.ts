import { applyTheme } from './theme'
import { setIcon } from './icons'
import { createFxPanel } from './fxpanel'
import { cleanFx, isNeutral, type AudioFxPreset } from '../shared/audiofx'
import type { Settings } from '../shared/settings'

/**
 * The title bar of an installed web app: back, reload, the page's title, and
 * the audio effects — the tools that make sense in a single-site window.
 */

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T
const panel = el('fx-panel')

let presets: AudioFxPreset[] = []
let open = false

setIcon(el('back'), 'back')
setIcon(el('reload'), 'reload')
setIcon(el('fx'), 'fx')
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
  const needed = open ? panel.offsetHeight + 16 : el('toast').hidden ? 0 : 44
  void window.appbar.setHeight(needed)
}

const fxPanel = createFxPanel(panel, {
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

function setOpen(next: boolean): void {
  open = next
  panel.hidden = !next
  el('fx').classList.toggle('active', next)
  layout()
}

el('fx').addEventListener('click', async () => {
  if (open) return setOpen(false)
  await fxPanel.open()
  setOpen(true)
})

el('back').addEventListener('click', () => void window.appbar.back())
el('reload').addEventListener('click', () => void window.appbar.reload())
el('open').addEventListener('click', () => void window.appbar.openInBrowser())

// A click anywhere but the panel, or on the page itself, closes it.
document.addEventListener('mousedown', (event) => {
  const target = event.target as HTMLElement
  if (open && !target.closest('#fx-panel, #fx')) setOpen(false)
})
window.addEventListener('blur', () => {
  if (open) setOpen(false)
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
