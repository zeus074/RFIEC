# Changelog

## 2.6 – 2026-11-17
- The board shows up on the PC as **RFIEC** instead of "Arduino Leonardo" (`build.usb_product`). The manufacturer
  string stays "Arduino LLC", imposed by the Arduino core with VID 0x2341.

## 2.5 – 2026-11-17
- Bus controller mode tested with a real 1541-II (status, directory, a 149-block file read in 92 s, write,
  separator) and a real MPS-801 (printing from the PC).

## 2.4
- Bit timing like the XUM1541 in OpenCBM: CLK low for 75 µs before each bit, bit valid for 20 µs. With the
  40 µs of 2.0–2.3 the 1541-II did not acknowledge bytes (the MPS-801 did).
- EOI on the last byte of every write; patient wait for a busy drive.

## 2.3
- The `a` reply carries the reason of an error under ATN.

## 2.2
- `S` command: measurement of the bus lines, for troubleshooting.

## 2.1
- After TALK, wait up to 100 ms for the drive (like the Kernal) instead of 1 ms: with a real 1541 the page
  reported "no drive".
- **Bus controller (master) mode**: commands `M`, `A`, `B`, `G`, `X`. The board does what an XUM1541 does and
  the web pages use it over the serial port, with no driver. Routines written from scratch.

## 1.2 – 2026-11-16
- Final Cartridge III and Epyx FastLoad (detected by the web page, started with `F`). Tested on a real C64.
- Block transfers (`read`/`write` with buffer) keep serving the serial port while waiting for the PC.

## 1.1
- The port state is read with `Serial.dtr()` / `Serial.rts()`: in 1.0 `(bool) Serial` contained a
  `delay(10)`, the Pro Micro missed the 1 ms ATN deadline and the C64 stayed in SEARCHING FOR.

## 1.0
- First version: the PC acts as drive 8 for the C64 through the web page.
