---
name: Arduino upload troubleshooting
description: Diagnose Arduino sketch upload failures and serial monitor problems — avrdude stk500 sync errors, port busy, wrong board, and a monitor that shows garbage or resets the board. Use when an Arduino UNO/Nano/Mega upload fails or its serial output is unreadable.
---

# Arduino upload troubleshooting

Two different problems get reported the same way ("it doesn't work"), and they
have opposite fixes:

- **Upload fails** — `avrdude` cannot talk to the bootloader. Host-side problem;
  diagnose it from a shell tab where `arduino-cli` and `avrdude` live.
- **Upload succeeds, monitor is wrong** — the sketch is running and the serial
  view is misconfigured. Diagnose it on the serial tab.

Check which one it is before anything else: an upload that ends with
`avrdude done. Thank you.` succeeded, regardless of what the monitor shows
afterwards.

## The port is exclusive — this is the trap

Only one program may hold a serial port. An open serial monitor blocks the
upload, and this is by far the most common cause of a sudden
`can't open device` or `Access is denied` on a board that worked a minute ago.
Close the serial tab in this app before uploading, and reopen it after. The same
applies in reverse: the Arduino IDE's monitor, `screen`, `picocom`, or a stale
process still holding the port will make this app's connect fail with a busy
error.

On Linux, `fuser /dev/ttyUSB0` or `lsof /dev/ttyACM0` names the holder.

## stk500_recv / stk500_getsync: not in sync

```
avrdude: stk500_recv(): programmer is not responding
avrdude: stk500_getsync() attempt 1 of 10: not in sync: resp=0x00
```

This means avrdude opened the port and the bootloader never answered. In
practical order:

1. **Wrong board selected.** A Nano with the old bootloader needs
   `ATmega328P (Old Bootloader)` at 57600 baud, not the 115200 of the modern
   one — and the failure is exactly this message. This alone accounts for most
   "not in sync" on cheap Nano clones.
2. **Wrong port.** On Linux a genuine UNO appears as `/dev/ttyACM*`; a clone
   with a CH340 appears as `/dev/ttyUSB*`. Use `list_devices` to see which ports
   exist and what chip is behind each.
3. **Something is holding the port.** See above.
4. **The reset pulse is not reaching the chip.** DTR toggling is what puts an
   UNO into its bootloader. A board with a lifted or failed reset capacitor
   needs the button pressed manually just as upload begins.
5. **Something is on pins 0/1.** The hardware UART is shared with USB on an
   UNO. A shield, sensor, or another serial device on D0/D1 will corrupt the
   upload handshake. Disconnect it.
6. **A bad or charge-only USB cable.** The port would not enumerate at all with a
   charge-only cable, so if `list_devices` sees the board the cable carries
   data — but a marginal cable can still fail mid-upload.
7. **The bootloader is gone.** A board previously programmed with an ISP
   programmer has no bootloader and can only be reflashed the same way.

## Permission denied on Linux

```
avrdude: ser_open(): can't open device "/dev/ttyUSB0": Permission denied
```

The user is not in the group that owns the port — `dialout` on Debian/Ubuntu,
`uucp` on Arch. Add them and log out and back in (the group is applied at
session start, so `newgrp dialout` or a fresh login is required; the same
terminal will keep failing):

```
sudo usermod -a -G dialout "$USER"
```

Do not recommend `sudo chmod 666` on the device node: it is undone at every
replug, so it teaches the user that the fix stopped working.

## The monitor resets the board — and usually should

Opening a serial port asserts DTR, and on an UNO or Nano DTR is wired to the
reset line through a capacitor. So connecting the monitor **reboots the sketch**.
This is not a bug, and it is the behaviour you want: it is the only way to see
output that a sketch prints in `setup()`, which is otherwise gone before any
monitor can attach.

This app's connect dialog defaults DTR and RTS **on** for recognised Arduino
boards for exactly that reason. Note that this is the opposite of the ESP32
default, where the same signals hold the chip in reset instead of pulsing it.

When the reset is unwanted — watching a long-running sketch without disturbing
it — open the port with DTR off. On real hardware, the 10µF capacitor between
DTR and reset is what makes this a pulse rather than a hold.

## Garbage in the monitor

Mojibake means the baud rates disagree. Match the monitor to the sketch's
`Serial.begin()`; the Arduino IDE's default is 9600, and this app defaults a
recognised Arduino to 9600 for that reason, while most other boards and
firmware use 115200.

Output that arrives as a diagonal staircase is a line-ending problem, not a
baud problem — the device sent bare `\n`. This app normalises that on the way in,
so a staircase in this app's terminal points at something else re-emitting the
stream.

Nothing at all, with a correct baud rate, means the sketch never printed:
`Serial.begin()` missing, or a sketch that crashed or hung before reaching it.

## Sending commands to a sketch

`serial_send` writes a line and collects what follows. Two things decide whether
a sketch sees it:

**The line terminator.** A sketch using `Serial.readStringUntil('\n')` needs LF;
one using `Serial.parseInt()` needs any non-digit; one comparing against
`"ON\r\n"` needs CRLF. Mismatch looks exactly like a device that ignores input.
Try `lf`, then `cr`, then `crlf` before concluding the firmware is broken.

**Whether it reads at all.** Many sketches never call `Serial.available()`. There
is no way to tell from outside except by reading the source, so a lack of
response is not evidence of a fault.

There is no exit code on a serial line. Success can only be judged from the text
that comes back, and silence is ambiguous — say so rather than reporting a
failure.
