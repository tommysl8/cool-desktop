# Install PixelClock Desktop

Section 1 builds everything and copies it into place. After that, set up the pieces you want, in any order: the
Chrome new tab, the live wallpaper, or the still wallpaper. To take it all out again, see
[UNINSTALL.md](UNINSTALL.md).

How to read the steps:

- Labels on the screen are in bold, spelled as you will see them. Code text is something to type or paste.
- Run commands in Command Prompt in this folder: press Win+R, type `cmd`, press Enter, then `cd` to this folder.
- Every step ends with what you should see.

You need Windows 11, Node.js 22 or newer and Python 3 (the build zips the wallpaper with it), plus Google Chrome
for the new tab and Lively Wallpaper (free, from the Microsoft Store) for the live wallpaper.

## 1. Settings, build and install

1. Run `copy config\user.example.json config\user.json`. You see a new `config\user.json` beside the example.
2. Open it with `notepad config\user.json`, set your city, units, clock and links (the table below) and save it.
   You see your values in the file.
3. Run `node tools/build.mjs`. You see a line for every file it writes, a summary table and, last, a line starting
   with `build OK`.
4. Run `node tools/install.mjs`. You see every file it copies, a line starting with `install:` and your next steps,
   each starting with `next:`.

When a PixelClock checkout sits next to this folder, the build first refreshes the clock's engine from it;
otherwise it builds from the copy in `vendor/pixelclock`.

The installer copies `dist\newtab` to `%LOCALAPPDATA%\PixelClockDesktop\chrome-newtab` (Chrome loads the new tab
from there) and `dist\still` to `%LOCALAPPDATA%\PixelClockDesktop\still`. In the still's folder it also writes
`still.json` (the still's settings, only the first time), `run-hidden.js` and `task.xml` (for the scheduled task),
and makes an empty `out` folder for the pictures. It never registers the task or changes your wallpaper. The Lively
zip stays in `dist`, because Lively keeps its own copy. Add `--dry-run` to see what it would do without changing
anything.

What goes in `config\user.json` (strict JSON: double quotes, no comments):

| key | what it is | in the example |
|---|---|---|
| `"city"` | your city, for the weather and the real sunrise and sunset; a city and a two-letter country code works too, like `"Berlin, DE"` | `"Berlin"` |
| `"units"` | `"C"` or `"F"` | `"C"` |
| `"clock"` | `"24h"` or `"12h"` | `"24h"` |
| `"shortcuts"` | your links, at most 9, each like `{ "label": "maps", "url": "https://www.openstreetmap.org" }`; in the new tab, type a link's number and press Enter to open it | wikipedia, maps, open-meteo |
| `"sunTimes"` | follow the real sunrise and sunset | `true` |
| `"weather"` | show the weather | `true` |
| `"taskbarPx"` | room for the taskbar at the bottom of the wallpapers, in px; the text stays above it | `56` |

These are only the starting values. Later you change them in each piece: the new tab's settings, Lively's
**Customise** panel, and `still.json` for the still.

## 2. Chrome new tab

1. Go to `chrome://extensions` and turn on **Developer mode** (top right). Leave it on: Chrome switches unpacked
   extensions off while it is off. You see a **Load unpacked** button.
2. Click **Load unpacked**, paste `%LOCALAPPDATA%\PixelClockDesktop\chrome-newtab` into the folder window's address
   bar, press Enter and click **Select Folder**. You see a **PixelClock Desktop** card.
3. If another extension already replaces your new tab, switch its card off: Chrome shows one new tab page at a time.
   You see that card switched off.
4. Press Ctrl+T. If Chrome asks whether to keep the new tab page, click **Keep it**. You see the scene fill the tab,
   with the clock and the terminal on the left.
5. Type `help` and press Enter. You see the list of commands.
6. Type `settings` and press Enter. You see the settings sheet beside the scene, with **clock**, **city**, **units**
   and the rest. Changes apply at once and are saved in Chrome; Esc closes the sheet.
7. If Chrome asks to let the page look for devices on your local network, allow it. You see a line like
   `⌂ next alarm tomorrow 07:00 · work` under the date once your PixelClock answers. Without a clock, or if you block
   it, that line just stays hidden.

Good to know:

- So that your typing goes straight to the terminal, the page reloads itself once as it opens, and the address bar
  shows the extension's address instead of staying empty. Ctrl+L still takes you to the address bar. To keep
  Chrome's usual way, turn off **focus on open** in the settings.
- After a new build and install, click **Reload** on the PixelClock Desktop card. Your settings stay.
- Incognito windows always show Chrome's own new tab.

## 3. Live wallpaper (Lively)

1. Open **Lively Wallpaper** from the Start menu. You see its library of wallpapers.
2. Click **Add Wallpaper** (the + button), then **Browse**, and pick `dist\PixelClockDesktop-wallpaper.zip` in this
   folder. You see a new **PixelClock Desktop** tile.
3. Click the tile once (importing alone does not apply it). You see the scene on your desktop within a few seconds,
   with the clock and the weather on the right.
4. Right-click the tile and choose **Customise**. You see the settings in the table below. Set **City** and
   **Units**, and **Column side** if your desktop icons sit on the right; text boxes apply about 1.5 seconds after
   you stop typing.
5. In Lively's **Settings**, under **Performance**, check that **Applications fullscreen** is **Pause** (the default)
   and set **When on Battery Saver** to **Pause**. You see **Pause** in both.
6. Under **Wallpaper**, set **Wallpaper input** to **Off**. You see **Off**, and your desktop icons stay clickable.
7. With more than one screen, Lively shows one wallpaper per screen: pick the screen in Lively, then click the tile,
   once for each screen. You see the scene on every screen, laid out for its size.

What is in **Customise**:

| setting | what it does | starts as |
|---|---|---|
| **Theme** | **Auto (by date)** follows the calendar; or pick one scene | **Auto (by date)** |
| **Surprise me** | a random scene until midnight, or until you change **Theme** | - |
| **Shake** | shakes the scene now | - |
| **Surprise on the hour (10 am to midnight)** | shakes the scene on the hour | on |
| **24-hour clock** | 20:40 instead of 8:40 pm | from `"clock"` |
| **Follow the real sunrise and sunset** | ties the scene's light to your city's day | from `"sunTimes"` |
| **City** | the city for the weather and the sun | from `"city"` |
| **Units** | **Fahrenheit** or **Celsius** | from `"units"` |
| **Show weather** | the weather in the column | from `"weather"` |
| **Weather in the scene** | rain, snow, fog and clouds in the picture | on |
| **Refresh weather** | fetches the weather now | - |
| **Reduced motion** | a still frame each minute instead of the animation | off |
| **Performance mode (15 fps)** | 15 frames a second instead of 30 | off |
| **Performance mode on battery** | 15 frames a second while on battery | on |
| **Column side** | **Right** or **Left**: where the clock and the weather sit | **Right** |
| **Keep clear of the taskbar** | keeps the text above the taskbar | on |
| **Debug overlay** | technical readings at the top of the screen: size, frame rate, pauses | off |

After a new build: right-click the old tile, choose **Delete**, and add the new zip with steps 2 and 3 (adding it
again without deleting makes a second tile). **Customise** starts from the defaults again.

## 4. Still wallpaper

Instead of the live wallpaper, Windows can show a still picture of the scene, drawn again every 15 minutes by a
scheduled task, with nothing running in between. It shows the date where the clock would be, because a picture can
be 15 minutes old. While Lively plays a wallpaper the task does nothing, so use one or the other.

Run these in Command Prompt. The installer printed the same commands with your full paths.

1. Save your screen size once: `node "%LOCALAPPDATA%\PixelClockDesktop\still\pcd-still.mjs" --detect`. You see a
   line starting with `detected`, then one starting with `saved to`.
2. Register the task: `schtasks /Create /TN "PixelClock Desktop\Still wallpaper" /XML "%LOCALAPPDATA%\PixelClockDesktop\still\task.xml"`.
   You see a line starting with `SUCCESS:`.
3. If Lively is playing a wallpaper, right-click its icon in the taskbar's tray and choose **Exit**. You see your
   usual desktop picture.
4. Run it once now: `schtasks /Run /TN "PixelClock Desktop\Still wallpaper"`. You see a line starting with
   `SUCCESS:` and, a few seconds later, the still picture on your desktop.

From then on it runs every 15 minutes, when you sign in and when you unlock the computer. To change its city, units,
clock or scene, edit `"city"`, `"units"`, `"clock24"` or `"theme"` in
`%LOCALAPPDATA%\PixelClockDesktop\still\still.json`; the next run uses them. Its pictures and its log (`still.log`)
are in the `out` folder next to it. After a new build and install there is nothing to do: the next run uses the new
files.

| to | run |
|---|---|
| pause it | `schtasks /Change /TN "PixelClock Desktop\Still wallpaper" /Disable` |
| resume it | `schtasks /Change /TN "PixelClock Desktop\Still wallpaper" /Enable` |
| remove it | `schtasks /Delete /TN "PixelClock Desktop\Still wallpaper" /F` |

If a console window flashes every 15 minutes, run `node tools/install.mjs --conhost` once: the task then starts
Node hidden through `conhost.exe --headless`.
