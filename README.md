# IE2

A desktop browser built on Electron and Chromium.

It captures the text of every page you read and indexes it, so you can search
what a page **said** — not just its title and URL. Type a half-remembered phrase
from an article and the article comes back.

No mainstream browser does this. The one it is named after was famous for
forgetting your tabs.

> **IE2 is not Internet Explorer.** It is not affiliated with, endorsed by, or
> connected to Microsoft in any way. The name is a nod to Microsoft's Internet
> Explorer, which was retired in 2022; "Internet Explorer" is Microsoft's
> trademark and is used here only to say what the joke refers to.

## Running it

```bash
npm install
npm run dev
```

Developed and built on Node 24; CI runs the same. Older versions are untested.
Windows is the only platform currently packaged, though nothing in the code is
deliberately Windows-only except the native window-control overlay.

## Building an installer

```bash
npm run dist
```

Produces, in `dist/`:

| File | What it is |
|---|---|
| `IE2-Setup-<version>.exe` | NSIS installer, per-user, choosable install directory |
| `IE2-Portable-<version>.exe` | Single file, no install, good for testing |

`npm run dist` refuses to start if the browser is still running, type checks,
verifies every IPC channel has a handler, and then confirms that the artifacts
for the current version were actually rewritten — so a failed package cannot
look like a successful one. It prints `BUILD OK` or `BUILD FAILED` with a
reason. See [BUILDING.md](BUILDING.md) for the longer version.

The build is **unsigned**, so Windows SmartScreen shows "Windows protected your
PC" on first run. Click *More info* then *Run anyway*. Signing needs a code
signing certificate, which costs real money.

`npm run dist:dir` skips the installers and leaves an unpacked app in
`dist/win-unpacked/` — faster when you only want to check that it runs.

## Releasing

Installed copies update themselves from this repository's GitHub releases, so a
release is how anyone other than you gets a new version.

1. Add the changes to the top of [CHANGELOG.md](CHANGELOG.md) under a
   `## <version>` heading. The browser reads that section to show what changed,
   once, after updating.
2. Bump `version` in `package.json`.
3. Set a GitHub token with `repo` scope, then publish:

```bash
npm run release
```

That builds and uploads both installers **and `latest.yml`**. The updater
compares against `latest.yml`; without it, installed copies never see the
release no matter what is attached to it. `npm run dist` builds the same files
without uploading anything.

Tag the commit to match, so the source and the release agree.

## Features

**The reason it exists**

- **Total recall** — full-text search over the body text of every page visited,
  ranked with SQLite FTS5 and BM25. Searchable from the omnibox and from the
  new tab page.
- **Amnesia tabs** (Ctrl+Shift+N) — separate non-persistent session, nothing
  recorded, excluded from session restore, and marked in the strip so you never
  have to guess which mode you are in.
- **Never-remember list** — per-domain exclusion from recording, subdomains
  included, plus a purge for what is already stored.

**Tabs**

- Tab groups: named, coloured, contiguous runs, formed by right-click or by
  dragging a tab in among them
- Pinned tabs, which survive quitting the browser
- Sleeping tabs: an idle tab's page is discarded to give its memory back, and
  its full Back/Forward history is restored when you return to it
- Multi-select with Ctrl+click and Shift+click; tab commands act on the lot
- Split view, drag to reorder, drag out to a new window, reopen closed tabs

**Everything else**

- **Ad and tracker blocking** — Ghostery's filter lists at the network layer,
  plus scriptlets injected at document start so ads served from the same origin
  as the content are dealt with too. Per-site off switch for pages a filter list
  breaks.
- **Compatibility Mode** — genuinely claims to be MSIE 6.0 and applies
  period-accurate typography. Sites break. That is the feature.
- Picture in picture, screenshots, QR codes, media controls, a command palette,
  bookmarks with folders, downloads, and import from Chrome, Edge, Brave and
  Firefox
- 23 themes, a full colour picker, and a customisable new tab page
- Translations editable **inside the browser**, stored as JSON — no rebuild, and
  you can add a language the browser does not ship with

Press **?** in the toolbar, or open `ie2://help`, for the full manual.

## Layout

```
src/
├── main/               Main process
│   ├── index.ts        Windows, IPC, shortcuts, session restore
│   ├── tabs.ts         Tab lifecycle, groups, pinning, sleep, split view
│   ├── db.ts           SQLite: history, FTS index, bookmarks, settings
│   ├── capture.ts      Page text extraction (isolated world)
│   ├── suggest.ts      Omnibox suggestions (local)
│   ├── autocomplete.ts Search engine suggestions (network, opt-in)
│   ├── adblock.ts      Filter engine, scriptlets, per-site rules
│   ├── locale.ts       Translation overlays on disk
│   ├── protocol.ts     ie2:// internal pages and wallpapers
│   └── …               downloads, import, media, pip, screenshot, pwa
├── preload/
│   ├── index.ts        Bridge for the browser UI
│   ├── internal.ts     Bridge for ie2:// pages only
│   └── adblock.ts      Scriptlet injection, at document start
├── renderer/           Browser UI and internal pages
└── shared/             Types, settings, themes, i18n catalogue
scripts/
├── build.js            Checked packaging wrapper
├── check-ipc.js        Every preload channel must have a handler
├── extract-ui-strings.js  Page wording → translation catalogue
└── make-icon.js        Generates the app icon
```

## Security model

- Web content runs sandboxed, context-isolated, with no Node and no preload API
  beyond scriptlet injection. Pages cannot reach the browser UI or the main
  process.
- The chrome UI is a separate `WebContentsView` that never loads remote content.
- Internal `ie2://` pages get an API, and the main process verifies the sender's
  URL on every one of those channels — the preload check is convenience, not the
  boundary.
- Camera, microphone and geolocation are denied for every site, with no prompt,
  because the prompt UI does not exist yet.
- All page-controlled strings are inserted with `textContent`, never `innerHTML`.

### What is stored, and where

Everything lives in one SQLite file under `%APPDATA%/internet-explorer-2/`.
Nothing is uploaded anywhere, because there is nowhere to upload it to.

Login, checkout and banking pages are excluded from text capture by hostname
and path patterns (`accounts.*`, `/login`, `/checkout`, and similar). This is a
heuristic: **a logged-in dashboard on an ordinary URL will have its text
captured.** Use an amnesia tab or the never-remember list when that matters.

## Contributing

Before opening a pull request:

```bash
npm run typecheck
node scripts/check-ipc.js
node scripts/extract-ui-strings.js   # if you added or reworded any UI text
```

The same checks run in CI. Two things worth knowing:

- **IPC is not type checked across the boundary.** A channel the preload calls
  with no handler in the main process compiles cleanly and then rejects at
  runtime, blanking whatever page awaited it. `check-ipc.js` exists because that
  shipped once.
- **User-visible text belongs in the catalogue.** Either add a key to
  `src/shared/i18n.ts`, or wrap the string in `t('…')` and re-run the extractor.

## Licence

[Apache License 2.0](LICENSE), copyright 2026 Loseless02.

You may use, modify and redistribute this, including commercially. In return the
licence asks that you keep the copyright notice and the [NOTICE](NOTICE) file
with it, say what you changed, and not imply that this project endorses whatever
you built. It also grants you a patent licence, and grants no rights to the
project's name.

### Wallpapers

The wallpapers that ship with IE2 are **not mine and I do not
claim them to be**. They were taken from [wallpapercave.com](https://wallpapercave.com)
and I do not own them. They are **not** covered by the licence above.

If you own one of these images and would rather it were not here, open an issue
and it will be removed. Per-file details are in
[the note beside them](src/renderer/public/wallpapers/README.md).

Chromium, Electron, SQLite and Ghostery's filter lists carry their own licences.
