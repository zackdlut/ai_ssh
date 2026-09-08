import type { DeviceKind } from '../../../shared/deviceIdentity'
import type { UiIconName } from '../UiIcon'

/**
 * Icon for a board family.
 *
 * Not every family gets its own glyph: an Orange Pi and a plain Linux host are
 * both an SSH server with a shell, so they share the `server` icon rather than
 * inventing a mark nobody would recognize. A distinct icon is worth having only
 * where the device behaves differently, which is what the user is scanning the
 * list for.
 */
export function deviceIconName(kind: DeviceKind | undefined): UiIconName {
  switch (kind) {
    case 'esp32':
      return 'esp32'
    case 'arduino':
      return 'arduino'
    case 'raspberry-pi':
      return 'pi'
    case 'rp2040':
      return 'pi'
    case 'serial':
      return 'serial'
    default:
      return 'server'
  }
}
