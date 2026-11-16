# Uninstall PixelClock Desktop

Each piece comes out on its own, in any order. Remove the files last, because Chrome loads the new tab from them.
The steps read like the ones in [INSTALL.md](INSTALL.md): labels on the screen are in bold, code text is something
to type, and every step ends with what you should see.

## Chrome new tab

1. Go to `chrome://extensions`. You see the **PixelClock Desktop** card.
2. Click **Remove** on the card, then **Remove** again. You see the card disappear; its settings go with it.
3. Press Ctrl+T. You see Chrome's own new tab again, or the page of another new-tab extension you switch on.

To pause it instead, switch the card off. Switching it on again brings it back with your settings.

## Live wallpaper (Lively)

1. Open **Lively Wallpaper** from the Start menu. You see its library.
2. If the PixelClock Desktop wallpaper is on, click another tile. You see that wallpaper instead.
3. Right-click the **PixelClock Desktop** tile and choose **Delete**. You see the tile disappear.

## Still wallpaper

1. In Command Prompt, run `schtasks /Delete /TN "PixelClock Desktop\Still wallpaper" /F`. You see a line starting
   with `SUCCESS:`.
2. Press Win+R, paste `ms-settings:personalization-background` and press Enter. You see the **Background** settings.
3. Pick another picture there. You see it on your desktop; Windows keeps the last still until you do.

## Files

1. Remove the new tab and the scheduled task first (above). You see no PixelClock Desktop card on
   `chrome://extensions`.
2. Press Win+R, type `%LOCALAPPDATA%` and press Enter. You see a folder named **PixelClockDesktop**.
3. Delete that folder. You see it disappear. It held the installed new tab and the still wallpaper with its
   settings, pictures and log.

The new tab's settings lived in Chrome and the wallpaper's in Lively, so they went with the card and the tile. This
project folder still holds your `config\user.json` and the build in `dist`; delete it too if you no longer need it.
