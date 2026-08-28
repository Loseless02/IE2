import { defineConfig } from 'electron-vite'
import { resolve } from 'node:path'
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')) as {
  version: string
}

/**
 * Baked in so a running build can say exactly what it is. Guessing whether the
 * window in front of you includes a given change is not a debugging technique.
 */
const stamp = {
  __APP_VERSION__: JSON.stringify(pkg.version),
  __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  __BUILD_COMMIT__: JSON.stringify(shortCommit())
}

function shortCommit(): string {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim()
  } catch {
    // Not a checkout, or git is unavailable — the timestamp still identifies it.
    return 'nogit'
  }
}

export default defineConfig({
  main: {
    define: stamp,
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') }
      }
    }
  },
  preload: {
    define: stamp,
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          internal: resolve(__dirname, 'src/preload/internal.ts'),
          // Runs in every page, before the page's own scripts.
          adblock: resolve(__dirname, 'src/preload/adblock.ts')
        },
        output: { format: 'cjs', entryFileNames: '[name].js' }
      }
    }
  },
  renderer: {
    define: stamp,
    root: resolve(__dirname, 'src/renderer'),
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          home: resolve(__dirname, 'src/renderer/home.html'),
          help: resolve(__dirname, 'src/renderer/help.html'),
          settings: resolve(__dirname, 'src/renderer/settings.html'),
          translate: resolve(__dirname, 'src/renderer/translate.html'),
          bookmarks: resolve(__dirname, 'src/renderer/bookmarks.html'),
          history: resolve(__dirname, 'src/renderer/history.html'),
          reader: resolve(__dirname, 'src/renderer/reader.html')
        }
      }
    }
  }
})
