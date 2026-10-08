# Drops

A different take on desktop folders. A **Drop** is a small tile that lives on your
desktop (say "Games" or "School"). Drop apps onto it, and clicking it opens a list of
those apps right there. You never open a folder window.

## Download

**[⬇ Download the latest version](../../releases/latest)** (Windows 10 and 11)

- **Drops-Setup-x.y.z.exe** (recommended): installs Drops for your account and adds it to
  the Start menu. No admin rights needed.
- **Drops-x.y.z-portable.zip**: no install. Unzip it anywhere and run `Drops.exe`.

Windows may show **"Windows protected your PC"** the first time, because Drops isn't
signed with a paid certificate. Click **More info → Run anyway**.

To uninstall, go to **Settings → Apps → Installed apps → Drops → Uninstall**. Uninstalling
puts every app Drops took off your desktop back where it was.

## Using it

| To… | Do this |
| --- | --- |
| Open a Drop | Click its header. It closes again when you click elsewhere. |
| Launch an app | Click it in the list. |
| Add apps | Drag shortcuts, programs, files or folders onto a Drop, or click **+ Add apps** to pick from your desktop and Start menu. |
| Move a Drop | Drag its header. |
| Rename | Right-click the header → **Rename** (or press F2). Right-click an app → **Rename** for apps. |
| Reorder apps | Drag them up and down inside the list. |
| Move an app to another Drop | Right-click it → **Move to**, or drag it onto the other Drop. |
| Keep a Drop open | Click the pin on its header. |
| Change color / delete | Right-click the header. |
| New Drop | Tray icon → **New Drop**, or right-click any Drop header. |
| Bring all Drops to the front | Click the tray icon or press **Ctrl+Alt+D**. |

### Apps leave the desktop

Anything you add to a Drop disappears from the desktop and lives only in the Drop:

- **Your shortcuts** are moved into `%APPDATA%\Drops\Tidied`.
- **Shortcuts on the shared (all users) desktop** (most game launchers put theirs there)
  are moved too. Windows only allows that with admin rights, so you get one UAC prompt
  for each batch you add. If you decline, the app stays on the desktop but is still in the Drop.
- **Folders, files and programs** are *hidden* where they are, not moved, so nothing that
  depends on their location breaks. (If Explorer is set to show hidden files, you'll still
  see them, faded.)

Removing an app from its Drop puts it back on the desktop. Shared-desktop shortcuts come
back on your own desktop, so no admin prompt is needed. Deleting a Drop puts all its apps
back. The tray menu has **Put all apps back on the desktop** to undo everything, and
**Remove apps from desktop when added** to turn the behavior off.

### Tray menu

Right-click the Drops icon in the system tray (click **^** next to the clock if it's
hidden) for: New Drop, Show all, Add apps to…, Keep Drops on top of windows, Remove apps
from desktop when added, Start with Windows, and Quit.

Your Drops are saved in `%APPDATA%\Drops\drops.json`.

## Building from source

```powershell
npm install
npm start       # run from source
npm run dist    # build dist\Drops-Setup-x.y.z.exe and the portable zip
```

## Publishing a new version

GitHub Actions builds the installer and publishes the release for you:

```powershell
npm version 1.0.1     # bumps package.json, commits, and tags v1.0.1
git push --follow-tags
```

A few minutes later the new version shows up on the Releases page. To test a build
without releasing it, open **Actions → Release → Run workflow** and download the files
from the finished run.

## How it works

- `src/main.js`: windows, tray, menus, IPC. Each Drop is a frameless, transparent
  window that resizes itself when it opens.
- `src/apps.js`: icons, desktop/Start menu scanning, tidy/restore.
- `src/iconworker.ps1`: a long-lived PowerShell helper that asks the Windows shell for
  64px icons (sharp, no shortcut arrow, works for Steam `.url` links too). If PowerShell
  is unavailable, Electron's 32px icons are used instead.
- `src/ui/`: the Drop widget and the *Add apps* picker.
- `src/dev-snapshot.js`: dev-only. `DROPS_SNAPSHOT=<dir>` captures every window to PNG,
  and `DROPS_SELFTEST=1` also runs the tidy/rename checks.
