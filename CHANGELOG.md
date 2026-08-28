# Changelog

The newest version goes at the top. The browser reads the first section of this
file to show "what's new" once after an update, so keep the heading format —
`## <version>` — exactly as it is here.

## 0.4.0

- Find in this page with Ctrl+F — Enter for the next match, Shift+Enter for the
  one before, Esc to close
- A history page at ie2://history: everywhere you have been, by day, with search.
  Remove one page, a whole day, or the lot
- Forget history is now separate from Forget everything — it drops the record of
  where you went and keeps the text of those pages, so recall still finds them
- Every row on the new tab page has an × to take it out of your history
- Installed web apps get the site's real icon again. Sites whose manifest points
  at icons that no longer exist (Spotify's do) fall back through the touch icon
  and favicon, and the shortcut now carries every size Windows asks for instead
  of one it has to stretch
- Reader mode: strips a page back to the article, with reading time, and
  controls for text size and column width
- IE2 can be your default browser — links, .html and .pdf files open in it, and
  PDFs now display instead of downloading
- Turkish now ships with the browser, so everyone gets it rather than only the
  machine it was written on
- Tab groups fold away when you click their chip, and unfold again
- Dragging a tab now actually follows the cursor, and dropping a link on the
  strip shows an arrow where it will land
- Animations throughout, and the setting that turns them off now reaches every
  page instead of only the toolbar
- Fixed: the update button gave no sign it was doing anything, Copy in About
  reported success when it had failed, and saved colours had no visible way to
  remove them

## 0.3.0
- Updates: the browser can now tell you when a new version exists

## 0.2.0

- Tab groups: named, coloured runs of tabs, made by right-click or by dragging
  a tab in among them
- Pinned tabs, which stay at the front of the strip and survive quitting
- Sleeping tabs: an idle tab's page is discarded to give its memory back and
  reloads, with its full history, when you come back to it
- Select several tabs with Ctrl+click or Shift+click and act on all of them
- Ads served from the same origin as the content are now blocked too — the
  scriptlets that handle that were crashing before they ran
- Per-site switch for turning blocking off on a page a filter list breaks
- Wallpapers, themes, a colour picker, and a customise button on the new tab page
- Translations you can edit inside the browser, and languages you can add yourself

## 0.1.0

- First build. Tabs, bookmarks, downloads, history, full-text recall of every
  page read, amnesia tabs, ad blocking, and Compatibility Mode.
