# Building it yourself

## The three commands you actually need

```bash
npm run dev
```
Development mode. Opens the browser with hot reload: edit anything under
`src/renderer/` and the UI updates without restarting. Editing `src/main/`
restarts the app automatically. **Use this while working — you almost never
need to package.**

```bash
npm run typecheck
```
Type-checks main and renderer without producing anything. Fast. Run it before
packaging; it catches the mistakes that would otherwise only show up at runtime.

```bash
npm run dist
```
The real thing: type-checks, compiles, and produces installers in `dist/`.
Takes a few minutes.

## What `npm run dist` produces

| File | What it is |
|---|---|
| `dist/IE2 Setup 0.1.0.exe` | Installer. Per-user, choosable directory, desktop and start menu shortcuts |
| `dist/IE2 Portable 0.1.0.exe` | Single file, no install. Best for testing |
| `dist/win-unpacked/` | The app as loose files. `IE2.exe` inside runs directly |

## Before you build — the one rule

**Close every running copy of IE2 first.**

Packaging deletes and recreates `dist/win-unpacked`. Windows will not let it
delete a folder that a running process is using, and the build fails with:

```
⨯ EBUSY: resource busy or locked, rmdir '...\dist\win-unpacked'
```

Check nothing is running:

```bash
powershell -Command "Get-Process 'IE2' -ErrorAction SilentlyContinue"
```

No output means you are clear. To close them:

```bash
powershell -Command "Get-Process 'IE2' -ErrorAction SilentlyContinue | Stop-Process"
```

## How to tell whether the build actually worked

electron-builder prints a `⨯` line and keeps going, and **npm can still report
success**, so do not trust a green-looking terminal. Check one of these:

1. **Look for the failure marker** in the output:
   ```bash
   npm run dist 2>&1 | grep "⨯"
   ```
   No output means no error.

2. **Check the timestamps** — the surest test. If the exe was not rewritten
   just now, the build did not replace it:
   ```bash
   powershell -Command "Get-ChildItem dist -Filter *.exe | Select-Object Name, LastWriteTime"
   ```

Never pipe the build into `head` or `tail` and read the exit code — the exit
code you get back is the pipe's, not the build's. This bit me during
development, and I reported a successful build that had in fact failed.

## Other failures you may hit

| Message | Cause | Fix |
|---|---|---|
| `EBUSY ... rmdir win-unpacked` | The app is running | Close it (above) |
| `EPERM ... rename win-unpacked.tmp` | A leftover temp folder, or antivirus holding a new exe | `rm -rf dist` and retry |
| `Attempted to register a second handler` | Two ad blocker sessions | Already fixed — shout if it returns |
| SmartScreen "Windows protected your PC" | The build is unsigned | *More info* → *Run anyway*. Signing needs a paid certificate |

## Faster loops

```bash
npm run dist:dir
```
Skips the installers, just fills `dist/win-unpacked/`. Much quicker when you
only want to confirm the packaged app runs.

```bash
npm run icon
```
Regenerates `build/icon.ico` from `scripts/make-icon.js`. Only needed if you
change the icon drawing code.

## Testing a packaged build

Run `dist/win-unpacked/IE2.exe` directly, or the portable exe.

If you start it from a terminal, **do not pipe its output** into another
command. When that pipe closes, the app's next log write raises `EPIPE` and
Windows shows "A JavaScript error occurred in the main process". The app now
survives this, but the cleanest way to see logs is:

```bash
"dist/win-unpacked/IE2.exe" > app.log 2>&1
```

## Where your data lives

`%APPDATA%\internet-explorer-2\`

| File | Contents |
|---|---|
| `browser.db` | History, page text index, bookmarks, settings, counters |
| `adblock-engine.bin` | Cached filter lists (~7 MB) |
| `apps/` | Icons for installed web apps |

Dev and packaged builds share this folder, so your history carries across both.
Deleting `browser.db` resets the browser to empty; it is recreated on launch.

## Version numbers

The version in the artifact names comes from `version` in `package.json`. Bump
it there before a release build, or every build overwrites the last one.
