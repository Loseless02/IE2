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
 * Scores candidates the way Readability does, roughly: the container holding
 * the most paragraph text wins, minus anything that looks like navigation or
 * comments. Deliberately conservative — a page it cannot read should say so
 * rather than produce something mangled.
 */
const EXTRACT_SCRIPT = `(() => {
  const BAD = /(^|[\\s_-])(nav|menu|header|footer|sidebar|comment|share|promo|advert|ad|banner|related|recommend|subscribe|newsletter|cookie|popup|modal|breadcrumb|pagination|social|widget)([\\s_-]|$)/i

  const looksBad = (el) => {
    const id = el.id || ''
    const cls = typeof el.className === 'string' ? el.className : ''
    return BAD.test(id) || BAD.test(cls)
  }

  const textOf = (el) => (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim()

  const visible = (el) => {
    const style = window.getComputedStyle(el)
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false
    const box = el.getBoundingClientRect()
    return box.width > 0 || box.height > 0 || el.offsetParent !== null
  }

  // --- pick the container ---------------------------------------------------
  let best = null
  let bestScore = 0

  const candidates = document.querySelectorAll('article, main, [role="main"], .post, .article, .content, #content, div, section')

  for (const el of candidates) {
    if (looksBad(el)) continue

    const paragraphs = el.querySelectorAll(':scope > p, :scope > div > p')
    if (paragraphs.length < 2) continue

    let score = 0
    for (const p of paragraphs) {
      const length = textOf(p).length
      if (length < 40) continue
      score += length
    }

    // Prefer the tighter container when two score alike: the outer one is
    // usually the whole page wrapper.
    if (score > bestScore * 1.1) {
      bestScore = score
      best = el
    }
  }

  if (!best || bestScore < 400) return null

  // --- collect it in order --------------------------------------------------
  const blocks = []
  let words = 0

  const walk = (node) => {
    for (const child of node.children) {
      if (blocks.length > 400) return
      if (looksBad(child) || !visible(child)) continue

      const tag = child.tagName.toLowerCase()
      const text = textOf(child)

      if (tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'h4') {
        if (text) blocks.push({ type: 'heading', level: Number(tag[1]), text })
        continue
      }

      if (tag === 'p') {
        if (text.length > 1) {
          blocks.push({ type: 'paragraph', text })
          words += text.split(/\\s+/).length
        }
        continue
      }

      if (tag === 'blockquote') {
        if (text) blocks.push({ type: 'quote', text })
        continue
      }

      if (tag === 'pre' || tag === 'code') {
        if (text) blocks.push({ type: 'code', text })
        continue
      }

      if (tag === 'ul' || tag === 'ol') {
        for (const li of child.querySelectorAll(':scope > li')) {
          const item = textOf(li)
          if (item) {
            blocks.push({ type: 'item', text: item })
            words += item.split(/\\s+/).length
          }
        }
        continue
      }

      if (tag === 'figure' || tag === 'img') {
        const img = tag === 'img' ? child : child.querySelector('img')
        // Spacers and tracking pixels are not illustrations.
        if (img && img.currentSrc && img.naturalWidth > 200) {
          blocks.push({
            type: 'image',
            src: img.currentSrc,
            text: (img.alt || '').trim()
          })
        }
        continue
      }

      if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'form') continue

      // Anything else: look inside it.
      walk(child)
    }
  }

  walk(best)

  if (words < 60) return null

  const byline =
    document.querySelector('[rel="author"], .byline, .author, [itemprop="author"]')
  const published = document.querySelector('time[datetime]')

  return {
    title: (document.querySelector('h1')?.innerText || document.title || '').trim(),
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
