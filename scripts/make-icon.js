// Generates build/icon.ico with no image libraries: a hand-rolled PNG encoder
// (zlib is in Node) wrapped in an ICO container holding one PNG per size.
const zlib = require('node:zlib')
const fs = require('node:fs')
const path = require('node:path')

// --- CRC32 / PNG ------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typeAndData))
  return Buffer.concat([len, typeAndData, crc])
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // truecolour with alpha
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  // One filter byte (0 = None) per scanline.
  const raw = Buffer.alloc(height * (width * 4 + 1))
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

// --- Drawing ----------------------------------------------------------------

const BG = [27, 29, 33]
const BLUE = [79, 140, 255]
const VIOLET = [125, 91, 214]

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)
// Smooth 0..1 ramp, used everywhere instead of hard edges so the shapes are
// antialiased rather than jagged.
const smooth = (edge0, edge1, x) => {
  const t = clamp01((x - edge0) / (edge1 - edge0))
  return t * t * (3 - 2 * t)
}

function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

/** Signed distance to a rounded square, in normalised -1..1 space. */
function roundedSquare(x, y, half, radius) {
  const dx = Math.abs(x) - (half - radius)
  const dy = Math.abs(y) - (half - radius)
  const ax = Math.max(dx, 0)
  const ay = Math.max(dy, 0)
  return Math.sqrt(ax * ax + ay * ay) + Math.min(Math.max(dx, dy), 0) - radius
}

/** Signed distance to a thick line segment with round caps. */
function segment(x, y, ax, ay, bx, by, thickness) {
  const pax = x - ax
  const pay = y - ay
  const bax = bx - ax
  const bay = by - ay

  const h = clamp01((pax * bax + pay * bay) / (bax * bax + bay * bay))
  const dx = pax - bax * h
  const dy = pay - bay * h

  return Math.sqrt(dx * dx + dy * dy) - thickness
}

/**
 * The mark: a bold numeral 2.
 *
 * It used to be a tilted ring with a crossbar, described in this file as "an
 * 'e' if you are feeling charitable" — which was the problem. A blue swoosh-e
 * on a browser icon is the one shape this project should not go near, whatever
 * the README says underneath it, and as a piece of design it read as a generic
 * orbit that said nothing about what the app is.
 *
 * A numeral survives being 16 pixels wide, which almost nothing else does, and
 * it carries the joke on its own: the sequel nobody asked for.
 */
/**
 * The numeral, drawn in its own space so it can be placed and scaled: on its
 * own it fills the tile, and in the wordmark it sits beside the letters.
 *
 * Local space is roughly -0.5..0.5 wide and -0.72..0.72 tall.
 */
function two(px, py, t) {
  const cy = -0.219
  const r = 0.373

  const ringDist = Math.abs(Math.sqrt(px * px + (py - cy) ** 2) - r) - t

  // Keep the ring across the top, and down the right as far as the shoulder —
  // but no further. Left to run on, the bottom of the ring curves back towards
  // the middle and collides with the diagonal, which puts a notch in the side
  // of the numeral.
  const keep = Math.min(py - (cy + 0.02), Math.max(0.04 - px, py - (cy + 0.3)))
  const arc = Math.max(ringDist, keep)

  // The diagonal picks up exactly where the bowl was cut, then the base.
  const diagonal = segment(px, py, 0.221, 0.081, -0.339, 0.572, t)
  const base = segment(px, py, -0.373, 0.595, 0.373, 0.595, t)

  return Math.min(arc, diagonal, base)
}

/** A capital I: one stem. */
function letterI(px, py, h, t) {
  return segment(px, py, 0, -h, 0, h, t)
}

/** A capital E: a stem and three arms. */
function letterE(px, py, h, w, t) {
  const stem = segment(px, py, -w, -h, -w, h, t)
  const top = segment(px, py, -w, -h, w, -h, t)
  const mid = segment(px, py, -w, 0, w * 0.82, 0, t)
  const bottom = segment(px, py, -w, h, w, h, t)
  return Math.min(stem, top, mid, bottom)
}

/**
 * The wordmark: I E 2 on one line.
 *
 * The three are positioned from their outer edges rather than their centres,
 * so the gaps between them are equal. Spacing them by centre put the I and the
 * E almost touching while the 2 drifted off on its own.
 */
function markIE2(x, y) {
  const t = 0.058
  const h = 0.3 // cap half-height
  const scale = h / 0.72 // the numeral is 0.72 tall in its own space
  const ew = 0.17 // half-width of the E's arms

  const iHalf = t
  const eHalf = ew + t
  const nHalf = 0.373 * scale + t

  const gap = 0.1
  const total = iHalf * 2 + eHalf * 2 + nHalf * 2 + gap * 2
  let cursor = -total / 2

  const ix = cursor + iHalf
  cursor += iHalf * 2 + gap
  const ex = cursor + eHalf
  cursor += eHalf * 2 + gap
  const nx = cursor + nHalf

  return Math.min(
    letterI(x - ix, y, h, t),
    letterE(x - ex, y, h, ew, t),
    two((x - nx) / scale, y / scale, t / scale) * scale
  )
}

/** The numeral alone, filling the tile. */
function markTwo(x, y) {
  return two(x, y, 0.13)
}

const MARKS = { two: markTwo, ie2: markIE2 }

/**
 * Which mark a given size gets.
 *
 * An .ico holds several images and nothing requires them to be the same
 * drawing, so the small ones are allowed to be simpler. Below 32 pixels the
 * wordmark stops being a wordmark: the arms of the E merge into a bar and the
 * numeral collapses into a wedge. The numeral alone stays legible all the way
 * down, so that is what the taskbar and the file lists get.
 */
function markForSize(size, requested) {
  if (requested !== 'auto') return requested
  return size >= 32 ? 'ie2' : 'two'
}

function sample(x, y, mark) {
  const px = 2 / 256 // one output pixel in normalised units, for edge softness

  // Plate
  const plate = roundedSquare(x, y, 0.98, 0.42)
  const plateAlpha = 1 - smooth(-px * 1.5, px * 1.5, plate)

  let rgb = BG
  let alpha = plateAlpha

  const sdf = (MARKS[mark] ?? markTwo)(x, y)
  const glyph = 1 - smooth(-px * 1.5, px * 1.5, sdf)

  if (glyph > 0) {
    // Gradient across the mark so it does not look like flat clip-art.
    const g = clamp01((x + y + 1.2) / 2.4)
    rgb = mix(rgb, mix(BLUE, VIOLET, g), glyph * plateAlpha)
    alpha = Math.max(alpha, glyph * plateAlpha)
  }

  return [rgb[0], rgb[1], rgb[2], alpha * 255]
}

function rasterise(size, mark) {
  const rgba = Buffer.alloc(size * size * 4)
  const SS = 3 // supersampling factor

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0

      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const nx = ((x + (sx + 0.5) / SS) / size) * 2 - 1
          const ny = ((y + (sy + 0.5) / SS) / size) * 2 - 1
          const [pr, pg, pb, pa] = sample(nx, ny, mark)
          const w = pa / 255
          r += pr * w
          g += pg * w
          b += pb * w
          a += pa
        }
      }

      const n = SS * SS
      const aw = a / n / 255
      const i = (y * size + x) * 4
      // Un-premultiply so edges do not darken against a light background.
      rgba[i] = aw > 0 ? Math.round(r / n / aw) : 0
      rgba[i + 1] = aw > 0 ? Math.round(g / n / aw) : 0
      rgba[i + 2] = aw > 0 ? Math.round(b / n / aw) : 0
      rgba[i + 3] = Math.round(a / n)
    }
  }

  return rgba
}

function render(size, mark) {
  return encodePng(size, size, rasterise(size, mark))
}

/**
 * Blow one of the small sizes up with pixel replication, so what the taskbar
 * actually shows can be looked at rather than guessed. Legibility at 16 pixels
 * is the whole question for an app icon, and it cannot be judged from the 256.
 */
function preview(size, mark, factor) {
  const small = rasterise(size, mark)
  const big = size * factor
  const out = Buffer.alloc(big * big * 4)

  for (let y = 0; y < big; y++) {
    for (let x = 0; x < big; x++) {
      const src = (Math.floor(y / factor) * size + Math.floor(x / factor)) * 4
      const dst = (y * big + x) * 4
      small.copy(out, dst, src, src + 4)
    }
  }

  return encodePng(big, big, out)
}

// --- ICO container ----------------------------------------------------------

function buildIco(images) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(images.length, 4)

  const entries = []
  let offset = 6 + images.length * 16

  for (const { size, png } of images) {
    const entry = Buffer.alloc(16)
    entry[0] = size >= 256 ? 0 : size // 0 means 256
    entry[1] = size >= 256 ? 0 : size
    entry[2] = 0 // palette size
    entry[3] = 0 // reserved
    entry.writeUInt16LE(1, 4) // colour planes
    entry.writeUInt16LE(32, 6) // bits per pixel
    entry.writeUInt32LE(png.length, 8)
    entry.writeUInt32LE(offset, 12)
    entries.push(entry)
    offset += png.length
  }

  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)])
}

const outDir = process.argv[2]
fs.mkdirSync(outDir, { recursive: true })

/**
 * Which mark to draw. `auto` (the default) uses the wordmark at the sizes that
 * can carry it and the numeral below that; `two` or `ie2` force one throughout.
 */
const markArg = process.argv.find((arg) => arg.startsWith('--mark='))
const mark = markArg ? markArg.slice('--mark='.length) : 'auto'

if (mark !== 'auto' && !MARKS[mark]) {
  console.error(`Unknown mark "${mark}". Choose one of: auto, ${Object.keys(MARKS).join(', ')}`)
  process.exit(1)
}

// `--preview` writes magnified copies of the small sizes instead of an icon,
// for judging legibility where it actually matters.
if (process.argv.includes('--preview')) {
  for (const size of [16, 24, 32]) {
    const file = path.join(outDir, `preview-${mark}-${size}.png`)
    fs.writeFileSync(file, preview(size, markForSize(size, mark), 12))
    console.log(`wrote ${file}`)
  }
  process.exit(0)
}

const sizes = [16, 24, 32, 48, 64, 128, 256]
const images = sizes.map((size) => ({ size, png: render(size, markForSize(size, mark)) }))

// The icon is committed artwork now, not a build product, so this refuses to
// overwrite an existing one. It remains useful for bootstrapping a placeholder
// on a fresh checkout, or for regenerating deliberately with --force.
const icoPath = path.join(outDir, 'icon.ico')

if (fs.existsSync(icoPath) && !process.argv.includes('--force')) {
  console.log(`${icoPath} already exists — left alone.`)
  console.log('Pass --force to overwrite it with the generated placeholder.')
  process.exit(0)
}

fs.writeFileSync(icoPath, buildIco(images))
fs.writeFileSync(path.join(outDir, 'icon.png'), images[images.length - 1].png)

console.log('wrote icon.ico with sizes ' + sizes.join(', '))
console.log('ico bytes ' + fs.statSync(path.join(outDir, 'icon.ico')).size)
