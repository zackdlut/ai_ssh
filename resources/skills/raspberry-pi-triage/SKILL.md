---
name: Raspberry Pi triage
description: Diagnose common Raspberry Pi and Orange Pi failures over SSH — undervoltage throttling, SD card wear and read-only filesystems, thermal throttling, full boot partitions, and unreachable hosts. Use when a Pi or Orange Pi is slow, crashing, unreachable, or has a filesystem that turned read-only.
---

# Raspberry Pi triage

A Pi is a Linux host over SSH, so the whole tool surface works: `exec_command`,
the file tools, `grep`, `git_*`. What is Pi-specific is *which* failures are
common, and they are dominated by two causes that look like software bugs:
**power** and **SD card wear**. Check both before reading any application log.

## Power first: undervoltage explains most mystery faults

Random reboots, USB devices dropping, corrupted writes, and "the whole thing
just gets slow" are usually the supply, not the software. The firmware records
it, so it does not have to be inferred:

```
vcgencmd get_throttled
```

`throttled=0x0` is healthy. Otherwise the bits are the diagnosis — the low bits
mean *now*, and bits 16+ mean *since boot* (so `0x50000` is a machine that
throttled earlier and is fine at this instant, which is exactly the evidence a
user who saw a slowdown an hour ago needs):

| Bit | Meaning |
| --- | --- |
| 0 (`0x1`) | Undervoltage detected |
| 1 (`0x2`) | ARM frequency capped |
| 2 (`0x4`) | Currently throttled |
| 3 (`0x8`) | Soft temperature limit active |
| 16 (`0x10000`) | Undervoltage has occurred since boot |
| 17 (`0x20000`) | Frequency capping has occurred since boot |
| 18 (`0x40000`) | Throttling has occurred since boot |
| 19 (`0x80000`) | Soft temperature limit has occurred since boot |

Any undervoltage bit means the power supply, the cable, or what is plugged into
the Pi. A Pi 4 needs a real 3A USB-C supply and a Pi 5 wants 5A for full
peripheral current; phone chargers and long thin cables are the usual culprits.
Externally powered hubs fix a Pi that browns out under USB load.

The kernel logs it too, which is how to catch it on a host where `vcgencmd` is
absent (most Orange Pi images):

```
dmesg | grep -iE 'under-?voltage|voltage normalised'
```

`vcgencmd` is Raspberry Pi firmware. On an Orange Pi or other SBC it will not
exist — fall back to `dmesg` and to the thermal zone files below.

## Temperature

```
vcgencmd measure_temp
cat /sys/class/thermal/thermal_zone0/temp   # millidegrees; portable
```

Soft throttling starts at 60°C, hard at 80–85°C. A Pi 4 in a closed case with
no airflow reaches this under sustained load, and the symptom is a gradual
slowdown rather than a crash. Sustained high temperature with an *idle* CPU is
a different fault: check `top` for a runaway process before blaming the case.

## SD card wear: the read-only filesystem

A filesystem that has "turned read-only" is not a permissions problem and
`chmod` will not touch it. The kernel remounts read-only when the block device
starts failing writes, which is what a worn SD card does at end of life. That is
protective — it is preserving what is left.

```
mount | grep ' / '                       # look for (ro,
dmesg | grep -iE 'mmc|I/O error|remount|EXT4-fs error'
```

`EXT4-fs error ... Remounting filesystem read-only` preceded by mmc I/O errors
means the card is failing. The fix is a new card and a restore from backup, not
a remount. `fsck` on a card in this state can complete and then fail again
within hours — say that plainly rather than offering a repair that will not
hold.

Confirm before recommending a replacement, since a full filesystem and a
corrupt one produce similar-sounding complaints:

```
df -h /            # is it simply full?
df -i /            # inodes exhausted? — writes fail with plenty of space free
```

To reduce future wear: move logs to RAM (`log2ram`), keep swap off the card
(`dphys-swapfile`), and put anything with a steady write load — a database, a
Prometheus TSDB — on USB storage instead.

## A full /boot

`apt upgrade` failing on kernel install with no space, on a machine whose root
filesystem is nearly empty, is the small FAT boot partition filling with old
kernels:

```
df -h /boot /boot/firmware
sudo apt autoremove --purge
```

Never delete files from `/boot` by hand to make room. A missing
`kernel*.img`, `*.dtb`, or `config.txt` produces a board that does not boot at
all and cannot be fixed over SSH — it needs the card in another machine.

## Unreachable host

`list_devices` probes saved entries by opening a TCP connection to the SSH port.
It answers exactly one question — is something listening there right now — and
the failure mode narrows the cause:

- **Connection refused** — the host is up and sshd is not running (or listens on
  another port). The network is fine.
- **Timeout / no route** — the host is off, not on the network, or firewalled.
- **Reachable but authentication fails** — a key or account problem, not a
  connectivity one.

A DHCP lease change is the most common cause of a Pi that "disappeared" after a
reboot, and the probe cannot distinguish that from a dead host. Either check the
router's lease table, use its `.local` mDNS name, or give it a static
reservation.

A Pi that is up, reachable, and refuses SSH after an unclean shutdown has often
remounted read-only (see above) — sshd cannot write its state and drops
connections.

## When the network cannot answer

A Pi with a serial console on its UART header can be reached over a USB-TTL
adapter when SSH cannot, and that is the only way to read boot messages from a
machine that never finishes booting. Console UART on a Pi is 115200 8N1. That
tab is a serial tab: no shell tooling, no exit codes, and only `serial_send` and
`search_terminal` work on it — even though a login prompt may well appear, since
what is on the far end really is a getty.
