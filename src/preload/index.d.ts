import type { BrowserApi } from './index'
import type { InternalApi } from './internal'

declare global {
  interface Window {
    browser: BrowserApi
    ie2: InternalApi
  }
}

export {}
