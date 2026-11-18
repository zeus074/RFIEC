# RFIEC desktop app

The two programs of [retrofixer.it](https://retrofixer.it/xum1541/), drive and printer, as an offline app for
**Windows, Linux and macOS**. They are the same programs, inside [Electron](https://www.electronjs.org/), which brings
its own Chromium with Web Serial and WebUSB. The app works without a browser, without an internet connection
(except for the CSDb search), and with no drivers for the RFIEC.

| Tab | What you can do |
|---|---|
| **Floppies and drives** | **Real drive**: the PC reads and writes a 1541/1571/1581 via the RFIEC or an xum1541/ZoomFloppy, with directory, disk → D64, D64 → disk, files, DOS commands and format. **PC as a drive**: the C64 loads and saves on the PC (RFIEC). **Simulation**: everything without hardware. Files from the PC, D64/D71/D81 images, ZIP archives, CSDb search. |
| **Printer** | **The C64 prints on the PC**: an emulated MPS-801/803, with PDF export (RFIEC). **Real printer**: the PC prints text and pictures on a Commodore MPS. **Try it**: without hardware. |

The connection stays open when you switch tabs. The language (Italiano/English) is in the top-right corner and in
the *View* menu.

## Download

Packages are attached to the releases tagged `desktop-v…`: <https://github.com/zeus074/RFIEC/releases>

| System | File | Notes |
|---|---|---|
| Windows 10/11 | `RFIEC-x.y.z-win-x64.exe` (installer) or `RFIEC-x.y.z-win-portable.exe` | The packages are not signed, so SmartScreen may warn you: choose *More info → Run anyway*. The xum1541 needs the WinUSB driver (Zadig); the RFIEC needs nothing. |
| Linux | `RFIEC-x.y.z-linux-x86_64.AppImage` or `.deb` | AppImage: `chmod +x` and run (on Ubuntu 22.04+ install `libfuse2`). To open serial ports your user must be in the `dialout` group (`sudo usermod -aG dialout $USER`, then log in again); the xum1541 needs a udev rule (as for OpenCBM). |
| macOS 11+ | `RFIEC-x.y.z-mac-arm64.dmg` (Apple Silicon) or `-x64.dmg` (Intel) | The app is not notarized: the first time, right-click → *Open*, or run `xattr -cr /Applications/RFIEC.app`. |

## Run from source

```
cd desktop
npm install
npm start
```

Build the packages for your own system with `npm run dist`. GitHub Actions builds all three systems
(`.github/workflows/desktop.yml`).

## How it is made

- `app/drive.html` and `app/printer.html` are **generated** from the retrofixer.it sources (`floppy-web/build.py`,
  the same code as the web pages, without the guide and with the fonts bundled). Do not edit them by hand.
- `app/index.html`, `shell.js` and `shell.css` hold the window with the two tabs and the port/device chooser.
- `main.js` serves the pages on a private `rfiec://` origin and shows the chooser when a page asks for a serial port
  or USB device. It also opens a *Save as* dialog for downloads (PDF, D64, .prn) and opens external links in the
  system browser.
- `csdb.js` is the CSDb search and download used by the drive page. On the website it runs on the server; here it
  runs in the app, with the same limits (10 requests and 3 downloads a minute).

License: GPL-3.0-or-later.
