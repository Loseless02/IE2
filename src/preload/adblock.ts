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
}
