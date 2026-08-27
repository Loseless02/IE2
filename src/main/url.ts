// Schemes we are willing to load in a tab. Anything else (mailto:, javascript:,
// file:, custom protocol handlers) is either delegated to the OS or dropped.
import { searchUrlFor } from '../shared/settings'
import { getSettings } from './settings'

// `file:` is here so the browser can open a local page or PDF when Windows
// hands it one. Pages still cannot navigate themselves to file: — this list
// governs what the browser itself will load.
const ALLOWED_SCHEMES = new Set(['http:', 'https:', 'about:', 'ie2:', 'file:'])

/**
 * Turn whatever the user typed into the omnibox into a URL to navigate to.
 * Falls back to a search query when the input is not a plausible hostname.
 */
export function normalizeInput(input: string): string {
  const search = (query: string): string =>
    searchUrlFor(getSettings().searchEngine, query)

  const text = input.trim()
  if (!text) return 'about:blank'

  // Explicit scheme: trust it if it is one we allow, otherwise search for it.
  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) {
    try {
      const parsed = new URL(text)
      if (ALLOWED_SCHEMES.has(parsed.protocol)) return parsed.toString()
    } catch {
      // fall through to search
    }
    return search(text)
  }

  if (text === 'localhost' || text.startsWith('localhost:')) return `http://${text}`

  // Looks like "example.com", "example.com/path", "1.2.3.4:8080" -> treat as a host.
  const host = text.split(/[/?#]/)[0]
  const isHostLike = /^[^\s]+\.[a-z]{2,}$/i.test(host) || /^\d{1,3}(\.\d{1,3}){3}(:\d+)?$/.test(host)
  if (isHostLike && !text.includes(' ')) return `https://${text}`

  return search(text)
}

export function isAllowedUrl(url: string): boolean {
  try {
    return ALLOWED_SCHEMES.has(new URL(url).protocol)
  } catch {
    return false
  }
}
