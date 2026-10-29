import type { BrowserApi } from './index'
import type { InternalApi } from './internal'
import type { AppBarApi } from './appbar'

declare global {
  interface Window {
    browser: BrowserApi
    ie2: InternalApi
    appbar: AppBarApi
  }
}

export {}
