import { execFile } from 'child_process'
import type { ToolchainInfo } from '../../shared/types'

/**
 * Report which embedded toolchains this machine has installed.
 *
 * The app does not flash anything yet, so this exists to answer a question
 * that otherwise costs the user a round of trial and error: whether the tool a
 * suggested next step needs is even present, and at which version. Surfacing it
 * in the device list and in `list_devices` means the AI recommends
 * `arduino-cli compile` because it saw arduino-cli, not because it guessed.
 *
 * The candidate list is fixed and the arguments are constants. Nothing the
 * model or the user types reaches this module, and `execFile` is used without a
 * shell, so there is no argument string for anything to be injected into.
 */
interface Candidate {
  id: string
  /** Executables to try in order; the first one that answers wins. */
  commands: string[]
  args: string[]
}

const CANDIDATES: Candidate[] = [
  // Modern esptool ships as `esptool`; the v3-era entry point was `esptool.py`.
  { id: 'esptool', commands: ['esptool', 'esptool.py'], args: ['version'] },
  { id: 'arduino-cli', commands: ['arduino-cli'], args: ['version'] },
  { id: 'avrdude', commands: ['avrdude'], args: ['-v'] },
  { id: 'picocom', commands: ['picocom'], args: ['--help'] }
]

/** A tool that is not installed must not hold the device panel open. */
const PROBE_TIMEOUT_MS = 3000

/** Version-looking token, e.g. `4.7.0`, `v1.0.4`, `1.2`. */
const VERSION_RE = /\bv?(\d+\.\d+(?:\.\d+)?(?:-[\w.]+)?)\b/

/**
 * Run one probe.
 *
 * A missing executable and a broken one are the same answer here, so every
 * failure resolves rather than throws. Output is read even on a non-zero exit:
 * `avrdude -v` and `picocom --help` both report their version and then exit
 * non-zero, which would otherwise read as "not installed".
 */
function probe(command: string, args: string[]): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { timeout: PROBE_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 64 },
      (err, stdout, stderr) => {
        const output = `${stdout ?? ''}\n${stderr ?? ''}`.trim()
        // ENOENT means no such executable. Any other error still produced a
        // process, so whatever it printed is evidence the tool is there.
        const missing = !!err && (err as NodeJS.ErrnoException).code === 'ENOENT'
        resolve({ ok: !missing && output.length > 0, output })
      }
    )
  })
}

/** Detect every known toolchain, probing them concurrently. */
export async function detectToolchains(): Promise<ToolchainInfo[]> {
  return Promise.all(CANDIDATES.map(detectOne))
}

async function detectOne(candidate: Candidate): Promise<ToolchainInfo> {
  for (const command of candidate.commands) {
    const { ok, output } = await probe(command, candidate.args)
    if (!ok) continue
    return {
      id: candidate.id,
      command,
      found: true,
      version: VERSION_RE.exec(output)?.[1]
    }
  }
  return { id: candidate.id, command: candidate.commands[0], found: false }
}
