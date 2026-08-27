import type { WebContents, WebFrameMain } from 'electron'
import type { MediaState } from '../shared/types'

/**
 * What the active tab is playing, and control over it.
 *
 * Sites describe themselves through the Media Session API — the same data the
 * operating system's media keys use — so title, artist and artwork come from
 * there when offered. Position and playback come from the element itself, which
 * is also what gets paused. Embedded players live in iframes, so every frame is
 * asked in turn.
 */

const READ_SCRIPT = `
(() => {
  const media = [...document.querySelectorAll('video, audio')].filter(
    (el) => el.readyState >= 1 && (el.duration > 0 || el.duration === Infinity)
  );
  if (media.length === 0) return null;

  // The one being listened to: playing beats paused, longer beats shorter.
  media.sort((a, b) => {
    const playing = Number(!b.paused) - Number(!a.paused);
    if (playing !== 0) return playing;
    return (b.duration || 0) - (a.duration || 0);
  });

  const el = media[0];
  const session = navigator.mediaSession && navigator.mediaSession.metadata;
  const artwork = session && session.artwork && session.artwork.length > 0
    ? [...session.artwork].sort((a, b) => {
        const size = (s) => parseInt((s.sizes || '0x0').split('x')[0], 10) || 0;
        return size(b) - size(a);
      })[0].src
    : null;

  return {
    hasMedia: true,
    title: (session && session.title) || document.title || location.hostname,
    artist: (session && session.artist) || location.hostname,
    artwork,
    playing: !el.paused && !el.ended,
    muted: el.muted,
    position: Number.isFinite(el.currentTime) ? el.currentTime : 0,
    duration: Number.isFinite(el.duration) ? el.duration : 0
  };
})()
`

/** Actions are applied to the same element the reader picked. */
function controlScript(action: string): string {
  return `
(() => {
  const media = [...document.querySelectorAll('video, audio')].filter((el) => el.readyState >= 1);
  if (media.length === 0) return false;

  media.sort((a, b) => {
    const playing = Number(!b.paused) - Number(!a.paused);
    if (playing !== 0) return playing;
    return (b.duration || 0) - (a.duration || 0);
  });

  const el = media[0];
  switch (${JSON.stringify(action)}) {
    case 'play': el.play(); break;
    case 'pause': el.pause(); break;
    case 'toggle': el.paused ? el.play() : el.pause(); break;
    case 'back': el.currentTime = Math.max(0, el.currentTime - 10); break;
    case 'forward': el.currentTime = el.currentTime + 10; break;
    case 'mute': el.muted = !el.muted; break;
    default: return false;
  }
  return true;
})()
`
}

function framesOf(wc: WebContents): WebFrameMain[] {
  const main = wc.mainFrame
  if (!main) return []

  try {
    return [main, ...main.framesInSubtree.filter((frame) => frame !== main)]
  } catch {
    return [main]
  }
}

/** Ask each frame until one reports something playable. */
export async function readMedia(wc: WebContents): Promise<MediaState> {
  for (const frame of framesOf(wc)) {
    try {
      const found = (await Promise.race([
        frame.executeJavaScript(READ_SCRIPT),
        new Promise((resolve) => setTimeout(() => resolve(null), 1000))
      ])) as MediaState | null

      if (found?.hasMedia) return found
    } catch {
      continue
    }
  }

  return { hasMedia: false, title: '', artist: '', artwork: null, playing: false, muted: false, position: 0, duration: 0 }
}

export async function controlMedia(wc: WebContents, action: string): Promise<boolean> {
  for (const frame of framesOf(wc)) {
    try {
      const done = (await Promise.race([
        frame.executeJavaScript(controlScript(action), true),
        new Promise((resolve) => setTimeout(() => resolve(false), 1000))
      ])) as boolean

      if (done) return true
    } catch {
      continue
    }
  }

  return false
}
