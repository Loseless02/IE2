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
