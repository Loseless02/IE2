/**
 * A small HSV colour picker: a saturation/value field with a draggable dot, a
 * hue strip, a hex box, and the user's own saved swatches.
 *
 * No canvas and no dependencies — the field is two stacked CSS gradients, and
 * the dot position is read straight back out as saturation and value.
 */

export interface ColourPickerOptions {
  value: string
  /** Fires continuously while dragging. */
  onChange: (hex: string) => void
  /** Fires when a drag ends or a value is committed — the point to persist. */
  onCommit: (hex: string) => void
}

interface Hsv {
  h: number
  s: number
  v: number
}

export function hexToHsv(hex: string): Hsv {
  const r = parseInt(hex.slice(1, 3), 16) / 255
  const g = parseInt(hex.slice(3, 5), 16) / 255
  const b = parseInt(hex.slice(5, 7), 16) / 255

  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const delta = max - min

  let h = 0
  if (delta !== 0) {
    if (max === r) h = ((g - b) / delta) % 6
    else if (max === g) h = (b - r) / delta + 2
    else h = (r - g) / delta + 4
  }

  // Hue stays fractional. Rounding it to whole degrees shifts channels by up to
  // 1/255, so a colour typed in as #4f8cff would come back out as #4f8dff.
  h *= 60
  if (h < 0) h += 360

  return { h, s: max === 0 ? 0 : delta / max, v: max }
}

export function hsvToHex({ h, s, v }: Hsv): string {
  const c = v * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = v - c

  const [r, g, b] =
    h < 60
      ? [c, x, 0]
      : h < 120
        ? [x, c, 0]
        : h < 180
          ? [0, c, x]
          : h < 240
            ? [0, x, c]
            : h < 300
              ? [x, 0, c]
              : [c, 0, x]

  const byte = (n: number): string =>
    Math.round((n + m) * 255)
      .toString(16)
      .padStart(2, '0')

  return `#${byte(r)}${byte(g)}${byte(b)}`
}

/** Readable text colour for a swatch, so labels never vanish into it. */
export function contrastOn(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  // Perceived brightness, the usual weighting.
  return (r * 299 + g * 587 + b * 114) / 1000 > 140 ? '#101216' : '#ffffff'
}

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n)

export function createColourPicker(options: ColourPickerOptions): {
  element: HTMLElement
  set: (hex: string) => void
} {
  let hsv = hexToHsv(options.value)

  const wrap = document.createElement('div')
  wrap.className = 'picker'

  // Saturation / value field.
  const field = document.createElement('div')
  field.className = 'picker-field'
  const dot = document.createElement('div')
  dot.className = 'picker-dot'
  field.append(dot)

  // Hue strip.
  const hue = document.createElement('div')
  hue.className = 'picker-hue'
  const hueDot = document.createElement('div')
  hueDot.className = 'picker-dot'
  hue.append(hueDot)

  // Hex entry plus a live preview of the current colour.
  const row = document.createElement('div')
  row.className = 'picker-row'

  const preview = document.createElement('div')
  preview.className = 'picker-preview'

  const input = document.createElement('input')
  input.type = 'text'
  input.spellcheck = false
  input.maxLength = 7
  input.className = 'picker-hex'

  row.append(preview, input)
  wrap.append(field, hue, row)

  const paint = (): void => {
    const hex = hsvToHex(hsv)

    field.style.background = `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, ${hsvToHex(
      { h: hsv.h, s: 1, v: 1 }
    )})`
    dot.style.left = `${hsv.s * 100}%`
    dot.style.top = `${(1 - hsv.v) * 100}%`
    dot.style.background = hex

    hueDot.style.left = `${(hsv.h / 360) * 100}%`
    hueDot.style.top = '50%'
    hueDot.style.background = hsvToHex({ h: hsv.h, s: 1, v: 1 })

    preview.style.background = hex
    if (document.activeElement !== input) input.value = hex
  }

  /** Pointer position within an element, as 0–1 on both axes. */
  const ratio = (element: HTMLElement, event: PointerEvent): { x: number; y: number } => {
    const box = element.getBoundingClientRect()
    return {
      x: clamp01((event.clientX - box.left) / box.width),
      y: clamp01((event.clientY - box.top) / box.height)
    }
  }

  const drag = (element: HTMLElement, apply: (at: { x: number; y: number }) => void): void => {
    element.addEventListener('pointerdown', (event) => {
      element.setPointerCapture(event.pointerId)
      apply(ratio(element, event))
      paint()
      options.onChange(hsvToHex(hsv))

      const move = (moved: PointerEvent): void => {
        apply(ratio(element, moved))
        paint()
        options.onChange(hsvToHex(hsv))
      }

      const up = (): void => {
        element.removeEventListener('pointermove', move)
        element.removeEventListener('pointerup', up)
        options.onCommit(hsvToHex(hsv))
      }

      element.addEventListener('pointermove', move)
      element.addEventListener('pointerup', up)
    })
  }

  drag(field, (at) => {
    hsv = { ...hsv, s: at.x, v: 1 - at.y }
  })

  drag(hue, (at) => {
    hsv = { ...hsv, h: at.x * 360 }
  })

  const commitTyped = (): void => {
    const text = input.value.trim()
    const withHash = text.startsWith('#') ? text : `#${text}`

    if (/^#[0-9a-fA-F]{6}$/.test(withHash)) {
      hsv = hexToHsv(withHash.toLowerCase())
      paint()
      options.onCommit(hsvToHex(hsv))
    } else {
      // Not a colour: put the current value back rather than leaving it broken.
      paint()
    }
  }

  input.addEventListener('change', commitTyped)
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') commitTyped()
  })

  paint()

  return {
    element: wrap,
    set: (hex: string) => {
      hsv = hexToHsv(hex)
      paint()
    }
  }
}
