First version of the **RFIEC desktop program** for Windows, Linux and macOS, in Italian and English.

- **Floppy ⇄ PC**: PC folders on the left, floppy directory on the right. Copy files both ways (arrows, Enter,
  double-click or drag and drop), read a disk to D64/D71/D81, write an image to a disk. Also status, rename, scratch,
  format, validate, initialize, DOS commands and bus reset. Works with the RFIEC (no driver) and the xum1541/ZoomFloppy.
- **C64 uses the PC** (RFIEC): the C64 sees the PC as drive 8–11 with a D64/D71/D81 image, and as printer 4/5
  (MPS-803, Epson FX or NEC P emulation). What the C64 saves is written straight into the image file; the printout
  can be saved as PDF or `.prn`.
- **Print**: text or a BASIC listing on a real Commodore printer, or a raw file.
- **Interface → Install firmware**: RFIEC or XUM1541 on the Pro Micro, through its bootloader.

| System | File |
|---|---|
| Windows 10/11 | `RFIEC-0.1.0-win-x64.exe` (installer) or `RFIEC-0.1.0-win-portable.exe` |
| Linux | `RFIEC-0.1.0-linux-….AppImage` (any distribution) or `.deb` (Debian, Ubuntu) |
| macOS 11+ | `RFIEC-0.1.0-mac-arm64.dmg` (Apple Silicon) or `RFIEC-0.1.0-mac-x64.dmg` (Intel) |

The packages are not signed: Windows SmartScreen asks for confirmation (*More info → Run anyway*). On macOS
right-click → *Open* the first time, or run `xattr -cr /Applications/RFIEC.app`. On Linux your user must be in
the `dialout` group to open serial ports. Details are in [desktop/README.md](https://github.com/zeus074/RFIEC/blob/main/desktop/README.md).

**Beta:** in this first version the bus, DOS and printer code is the same as on the
[retrofixer.it](https://retrofixer.it/xum1541/) pages, which was tested with a real C64, 1541-II and MPS-801. The
program itself has been tested with simulated devices so far. Reports are welcome in the
[issues](https://github.com/zeus074/RFIEC/issues).

The firmware for the board is in the [RFIEC 2.6](https://github.com/zeus074/RFIEC/releases/tag/v2.6) release.
