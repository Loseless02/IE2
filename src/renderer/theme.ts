import { activeTheme } from '../shared/themes'
import { toHex, type Settings } from '../shared/settings'

/** The typefaces the interface can use: Windows ships every one of them. */
const UI_FONTS: Record<Settings['uiFont'], string> = {
  system: "system-ui, 'Segoe UI', sans-serif",
  bahnschrift: "Bahnschrift, 'Segoe UI', sans-serif",
  georgia: "Georgia, 'Times New Roman', serif",
  mono: "'Cascadia Mono', Consolas, monospace",
  comic: "'Comic Sans MS', 'Segoe UI', sans-serif"
}

/**
 * Push a theme into CSS variables. Every page in the browser calls this — the
 * chrome UI, the new tab page, the manual and settings — so a theme change is
 * one place, not five stylesheets.
 *
 * The accent is kept separate: a chosen accent survives a theme change, and
 * clearing it falls back to whatever the theme itself prefers.
 */
export function applyTheme(
  settings: Pick<Settings, 'theme' | 'accent'> & {
    animations?: boolean
    customTheme?: Settings['customTheme']
    useCustomTheme?: boolean
    uiFont?: Settings['uiFont']
    corners?: Settings['corners']
  }
): void {
  const theme = activeTheme(settings)
  const root = document.documentElement
  const c = theme.colours

  root.style.setProperty('--bg', c.bg)
  root.style.setProperty('--bg-elevated', c.bgElevated)
  root.style.setProperty('--bg-hover', c.bgHover)
  root.style.setProperty('--border', c.border)
  root.style.setProperty('--toolbar', c.toolbar)
  root.style.setProperty('--outline', c.outline)
  root.style.setProperty('--text', c.text)
  root.style.setProperty('--text-dim', c.textDim)
  root.style.setProperty('--mark', c.mark)
  root.style.setProperty('--hover', c.hover)
  root.style.setProperty('--overlay', c.overlay)

  // The new tab page uses its own names for the same two surfaces.
  root.style.setProperty('--panel', c.bgElevated)
  root.style.setProperty('--panel-hover', c.bgHover)

  root.style.setProperty('--accent', settings.accent ? toHex(settings.accent, c.accent) : c.accent)

  // Lets stylesheets special-case a light interface where they must.
  root.dataset['mode'] = theme.mode

  if (settings.uiFont !== undefined) root.style.setProperty('--ui-font', UI_FONTS[settings.uiFont] ?? UI_FONTS.system)
  if (settings.corners !== undefined) root.dataset['corners'] = settings.corners

  // The Animations setting used to reach only the browser chrome, so every
  // internal page kept moving after it was switched off. Each page calls this,
  // so this is the one place that governs all of them.
  if (settings.animations !== undefined) {
    root.classList.toggle('no-motion', !settings.animations)
  }
}
