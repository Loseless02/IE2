import { applyTheme } from './theme'
import type { ReaderArticle, ReaderBlock } from '../shared/types'

/**
 * Reader mode's page.
 *
 * Everything here is built from blocks the main process extracted, and every
 * piece of page-authored text goes in through `textContent`. There is no
 * `innerHTML` in this file, deliberately: the content came from an arbitrary
 * website, and this page has the internal API attached to it.
 */

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

const article = el('article')
const body = el('body')

/** Text size and column width, remembered per reader rather than per page. */
const SIZES = [16, 18, 20, 23, 26]
let sizeIndex = Number(localStorage.getItem('reader-size') ?? 1)
let wide = localStorage.getItem('reader-wide') === 'true'

function applyTypography(): void {
  document.documentElement.style.setProperty('--reader-size', `${SIZES[sizeIndex]}px`)
  document.body.classList.toggle('wide', wide)
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

function renderBlock(block: ReaderBlock): HTMLElement | null {
  switch (block.type) {
    case 'heading': {
      const node = document.createElement(`h${Math.min(4, Math.max(2, block.level))}`)
      node.textContent = block.text
      return node
    }

    case 'paragraph': {
      const node = document.createElement('p')
      node.textContent = block.text
      return node
    }

    case 'quote': {
      const node = document.createElement('blockquote')
      node.textContent = block.text
      return node
    }

    case 'code': {
      const pre = document.createElement('pre')
      const code = document.createElement('code')
      code.textContent = block.text
      pre.append(code)
      return pre
    }

    case 'item': {
      const node = document.createElement('li')
      node.textContent = block.text
      return node
    }

    case 'image': {
      const figure = document.createElement('figure')
      const img = document.createElement('img')
      img.src = block.src
      img.alt = block.text
      img.loading = 'lazy'
      figure.append(img)

      if (block.text) {
        const caption = document.createElement('figcaption')
        caption.textContent = block.text
        figure.append(caption)
      }

      return figure
    }

    default:
      return null
  }
}

function render(found: ReaderArticle): void {
  el('title').textContent = found.title
  el('minutes').textContent = `${found.minutes} min read`
  el('byline').textContent = found.byline
  el('published').textContent = found.published
  el('host').textContent = hostOf(found.url)

  document.title = found.title || 'Reader'

  // Consecutive list items are gathered back into one list, so bullets sit
  // together instead of each becoming an island.
  let list: HTMLUListElement | null = null

  for (const block of found.blocks) {
    const node = renderBlock(block)
    if (!node) continue

    if (block.type === 'item') {
      if (!list) {
        list = document.createElement('ul')
        body.append(list)
      }
      list.append(node)
      continue
    }

    list = null
    body.append(node)
  }

  article.hidden = false
}

async function load(): Promise<void> {
  const settings = await window.ie2.getSettings()
  applyTheme(settings)
  applyTypography()

  const found = await window.ie2.readerArticle()

  if (!found || found.blocks.length === 0) {
    el('empty').hidden = false
    return
  }

  render(found)

  el('original').addEventListener('click', () => window.ie2.open(found.url))
  el('back').addEventListener('click', () => window.ie2.open(found.url))
}

el('bigger').addEventListener('click', () => {
  sizeIndex = Math.min(SIZES.length - 1, sizeIndex + 1)
  localStorage.setItem('reader-size', String(sizeIndex))
  applyTypography()
})

el('smaller').addEventListener('click', () => {
  sizeIndex = Math.max(0, sizeIndex - 1)
  localStorage.setItem('reader-size', String(sizeIndex))
  applyTypography()
})

el('width').addEventListener('click', () => {
  wide = !wide
  localStorage.setItem('reader-wide', String(wide))
  applyTypography()
})

void load()
