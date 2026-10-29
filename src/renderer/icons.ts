/**
 * Line icons for the interface.
 *
 * Emoji render as full-colour pictures that follow the system font rather than
 * the theme, so they look pasted on and change between machines. These are
 * stroked paths using `currentColor`, so every icon takes the colour of the
 * button it sits in and matches at any theme.
 *
 * Drawn on a 24×24 grid with a stroke of 2 and round caps — the proportions
 * every modern icon set uses, because at a 16px render a heavier stroke on a
 * larger grid stays legible where hairlines on a small grid go muddy. The
 * earlier set was improvised on a 20 grid at 1.5, which is why several of them
 * read as the wrong thing entirely: the incognito mark was a circle with a bar
 * through it, indistinguishable from a "no entry" sign, and the gear was a hub
 * with straight spokes, which reads as a sun.
 */

const PATHS: Record<string, string> = {
  // --- navigation ------------------------------------------------------------
  back: '<path d="M15 18l-6-6 6-6"/>',
  forward: '<path d="M9 18l6-6-6-6"/>',
  up: '<path d="M18 15l-6-6-6 6"/>',
  down: '<path d="M6 9l6 6 6-6"/>',
  reload: '<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1.5"/>',
  home:
    '<path d="M3 9.6 12 2.5l9 7.1V20a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9.5 22v-6h5v6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',

  // --- page actions ----------------------------------------------------------
  // Outer and inner points alternating every 36° around the centre, so the five
  // arms are actually equal — the hand-guessed one leaned to the left.
  star:
    '<path d="M12 2.5 L14.29 8.85 L21.04 9.06 L15.71 13.21 L17.58 19.69 L12 15.9 L6.42 19.69 L8.29 13.21 L2.96 9.06 L9.71 8.85 Z"/>',
  bookmark: '<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>',
  link:
    '<path d="M9 17H7A5 5 0 0 1 7 7h2"/><path d="M15 7h2a5 5 0 0 1 0 10h-2"/><path d="M8 12h8"/>',
  camera:
    '<path d="M20 20H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h2.5L8.5 4h7l2 3H20a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2z"/><circle cx="12" cy="13" r="3.6"/>',
  qr:
    '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM20.5 14v3M14 20.5h3M20.5 20.5h.01"/>',
  download:
    '<path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>',
  install:
    '<path d="M12 2.5v10"/><path d="M8 8.5l4 4 4-4"/><rect x="3" y="16" width="18" height="5" rx="1.5"/>',
  music:
    '<path d="M9 17.5V5.2l12-2.2v12.3"/><circle cx="6" cy="17.5" r="3"/><circle cx="18" cy="15.3" r="3"/>',

  // --- views -----------------------------------------------------------------
  split: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/>',
  pip:
    '<rect x="2.5" y="4.5" width="19" height="15" rx="2"/><rect x="12" y="11" width="7.5" height="6" rx="1" fill="currentColor" stroke="none"/>',
  compat:
    '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/><path d="M6.2 6.5h.01M9.2 6.5h.01M12.2 6.5h.01"/>',

  // --- chrome ----------------------------------------------------------------
  shield:
    '<path d="M12 22c-4.5-1.5-8-4-8-9V5.2L12 2l8 3.2V13c0 5-3.5 7.5-8 9z"/><path d="M9 12l2.2 2.2L15.5 10"/>',
  settings:
    '<circle cx="12" cy="12" r="3.2"/><circle cx="12" cy="12" r="7"/><path d="M19 12h2.4M2.6 12H5M12 19v2.4M12 2.6V5M16.95 16.95l1.7 1.7M5.35 5.35l1.7 1.7M16.95 7.05l1.7-1.7M5.35 18.65l1.7-1.7"/>',
  help:
    '<circle cx="12" cy="12" r="9.5"/><path d="M9.2 9.3a2.9 2.9 0 1 1 3.9 2.7c-.8.3-1.4 1-1.4 1.9v.4"/><path d="M11.7 17.6h.01"/>',
  devtools: '<path d="M9 6l-5 6 5 6"/><path d="M15 6l5 6-5 6"/><path d="M13.6 4l-3.2 16"/>',

  /**
   * A hat and glasses. The previous mark — a circle with a line through it —
   * was the international symbol for "not allowed", which is an unfortunate
   * thing to put on the button that opens a private tab.
   */
  incognito:
    '<path d="M2.5 13.5h19"/><path d="M6 13.5c0-4.3 1.8-7 6-7s6 2.7 6 7"/><circle cx="7.6" cy="17.4" r="3"/><circle cx="16.4" cy="17.4" r="3"/><path d="M10.6 17.1h2.8"/>',

  // --- omnibox and lists -----------------------------------------------------
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4.3-4.3"/>',
  clock: '<circle cx="12" cy="12" r="9.5"/><path d="M12 6.8V12l3.6 2.1"/>',
  globe:
    '<circle cx="12" cy="12" r="9.5"/><path d="M2.6 12h18.8"/><path d="M12 2.5a15 15 0 0 1 4 9.5 15 15 0 0 1-4 9.5 15 15 0 0 1-4-9.5 15 15 0 0 1 4-9.5z"/>',
  text: '<path d="M4 6h16M4 12h16M4 18h10"/>',
  folder: '<path d="M3 6.5a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  copy:
    '<rect x="8.5" y="8.5" width="12" height="12" rx="2"/><path d="M15.5 8.5v-3a2 2 0 0 0-2-2h-8a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h3"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',

  // --- tools -----------------------------------------------------------------
  /** Mood: a rain cloud. */
  mood:
    '<path d="M7 15.5a4.5 4.5 0 1 1 1.1-8.86A6 6 0 0 1 19.6 9.1 3.8 3.8 0 0 1 17.5 16"/><path d="M8.5 19l-1 2.5M12.5 18l-1.5 3.5M16.5 19l-1 2.5"/>',
  /** Public IP: a screen with the letters on it. */
  ip:
    '<rect x="2.5" y="4" width="19" height="13" rx="2"/><path d="M8 21h8M12 17v4"/><path d="M8 8v5M11 13V8h2.2a1.8 1.8 0 0 1 0 3.6H11"/>',
  /** Audio effects: a waveform. */
  fx: '<path d="M3 12h1.5M7 8.5v7M10.5 5v14M14 8v8M17.5 10v4M21 12h-1.5"/>',
  key: '<circle cx="7.5" cy="15.5" r="4"/><path d="M10.4 12.6 20 3M16.5 6.5l3 3M13.8 9.2l2 2"/>',
  lock: '<rect x="4.5" y="10.5" width="15" height="10.5" rx="2"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/>',
  mic: '<rect x="9" y="2.5" width="6" height="12" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>',
  pin: '<path d="M12 21s-7-6.1-7-11.5a7 7 0 0 1 14 0C19 14.9 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>',
  bell: '<path d="M6 16v-5a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
  /** The ☰ menu, and the things in it. */
  menu: '<path d="M4 6.5h16M4 12h16M4 17.5h16"/>',
  window: '<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="M3 9h18"/>',
  wrench:
    '<path d="M14.5 6.5a4 4 0 0 0 5 5L21 13l-8 8-2.5-2.5 6-6-1.5-1.5-6 6L6.5 14.5l8-8z" transform="translate(-2 -2)"/>',
  printer:
    '<path d="M7 9V3.5h10V9"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M7 14h10v6.5H7z"/>',
  share: '<path d="M12 15V3.5M7.5 8 12 3.5 16.5 8"/><path d="M5 12v7.5h14V12"/>',
  expand: '<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/>',
  minus: '<path d="M5 12h14"/>',
  chev: '<path d="M9 5l7 7-7 7"/>',
  exit: '<path d="M14 4h5v16h-5"/><path d="M10 8l-4 4 4 4M6 12h10"/>',
  /** Dark mode: a crescent moon. */
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
  /** Extensions: a jigsaw piece. */
  puzzle:
    '<path d="M9 4.5a2 2 0 0 1 4 0V6h4a1 1 0 0 1 1 1v4h-1.5a2 2 0 0 0 0 4H18v4a1 1 0 0 1-1 1h-4v-1.5a2 2 0 0 0-4 0V20H5a1 1 0 0 1-1-1v-4h1.5a2 2 0 0 0 0-4H4V7a1 1 0 0 1 1-1h4z"/>',
  /** Pinning to the toolbar: a drawing pin. */
  tack: '<path d="M9 3.5h6l-1 5 3 3v2H7v-2l3-3z"/><path d="M12 13.5V21"/>',
  more: '<circle cx="5.5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="18.5" cy="12" r="1.2"/>',

  // --- media -----------------------------------------------------------------
  play: '<path d="M7 4.4v15.2L20 12z"/>',
  pause: '<path d="M9 4.5v15M15 4.5v15"/>',
  /** Rewind and fast-forward, which the circular arrows were being mistaken for. */
  back10: '<path d="M11.5 19l-9.5-7 9.5-7z"/><path d="M22 19l-9.5-7L22 5z"/>',
  forward10: '<path d="M12.5 19l9.5-7-9.5-7z"/><path d="M2 19l9.5-7L2 5z"/>',
  volume:
    '<path d="M11 4.8L6 9H3v6h3l5 4.2z"/><path d="M15.6 8.6a4.8 4.8 0 0 1 0 6.8"/><path d="M18.6 5.6a9 9 0 0 1 0 12.8"/>',
  mute: '<path d="M11 4.8L6 9H3v6h3l5 4.2z"/><path d="M16.5 9.5l5 5M21.5 9.5l-5 5"/>'
}

/** Some icons read better filled than stroked. */
const FILLED = new Set(['play', 'stop', 'back10', 'forward10', 'star-filled', 'bookmark-filled'])

export function iconSvg(name: string): string {
  const path = PATHS[name] ?? PATHS.help
  const filled = FILLED.has(name)

  return [
    '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" width="16" height="16"',
    ` fill="${filled ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"`,
    ' stroke-linecap="round" stroke-linejoin="round">',
    path,
    '</svg>'
  ].join('')
}

/**
 * Build the icon as real nodes. The markup here is ours, not page content, but
 * parsing it through a template keeps a single trusted path for all of it.
 */
export function icon(name: string): SVGElement {
  const template = document.createElement('template')
  template.innerHTML = iconSvg(name).trim()
  return template.content.firstElementChild as SVGElement
}

/** Replace a button's contents with an icon, keeping any badge it carries. */
export function setIcon(element: HTMLElement, name: string): void {
  const badge = element.querySelector('.badge, #dl-count')
  element.replaceChildren(icon(name))
  if (badge) element.append(badge)
}
