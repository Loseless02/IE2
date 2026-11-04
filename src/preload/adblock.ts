import { ipcRenderer, webFrame } from 'electron'

/**
 * Scriptlets, injected before the page runs.
 *
 * A scriptlet is a small script a filter list injects to defeat ads that cannot
 * be blocked by URL — the ones served from the same place as the content, which
 * is how YouTube delivers its video ads. They work by replacing page functions
 * such as `fetch` and `XMLHttpRequest` before the page can use them.
 *
 * That last part is the whole game. @ghostery/adblocker-electron asks the main
 * process for its scriptlets over `ipcRenderer.invoke`, which is asynchronous:
 * the answer arrives a few turns of the event loop later, by which time the
 * page's own scripts have started and taken their own references to `fetch`.
 * Replacing it afterwards changes nothing, because the page is no longer
 * looking. Cosmetic hiding still worked, which is why ads *looked* blocked
 * everywhere except where it mattered.
 *
 * This runs at document start and asks synchronously, so the replacements are
 * in place before the first line of page script executes — the same guarantee
 * uBlock Origin gets from a content script at `document_start`.
 */

// Frames only, and never our own pages: nothing to block there, and the sync
// round trip is not free.
if (window.location.protocol !== 'ie2:' && window.location.protocol !== 'devtools:') {
  try {
    const scripts = ipcRenderer.sendSync('ie2:scriptlets', window.location.href) as
      | string[]
      | undefined

    if (Array.isArray(scripts)) {
      for (const code of scripts) {
        try {
          // The main world, where the page's own `fetch` lives. A preload runs
          // in an isolated world, so patching it from here would be invisible
          // to the page.
          //
          // Each one gets its own function scope. Several scriptlets declare
          // the same helpers at top level — `class JSONPath` appears in every
          // JSON-pruning one, and YouTube gets four of them — and top-level
          // class and const declarations share a single global lexical scope
          // across separate scripts, so the second copy dies with
          // "Identifier 'JSONPath' has already been declared" and every
          // scriptlet after it never runs.
          webFrame.executeJavaScript(`(function(){${code}\n})()`, true)
        } catch {
          // One bad scriptlet must not stop the rest, and must never stop the
          // page from loading.
        }
      }
    }
  } catch {
    // Blocking is a courtesy; a page that cannot reach the main process still
    // has to load.
  }

  if (window.top === window && /(^|\.)youtube\.com$/.test(window.location.hostname)) watchYouTubeStalls()
}

/**
 * A YouTube video that never starts.
 *
 * YouTube changes how it serves ads all the time, and the filter lists'
 * YouTube scriptlets chase it. When they fall behind, the player can sit on
 * its spinner for good — waiting for an ad that was taken away, or reloading
 * itself over and over. Measured with current lists, removing the ads costs a
 * few seconds' start-up; when it costs more than that, something is broken.
 *
 * So: a video still on the spinner after 12 visible seconds, with no ad
 * playing, is reloaded once without the YouTube scriptlets — network blocking
 * stays on — because a video that plays, possibly after an ad, beats one that
 * never does. A plain reload first was tried, and measured: it never once got
 * a stuck video going, so it only added fifteen seconds of spinner.
 */
const STALL_MS = 12_000
const RESCUE_KEY = 'ie2-youtube-rescue'
/** A rescue counts for this long; after that the same video starts afresh. */
const RESCUE_MEMORY_MS = 2 * 60_000

function watchYouTubeStalls(): void {
  let href = ''
  let stuckFor = 0
  let last = Date.now()

  const rescued = (): { href: string; at: number } | null => {
    try {
      const value = JSON.parse(sessionStorage.getItem(RESCUE_KEY) ?? 'null')
      return value && value.href === href && Date.now() - value.at < RESCUE_MEMORY_MS ? value : null
    } catch {
      return null
    }
  }

  window.setInterval(() => {
    const now = Date.now()
    const elapsed = now - last
    last = now

    if (window.location.href !== href) {
      href = window.location.href
      stuckFor = 0
    }
    if (!window.location.pathname.startsWith('/watch') || document.visibilityState !== 'visible') return

    const video = document.querySelector<HTMLVideoElement>('#movie_player video')
    const player = document.getElementById('movie_player')
    const spinner = player?.querySelector<HTMLElement>('.ytp-spinner')
    const spinning = Boolean(spinner && getComputedStyle(spinner).display !== 'none')
    const ad = Boolean(player?.classList.contains('ad-showing'))
    const stuck = Boolean(video) && spinning && !ad && (video?.currentTime ?? 0) < 0.5

    stuckFor = stuck ? stuckFor + elapsed : 0
    if (stuckFor < STALL_MS) return
    stuckFor = 0

    // Once per video: if it is stuck even without them, reloading again will
    // not help either.
    if (rescued()) return
    try {
      sessionStorage.setItem(RESCUE_KEY, JSON.stringify({ href, at: now }))
    } catch {
      return
    }
    void ipcRenderer.invoke('adblock:skip-scriptlets-once').finally(() => window.location.reload())
  }, 1000)
}
