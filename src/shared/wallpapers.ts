/**
 * Wallpapers that ship with the browser.
 *
 * They live in src/renderer/wallpapers and are served through ie2://wallpaper
 * like any other, so nothing downstream needs to know whether an image came
 * with the app or from the user's own disk.
 *
 * The names are for the picker's labels; the picker also shows each one, so
 * they only have to tell two entries apart rather than describe the picture.
 */

export interface BuiltInWallpaper {
  /** File name inside the wallpapers directory. Never a path. */
  file: string
  name: string
}

export const BUILT_IN_WALLPAPERS: BuiltInWallpaper[] = [
  { file: 'desmumtz11.jpg', name: 'Reaper' },
  { file: 'des37.jpg', name: 'Reaper II' },
  { file: '6045432.jpg', name: 'Drift' },
  { file: 'japan-artistic-3840x2160-25406.jpg', name: 'Japan' },
  { file: 'mountain-landscape-4800x3600-26973.png', name: 'Mountains' },
  {
    file: 'windows-11-dark-mode-abstract-background-black-background-3840x2160-8710.png',
    name: 'Dark abstract'
  },
  { file: 'aluminium-os-stock-4096x4096-26370.jpg', name: 'Aluminium' },
  { file: 'aluminium-os-stock-5120x5120-26371.jpg', name: 'Aluminium II' }
]

/** True only for names we ship — the only ones the protocol will serve. */
export function isBuiltInWallpaper(file: string): boolean {
  return BUILT_IN_WALLPAPERS.some((wallpaper) => wallpaper.file === file)
}
