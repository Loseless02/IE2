import { themeById } from '../shared/themes'
import { toHex, type Settings } from '../shared/settings'

/**
 * Push a theme into CSS variables. Every page in the browser calls this — the
 * chrome UI, the new tab page, the manual and settings — so a theme change is
 * one place, not five stylesheets.
 *
 * The accent is kept separate: a chosen accent survives a theme change, and
 * clearing it falls back to whatever the theme itself prefers.
 */
export function applyTheme(settings: Pick<Settings, 'theme' | 'accent'>): void {
  const theme = themeById(settings.theme)
  const root = document.documentElement
  const c = theme.colours

  root.style.setProperty('--bg', c.bg)
  root.style.setProperty('--bg-elevated', c.bgElevated)
  root.style.setProperty('--bg-hover', c.bgHover)
  root.style.setProperty('--border', c.border)
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
}
