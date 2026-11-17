# RFIEC serial protocol

The board is a USB CDC serial port (product name **RFIEC**). The baud rate setting is ignored. All messages are
binary: one command letter followed by single-byte fields. The web pages on
[retrofixer.it](https://retrofixer.it/xum1541/) implement the PC side in JavaScript (`IecHost` for device mode,
`SerialXum` for bus controller mode).

Two **slots** exist in device mode: slot 0 is the drive (default device 8), slot 1 is the printer (device 4 or 5,
off until configured with `C`).

```
Protocol (binary, over USB serial; the configured baud rate does not matter):
  PC → Pro Micro
    'V'                              requests the version → reply 'H'
    'C' slot dev flags               configures slot 0 (drive) or 1 (printer): device number and enable (bit 0)
    'D' slot seq len flags data[len] data to send to the C64 (len ≤ 64); flags bit0 = end of file, bit1 = no data
    'F' slot loader proto            starts a fast loader detected by the web page (loader 2 = Final Cartridge III;
                                     proto 1 LOAD and 5 LOADIMG read channel 0, 2 SAVE writes to channel 1;
                                     loader 1 = Epyx FastLoad, proto 3: the file name comes from the loader)
    'M' mode                         0 = device (emulated drive/printer), 1 = bus controller (master) → reply 'm' mode
  bus controller (master) mode only:
    'A' len flags byte[len]          bytes under ATN (LISTEN/TALK/OPEN/CLOSE/UNLISTEN/UNTALK); flags bit0 = a TALK follows:
                                     the PC becomes the listener → reply 'a' n err (bytes accepted, 0 = no device;
                                     err: 0 ok, 1 nobody pulls DATA, 2 the listener never releases, 3 byte not acknowledged,
                                     4 the device does not take CLK after the TALK)
    'B' len flags byte[len]          data for the listener; flags bit0 = EOI on the last byte → reply 'b' n
    'G' lo hi                        reads up to lo+hi*256 bytes from the talker → replies 'g' n flags byte[n] (n ≤ 60;
                                     flags bit0 = EOI received, bit1 = last chunk); stops after 1 s without data
    'X'                              bus RESET (RESET line held low for 100 ms) → reply 'x'
    'S'                              line measurement → reply 's' a b c d (32U4 port B: a = idle,
                                     b = idle with internal pull-ups, c = with ATN and CLK pulled, after 1 ms,
                                     d = 100 ms after releasing everything; bit 2 DATA, 3 CLK, 4 ATN, 6 RESET, 1 = high)
  Pro Micro → PC
    'H' len text                     firmware version
    'L' slot sec                     LISTEN with secondary address (0x6n data, 0xEn CLOSE, 0xFn OPEN)
    'T' slot sec seq                 TALK (seq: TALK session number)
    'U' slot                         UNLISTEN
    'K' slot seq lo hi               UNTALK: how many bytes the C64 actually read in this session
    'W' slot len eoi data[len]       bytes sent by the C64 (len ≤ 32)
    'Q' slot seq                     more data needed for the TALK in progress
    'R'                              the bus RESET line went low
```

## Typical sequences

**C64 loads a file from the emulated drive (device mode)**

1. PC → `V`, board → `H` with the version text (for example `RFIEC 2.6`).
2. PC → `M 0` (device mode, the default after power-up), `C 0 8 1` (slot 0 = device 8, enabled).
3. C64 `OPEN` → board → `L 0 0xF0` then `W 0 …` with the file name, then `U 0`.
4. C64 reads → board → `T 0 0x60 seq`; PC → `D 0 seq len flags data` (repeated, `flags` bit 0 on the last
   chunk); board → `Q 0 seq` when it needs more, `K 0 seq lo hi` at UNTALK.

**PC reads the error channel of a real drive (bus controller mode)**

1. PC → `M 1` → `m 1`.
2. PC → `A 2 1 0x48 0x6F` (TALK 8, secondary 15, a TALK follows) → `a 2 0`.
3. PC → `G 0 1` → `g n flags bytes…` until `flags` bit 1.
4. PC → `A 1 0 0x5F` (UNTALK) → `a 1 0`.
