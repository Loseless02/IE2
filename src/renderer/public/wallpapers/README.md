# Built-in wallpapers

These ship with the browser and are offered under **New tab → Background → One
that came with the browser**. They are served through `ie2://wallpaper/<name>`,
which only answers for names listed in `src/shared/wallpapers.ts`.

## Where they came from

These were taken from [wallpapercave.com](https://wallpapercave.com). They are
not the project's own work, no ownership is claimed over them, and they are not
covered by the project's MIT licence.

**Attribution is not the same as permission.** WallpaperCave is an aggregator:
it hosts images uploaded by users and does not itself grant redistribution
rights, and the original photographers and artists are mostly unidentified. So
crediting the source records honestly where the files came from, but it does not
make redistributing them in a public repository or inside an installer
permitted. That remains a risk the project is choosing to carry.

If that risk is ever unwanted, removing an image is one line: delete its entry
from `src/shared/wallpapers.ts` and the file itself. The picker is generated
from that list, so nothing else changes. Note that deleting a file in a later
commit does **not** remove it from git history — that needs a history rewrite.

| File | Source | Original author |
|---|---|---|
| `6045432.jpg` | wallpapercave.com | unknown |
| `aluminium-os-stock-4096x4096-26370.jpg` | wallpapercave.com | unknown |
| `aluminium-os-stock-5120x5120-26371.jpg` | wallpapercave.com | unknown |
| `des37.jpg` | wallpapercave.com | unknown |
| `desmumtz11.jpg` | wallpapercave.com | unknown |
| `japan-artistic-3840x2160-25406.jpg` | wallpapercave.com | unknown |
| `mountain-landscape-4800x3600-26973.png` | wallpapercave.com | unknown |
| `windows-11-dark-mode-abstract-background-black-background-3840x2160-8710.png` | wallpapercave.com | unknown |

## Size

The set is roughly 30 MB, which is the bulk of this repository and of the
installer. The two `aluminium-os` files are 8 MB and 7.4 MB on their own;
downscaling them to the largest screen anyone will realistically use would cut
that substantially.
