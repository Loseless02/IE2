import { net } from 'electron'
import { getSettings } from './settings'
import type { SearchEngineId } from '../shared/settings'

/**
 * Suggestions from the search engine itself — the autocomplete list every other
 * browser shows while you type.
 *
 * This is off unless the user turns it on, because it means sending what you
 * type to the engine before you press Enter. That is a real privacy cost in a
 * browser whose whole point is that nothing leaves the machine unasked.
 */

/** Endpoints that return the OpenSearch array format: [query, [suggestions]]. */
const ENDPOINTS: Partial<Record<SearchEngineId, (q: string) => string>> = {
  duckduckgo: (q) => `https://duckduckgo.com/ac/?q=${q}&type=list`,
  google: (q) => `https://suggestqueries.google.com/complete/search?client=firefox&q=${q}`,
  brave: (q) => `https://search.brave.com/api/suggest?q=${q}`,
  bing: (q) => `https://api.bing.com/osjson.aspx?query=${q}`,
  yahoo: (q) => `https://search.yahoo.com/sugg/gossip/gossip-us-ura/?output=sd1&command=${q}`,
  ecosia: (q) => `https://ac.ecosia.org/autocomplete?q=${q}`,
  startpage: (q) => `https://www.startpage.com/suggestions?q=${q}&format=opensearch`,
  wikipedia: (q) =>
    `https://en.wikipedia.org/w/api.php?action=opensearch&format=json&limit=6&search=${q}`
}

/** Small cache so backspacing does not re-ask for something just fetched. */
const cache = new Map<string, string[]>()
const CACHE_LIMIT = 60

/** Requests are abandoned rather than queued — the next keystroke supersedes. */
let inFlight: AbortController | null = null

export async function fetchSuggestions(query: string): Promise<string[]> {
  const settings = getSettings()
  if (!settings.searchAutocomplete) return []

  const trimmed = query.trim()
  if (trimmed.length < 2) return []

  const key = `${settings.searchEngine}:${trimmed.toLowerCase()}`
  const cached = cache.get(key)
  if (cached) return cached

  const build = ENDPOINTS[settings.searchEngine]
  if (!build) return []

  inFlight?.abort()
  const controller = new AbortController()
  inFlight = controller

  // A suggestion that arrives late is worse than none at all.
  const timeout = setTimeout(() => controller.abort(), 1500)

  try {
    const response = await net.fetch(build(encodeURIComponent(trimmed)), {
      signal: controller.signal,
      // Nothing about the browsing session belongs in an autocomplete request.
      credentials: 'omit'
    })
    if (!response.ok) return []

    const suggestions = parse(await response.text()).slice(0, 6)

    cache.set(key, suggestions)
    if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string)

    return suggestions
  } catch {
    // Aborted, offline, or the engine changed its shape. Local results stand.
    return []
  } finally {
    clearTimeout(timeout)
    if (inFlight === controller) inFlight = null
  }
}

/**
 * Engines answer in several shapes: the OpenSearch array, DuckDuckGo's list of
 * objects, or Wikipedia's four-element array. All of them are handled here so
 * the caller only ever sees strings.
 */
function parse(body: string): string[] {
  let data: unknown
  try {
    data = JSON.parse(body)
  } catch {
    return []
  }

  // ["query", ["first", "second", …], …]
  if (Array.isArray(data) && Array.isArray(data[1])) {
    return (data[1] as unknown[]).filter((v): v is string => typeof v === 'string')
  }

  // [{ phrase: "first" }, { phrase: "second" }]
  if (Array.isArray(data)) {
    return data
      .map((entry) =>
        typeof entry === 'string'
          ? entry
          : typeof (entry as { phrase?: string })?.phrase === 'string'
            ? (entry as { phrase: string }).phrase
            : null
      )
      .filter((v): v is string => v !== null)
  }

  // { suggestions: [{ term: "…" }] } — what some Yahoo endpoints return.
  const suggestions = (data as { suggestions?: unknown })?.suggestions
  if (Array.isArray(suggestions)) {
    return suggestions
      .map((entry) => (entry as { term?: string })?.term)
      .filter((v): v is string => typeof v === 'string')
  }

  return []
}
