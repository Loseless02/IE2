import type { ReaderArticle, ReaderBlock } from '../shared/types'

/**
 * Reader mode: the article, and nothing else on the page.
 *
 * The extraction returns **structured blocks**, not HTML. That is the whole
 * design: page markup is hostile input, and handing it to an internal page to
 * render would mean either `innerHTML` — which is how internal pages get
 * scripted — or sanitising it, which is a losing arms race. Blocks carry text
 * and image addresses only, and the reader rebuilds them with `textContent`,
 * so nothing a page contains can execute on the way through.
 */

/**
 * Runs in the page, in an isolated world.
 *
 * Finds where the page's text lives and keeps all of it, in order. Every block
 * of text — paragraphs, list items, and the plain text boxes many sites use
 * instead of paragraphs — counts toward the containers around it; the reader
 * takes the deepest container that holds nearly all of the page's text, or the
 * page's own <main>/<article> when that holds most of it. Navigation, footers,
 * comments and the like are left out by name.
 *
 * The first version scored only <p> elements sitting directly in one box, so a
 * page made of separate cards or sections came out as whichever card won, and
 * it skipped anything transparent — which is every section that fades in as
 * you scroll to it.
 */
const EXTRACT_SCRIPT = `(() => {
  const BAD = /(^|[\\s_-])(nav|navbar|menu|header|footer|sidebar|comment|comments|share|promo|advert|ad|ads|banner|related|recommend|subscribe|newsletter|cookie|consent|popup|modal|breadcrumb|pagination|social|widget|toolbar|skip)([\\s_-]|$)/i
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'FORM', 'NAV', 'FOOTER', 'ASIDE', 'SVG', 'BUTTON', 'IFRAME', 'TEMPLATE', 'DIALOG', 'SELECT', 'TEXTAREA', 'INPUT'])
  const INLINE = new Set(['A', 'B', 'I', 'EM', 'STRONG', 'SPAN', 'CODE', 'SMALL', 'BR', 'ABBR', 'MARK', 'SUP', 'SUB', 'IMG', 'TIME', 'KBD', 'S', 'U', 'Q', 'CITE', 'WBR', 'LABEL'])

  const badCache = new Map()
  const looksBad = (el) => {
    if (badCache.has(el)) return badCache.get(el)
    const id = el.id || ''
    const cls = typeof el.className === 'string' ? el.className : ''
    const role = el.getAttribute('role') || ''
    const bad =
      SKIP.has(el.tagName) ||
      BAD.test(id) || BAD.test(cls) ||
      role === 'navigation' || role === 'banner' || role === 'contentinfo' || role === 'complementary' ||
      el.getAttribute('aria-hidden') === 'true'
    badCache.set(el, bad)
    return bad
  }

  /** Inside something that is not content, at any depth. */
  const inBad = (el) => {
    for (let node = el; node && node !== document.body; node = node.parentElement) {
      if (looksBad(node)) return true
    }
    return false
  }

  const textOf = (el) => (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim()

  // Hidden for good, not hidden until scrolled to: opacity is deliberately not
  // checked, since scroll-reveal sections sit at zero until they are seen.
  const hidden = (el) => {
    const style = window.getComputedStyle(el)
    return style.display === 'none' || style.visibility === 'hidden'
  }

  /** A box whose children are all inline: its text is one block. */
  const leaf = (el) => [...el.children].every((child) => INLINE.has(child.tagName))

  const isTextBlock = (el) => {
    const tag = el.tagName
    if (tag === 'P' || tag === 'LI' || tag === 'PRE' || tag === 'BLOCKQUOTE' || tag === 'DD' || tag === 'FIGCAPTION' || /^H[1-6]$/.test(tag)) return true
    return (tag === 'DIV' || tag === 'SPAN' || tag === 'SECTION' || tag === 'TD') && leaf(el)
  }

  // --- where the text is ------------------------------------------------------
  const holds = new Map()
  let total = 0

  for (const el of document.body.querySelectorAll('*')) {
    if (!isTextBlock(el)) continue
    // Nested text blocks (a <p> in an <li>, a <span> in a box of text) count
    // once, at the outermost.
    const parent = el.parentElement
    if (parent && parent !== document.body && (isTextBlock(parent) || parent.closest('p, li, pre, blockquote'))) continue
    if (inBad(el) || hidden(el)) continue
    const length = textOf(el).length
    if (length < 2) continue
    total += length
    for (let node = el.parentElement; node; node = node.parentElement) {
      holds.set(node, (holds.get(node) || 0) + length)
      if (node === document.body) break
    }
  }

  if (total < 300) return null

  // The page's own statement of where its content is, if it holds most of it.
  let best = null
  for (const el of document.querySelectorAll('main, article, [role="main"]')) {
    if ((holds.get(el) || 0) >= total * 0.6 && (!best || best.contains(el))) best = el
  }

  // Otherwise the deepest box that still holds nearly everything.
  if (!best) {
    best = document.body
    for (;;) {
      const next = [...best.children].find((child) => (holds.get(child) || 0) >= total * 0.85)
      if (!next) break
      best = next
    }
  }

  // --- collect it in order ----------------------------------------------------
  const blocks = []
  let words = 0
  const bodySize = parseFloat(window.getComputedStyle(document.body).fontSize) || 16
  const count = (text) => (words += text.split(/\\s+/).length)

  const walk = (node) => {
    for (const child of node.children) {
      if (blocks.length > 800) return
      if (looksBad(child) || hidden(child)) continue

      const tag = child.tagName.toLowerCase()
      const text = textOf(child)

      if (/^h[1-6]$/.test(tag)) {
        if (text) blocks.push({ type: 'heading', level: Math.min(4, Math.max(1, Number(tag[1]))), text })
        continue
      }

      if (tag === 'p') {
        if (text.length > 1) {
          blocks.push({ type: 'paragraph', text })
          count(text)
        }
        continue
      }

      if (tag === 'blockquote') {
        if (text) blocks.push({ type: 'quote', text })
        continue
      }

      if (tag === 'pre') {
        if (text) blocks.push({ type: 'code', text })
        continue
      }

      if (tag === 'ul' || tag === 'ol' || tag === 'dl') {
        for (const li of child.querySelectorAll(':scope > li, :scope > dd, :scope > dt')) {
          const item = textOf(li)
          if (item && !looksBad(li)) {
            blocks.push({ type: 'item', text: item })
            count(item)
          }
        }
        continue
      }

      if (tag === 'figure' || tag === 'img' || tag === 'picture') {
        const img = tag === 'img' ? child : child.querySelector('img')
        // Spacers and tracking pixels are not illustrations.
        if (img && img.currentSrc && img.naturalWidth > 200) {
          blocks.push({ type: 'image', src: img.currentSrc, text: (img.alt || '').trim() })
        }
        continue
      }

      // A plain box of text: a paragraph, or a heading if it is set like one.
      if (leaf(child)) {
        if (text.length < 2) continue
        const style = window.getComputedStyle(child)
        const size = parseFloat(style.fontSize) || bodySize
        const heavy = Number(style.fontWeight) >= 600
        if (text.length < 120 && (size >= bodySize * 1.5 || (size >= bodySize * 1.15 && heavy))) {
          blocks.push({ type: 'heading', level: size >= bodySize * 2 ? 2 : 3, text })
        } else {
          blocks.push({ type: 'paragraph', text })
          count(text)
        }
        continue
      }

      walk(child)
    }
  }

  walk(best)

  if (words < 60) return null

  const byline = document.querySelector('[rel="author"], .byline, .author, [itemprop="author"]')
  const published = document.querySelector('time[datetime]')
  const heading = best.querySelector('h1') || document.querySelector('h1')

  return {
    title: ((heading && heading.innerText) || document.title || '').trim(),
    byline: byline ? textOf(byline).slice(0, 120) : '',
    published: published ? (published.getAttribute('datetime') || '').slice(0, 10) : '',
    words,
    blocks
  }
})()`

/** Roughly how long it takes to read, at an unhurried pace. */
function minutesToRead(words: number): number {
  return Math.max(1, Math.round(words / 200))
}

/** Only ever text and image addresses reach the reader page. */
function clean(blocks: unknown): ReaderBlock[] {
  if (!Array.isArray(blocks)) return []

  const out: ReaderBlock[] = []

  for (const raw of blocks) {
    const block = raw as Partial<ReaderBlock>
    const text = typeof block.text === 'string' ? block.text.slice(0, 4000) : ''

    switch (block.type) {
      case 'heading':
        out.push({ type: 'heading', text, level: Number(block.level) || 2 })
        break
      case 'paragraph':
      case 'quote':
      case 'code':
      case 'item':
        if (text) out.push({ type: block.type, text })
        break
      case 'image': {
        const src = typeof block.src === 'string' ? block.src : ''
        // http(s) and data: only — never file: or anything else the page names.
        if (/^https?:\/\//i.test(src)) out.push({ type: 'image', src, text })
        break
      }
      default:
        break
    }
  }

  return out
}

export async function extractArticle(
  wc: Electron.WebContents
): Promise<ReaderArticle | null> {
  try {
    // Isolated world: the page's own scripts cannot see or interfere with this.
    const raw = (await wc.executeJavaScriptInIsolatedWorld(1, [
      { code: EXTRACT_SCRIPT }
    ])) as {
      title?: string
      byline?: string
      published?: string
      words?: number
      blocks?: unknown
    } | null

    if (!raw) return null

    const blocks = clean(raw.blocks)
    if (blocks.length === 0) return null

    return {
      url: wc.getURL(),
      title: String(raw.title ?? '').slice(0, 300) || wc.getTitle(),
      byline: String(raw.byline ?? '').slice(0, 120),
      published: String(raw.published ?? '').slice(0, 10),
      minutes: minutesToRead(Number(raw.words) || 0),
      blocks
    }
  } catch {
    // A page that refuses to be read is not an error worth showing.
    return null
  }
}
