import { ipcRenderer } from 'electron'
import { NEUTRAL_FX, type AudioFx, type AudioFxReport } from '../shared/audiofx'

/**
 * Slowed, reverb, nightcore: the audio effects tool, inside the page.
 *
 * Runs in the preload's isolated world, where the page's scripts cannot reach
 * it. Speed and pitch are the media element's own controls. Reverb and bass
 * need the sound itself, so the element is routed through Web Audio — which
 * only works when the page is allowed to read its own audio: same-origin or
 * CORS media, and Media Source streams like YouTube's. For anything else,
 * routing it would turn it silent, so those keep speed only and say so.
 */

let fx: AudioFx = { ...NEUTRAL_FX }

interface Chain {
  bass: BiquadFilterNode
  dry: GainNode
  wet: GainNode
  verb: ConvolverNode
  room: number
}

let ctx: AudioContext | null = null
const chains = new WeakMap<HTMLMediaElement, Chain>()
const blocked = new WeakSet<HTMLMediaElement>()

/** A decaying burst of noise: the sound of a room, longer for a bigger one. */
function impulse(room: number): AudioBuffer {
  const ac = ctx as AudioContext
  const seconds = 0.8 + room * 4.2
  const length = Math.floor(ac.sampleRate * seconds)
  const buffer = ac.createBuffer(2, length, ac.sampleRate)
  const decay = 2 + (1 - room) * 3
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch)
    for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay)
  }
  return buffer
}

/** Whether routing this element through Web Audio would keep it audible. */
function routable(media: HTMLMediaElement): boolean {
  // Protected playback (Spotify, Netflix) is never readable.
  if (media.mediaKeys) return false
  const src = media.currentSrc || media.src
  if (!src) return false
  if (src.startsWith('blob:') || src.startsWith('data:') || src.startsWith('mediastream:')) return true
  try {
    if (new URL(src, location.href).origin === location.origin) return true
  } catch {
    return false
  }
  return media.crossOrigin !== null
}

function chainFor(media: HTMLMediaElement): Chain | null {
  const existing = chains.get(media)
  if (existing) return existing
  if (blocked.has(media)) return null
  if (!routable(media)) {
    blocked.add(media)
    return null
  }

  try {
    ctx ??= new AudioContext()
    const source = ctx.createMediaElementSource(media)
    const bass = ctx.createBiquadFilter()
    bass.type = 'lowshelf'
    bass.frequency.value = 120
    const dry = ctx.createGain()
    const wet = ctx.createGain()
    const verb = ctx.createConvolver()
    // Reverb tails without their hiss: the wet path loses its very top.
    const soften = ctx.createBiquadFilter()
    soften.type = 'lowpass'
    soften.frequency.value = 7000

    source.connect(bass)
    bass.connect(dry).connect(ctx.destination)
    bass.connect(verb).connect(soften).connect(wet).connect(ctx.destination)

    const chain: Chain = { bass, dry, wet, verb, room: -1 }
    chains.set(media, chain)
    return chain
  } catch {
    // Already routed by the page itself, or refused: speed still works.
    blocked.add(media)
    return null
  }
}

function needsChain(): boolean {
  return fx.reverb > 0 || fx.bass > 0
}

function applyTo(media: HTMLMediaElement): void {
  // Speed, and whether the pitch follows it. Off is the classic slowed sound.
  if (Math.abs(media.playbackRate - fx.speed) > 0.001) media.playbackRate = fx.speed
  media.preservesPitch = fx.keepPitch

  const chain = chains.get(media) ?? (needsChain() ? chainFor(media) : null)
  if (!chain || !ctx) return

  const t = ctx.currentTime
  if (Math.abs(chain.room - fx.room) > 0.01) {
    chain.verb.buffer = impulse(fx.room)
    chain.room = fx.room
  }
  // Equal-power blend, so turning reverb up does not just make it louder.
  chain.dry.gain.setTargetAtTime(Math.cos((fx.reverb * Math.PI) / 2) * 0.35 + 0.65, t, 0.05)
  chain.wet.gain.setTargetAtTime(Math.sin((fx.reverb * Math.PI) / 2) * 0.9, t, 0.05)
  chain.bass.gain.setTargetAtTime(fx.bass * 14, t, 0.05)
  if (ctx.state === 'suspended') void ctx.resume()
}

function mediaElements(): HTMLMediaElement[] {
  return [...document.querySelectorAll<HTMLMediaElement>('video, audio')]
}

function report(): void {
  const media = mediaElements()
  const status: AudioFxReport = {
    hasMedia: media.length > 0,
    // Reverb and bass are out of reach on at least one player here.
    limited: needsChain() && media.some((element) => blocked.has(element))
  }
  void ipcRenderer.invoke('fx:report', status)
}

function applyAll(): void {
  for (const media of mediaElements()) applyTo(media)
  report()
}

/** Players fight back: many reset the speed when a track changes. */
function keepSpeed(event: Event): void {
  const media = event.target
  if (!(media instanceof HTMLMediaElement)) return
  if (fx.speed !== 1 || chains.has(media) || needsChain()) applyTo(media)
}

export function watchAudio(): void {
  ipcRenderer.on('fx:apply', (_event, next: AudioFx) => {
    fx = { ...NEUTRAL_FX, ...next }
    applyAll()
  })

  // Media events do not bubble, but they do pass through the capture phase.
  for (const type of ['play', 'loadedmetadata', 'ratechange']) {
    document.addEventListener(type, keepSpeed, true)
  }

  // A site this was turned on for, or a tab it was already on in.
  void ipcRenderer.invoke('fx:initial').then((initial: AudioFx | null) => {
    if (!initial) return
    fx = { ...NEUTRAL_FX, ...initial }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', applyAll, { once: true })
    else applyAll()
  })
}
