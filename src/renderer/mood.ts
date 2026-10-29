/**
 * Mood: rain, wind, thunder and crickets, mixed from layers like a noise
 * machine, playing behind whatever is being read.
 *
 * Every layer is generated here with Web Audio — filtered noise, scheduled
 * drops, synthesised thunder — so nothing is downloaded, nothing needs a
 * licence, and nothing repeats. Recorded layers can be added later as files in
 * `public/sounds/`; any that are listed but missing simply do not appear.
 *
 * It lives in the chrome window, so it keeps playing with its panel closed.
 */

export interface MoodLayer {
  id: string
  name: string
  /** Generated here, or a recording shipped with the browser. */
  source: 'gen' | 'rec'
}

interface Running {
  stop: () => void
  hit?: () => void
}

interface Layer extends MoodLayer {
  make: (dest: GainNode) => Running | Promise<Running>
  /** Loudness balance, measured, so equal slider positions sound about equal. */
  trim: number
  gain: GainNode | null
  handle: Running | null
  /** Slow drift for Animate, unique per layer so they never move together. */
  drift: { f1: number; f2: number; p1: number; p2: number }
}

export interface MoodState {
  playing: boolean
  animate: boolean
  master: number
  thunderRate: number
  levels: Record<string, number>
}

const rand = (a: number, b: number): number => a + Math.random() * (b - a)

let ctx: AudioContext | null = null
let master: GainNode | null = null
let white: AudioBuffer | null = null
let brown: AudioBuffer | null = null
let verbBuffer: AudioBuffer | null = null
let thunderRate = 0.4

function audio(): AudioContext {
  if (ctx) return ctx

  ctx = new AudioContext()
  // Thunder on top of heavy rain can sum past full scale; this keeps it clean.
  const comp = ctx.createDynamicsCompressor()
  comp.threshold.value = -12
  comp.ratio.value = 4
  master = ctx.createGain()
  master.gain.value = 0
  master.connect(comp).connect(ctx.destination)

  white = noise('white')
  brown = noise('brown')

  const n = ctx.sampleRate * 4
  verbBuffer = ctx.createBuffer(2, n, ctx.sampleRate)
  for (let ch = 0; ch < 2; ch++) {
    const data = verbBuffer.getChannelData(ch)
    for (let i = 0; i < n; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 3)
  }
  return ctx
}

/** Crossfade the tail into the head so the buffer loops with no audible seam. */
function loopify(buffer: AudioBuffer, seconds: number): AudioBuffer {
  const ac = audio()
  const fade = Math.min(Math.floor(buffer.sampleRate * seconds), Math.floor(buffer.length / 3))
  const length = buffer.length - fade
  const out = ac.createBuffer(buffer.numberOfChannels, length, buffer.sampleRate)

  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const source = buffer.getChannelData(ch)
    const data = out.getChannelData(ch)
    data.set(source.subarray(0, length))
    for (let i = 0; i < fade; i++) {
      const x = i / fade
      data[i] = source[i] * Math.sqrt(x) + source[length + i] * Math.sqrt(1 - x)
    }
  }
  return out
}

function noise(kind: 'white' | 'brown'): AudioBuffer {
  const ac = ctx as AudioContext
  const n = ac.sampleRate * 7
  const buffer = ac.createBuffer(2, n, ac.sampleRate)

  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch)
    let last = 0
    for (let i = 0; i < n; i++) {
      const w = Math.random() * 2 - 1
      if (kind === 'brown') {
        last = (last + 0.02 * w) / 1.02
        data[i] = last * 3.5
      } else {
        data[i] = w
      }
    }
  }
  return loopify(buffer, 1)
}

function loop(buffer: AudioBuffer): AudioBufferSourceNode {
  const source = audio().createBufferSource()
  source.buffer = buffer
  source.loop = true
  source.start(0, Math.random() * buffer.duration)
  return source
}

/** Call fn now, then again after however many milliseconds it returns. */
function repeat(fn: () => number): () => void {
  let alive = true
  let timer: number | undefined
  const tick = (): void => {
    if (alive) timer = window.setTimeout(tick, fn())
  }
  tick()
  return () => {
    alive = false
    window.clearTimeout(timer)
  }
}

// --- the layers ------------------------------------------------------------

function drop(dest: AudioNode, low: number, high: number): void {
  const ac = audio()
  const t = ac.currentTime
  const source = ac.createBufferSource()
  const filter = ac.createBiquadFilter()
  const gain = ac.createGain()
  const pan = ac.createStereoPanner()

  source.buffer = white
  filter.type = 'bandpass'
  filter.frequency.value = rand(low, high)
  filter.Q.value = rand(8, 18)
  pan.pan.value = rand(-1, 1)
  gain.gain.setValueAtTime(rand(0.3, 1), t)
  gain.gain.exponentialRampToValueAtTime(0.001, t + rand(0.02, 0.07))

  source.connect(filter).connect(gain).connect(pan).connect(dest)
  source.start(t, rand(0, 5), 0.1)
}

function rainBed(heavy: boolean): (dest: GainNode) => Running {
  return (dest) => {
    const ac = audio()
    const hiss = loop(white as AudioBuffer)
    const hissFilter = ac.createBiquadFilter()
    const hissGain = ac.createGain()
    hissFilter.type = 'bandpass'
    hissFilter.frequency.value = heavy ? 4200 : 5200
    hissFilter.Q.value = 0.5
    hissGain.gain.value = heavy ? 0.3 : 0.18
    hiss.connect(hissFilter).connect(hissGain).connect(dest)

    const wash = loop(brown as AudioBuffer)
    const washFilter = ac.createBiquadFilter()
    washFilter.type = 'lowpass'
    washFilter.frequency.value = heavy ? 2200 : 1400
    wash.connect(washFilter).connect(dest)

    const rate = heavy ? 75 : 30
    const stop = repeat(() => {
      drop(dest, 1800, 7000)
      return (-Math.log(Math.random()) / rate) * 1000
    })
    return {
      stop: () => {
        stop()
        hiss.stop()
        wash.stop()
      }
    }
  }
}

function plink(dest: AudioNode): void {
  const ac = audio()
  const t = ac.currentTime + 0.01
  const osc = ac.createOscillator()
  const gain = ac.createGain()
  const pan = ac.createStereoPanner()
  const f = rand(450, 1300)

  // A water drop rises in pitch as the bubble it makes closes.
  osc.frequency.setValueAtTime(f, t)
  osc.frequency.exponentialRampToValueAtTime(f * 1.9, t + 0.045)
  gain.gain.setValueAtTime(0, t)
  gain.gain.linearRampToValueAtTime(rand(0.25, 0.6), t + 0.003)
  gain.gain.exponentialRampToValueAtTime(0.001, t + rand(0.06, 0.14))
  pan.pan.value = rand(-0.8, 0.8)

  osc.connect(gain).connect(pan).connect(dest)
  osc.start(t)
  osc.stop(t + 0.2)
}

function drips(dest: GainNode): Running {
  // Gutters drip in bursts: sometimes a quick double, sometimes a long gap.
  return { stop: repeat(() => (plink(dest), Math.random() < 0.3 ? rand(110, 300) : rand(300, 1700))) }
}

function wind(dest: GainNode): Running {
  const ac = audio()
  const body = loop(brown as AudioBuffer)
  const band = ac.createBiquadFilter()
  const gain = ac.createGain()
  band.type = 'bandpass'
  band.Q.value = 0.8
  band.frequency.value = 400
  body.connect(band).connect(gain).connect(dest)

  const whistle = loop(white as AudioBuffer)
  const whistleFilter = ac.createBiquadFilter()
  const whistleGain = ac.createGain()
  whistleFilter.type = 'bandpass'
  whistleFilter.Q.value = 18
  whistleFilter.frequency.value = 900
  whistleGain.gain.value = 0.02
  whistle.connect(whistleFilter).connect(whistleGain).connect(dest)

  const stop = repeat(() => {
    const t = ac.currentTime
    const span = rand(2, 6)
    band.frequency.setTargetAtTime(rand(250, 850), t, span / 2)
    gain.gain.setTargetAtTime(rand(0.4, 1.6), t, span / 2)
    whistleFilter.frequency.setTargetAtTime(rand(600, 1500), t, span / 2)
    whistleGain.gain.setTargetAtTime(rand(0, 0.05), t, span / 2)
    return span * 1000
  })
  return {
    stop: () => {
      stop()
      body.stop()
      whistle.stop()
    }
  }
}

function rumble(dest: GainNode): Running {
  const ac = audio()
  const source = loop(brown as AudioBuffer)
  const low = ac.createBiquadFilter()
  const gain = ac.createGain()
  low.type = 'lowpass'
  low.frequency.value = 110
  source.connect(low).connect(gain).connect(dest)

  const stop = repeat(() => {
    const t = ac.currentTime
    const span = rand(3, 9)
    gain.gain.setTargetAtTime(rand(0.5, 1.6), t, span / 2)
    low.frequency.setTargetAtTime(rand(70, 160), t, span / 2)
    return span * 1000
  })
  return {
    stop: () => {
      stop()
      source.stop()
    }
  }
}

/** One thunder strike. dist 0 is overhead, 1 is far away. */
function strike(dest: AudioNode, verb: AudioNode, dist: number): void {
  const ac = audio()
  const t = ac.currentTime + 0.05
  const length = rand(4, 9) + dist * 3
  const pan = ac.createStereoPanner()
  pan.pan.value = rand(-0.7, 0.7)
  pan.connect(dest)
  pan.connect(verb)

  if (dist < 0.45) {
    // Close: a low tearing crackle of many tiny bursts. One clean high hiss
    // here reads as a hi-hat, not as lightning.
    const filter = ac.createBiquadFilter()
    const gain = ac.createGain()
    const span = rand(0.35, 0.8)
    filter.type = 'lowpass'
    filter.frequency.value = 1800
    gain.gain.value = 1.2 * (1 - dist)
    filter.connect(gain).connect(pan)

    for (let k = 0; k < 30; k++) {
      const source = ac.createBufferSource()
      const env = ac.createGain()
      const at = t + Math.pow(Math.random(), 1.5) * span
      source.buffer = white
      env.gain.setValueAtTime(0, at)
      env.gain.linearRampToValueAtTime(rand(0.2, 0.8) * (1 - (0.6 * (at - t)) / span), at + 0.004)
      env.gain.exponentialRampToValueAtTime(0.001, at + rand(0.02, 0.08))
      source.connect(env).connect(filter)
      source.start(at, rand(0, 5), 0.1)
    }
  }

  const roll = ac.createBufferSource()
  const low = ac.createBiquadFilter()
  const gain = ac.createGain()
  roll.buffer = brown
  roll.loop = true
  low.type = 'lowpass'
  low.frequency.setValueAtTime(900 - dist * 600, t)
  low.frequency.exponentialRampToValueAtTime(90, t + length)

  const peak = 1.6 - dist * 0.9
  const attack = 0.08 + dist * 0.6
  gain.gain.setValueAtTime(0.0001, t)
  gain.gain.exponentialRampToValueAtTime(peak, t + attack)
  let at = t + attack
  while (at < t + length * 0.7) {
    at += rand(0.4, 1.6)
    gain.gain.exponentialRampToValueAtTime(peak * rand(0.25, 0.75) * (1 - (at - t) / length) + 0.001, at)
  }
  gain.gain.exponentialRampToValueAtTime(0.0001, t + length)

  roll.connect(low).connect(gain).connect(pan)
  roll.start(t, rand(0, 5))
  roll.stop(t + length + 0.1)
}

function thunder(near: boolean): (dest: GainNode) => Running {
  return (dest) => {
    const ac = audio()
    const verb = ac.createConvolver()
    const wet = ac.createGain()
    verb.buffer = verbBuffer
    wet.gain.value = near ? 0.35 : 0.6
    verb.connect(wet).connect(dest)

    const hit = (): void => strike(dest, verb, near ? rand(0, 0.4) : rand(0.5, 1))
    let first = true
    const stop = repeat(() => {
      if (first) {
        first = false
        return rand(1500, 5000)
      }
      hit()
      // Seconds between strikes, from rare to frequent.
      const mean = near ? 60 - thunderRate * 48 : 40 - thunderRate * 33
      return mean * rand(0.4, 1.6) * 1000
    })
    return { stop, hit }
  }
}

/** One species: the crickets share a pitch (one sings a few % higher), in bouts with long rests. */
function crickets(dest: GainNode): Running {
  const ac = audio()
  const low = ac.createBiquadFilter()
  const verb = ac.createConvolver()
  const wet = ac.createGain()
  low.type = 'lowpass'
  low.frequency.value = 6500
  low.connect(dest)
  verb.buffer = verbBuffer
  wet.gain.value = 0.15
  low.connect(verb)
  verb.connect(wet).connect(dest)

  const pitch = rand(4200, 4500)
  const bugs = [1, 1.03, 1].map((ratio, i) => {
    const osc = ac.createOscillator()
    const gain = ac.createGain()
    const pan = ac.createStereoPanner()
    osc.frequency.value = pitch * ratio
    gain.gain.value = 0
    pan.pan.value = [-0.6, 0.5, 0.1][i]
    osc.connect(gain).connect(pan).connect(low)
    osc.start()
    return {
      osc,
      gain,
      f: pitch * ratio,
      period: rand(1.2, 1.8),
      volume: [0.12, 0.08, 0.04][i],
      singing: i === 0,
      until: ac.currentTime + rand(3, 10),
      next: ac.currentTime + rand(0.3, 2)
    }
  })

  const stop = repeat(() => {
    const horizon = ac.currentTime + 0.6
    for (const bug of bugs) {
      while (bug.next < horizon) {
        if (bug.next >= bug.until) {
          bug.singing = !bug.singing
          bug.until = bug.next + (bug.singing ? rand(5, 15) : rand(6, 25))
        }
        if (!bug.singing) {
          bug.next = bug.until
          continue
        }
        for (let k = 0; k < 3; k++) {
          const t = bug.next + k * 0.045
          bug.gain.gain.setValueAtTime(0, t)
          bug.gain.gain.linearRampToValueAtTime(bug.volume, t + 0.008)
          bug.gain.gain.linearRampToValueAtTime(0, t + 0.03)
          bug.osc.frequency.setValueAtTime(bug.f * 1.01, t)
          bug.osc.frequency.linearRampToValueAtTime(bug.f, t + 0.03)
        }
        bug.next += bug.period * rand(0.95, 1.05)
      }
    }
    return 250
  })
  return {
    stop: () => {
      stop()
      for (const bug of bugs) bug.osc.stop()
    }
  }
}

/** A recording shipped in public/sounds, looped with a crossfade. */
const decoded = new Map<string, Promise<AudioBuffer>>()
function recorded(file: string): (dest: GainNode) => Promise<Running> {
  return async (dest) => {
    if (!decoded.has(file)) {
      decoded.set(
        file,
        fetch(`./sounds/${file}`)
          .then((response) => {
            if (!response.ok) throw new Error(String(response.status))
            return response.arrayBuffer()
          })
          .then((bytes) => audio().decodeAudioData(bytes))
          .then((buffer) => loopify(buffer, 2))
      )
    }
    const source = loop(await (decoded.get(file) as Promise<AudioBuffer>))
    source.connect(dest)
    return { stop: () => source.stop() }
  }
}

const drift = (): Layer['drift'] => ({
  f1: 1 / rand(15, 45),
  f2: 1 / rand(40, 100),
  p1: rand(0, 6.3),
  p2: rand(0, 6.3)
})

/** Recordings that may ship in public/sounds. Missing files are left out. */
const RECORDINGS: { id: string; name: string; file: string; trim: number }[] = [
  { id: 'rec-window', name: 'Rain on window', file: 'rain-window.ogg', trim: 3.4 },
  { id: 'rec-close', name: 'Close rain', file: 'rain-close.ogg', trim: 7 }
]

const LAYERS: Layer[] = [
  { id: 'rain', name: 'Rain', source: 'gen', make: rainBed(false), trim: 0.5 },
  { id: 'downpour', name: 'Downpour', source: 'gen', make: rainBed(true), trim: 0.45 },
  { id: 'drips', name: 'Roof drips', source: 'gen', make: drips, trim: 2 },
  { id: 'wind', name: 'Wind', source: 'gen', make: wind, trim: 1.2 },
  { id: 'rumble', name: 'Low rumble', source: 'gen', make: rumble, trim: 0.9 },
  { id: 'far-thunder', name: 'Far thunder', source: 'gen', make: thunder(false), trim: 2 },
  { id: 'near-thunder', name: 'Close thunder', source: 'gen', make: thunder(true), trim: 1.8 },
  { id: 'crickets', name: 'Crickets', source: 'gen', make: crickets, trim: 2 }
].map((layer) => ({ ...layer, source: layer.source as 'gen', gain: null, handle: null, drift: drift() }))

/** Mixes, by layer id. Anything not named is silent. */
export const PRESETS: Record<string, Record<string, number>> = {
  'Gentle rain': { rain: 0.55, drips: 0.35, 'rec-window': 0.6 },
  'Summer night storm': {
    rain: 0.45,
    drips: 0.25,
    wind: 0.25,
    rumble: 0.35,
    'far-thunder': 0.55,
    'near-thunder': 0.3,
    crickets: 0.45,
    'rec-window': 0.4
  },
  'Heavy storm': {
    rain: 0.35,
    downpour: 0.7,
    wind: 0.55,
    rumble: 0.6,
    'far-thunder': 0.6,
    'near-thunder': 0.7,
    'rec-close': 0.6
  },
  'Distant storm': { rain: 0.4, drips: 0.15, wind: 0.3, rumble: 0.5, 'far-thunder': 0.7, crickets: 0.3 },
  'Just crickets': { crickets: 0.6, wind: 0.15 }
}

const STORAGE_KEY = 'ie2.mood'

const moodState: MoodState = {
  playing: false,
  animate: false,
  master: 0.7,
  thunderRate: 0.4,
  levels: { ...PRESETS['Summer night storm'] }
}

try {
  const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<MoodState> | null
  if (saved) {
    moodState.animate = Boolean(saved.animate)
    if (typeof saved.master === 'number') moodState.master = saved.master
    if (typeof saved.thunderRate === 'number') moodState.thunderRate = saved.thunderRate
    if (saved.levels && typeof saved.levels === 'object') moodState.levels = saved.levels
  }
} catch {
  // A missing or unreadable mix just starts from the default.
}
thunderRate = moodState.thunderRate

function persist(): void {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        animate: moodState.animate,
        master: moodState.master,
        thunderRate: moodState.thunderRate,
        levels: moodState.levels
      })
    )
  } catch {
    // Remembering the mix is a convenience, not worth failing over.
  }
}

/** Recordings that actually shipped, found once. */
let available: Promise<Layer[]> | null = null
export function moodLayers(): Promise<MoodLayer[]> {
  available ??= Promise.all(
    RECORDINGS.map(async (rec) => {
      try {
        const response = await fetch(`./sounds/${rec.file}`, { method: 'HEAD' })
        return response.ok ? rec : null
      } catch {
        return null
      }
    })
  ).then((found) => [
    ...found
      .filter((rec): rec is (typeof RECORDINGS)[number] => rec !== null)
      .map(
        (rec): Layer => ({
          id: rec.id,
          name: rec.name,
          source: 'rec',
          make: recorded(rec.file),
          trim: rec.trim,
          gain: null,
          handle: null,
          drift: drift()
        })
      ),
    ...LAYERS
  ])
  return available.then((layers) => layers.map(({ id, name, source }) => ({ id, name, source })))
}

export function getMood(): MoodState {
  return moodState
}

/** The level a layer is playing at right now, Animate's drift included. */
export function liveLevel(id: string): number {
  const base = moodState.levels[id] ?? 0
  if (!moodState.animate) return base
  const layer = allLayers.find((each) => each.id === id)
  if (!layer) return base
  const t = performance.now() / 1000
  const { f1, f2, p1, p2 } = layer.drift
  const m = 0.6 * Math.sin(2 * Math.PI * f1 * t + p1) + 0.4 * Math.sin(2 * Math.PI * f2 * t + p2)
  return Math.min(1, Math.max(0, base * (1 + 0.6 * m)))
}

let allLayers: Layer[] = []
let mixTimer: number | undefined

function applyLevels(): void {
  if (!ctx) return
  for (const layer of allLayers) {
    const v = liveLevel(layer.id)
    layer.gain?.gain.setTargetAtTime(v * v * layer.trim, ctx.currentTime, 0.15)
  }
}

export async function playMood(): Promise<void> {
  if (moodState.playing) return
  const ac = audio()
  await ac.resume()
  await moodLayers()
  allLayers = await (available as Promise<Layer[]>)

  moodState.playing = true
  master?.gain.cancelScheduledValues(ac.currentTime)
  master?.gain.setTargetAtTime(moodState.master ** 2, ac.currentTime, 0.3)

  for (const layer of allLayers) {
    const gain = ac.createGain()
    gain.gain.value = 0
    gain.connect(master as GainNode)
    layer.gain = gain
    const made = layer.make(gain)
    if (made instanceof Promise) {
      made
        .then((handle) => {
          if (layer.gain === gain) layer.handle = handle
          else handle.stop()
        })
        .catch(() => undefined)
    } else {
      layer.handle = made
    }
  }

  window.clearInterval(mixTimer)
  mixTimer = window.setInterval(applyLevels, 150)
  applyLevels()
}

export function stopMood(): void {
  if (!moodState.playing || !ctx) return
  moodState.playing = false
  window.clearInterval(mixTimer)
  window.clearTimeout(sleepTimer)
  sleepAt = 0

  const old = allLayers.map((layer) => [layer.handle, layer.gain] as const)
  for (const layer of allLayers) {
    layer.handle = null
    layer.gain = null
  }
  master?.gain.setTargetAtTime(0, ctx.currentTime, 0.1)
  window.setTimeout(() => {
    for (const [handle, gain] of old) {
      handle?.stop()
      gain?.disconnect()
    }
  }, 600)
}

export function setLevel(id: string, value: number): void {
  moodState.levels = { ...moodState.levels, [id]: value }
  applyLevels()
  persist()
}

export function setPreset(name: string): void {
  moodState.levels = { ...(PRESETS[name] ?? {}) }
  applyLevels()
  persist()
}

export function setMaster(value: number): void {
  moodState.master = value
  if (ctx && moodState.playing) master?.gain.setTargetAtTime(value ** 2, ctx.currentTime, 0.1)
  persist()
}

export function setAnimate(on: boolean): void {
  moodState.animate = on
  persist()
}

export function setThunderRate(value: number): void {
  moodState.thunderRate = value
  thunderRate = value
  persist()
}

/** Thunder right now, from whichever thunder layer is turned up. */
export async function thunderNow(): Promise<void> {
  if (!moodState.playing) await playMood()
  const near = allLayers.find((layer) => layer.id === 'near-thunder')
  const far = allLayers.find((layer) => layer.id === 'far-thunder')
  const pick = (moodState.levels['near-thunder'] ?? 0) > 0.05 ? near : far
  if (pick && (moodState.levels[pick.id] ?? 0) < 0.05) setLevel(pick.id, 0.5)
  pick?.handle?.hit?.()
}

// --- sleep timer ---

let sleepTimer: number | undefined
let sleepAt = 0

/** Fade out and stop after this many minutes; 0 turns the timer off. */
export function setSleepTimer(minutes: number, onStop: () => void): void {
  window.clearTimeout(sleepTimer)
  sleepAt = minutes > 0 ? Date.now() + minutes * 60_000 : 0
  if (!minutes) return

  sleepTimer = window.setTimeout(() => {
    if (ctx && master) master.gain.setTargetAtTime(0, ctx.currentTime, 3)
    sleepTimer = window.setTimeout(() => {
      stopMood()
      onStop()
    }, 10_000)
  }, minutes * 60_000)
}

/** When the sleep timer will stop playback, or 0 if it is off. */
export function sleepEndsAt(): number {
  return sleepAt
}
