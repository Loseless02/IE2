/**
 * Interface themes. Each one is a complete palette, not a tint of the default:
 * light themes have to work as well as dark ones, so every surface, border and
 * overlay is named here rather than hardcoded in the stylesheets.
 *
 * The palettes are inspired by well-known editor themes and named after them
 * for recognition; they are approximations, not the originals.
 */
export interface Theme {
  name: string
  mode: 'dark' | 'light'
  colours: {
    /** Page and toolbar ground. */
    bg: string
    /** Panels, popovers, tabs. */
    bgElevated: string
    /** Hover state for a tab. */
    bgHover: string
    /** Lines, and the active tab's fill. */
    border: string
    text: string
    textDim: string
    accent: string
    /** Search-match highlight. */
    mark: string
    /** Button hover wash — light on dark themes, dark on light ones. */
    hover: string
    /** Stronger wash, for pressed and selected rows. */
    overlay: string
  }
}

const dark = (
  name: string,
  bg: string,
  bgElevated: string,
  bgHover: string,
  border: string,
  text: string,
  textDim: string,
  accent: string,
  mark = '#ffd479'
): Theme => ({
  name,
  mode: 'dark',
  colours: {
    bg,
    bgElevated,
    bgHover,
    border,
    text,
    textDim,
    accent,
    mark,
    hover: 'rgba(255, 255, 255, 0.10)',
    overlay: 'rgba(255, 255, 255, 0.06)'
  }
})

const light = (
  name: string,
  bg: string,
  bgElevated: string,
  bgHover: string,
  border: string,
  text: string,
  textDim: string,
  accent: string,
  mark = '#a86a00'
): Theme => ({
  name,
  mode: 'light',
  colours: {
    bg,
    bgElevated,
    bgHover,
    border,
    text,
    textDim,
    accent,
    mark,
    hover: 'rgba(0, 0, 0, 0.08)',
    overlay: 'rgba(0, 0, 0, 0.05)'
  }
})

export const THEMES: Record<string, Theme> = {
  // --- dark ------------------------------------------------------------------
  'ie2-dark': dark(
    'IE2 Dark',
    '#1b1d21',
    '#26292f',
    '#33373f',
    '#3a3f47',
    '#e6e8eb',
    '#9aa1ab',
    '#4f8cff'
  ),
  'dark-modern': dark(
    'Dark Modern',
    '#1f1f1f',
    '#252526',
    '#2d2d2d',
    '#3c3c3c',
    '#cccccc',
    '#9d9d9d',
    '#0078d4'
  ),
  abyss: dark('Abyss', '#000c18', '#082050', '#0b2f6b', '#0d3a86', '#dbe9ff', '#7996c4', '#ffbd2d'),
  'github-dark': dark(
    'GitHub Dark',
    '#0d1117',
    '#161b22',
    '#21262d',
    '#30363d',
    '#e6edf3',
    '#8b949e',
    '#58a6ff'
  ),
  'github-dark-dimmed': dark(
    'GitHub Dark Dimmed',
    '#22272e',
    '#2d333b',
    '#373e47',
    '#444c56',
    '#adbac7',
    '#768390',
    '#539bf5'
  ),
  'kimbie-dark': dark(
    'Kimbie Dark',
    '#221a0f',
    '#2f2418',
    '#3b2e1d',
    '#4b3a26',
    '#d3af86',
    '#a57a4c',
    '#f79a32'
  ),
  monokai: dark(
    'Monokai',
    '#272822',
    '#31322a',
    '#3e3d32',
    '#49483e',
    '#f8f8f2',
    '#a6a28c',
    '#a6e22e',
    '#e6db74'
  ),
  'monokai-dimmed': dark(
    'Monokai Dimmed',
    '#1e1e1e',
    '#272727',
    '#303030',
    '#3a3a3a',
    '#c5c8c6',
    '#8f9195',
    '#6a9fb5'
  ),
  red: dark('Red', '#390000', '#4a0f0f', '#5c1a1a', '#7a2626', '#f8f8f8', '#cf8b8b', '#ff7a7a'),
  'solarized-dark': dark(
    'Solarized Dark',
    '#002b36',
    '#073642',
    '#0b4553',
    '#12586b',
    '#eee8d5',
    '#93a1a1',
    '#268bd2',
    '#b58900'
  ),
  'tokyo-night': dark(
    'Tokyo Night',
    '#1a1b26',
    '#20212e',
    '#292e42',
    '#343a52',
    '#c0caf5',
    '#787c99',
    '#7aa2f7'
  ),
  'tokyo-night-storm': dark(
    'Tokyo Night Storm',
    '#24283b',
    '#2a2e42',
    '#343a52',
    '#3d4260',
    '#c0caf5',
    '#8189af',
    '#7aa2f7'
  ),
  'tomorrow-night-blue': dark(
    'Tomorrow Night Blue',
    '#002451',
    '#00346e',
    '#00457c',
    '#204a87',
    '#ffffff',
    '#9fb0c9',
    '#bbdaff'
  ),
  'vs-2019-dark': dark(
    'Visual Studio 2019 Dark',
    '#1e1e1e',
    '#252526',
    '#2a2d2e',
    '#3f3f46',
    '#d4d4d4',
    '#9b9b9b',
    '#569cd6'
  ),
  'dark-high-contrast': {
    name: 'Dark High Contrast',
    mode: 'dark',
    colours: {
      bg: '#000000',
      bgElevated: '#0a0a0a',
      bgHover: '#1a1a1a',
      border: '#6fc3df',
      text: '#ffffff',
      textDim: '#d6d6d6',
      accent: '#1aebff',
      mark: '#ffff00',
      hover: 'rgba(255, 255, 255, 0.18)',
      overlay: 'rgba(255, 255, 255, 0.12)'
    }
  },

  // --- light -----------------------------------------------------------------
  'ie2-light': light(
    'IE2 Light',
    '#f4f5f7',
    '#ffffff',
    '#e9ebef',
    '#d6dae1',
    '#1b1d21',
    '#5f6672',
    '#2f6fdb'
  ),
  'light-modern': light(
    'Light Modern',
    '#f8f8f8',
    '#ffffff',
    '#ececec',
    '#d4d4d4',
    '#3b3b3b',
    '#6b6b6b',
    '#005fb8'
  ),
  'github-light': light(
    'GitHub Light',
    '#f6f8fa',
    '#ffffff',
    '#eaeef2',
    '#d0d7de',
    '#1f2328',
    '#656d76',
    '#0969da'
  ),
  'quiet-light': light(
    'Quiet Light',
    '#f5f5f5',
    '#ffffff',
    '#e4e9e4',
    '#d0d5d0',
    '#333333',
    '#6a706a',
    '#7a3e9d'
  ),
  'solarized-light': light(
    'Solarized Light',
    '#fdf6e3',
    '#fffbf0',
    '#eee8d5',
    '#ddd6c1',
    '#073642',
    '#657b83',
    '#268bd2',
    '#b58900'
  ),
  'tokyo-night-light': light(
    'Tokyo Night Light',
    '#e6e7ed',
    '#ffffff',
    '#dcdee6',
    '#c8cad4',
    '#343b58',
    '#6c6e75',
    '#34548a'
  ),
  'vs-2019-light': light(
    'Visual Studio 2019 Light',
    '#f5f5f5',
    '#ffffff',
    '#e8e8e8',
    '#cccedb',
    '#1e1e1e',
    '#616161',
    '#0066b8'
  ),
  'light-high-contrast': {
    name: 'Light High Contrast',
    mode: 'light',
    colours: {
      bg: '#ffffff',
      bgElevated: '#ffffff',
      bgHover: '#ededed',
      border: '#0f4a85',
      text: '#000000',
      textDim: '#3b3b3b',
      accent: '#0f4a85',
      mark: '#6c4a00',
      hover: 'rgba(0, 0, 0, 0.14)',
      overlay: 'rgba(0, 0, 0, 0.08)'
    }
  }
}

export type ThemeId = keyof typeof THEMES

export const DEFAULT_THEME = 'ie2-dark'

export function themeById(id: string): Theme {
  return THEMES[id] ?? THEMES[DEFAULT_THEME]
}

/** Grouped for the settings menu, dark first. */
export function themesByMode(): { dark: [string, Theme][]; light: [string, Theme][] } {
  const entries = Object.entries(THEMES)
  return {
    dark: entries.filter(([, t]) => t.mode === 'dark'),
    light: entries.filter(([, t]) => t.mode === 'light')
  }
}
