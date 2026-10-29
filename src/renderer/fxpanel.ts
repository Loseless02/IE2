import './fxpanel.css'
import { icon } from './icons'
import {
  BUILT_IN_FX_PRESETS,
  NEUTRAL_FX,
  cleanFx,
  type AudioFx,
  type AudioFxPreset,
  type AudioFxState
} from '../shared/audiofx'

/**
 * The audio effects panel: presets, speed, reverb, room, bass and pitch for
 * whatever a tab is playing. Built here once and used by both the browser's
 * toolbar and an installed app's title bar, which differ only in where it
 * hangs and which page it talks to.
 */

export interface FxPanelOptions {
  get: () => Promise<AudioFxState | null>
  set: (fx: AudioFx, remember: boolean) => Promise<AudioFxState | null>
  /** The user's own presets, and somewhere to keep them. */
  presets: () => AudioFxPreset[]
  savePresets: (presets: AudioFxPreset[]) => void
  toast: (text: string) => void
  /** The panel changed size: the host may need to make room. */
  resized: () => void
  /** The tab's effects changed, for lighting the button. */
  changed: (state: AudioFxState | null) => void
}

export interface FxPanel {
  /** Ask the page in front for its current effects. */
  refresh: () => Promise<void>
  /** Draw it, ready to be shown. */
  open: () => Promise<void>
}

function make<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text) node.textContent = text
  return node
}

function roomLabel(room: number): string {
  return room < 0.25 ? 'Small room' : room < 0.5 ? 'Room' : room < 0.75 ? 'Hall' : 'Cathedral'
}

export function createFxPanel(root: HTMLElement, options: FxPanelOptions): FxPanel {
  root.classList.add('fx-panel')
  root.replaceChildren()

  let state: AudioFxState | null = null
  let sendTimer: number | undefined

  // --- the parts ---

  const head = make('div', 'panel-head')
  const site = make('span', 'fx-site')
  head.append(make('span', '', 'Audio effects'), site)

  const presetRow = make('div', 'fx-presets')

  const nameRow = make('div', 'fx-name-row')
  nameRow.hidden = true
  const nameInput = make('input')
  nameInput.type = 'text'
  nameInput.maxLength = 30
  nameInput.spellcheck = false
  nameInput.placeholder = 'Preset name'
  const nameSave = make('button', 'primary', 'Save')
  nameRow.append(nameInput, nameSave)

  const slider = (label: string, min: number, max: number): { wrap: HTMLElement; input: HTMLInputElement; value: HTMLElement } => {
    const wrap = make('div', 'fx-slider')
    const top = make('label')
    const value = make('b')
    value.title = 'Double-click to reset'
    top.append(make('span', '', label), value)
    const input = make('input')
    input.type = 'range'
    input.min = String(min)
    input.max = String(max)
    input.step = '0.01'
    wrap.append(top, input)
    return { wrap, input, value }
  }

  const speed = slider('Speed', 0.5, 1.5)
  const reverb = slider('Reverb', 0, 1)
  const room = slider('Room size', 0, 1)
  const bass = slider('Bass boost', 0, 1)

  const check = (label: string): { wrap: HTMLElement; input: HTMLInputElement } => {
    const wrap = make('label', 'fx-check')
    const input = make('input')
    input.type = 'checkbox'
    wrap.append(input, document.createTextNode(` ${label}`))
    return { wrap, input }
  }
  const pitch = check('Keep original pitch')
  const remember = check('Remember for this site')

  const status = make('div', 'fx-status')

  const actions = make('div', 'fx-actions')
  const saveButton = make('button', '', 'Save as preset')
  const resetButton = make('button', '', 'Reset')
  actions.append(saveButton, make('span', 'spacer'), resetButton)

  root.append(head, presetRow, nameRow, speed.wrap, reverb.wrap, room.wrap, bass.wrap, pitch.wrap, remember.wrap, status, actions)

  // --- drawing ---

  const fromInputs = (): AudioFx => ({
    speed: Number(speed.input.value),
    reverb: Number(reverb.input.value),
    room: Number(room.input.value),
    bass: Number(bass.input.value),
    keepPitch: pitch.input.checked
  })

  const drawValues = (fx: AudioFx): void => {
    speed.value.textContent = `${fx.speed.toFixed(2)}×`
    reverb.value.textContent = `${Math.round(fx.reverb * 100)}%`
    room.value.textContent = roomLabel(fx.room)
    bass.value.textContent = `${Math.round(fx.bass * 100)}%`
  }

  const draw = (): void => {
    try {
      site.textContent = state ? new URL(state.origin).host : ''
    } catch {
      site.textContent = ''
    }
    const fx = state?.fx ?? NEUTRAL_FX
    speed.input.value = String(fx.speed)
    reverb.input.value = String(fx.reverb)
    room.input.value = String(fx.room)
    bass.input.value = String(fx.bass)
    pitch.input.checked = fx.keepPitch
    remember.input.checked = Boolean(state?.remembered)
    drawValues(fx)

    const report = state?.report
    status.textContent = !report
      ? ''
      : !report.hasMedia
        ? 'Nothing is playing here yet — the settings apply as soon as something does.'
        : report.limited
          ? 'This player is protected: speed works, but its sound cannot be given reverb or bass.'
          : ''

    // The built-in presets, then the ones saved here, each removable.
    presetRow.replaceChildren()
    const custom = options.presets()
    for (const preset of [...BUILT_IN_FX_PRESETS, ...custom]) {
      const button = make('button', 'fx-preset', preset.name)
      const active =
        Math.abs(preset.speed - fx.speed) < 0.005 &&
        Math.abs(preset.reverb - fx.reverb) < 0.005 &&
        Math.abs(preset.bass - fx.bass) < 0.005 &&
        preset.keepPitch === fx.keepPitch
      button.classList.toggle('on', active)
      button.addEventListener('click', () => void send(cleanFx(preset)))

      if (custom.includes(preset)) {
        const remove = make('span', 'fx-remove')
        remove.title = 'Delete this preset'
        remove.append(icon('close'))
        remove.addEventListener('click', (event) => {
          event.stopPropagation()
          options.savePresets(custom.filter((each) => each !== preset))
          draw()
        })
        button.append(remove)
      }
      presetRow.append(button)
    }
  }

  const send = async (fx: AudioFx): Promise<void> => {
    const next = await options.set(fx, remember.input.checked)
    if (next) state = next
    options.changed(state)
    draw()
  }

  // --- behaviour ---

  // Sliders send as they move, a few times a second at most.
  for (const part of [speed, reverb, room, bass]) {
    part.input.addEventListener('input', () => {
      const fx = fromInputs()
      drawValues(fx)
      window.clearTimeout(sendTimer)
      sendTimer = window.setTimeout(() => void send(fx), 60)
    })
  }
  for (const part of [pitch, remember]) part.input.addEventListener('change', () => void send(fromInputs()))

  // Double-click a value to put just that one back.
  for (const [part, key] of [
    [speed, 'speed'],
    [reverb, 'reverb'],
    [room, 'room'],
    [bass, 'bass']
  ] as [typeof speed, keyof AudioFx][]) {
    part.value.addEventListener('dblclick', () => void send({ ...fromInputs(), [key]: NEUTRAL_FX[key] }))
  }

  resetButton.addEventListener('click', () => void send({ ...NEUTRAL_FX }))

  saveButton.addEventListener('click', () => {
    nameRow.hidden = false
    nameInput.value = ''
    options.resized()
    nameInput.focus()
  })

  const savePreset = (): void => {
    const name = nameInput.value.trim()
    if (!name) return
    options.savePresets([...options.presets().filter((each) => each.name !== name), { name, ...fromInputs() }])
    nameRow.hidden = true
    draw()
    options.resized()
    options.toast(`Saved preset "${name}"`)
  }
  nameSave.addEventListener('click', savePreset)
  nameInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') savePreset()
    if (event.key === 'Escape') {
      nameRow.hidden = true
      options.resized()
    }
  })

  return {
    refresh: async () => {
      state = await options.get()
      options.changed(state)
      if (!root.hidden) draw()
    },
    open: async () => {
      state = await options.get()
      options.changed(state)
      nameRow.hidden = true
      draw()
    }
  }
}
