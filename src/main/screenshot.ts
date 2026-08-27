import { app, clipboard, dialog, nativeImage, type WebContents } from 'electron'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ScreenshotResult } from '../shared/types'

/**
 * Capture the visible page, put it on the clipboard immediately, and hold on to
 * it so the user can also save it as a PNG if they want.
 *
 * Nothing is written to disk unless they ask — a screenshot that silently
 * littered the downloads folder would be worse than useless.
 */

/** The last capture, kept in memory only, so Download has something to write. */
let lastCapture: { png: Buffer; suggested: string } | null = null

export async function captureVisible(wc: WebContents): Promise<ScreenshotResult | null> {
  try {
    const image = await wc.capturePage()
    if (image.isEmpty()) return null

    const png = image.toPNG()
    clipboard.writeImage(image)

    lastCapture = { png, suggested: suggestName(wc.getURL()) }

    // A small preview is enough for the panel; sending the full PNG over IPC
    // would mean copying several megabytes for a thumbnail.
    const size = image.getSize()
    const preview = image.resize({ width: Math.min(320, size.width) })

    return {
      preview: preview.toDataURL(),
      width: size.width,
      height: size.height,
      bytes: png.byteLength,
      suggested: lastCapture.suggested
    }
  } catch {
    return null
  }
}

/** Save the held capture. Returns the path written, or null if cancelled. */
export async function saveLastCapture(): Promise<string | null> {
  if (!lastCapture) return null

  const result = await dialog.showSaveDialog({
    title: 'Save screenshot',
    defaultPath: join(app.getPath('downloads'), lastCapture.suggested),
    filters: [{ name: 'PNG image', extensions: ['png'] }]
  })

  if (result.canceled || !result.filePath) return null

  try {
    await writeFile(result.filePath, lastCapture.png)
    return result.filePath
  } catch {
    return null
  }
}

export function hasCapture(): boolean {
  return lastCapture !== null
}

export function forgetCapture(): void {
  lastCapture = null
}

/** ie2-screenshot-example.com-2026-08-17-1421.png */
function suggestName(url: string): string {
  let host = 'page'
  try {
    host = new URL(url).hostname.replace(/^www\./, '') || 'page'
  } catch {
    // Keep the fallback.
  }

  const now = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(
    now.getHours()
  )}${pad(now.getMinutes())}`

  return `ie2-screenshot-${host}-${stamp}.png`
}

/** Also used when a page has no image at all, so the caller can say so. */
export function emptyImage(): Electron.NativeImage {
  return nativeImage.createEmpty()
}
