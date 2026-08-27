import type { WebContents, WebFrameMain } from 'electron'

/**
 * Picture-in-Picture: float the video above everything else.
 *
 * Chromium provides the window; the work here is finding the right video. Sites
 * often have several — an autoplaying trailer in a sidebar, a muted background
 * loop — so the biggest one that is actually playing wins. Embedded players live
 * in cross-origin iframes, which the top document cannot reach, so every frame
 * is asked in turn.
 */

export type PipResult = 'entered' | 'exited' | 'no-video' | 'blocked' | 'unavailable'

/** Runs in the page. Returns a status string rather than throwing. */
const TOGGLE_SCRIPT = `
(async () => {
  if (!document.pictureInPictureEnabled) return 'unavailable';

  // Already floating? Then this is a request to put it back.
  if (document.pictureInPictureElement) {
    try { await document.exitPictureInPicture(); return 'exited'; } catch { return 'blocked'; }
  }

  const videos = [...document.querySelectorAll('video')].filter(
    (v) => !v.disablePictureInPicture && v.readyState >= 2 && v.videoWidth > 0
  );
  if (videos.length === 0) return 'no-video';

  // Biggest on screen wins, and a playing video beats a paused one.
  videos.sort((a, b) => {
    const playing = Number(!b.paused) - Number(!a.paused);
    if (playing !== 0) return playing;
    return b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight;
  });

  try {
    await videos[0].requestPictureInPicture();
    return 'entered';
  } catch {
    return 'blocked';
  }
})()
`

/** Every frame in the page, top document first. */
function framesOf(wc: WebContents): WebFrameMain[] {
  const main = wc.mainFrame
  if (!main) return []

  try {
    return [main, ...main.framesInSubtree.filter((frame) => frame !== main)]
  } catch {
    return [main]
  }
}

/**
 * Ask each frame to toggle, stopping at the first that does something. A frame
 * with no video answers 'no-video' and the next one gets a turn.
 */
export async function togglePictureInPicture(wc: WebContents): Promise<PipResult> {
  let sawFrame = false

  for (const frame of framesOf(wc)) {
    let result: PipResult
    try {
      // A user gesture is required by the API, and the call is raced against a
      // timeout so a wedged frame cannot leave the browser waiting.
      result = (await Promise.race([
        frame.executeJavaScript(TOGGLE_SCRIPT, true),
        new Promise<PipResult>((resolve) => setTimeout(() => resolve('blocked'), 3000))
      ])) as PipResult
    } catch {
      // Frame went away mid-call, or refused the script.
      continue
    }

    sawFrame = true
    if (result === 'entered' || result === 'exited') return result
    if (result === 'unavailable') return 'unavailable'
  }

  return sawFrame ? 'no-video' : 'unavailable'
}
