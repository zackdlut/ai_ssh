import { describe, expect, it } from 'vitest'
import {
  DEFAULT_KEYBINDINGS,
  KEYBINDING_IDS,
  normalizeKeybinding,
  normalizeKeybindingsSettings,
  parseKeybinding
} from './keybindings'

describe('DEFAULT_KEYBINDINGS', () => {
  it('defines every id exactly once', () => {
    expect(new Set(KEYBINDING_IDS).size).toBe(KEYBINDING_IDS.length)
    expect(Object.keys(DEFAULT_KEYBINDINGS).sort()).toEqual([...KEYBINDING_IDS].sort())
  })

  it('survives its own normalizer, so no default is silently replaced', () => {
    for (const id of KEYBINDING_IDS) {
      expect(normalizeKeybinding(DEFAULT_KEYBINDINGS[id], '')).toBe(DEFAULT_KEYBINDINGS[id])
    }
  })

  it('hands out no duplicate chords', () => {
    const specs = KEYBINDING_IDS.map((id) => DEFAULT_KEYBINDINGS[id])
    expect(new Set(specs).size).toBe(specs.length)
  })

  it('never combines shift with a digit, which could not be matched', () => {
    // Matching compares against `KeyboardEvent.key`, and shift rewrites a digit
    // into punctuation, so such a chord would be silently dead.
    for (const id of KEYBINDING_IDS) {
      const { key, shift } = parseKeybinding(DEFAULT_KEYBINDINGS[id])
      expect(shift && /^[0-9]$/.test(key), `${id}: ${DEFAULT_KEYBINDINGS[id]}`).toBe(false)
    }
  })
})

describe('normalizeKeybinding', () => {
  it('accepts arrow keys, which the pane focus bindings need', () => {
    for (const arrow of ['arrowleft', 'arrowright', 'arrowup', 'arrowdown']) {
      expect(normalizeKeybinding(`mod+shift+${arrow}`, '')).toBe(`mod+shift+${arrow}`)
    }
  })

  it('orders modifiers canonically regardless of input order', () => {
    expect(normalizeKeybinding('shift+mod+arrowup', '')).toBe('mod+shift+arrowup')
    expect(normalizeKeybinding('ALT+Mod+F', '')).toBe('mod+alt+f')
  })

  it('rejects keys it cannot represent and falls back', () => {
    expect(normalizeKeybinding('mod+shift+home', 'mod+f')).toBe('mod+f')
    expect(normalizeKeybinding('mod+shift+arrowsideways', 'mod+f')).toBe('mod+f')
    expect(normalizeKeybinding('', 'mod+f')).toBe('mod+f')
    expect(normalizeKeybinding('mod+f13', 'mod+f')).toBe('mod+f')
  })
})

describe('parseKeybinding', () => {
  it('splits an arrow chord into modifiers and key', () => {
    expect(parseKeybinding('mod+shift+arrowleft')).toEqual({
      key: 'arrowleft',
      mod: true,
      shift: true,
      alt: false
    })
  })
})

describe('normalizeKeybindingsSettings', () => {
  it('fills every id from the defaults when given nothing', () => {
    expect(normalizeKeybindingsSettings(null)).toEqual(DEFAULT_KEYBINDINGS)
  })

  it('keeps a valid override and repairs an invalid one', () => {
    const out = normalizeKeybindingsSettings({
      focusPaneLeft: 'alt+arrowleft',
      focusPaneRight: 'mod+shift+nonsense'
    })
    expect(out.focusPaneLeft).toBe('alt+arrowleft')
    expect(out.focusPaneRight).toBe(DEFAULT_KEYBINDINGS.focusPaneRight)
  })
})
