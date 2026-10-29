# Changelog

The newest version goes at the top. The browser reads the first section of this
file to show "what's new" once after an update, so keep the heading format —
`## <version>` — exactly as it is here.

## 0.9.0

- Chrome extensions. Open one in the Chrome Web Store and press its Add
  button; a card under the toolbar says what it will be able to do, and anything it
  needs that IE2 does not have, before it is added. Extensions update
  themselves
- The jigsaw button lists them: click one to open it, pin it beside the
  address bar, or turn it off, change its options and remove it. Badges,
  popups, right-click items and extension keyboard shortcuts all work.
  Installed apps have the button too
- Dark mode, the moon button: websites turn dark as they are drawn, so a white
  page never flashes up first. Sites with their own dark theme show it; the
  rest are darkened without restyling them, leaving photos and video alone.
  Switch it off for any site that looks wrong, without reloading
- The Chrome Web Store no longer nags about switching to Chrome

## 0.8.2

- A short opening animation each time IE2 starts
- The address bar finishes the address as you type — "y" becomes youtube.com
  if that is where you go — so Enter takes you there
- Middle- and Ctrl+click open links in a tab behind, right next to the page
- Closing a tab goes back to the tab you were on before it, not its neighbour
- Tabs open and close smoothly: a closing tab fades where it stands, then the
  others close the gap
- Much richer right-click menus for links, images, video, selected text and
  spelling — including Copy clean link, which drops tracking codes
- A rounded frame round the page (Settings → Appearance → Page frame)
- Custom theme is a switch of its own now: its colours stay visible, locked,
  until it is on, and switching it off brings back the theme you had
- New on/off switches throughout
- Public IP shows the country too, without asking for your location
- Install updates automatically: an option to download and restart into a new
  version as soon as one is found at startup
- Thunder no longer starts with a hiss
- Settings: no sideways scrollbar in the menu, and cards no longer light up
  unless they can be clicked

## 0.8.1

- Custom theme: pick Theme → Custom… in Settings and set every colour yourself —
  background, surfaces, lines, text and more — starting from any built-in theme
- Installed web apps have a title bar now: back, reload, the page's title, the
  audio effects, and a button to open the page in a normal tab. Passwords fill
  in apps too
- The bookmarks bar can show always, only on the new tab page, or never
- Reader mode reads the whole page, not just the first block of it — pages
  built from cards and sections, and text that fades in as you scroll, come
  through
- The manual is reorganised, with contents at the top and sections for sound
  and installed apps
- Fixed: Sleep after showed a percentage instead of minutes
- Fixed: a bookmarks bar folder stayed highlighted after its list closed
- Fixed: the new tab page's Customise panel scrolled sideways
- Settings cards no longer sit edge to edge

## 0.8.0

- Passwords: IE2 offers to save a login when you sign in, offers to update it
  when the password changes, and fills it next time. Everything is sealed with a
  master password and locks itself after a few idle minutes. Manage, edit,
  generate, import and export them at ie2://passwords
- Bookmarks, rebuilt: the star saves straight into a new bookmarks bar under the
  toolbar and says where, with a box to rename it or pick another folder. The
  bookmarks button opens a sidebar beside the page — folders you can fold,
  rename, nest and drag bookmarks between — and bookmarks can be exported
- Sites can ask for the camera, microphone, location and notifications. Each
  asks once; the lock in the address bar shows and changes what a site may use.
  Fullscreen video works again
- Mood: rain, wind, thunder and crickets, mixed with sliders, with presets,
  slow drift and a sleep timer. Keeps playing with its panel closed
- Audio effects: slowed + reverb, nightcore, or your own mix for whatever a tab
  is playing — speed, reverb, room size, bass boost and keep-the-pitch, with
  presets you can save and a switch to remember a site. Built in and free
- Public IP: the address websites see, blurred until you click it, every time
- Drag a tab onto another window's tab strip to move it there, exactly where
  the marker shows — the page moves without reloading
- Hover a toolbar tool to see what it does. Tools that cannot work on the page
  in front are greyed out and say why. Press and hold a tool to slide it into a
  different place on the toolbar
- Importing from another browser lets you pick what comes across, and Firefox
  cookies can come too, so you stay signed in
- The new tab page is readable over any wallpaper
- Fixed: an installed web app opened in the browser window instead of its own
  whenever IE2 was already running
- Fixed: closing a new tab with Ctrl+W left the address bar without the caret
- Fixed: search suggestions flickered on every keystroke. Esc now closes them
  and keeps what you typed
- Fixed: tool popups stayed open until clicked again; any click elsewhere now
  closes them
- Fixed: the address bar could keep showing the previous page's address

## 0.4.1

- Updating is one button: Check for updates downloads whatever it finds, then
  asks before restarting — and says what survives a restart and what does not
- Updates install silently and IE2 opens again by itself, instead of walking
  you through the installer as if setting it up for the first time
- Fixed: restarting to install an update lost your open tabs

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
