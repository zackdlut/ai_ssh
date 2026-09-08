---
name: ESP32 serial debugging
description: Diagnose an ESP32 over a serial console — boot loops, panic backtraces, brownouts, garbage output, and a port that opens but stays silent. Use when an ESP32/ESP8266 board reboots repeatedly, prints a Guru Meditation Error or backtrace, shows mojibake, or shows nothing at all.
---

# ESP32 serial debugging

A serial tab is a byte stream. There is no shell, no exit code, and no files —
`exec_command`, `read_file`, `grep` and `git_*` do not work on it. The whole
toolkit is: `search_terminal` to read what the board already printed,
`serial_send` to write a line, and `serial_reset` to reboot it and capture a
fresh boot log.

## Read the reset reason first

Never diagnose an ESP32 from the middle of its output. The first lines after a
reset name the cause, and everything after them is a consequence. Call
`serial_reset` and read the banner.

The second line of a boot log looks like `rst:0xc (SW_CPU_RESET),boot:0x13`.
The `rst:` code is the diagnosis:

| Code | Meaning | Where to look |
| --- | --- | --- |
| `0x1` POWERON | Clean power-up | Normal |
| `0x3` SW_RESET / `0xc` SW_CPU_RESET | Software restarted it | A panic handler ran, or `esp_restart()` — expect a backtrace above |
| `0x5` DEEPSLEEP | Woke from deep sleep | Normal for a sleeping design |
| `0x6` SDIO_RESET / `0x7`–`0xb` TG*WDT | A watchdog fired | A task blocked; see the watchdog section |
| `0xd` RTCWDT_RTC_RESET / `0x10` RTCWDT_RTC | RTC watchdog | Usually brownout or a hang before app start |
| `0xf` BROWNOUT | Supply sagged below threshold | Power, not firmware |

`boot:0x13` is a strapping value, not a fault — the low three bits are the boot
mode. `boot:0x3` / `0x13` is normal SPI flash boot. A boot mode of
`(DOWNLOAD(USB/UART0))` means IO0 was low at reset, so the chip is sitting in
the bootloader waiting to be flashed and will never run your program.

## Brownout is the most misdiagnosed failure

`Brownout detector was triggered` followed by a reboot loop reads like a
firmware crash and is a power problem. It appears when the board draws current
faster than the supply can deliver — almost always at Wi-Fi association, which
is why the loop looks correlated with the network code.

Causes, in the order they actually occur: a thin or long USB cable (a charge-only
cable is worse — check by trying another), a USB hub instead of a direct port,
a 3.3V regulator on a breakout board being asked for the ~500mA peak the radio
draws, missing bulk capacitance near the module, or a servo/LED strip sharing
the ESP32's own regulator instead of having its own supply.

To confirm it is power and not code: the same firmware that brownouts on Wi-Fi
connect will run indefinitely with the radio disabled. If it survives, stop
reading the firmware.

## Read a panic backtrace

A `Guru Meditation Error` names the fault type, and the type narrows the cause
before any address is decoded:

- `LoadProhibited` / `StoreProhibited` — dereferenced a bad pointer. If the
  faulting address in `EXCVADDR` is `0x00000000` it is a null pointer; if it is
  small and odd it is an uninitialised or freed pointer.
- `IntegerDivideByZero` — exactly what it says.
- `InstrFetchProhibited` — jumped to a bad address: a corrupted function
  pointer, a callback on a destroyed object, or a stack overflow that clobbered
  a return address.
- `Interrupt wdt timeout on CPU0/CPU1` — an ISR ran too long or blocked. ISR
  code must not allocate, log, take a mutex, or call anything that can block.

The `Backtrace: 0x400d1234:0x3ffb2000 ...` line is a list of PC:SP pairs and it
is useless unread. It has to be resolved against the exact ELF that produced the
image — this is a host-side step, so it belongs on a shell tab, not the serial
one:

```
xtensa-esp32-elf-addr2line -pfiaC -e build/firmware.elf 0x400d1234 0x400d5678
```

For ESP-IDF, `idf.py monitor` decodes backtraces automatically; that is the
better tool once a build tree is present. If the ELF is not available, the
backtrace cannot be decoded — say so rather than guessing at addresses. The
fault type and the reset reason above are still diagnostic on their own.

If the panic repeats identically on every boot, it is deterministic and lives in
setup or early init. If it takes a while and varies, suspect a leak, a stack
overflow (`***ERROR*** A stack overflow in task ...` names the task), or heap
corruption — and note that heap corruption usually crashes far from its cause.

## The port opens but nothing prints

In order of likelihood:

**DTR/RTS are holding the chip in reset.** This is the single most common cause
and it is specific to ESP32 boards. Their USB-serial bridge wires DTR and RTS to
IO0 and EN, so a host that asserts both — which is the default for most serial
libraries — pins the chip in reset and it prints nothing at all. An ESP32 tab in
this app must be opened with **DTR off and RTS off**; the connect dialog defaults
them that way for recognised ESP32 boards. If the board was saved with a
different device kind, or opened with a CH340 that could not be told apart from
an Arduino clone, reopen the port with both signals off.

**The baud rate is wrong.** Wrong baud gives mojibake or nothing, not silence
followed by good output. The app default is 115200, which is right for almost
all ESP-IDF and Arduino-core firmware. Two exceptions worth knowing: 74880 is
the ESP8266/ESP32 ROM bootloader rate, which is why the first two lines of a boot
log are often garbage at 115200 and legible at 74880; and firmware that calls
`Serial.begin()` with something else prints its own output at that rate while the
ROM banner stays at the ROM rate. Garbage before the banner and clean text after
it means the rates differ by design and nothing is wrong.

**The chip is in download mode.** See `boot:` above. Reset with IO0 released.

**The firmware prints nothing.** A sketch with an empty `setup()`, or one whose
`Serial.begin()` never ran because it crashed first. `serial_reset` distinguishes
these: a boot banner with no application output means the ROM and bootloader are
fine and the application is the problem.

**Nothing is listening on that port.** On Linux, a port that belongs to a
different device, or a `ttyS*` legacy port with no hardware behind it, opens
successfully and stays quiet. Use `list_devices` and prefer a port whose USB
identity is a recognised bridge chip.

## Watchdogs

`Task watchdog got triggered` names the task that failed to feed it and the
tasks that were running. On Arduino-core code the usual cause is a long blocking
loop with no `delay()` or `yield()`; under ESP-IDF it is a task that never
returns to the scheduler. The message lists the offending task by name — that
name is the fix's location, and it is more reliable than any inference from
timing.

An interrupt watchdog (`Interrupt wdt timeout`) is a different fault with a
different fix: the problem is in ISR code, not in a task.

## What not to conclude

`serial_send` has no exit code. Sending a line and seeing no reply does not mean
the command failed — it may mean the firmware does not read the serial port at
all, that it expects a different line terminator (try `cr`, `lf`, then `crlf`),
or that it only prints on its own schedule. Before deciding a device is
unresponsive, `serial_reset` it: a board that prints a boot banner is alive, and
one that prints nothing even after a reset has a power, wiring, or signal
problem rather than a firmware one.
