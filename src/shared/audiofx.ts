/** The audio effects tool's settings for one tab. */
export interface AudioFx {
  /** Playback speed, 0.5 to 1.5. */
  speed: number
  /** Keep the pitch when the speed changes. Off gives the slowed, deeper sound. */
  keepPitch: boolean
  /** Reverb mix, 0 to 1. */
  reverb: number
  /** Room size, 0 (small room) to 1 (hall). */
  room: number
  /** Bass boost, 0 to 1. */
  bass: number
}

export interface AudioFxPreset extends AudioFx {
  name: string
}

/** What the page found when it applied the effects. */
export interface AudioFxReport {
  hasMedia: boolean
  /** A player here cannot have its sound processed: speed works, reverb and bass do not. */
  limited: boolean
}

/** What the toolbar panel needs about the tab in front. */
export interface AudioFxState {
  origin: string
  fx: AudioFx
  /** The settings come back every time this site is opened. */
  remembered: boolean
  report: AudioFxReport | null
}

export const NEUTRAL_FX: AudioFx = { speed: 1, keepPitch: true, reverb: 0, room: 0.5, bass: 0 }

export const BUILT_IN_FX_PRESETS: AudioFxPreset[] = [
  { name: 'Slowed + Reverb', speed: 0.8, keepPitch: false, reverb: 0.4, room: 0.65, bass: 0.15 },
  { name: 'Nightcore', speed: 1.25, keepPitch: false, reverb: 0, room: 0.5, bass: 0.1 },
  { name: 'Off', ...NEUTRAL_FX }
]

export function isNeutral(fx: AudioFx): boolean {
  return fx.speed === 1 && fx.reverb === 0 && fx.bass === 0
}

/** Anything from outside, clamped into range. */
export function cleanFx(value: Partial<AudioFx> | null | undefined): AudioFx {
  const num = (input: unknown, min: number, max: number, fallback: number): number => {
    const n = Number(input)
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
  }
  return {
    speed: num(value?.speed, 0.5, 1.5, 1),
    keepPitch: value?.keepPitch === undefined ? true : Boolean(value.keepPitch),
    reverb: num(value?.reverb, 0, 1, 0),
    room: num(value?.room, 0, 1, 0.5),
    bass: num(value?.bass, 0, 1, 0)
  }
}
