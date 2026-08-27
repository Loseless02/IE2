import type { WebContents } from 'electron'
import { isNeverRemembered } from './db'
import { getSettings } from './settings'

/** Isolated world id for our extraction script — never shared with the page. */
const WORLD_ID = 999

const MAX_CHARS = 300_000

/**
 * Runs in the page, in an isolated world so the page cannot see it, tamper with
 * it, or feed us doctored text through overridden DOM getters.
 */
const EXTRACT_SCRIPT = `
(() => {
  // No body on error pages, PDFs and documents that never finished parsing.
  // Throwing here surfaces as an unhandled rejection in the main process.
  if (!document.body) return '';

  const skip = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG']);
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || skip.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
      if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });

  const parts = [];
  let total = 0;
  while (walker.nextNode() && total < ${MAX_CHARS}) {
    const text = walker.currentNode.nodeValue.trim();
    parts.push(text);
    total += text.length + 1;
  }
  return parts.join(' ').replace(/\\s+/g, ' ').slice(0, ${MAX_CHARS});
})()
`

/**
 * Pull the readable text out of a loaded page. Returns null when the page is
 * not something we should be indexing, or when extraction fails.
 */
export async function capturePageText(wc: WebContents): Promise<string | null> {
  if (!getSettings().captureText) return null

  try {
    const result = await wc.executeJavaScriptInIsolatedWorld(WORLD_ID, [{ code: EXTRACT_SCRIPT }])
    return typeof result === 'string' && result.length > 0 ? result : null
  } catch {
    return null
  }
}

/**
 * Pages we deliberately do not index. Everything here is either not ours to
 * keep (private sessions, auth flows) or worthless in a text index.
 */
export function shouldIndex(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false

  // Recording can be switched off wholesale in settings.
  if (!getSettings().recordHistory) return false

  // Domains the user has explicitly told us to stay out of.
  if (isNeverRemembered(parsed.hostname)) return false

  // Credentials and payment flows: never capture the contents of these pages.
  const sensitive = /(^|\.)(accounts|login|signin|auth|oauth|checkout|payments?|banking)\./i
  if (sensitive.test(parsed.hostname)) return false
  if (/\/(login|signin|sign-in|register|checkout|payment|password|reset)(\/|$)/i.test(parsed.pathname))
    return false

  return true
}
