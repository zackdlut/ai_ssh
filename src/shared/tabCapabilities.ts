/**
 * What a terminal tab can actually do, by transport.
 *
 * Before serial there were two transports and one difference between them, so
 * `kind === 'wsl'` was a fine way to ask "is there an SFTP channel here". A
 * third transport with a different set of gaps turns every one of those checks
 * into a guess that happens to be right, and there are seven of them across the
 * renderer and the prompts. The rules live here instead so that adding a
 * transport means editing this file rather than finding them all again.
 *
 * The gaps are not arbitrary. A file channel needs random access to a
 * filesystem, which SSH gets from SFTP and a local shell gets from the machine
 * it is already running on. A command channel needs something that runs
 * commands and reports an exit status, which a shell has and a microcontroller
 * does not.
 */
export type TabKind = 'ssh' | 'wsl' | 'local' | 'serial' | undefined

/** A tab with no `kind` predates the field and is SSH. */
function resolve(kind: TabKind): 'ssh' | 'wsl' | 'local' | 'serial' {
  return kind ?? 'ssh'
}

/**
 * Whether the file tools work: `read_file`, `edit_file`, `write_file`,
 * `apply_patch`, the file panel, and file diff previews.
 *
 * Two transports have one: SSH over SFTP, and a local shell over the host's own
 * filesystem. WSL has neither — its pty runs inside the distro, whose files the
 * main process cannot address as local paths — so it falls back to shell
 * commands. Serial cannot fall back at all.
 */
export function hasFileChannel(kind: TabKind): boolean {
  const k = resolve(kind)
  return k === 'ssh' || k === 'local'
}

/**
 * Whether commands can be run and their exit status read: `exec_command`,
 * `run_in_terminal`, `grep`, `glob`, `git_*`, live charts, and host memory.
 *
 * A serial device is a byte stream. Bytes typed at it may happen to reach a
 * shell — a Pi console over its UART header — but nothing can know that, and
 * there is no exit code to read either way, so the tools that promise one are
 * not offered.
 */
export function hasCommandChannel(kind: TabKind): boolean {
  return resolve(kind) !== 'serial'
}

export function isSerialTab(kind: TabKind): boolean {
  return resolve(kind) === 'serial'
}

/**
 * One sentence naming the transport and what it costs, for an error message
 * that has to tell the model what to do instead.
 */
export function describeTabLimits(kind: TabKind): string {
  switch (resolve(kind)) {
    case 'wsl':
      return 'a local WSL terminal, which has no SFTP channel. Use exec_command (cat/sed/tee) for file work on this tab.'
    case 'local':
      return 'a shell on this machine.'
    case 'serial':
      return 'a serial device, which has no shell: no SFTP, no commands, and no exit codes. Use serial_send to write a line and read the reply, or search_terminal to read what the device has already printed.'
    case 'ssh':
      return 'a remote host over SSH.'
  }
}
