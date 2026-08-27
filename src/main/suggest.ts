import type { Suggestion } from '../shared/types'
import { searchFullText, searchHistory, searchTerms } from './db'
import { normalizeInput } from './url'
import { SEARCH_ENGINES, searchUrlFor } from '../shared/settings'
import { getSettings } from './settings'
import { fetchSuggestions } from './autocomplete'

/**
 * Build the omnibox dropdown: what you typed, then places you have been, then —
 * the reason this browser exists — pages whose *text* contains what you typed,
 * even if the title and URL say nothing about it.
 *
 * Everything here is local and answers immediately. The search engine's own
 * autocomplete is deliberately *not* awaited: it used to be, which meant the
 * whole dropdown waited on a network round trip, and by the time it arrived the
 * next keystroke had already made it stale, so the results were thrown away and
 * nothing from the engine was ever shown. It now arrives separately, through
 * {@link engineSuggestions}.
 */
export function buildSuggestions(input: string): Suggestion[] {
  const query = input.trim()
  if (!query) return []

  const engine = SEARCH_ENGINES[getSettings().searchEngine] ?? SEARCH_ENGINES.duckduckgo
  const target = normalizeInput(query)
  const isSearch = target.startsWith(engine.url)

  const out: Suggestion[] = [
    {
      kind: isSearch ? 'search' : 'url',
      label: isSearch ? engine.name : 'Go to',
      url: target,
      title: query,
      favicon: null,
      lastVisit: 0,
      snippet: null
    }
  ]

  const seen = new Set([target])

  // "Suggestions while typing" was previously read by nothing at all: turning
  // it off changed no behaviour. With it off, the dropdown offers only what
  // pressing Enter would do.
  if (!getSettings().searchSuggestions) return out

  // Searches carried over from another browser, or made here before.
  for (const past of searchTerms(query, 3)) {
    if (past.term.toLowerCase() === query.toLowerCase()) continue
    const url = searchUrlFor(getSettings().searchEngine, past.term)
    if (seen.has(url)) continue
    seen.add(url)
    out.push({
      kind: 'search',
      label: 'Searched before',
      url,
      title: past.term,
      favicon: null,
      lastVisit: 0,
      snippet: null
    })
  }

  for (const hit of searchHistory(query, 4)) {
    if (seen.has(hit.url)) continue
    seen.add(hit.url)
    out.push({ ...hit, kind: 'history', label: 'Visited' })
  }

  for (const hit of searchFullText(query, 6)) {
    if (seen.has(hit.url)) continue
    seen.add(hit.url)
    out.push({ ...hit, kind: 'fulltext', label: 'In page text' })
  }

  return out
}

/**
 * The engine's own autocomplete, when the user has allowed it. Kept apart from
 * the local results so a slow or failed request costs nothing but itself.
 */
export async function engineSuggestions(input: string): Promise<Suggestion[]> {
  const query = input.trim()
  if (!query) return []

  const settings = getSettings()
  if (!settings.searchSuggestions) return []

  const engine = SEARCH_ENGINES[settings.searchEngine] ?? SEARCH_ENGINES.duckduckgo

  return (await fetchSuggestions(query))
    .filter((phrase) => phrase.trim().toLowerCase() !== query.toLowerCase())
    .map((phrase) => ({
      kind: 'search' as const,
      label: `${engine.name} suggests`,
      url: searchUrlFor(settings.searchEngine, phrase),
      title: phrase,
      favicon: null,
      lastVisit: 0,
      snippet: null
    }))
}
