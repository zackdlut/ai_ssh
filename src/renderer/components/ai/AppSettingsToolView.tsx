import { useState, type ReactNode } from 'react'
import { MODEL_PROFILES } from '../../../shared/aiSettings'
import { THEME_OPTIONS } from '../../lib/themes'
import { resolveTerminalTheme, terminalSwatchColors } from '../../lib/terminalColorSchemes'
import {
  modelProfileLabel,
  terminalFontPresetLabel,
  terminalFontWeightLabel,
  terminalSchemeLabel,
  themeMeta,
  useT
} from '../../lib/i18n'
import { matchTerminalFontPreset, primaryFontName } from '../../lib/terminalFonts'
import { useLocaleStore } from '../../store/localeStore'
import {
  ThemePreview,
  TerminalPreview,
  ColorSwatch,
  ColorSchemeDropdown,
  FontFamilyPicker,
  StepperNumberInput
} from '../settings/shared'
import {
  aiFieldChanged,
  aiNestedFieldChanged,
  hasAiUpdates,
  hasStartupUpdates,
  hasTerminalUpdates,
  hasUiUpdates,
  startupFieldChanged,
  terminalFieldChanged,
  type AppSettingsSnapshot,
  type StartupSettings
} from '../../lib/appSettingsMerge'
import {
  TERMINAL_FONT_WEIGHTS,
  MAX_TERMINAL_LINE_HEIGHT,
  MIN_TERMINAL_LINE_HEIGHT,
  type TerminalAppearanceSettings,
  type TerminalColorSchemeId,
  type TerminalFontWeight
} from '../../../shared/terminalSettings'
import type { AppLocale, ModelProfile } from '../../../shared/types'
import type { ThemeMeta } from '../../lib/themes'

interface Props {
  mode: 'read' | 'edit'
  snapshot: AppSettingsSnapshot
  updates?: Record<string, unknown>
  onUpdatesChange?: (updates: Record<string, unknown>) => void
}

const LANGUAGE_OPTIONS: {
  id: AppLocale
  labelKey: 'language.zh' | 'language.en'
  descKey: 'language.zhDesc' | 'language.enDesc'
}[] = [
  { id: 'zh', labelKey: 'language.zh', descKey: 'language.zhDesc' },
  { id: 'en', labelKey: 'language.en', descKey: 'language.enDesc' }
]

/** Effective model when a profile has no explicit model configured. */
const AI_MODEL_FALLBACK = 'gpt-4o-mini'

/** Compact token count, e.g. 32768 -> "33k", 8192 -> "8k". */
function formatContextTokens(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
}

function ReadonlyProfileSeg({
  locale,
  value
}: {
  locale: AppLocale
  value: ModelProfile
}): JSX.Element {
  return (
    <div className="seg seg-profile tool-settings-seg tool-settings-seg--readonly" aria-readonly>
      {MODEL_PROFILES.map((profile) => (
        <button
          key={profile.id}
          type="button"
          tabIndex={-1}
          className={value === profile.id ? 'active' : ''}
          aria-pressed={value === profile.id}
        >
          {modelProfileLabel(locale, profile.id)}
        </button>
      ))}
    </div>
  )
}

/**
 * A tiny window title bar (traffic-light dots) that frames the terminal preview
 * so it reads as a mini window, matching the theme preview and startup diagram.
 */
function TerminalChrome(): JSX.Element {
  return (
    <div className="tool-settings-terminal-chrome" aria-hidden>
      <span className="tool-settings-terminal-dot" />
      <span className="tool-settings-terminal-dot" />
      <span className="tool-settings-terminal-dot" />
    </div>
  )
}

function TerminalField({
  label,
  changed,
  children
}: {
  label: string
  changed: boolean
  children: ReactNode
}): JSX.Element {
  return (
    <div className={`tool-settings-sub${changed ? ' tool-settings-changed' : ''}`}>
      <span className="tool-settings-field-label">{label}</span>
      {children}
    </div>
  )
}

function terminalFontLabel(locale: AppLocale, fontFamily: string): string {
  const preset = matchTerminalFontPreset(fontFamily)
  return preset ? terminalFontPresetLabel(locale, preset) : primaryFontName(fontFamily)
}

/**
 * A miniature app-window schematic that doubles as the startup-panel toggles.
 * The left slab is the connection sidebar (a tiny list), the right slab is the
 * Copilot chat (tiny bubbles); toggling lights the panel up in the accent color
 * or collapses it, mirroring what the user will see on next launch.
 */
function StartupLayoutDiagram({
  connOpen,
  copilotOpen,
  editable,
  changedConn,
  changedCopilot,
  connLabel,
  copilotLabel,
  onText,
  offText,
  onToggleConn,
  onToggleCopilot
}: {
  connOpen: boolean
  copilotOpen: boolean
  editable: boolean
  changedConn: boolean
  changedCopilot: boolean
  connLabel: string
  copilotLabel: string
  onText: string
  offText: string
  onToggleConn: () => void
  onToggleCopilot: () => void
}): JSX.Element {
  const Slab = editable ? 'button' : 'div'

  const leftSlab = (
    <Slab
      type={editable ? 'button' : undefined}
      className={`startup-slab startup-slab--left ${connOpen ? 'is-on' : 'is-off'}${
        changedConn ? ' is-changed' : ''
      }`}
      onClick={editable ? onToggleConn : undefined}
      aria-pressed={editable ? connOpen : undefined}
      aria-label={editable ? `${connLabel} · ${connOpen ? onText : offText}` : undefined}
      title={editable ? connLabel : undefined}
    >
      <span className="startup-rows" aria-hidden>
        <i />
        <i />
        <i />
        <i />
      </span>
    </Slab>
  )

  const rightSlab = (
    <Slab
      type={editable ? 'button' : undefined}
      className={`startup-slab startup-slab--right ${copilotOpen ? 'is-on' : 'is-off'}${
        changedCopilot ? ' is-changed' : ''
      }`}
      onClick={editable ? onToggleCopilot : undefined}
      aria-pressed={editable ? copilotOpen : undefined}
      aria-label={editable ? `${copilotLabel} · ${copilotOpen ? onText : offText}` : undefined}
      title={editable ? copilotLabel : undefined}
    >
      <span className="startup-bubbles" aria-hidden>
        <i />
        <i />
        <i />
      </span>
    </Slab>
  )

  return (
    <div className={`startup-diagram${editable ? ' is-editable' : ''}`}>
      <div className="startup-window">
        <div className="startup-window-bar" aria-hidden>
          <span className="startup-window-dot" />
          <span className="startup-window-dot" />
          <span className="startup-window-dot" />
        </div>
        <div className="startup-window-body">
          {leftSlab}
          <div className="startup-window-main" aria-hidden>
            <span className="startup-term-prompt">~ $</span>
            <span className="startup-term-caret" />
          </div>
          {rightSlab}
        </div>
      </div>
      <div className="startup-captions">
        <div className={`startup-caption${changedConn ? ' is-changed' : ''}`}>
          <span className="startup-caption-name">{connLabel}</span>
          <span className={`startup-pill${connOpen ? ' is-on' : ''}`}>
            {connOpen ? onText : offText}
          </span>
        </div>
        <div className={`startup-caption${changedCopilot ? ' is-changed' : ''}`}>
          <span className="startup-caption-name">{copilotLabel}</span>
          <span className={`startup-pill${copilotOpen ? ' is-on' : ''}`}>
            {copilotOpen ? onText : offText}
          </span>
        </div>
      </div>
    </div>
  )
}

function sectionClass(changed: boolean, index: number): string {
  const base = `tool-settings-section-block tool-settings-reveal-${index}`
  return changed ? `${base} tool-settings-changed` : base
}

function patchUpdates(
  updates: Record<string, unknown>,
  patch: Record<string, unknown>
): Record<string, unknown> {
  return { ...updates, ...patch }
}

function patchTerminalUpdates(
  updates: Record<string, unknown>,
  patch: Partial<TerminalAppearanceSettings>
): Record<string, unknown> {
  const current =
    updates.terminal_appearance && typeof updates.terminal_appearance === 'object'
      ? (updates.terminal_appearance as Record<string, unknown>)
      : {}
  return {
    ...updates,
    terminal_appearance: { ...current, ...patch }
  }
}

function patchStartupUpdates(
  updates: Record<string, unknown>,
  patch: Partial<StartupSettings>
): Record<string, unknown> {
  const current =
    updates.startup && typeof updates.startup === 'object'
      ? (updates.startup as Record<string, unknown>)
      : {}
  return {
    ...updates,
    startup: { ...current, ...patch }
  }
}

function patchAiUpdates(
  updates: Record<string, unknown>,
  patch: Record<string, unknown>
): Record<string, unknown> {
  const current =
    updates.ai && typeof updates.ai === 'object' ? (updates.ai as Record<string, unknown>) : {}
  return {
    ...updates,
    ai: { ...current, ...patch }
  }
}

function patchAiNested(
  updates: Record<string, unknown>,
  group: 'models' | 'contextLengths',
  profile: ModelProfile,
  value: string | number
): Record<string, unknown> {
  const ai =
    updates.ai && typeof updates.ai === 'object' ? (updates.ai as Record<string, unknown>) : {}
  const groupObj =
    ai[group] && typeof ai[group] === 'object'
      ? (ai[group] as Record<string, unknown>)
      : {}
  return patchAiUpdates(updates, {
    [group]: { ...groupObj, [profile]: value }
  })
}

export default function AppSettingsToolView({
  mode,
  snapshot,
  updates = {},
  onUpdatesChange
}: Props): JSX.Element {
  const t = useT()
  const locale = useLocaleStore((s) => s.locale)
  const editable = mode === 'edit' && !!onUpdatesChange
  const [editingProfile, setEditingProfile] = useState<ModelProfile>('default')

  const showUi = mode === 'read' || hasUiUpdates(updates)
  const showTerminal = mode === 'read' || hasTerminalUpdates(updates)
  const showStartup = mode === 'read' || hasStartupUpdates(updates)
  const showAi = mode === 'read' || hasAiUpdates(updates)

  const previewTheme = snapshot.theme
  const resolvedTerminalTheme = resolveTerminalTheme(snapshot.terminal_appearance.colorScheme, previewTheme)
  const terminal = snapshot.terminal_appearance
  // The embedded preview lives in a ~320px surface; clamp the visual font size so
  // extreme terminal settings (8px / 32px) don't break the panel's proportions.
  // The actual edited value is still shown in the stepper / read-only summary.
  const previewFontSize = Math.max(11, Math.min(14, terminal.fontSize))
  const ai = snapshot.ai
  const aiUpdates =
    updates.ai && typeof updates.ai === 'object' ? (updates.ai as Record<string, unknown>) : null

  const change = (next: Record<string, unknown>): void => {
    onUpdatesChange?.(next)
  }

  let sectionIndex = 0

  return (
    <div className="tool-settings-panel">
      <div className="tool-settings-panel-head">
        <span className="tool-settings-panel-title">{t('tool.settings.preview')}</span>
        {editable && <span className="tool-settings-panel-badge">{t('tool.settings.changed')}</span>}
      </div>

      {showUi && (
        <section className={sectionClass(updates.theme !== undefined || updates.locale !== undefined, sectionIndex++)}>
          <h3 className="tool-settings-section">{t('tool.section.ui')}</h3>

          {editable ? (
            <>
              {updates.theme !== undefined && (
                <div className="tool-settings-sub tool-settings-changed">
                  <span className="tool-settings-field-label">{t('tool.settings.theme')}</span>
                  <div className="tool-settings-theme-grid">
                    {THEME_OPTIONS.map((opt) => {
                      const meta = themeMeta(locale, opt.id)
                      const previewMeta: ThemeMeta = { id: opt.id, ...meta }
                      const active = snapshot.theme === opt.id
                      return (
                        <button
                          key={opt.id}
                          type="button"
                          className={`theme-card tool-settings-theme-card ${active ? 'active' : ''}`}
                          onClick={() => change(patchUpdates(updates, { theme: opt.id }))}
                          aria-pressed={active}
                        >
                          <ThemePreview meta={previewMeta} />
                          <div className="theme-card-copy">
                            <span className="theme-card-name">{meta.label}</span>
                          </div>
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}

              {updates.locale !== undefined && (
                <div className="tool-settings-sub tool-settings-changed">
                  <span className="tool-settings-field-label">{t('tool.settings.locale')}</span>
                  <div className="tool-settings-language-grid">
                    {LANGUAGE_OPTIONS.map((opt) => {
                      const active = snapshot.locale === opt.id
                      return (
                        <button
                          key={opt.id}
                          type="button"
                          className={`language-card tool-settings-language-card ${active ? 'active' : ''}`}
                          onClick={() => change(patchUpdates(updates, { locale: opt.id }))}
                          aria-pressed={active}
                        >
                          <span className="language-card-glyph" aria-hidden>
                            {opt.id === 'zh' ? '中' : 'En'}
                          </span>
                          <div className="language-card-copy">
                            <span className="language-card-name">{t(opt.labelKey)}</span>
                          </div>
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="tool-settings-current-grid">
              <div className="tool-settings-current-card">
                <ThemePreview meta={{ id: snapshot.theme, ...themeMeta(locale, snapshot.theme) }} />
                <div className="tool-settings-current-copy">
                  <span className="tool-settings-current-label">{t('tool.settings.theme')}</span>
                  <span className="tool-settings-current-value">
                    {themeMeta(locale, snapshot.theme).label}
                  </span>
                  <span className="tool-settings-current-tag">{themeMeta(locale, snapshot.theme).tag}</span>
                </div>
              </div>
              <div className="tool-settings-current-card tool-settings-current-card--lang">
                <span className="language-card-glyph" aria-hidden>
                  {snapshot.locale === 'zh' ? '中' : 'En'}
                </span>
                <div className="tool-settings-current-copy">
                  <span className="tool-settings-current-label">{t('tool.settings.locale')}</span>
                  <span className="tool-settings-current-value">
                    {t(snapshot.locale === 'zh' ? 'language.zh' : 'language.en')}
                  </span>
                </div>
              </div>
            </div>
          )}
        </section>
      )}

      {showTerminal && (
        <section
          className={sectionClass(hasTerminalUpdates(updates), sectionIndex++)}
        >
          <h3 className="tool-settings-section">{t('tool.section.terminal')}</h3>

          {editable ? (
            <div className="tool-settings-terminal-block">
              <div className="tool-settings-sub tool-settings-terminal-preview-sub">
                <div className="tool-settings-terminal-preview-frame tool-settings-terminal-preview-frame--wide">
                  <TerminalChrome />
                  <TerminalPreview
                    theme={resolvedTerminalTheme}
                    fontFamily={terminal.fontFamily}
                    fontSize={previewFontSize}
                    lineHeight={terminal.lineHeight}
                    fontWeight={terminal.fontWeight}
                    compact
                  />
                </div>
              </div>

              <TerminalField
                label={t('tool.settings.colorScheme')}
                changed={terminalFieldChanged(updates, 'colorScheme')}
              >
                <ColorSchemeDropdown
                  value={terminal.colorScheme}
                  onChange={(colorScheme) =>
                    change(patchTerminalUpdates(updates, { colorScheme }))
                  }
                />
              </TerminalField>
              <TerminalField
                label={t('tool.settings.fontFamily')}
                changed={terminalFieldChanged(updates, 'fontFamily')}
              >
                <FontFamilyPicker
                  value={terminal.fontFamily}
                  onChange={(fontFamily) =>
                    change(patchTerminalUpdates(updates, { fontFamily }))
                  }
                />
              </TerminalField>
              <TerminalField
                label={t('tool.settings.fontSize')}
                changed={terminalFieldChanged(updates, 'fontSize')}
              >
                <StepperNumberInput
                  value={terminal.fontSize}
                  min={8}
                  max={32}
                  step={1}
                  decimals={0}
                  onChange={(fontSize) => change(patchTerminalUpdates(updates, { fontSize }))}
                />
              </TerminalField>
              <TerminalField
                label={t('tool.settings.lineHeight')}
                changed={terminalFieldChanged(updates, 'lineHeight')}
              >
                <StepperNumberInput
                  value={terminal.lineHeight}
                  min={MIN_TERMINAL_LINE_HEIGHT}
                  max={MAX_TERMINAL_LINE_HEIGHT}
                  step={0.05}
                  decimals={2}
                  onChange={(lineHeight) => change(patchTerminalUpdates(updates, { lineHeight }))}
                />
              </TerminalField>
              <TerminalField
                label={t('tool.settings.fontWeight')}
                changed={terminalFieldChanged(updates, 'fontWeight')}
              >
                <select
                  value={terminal.fontWeight}
                  onChange={(e) =>
                    change(
                      patchTerminalUpdates(updates, {
                        fontWeight: e.target.value as TerminalFontWeight
                      })
                    )
                  }
                >
                  {TERMINAL_FONT_WEIGHTS.map((w) => (
                    <option key={w} value={w}>
                      {terminalFontWeightLabel(locale, w)}
                    </option>
                  ))}
                </select>
              </TerminalField>
            </div>
          ) : (
            <div className="tool-settings-current-card tool-settings-current-card--terminal">
              <div className="tool-settings-terminal-preview-frame tool-settings-terminal-preview-frame--card">
                <TerminalChrome />
                <TerminalPreview
                  theme={resolvedTerminalTheme}
                  fontFamily={terminal.fontFamily}
                  fontSize={previewFontSize}
                  lineHeight={terminal.lineHeight}
                  fontWeight={terminal.fontWeight}
                  compact
                  micro
                />
              </div>
              <div className="tool-settings-current-copy">
                <span className="tool-settings-current-label">{t('tool.settings.colorScheme')}</span>
                <span className="tool-settings-current-value tool-settings-terminal-scheme">
                  <ColorSwatch colors={terminalSwatchColors(resolvedTerminalTheme)} />
                  <span className="tool-settings-terminal-scheme-name">
                    {terminalSchemeLabel(locale, terminal.colorScheme)}
                  </span>
                </span>
                <div className="tool-settings-terminal-tags">
                  <span
                    className="tool-settings-terminal-tag"
                    title={`${t('tool.settings.fontFamily')}: ${terminalFontLabel(locale, terminal.fontFamily)}`}
                  >
                    {terminalFontLabel(locale, terminal.fontFamily)}
                  </span>
                  <span
                    className="tool-settings-terminal-tag"
                    title={`${t('tool.settings.fontSize')}: ${terminal.fontSize}px`}
                  >
                    {terminal.fontSize}px
                  </span>
                  <span
                    className="tool-settings-terminal-tag"
                    title={`${t('tool.settings.lineHeight')}: ${terminal.lineHeight}`}
                  >
                    {t('tool.settings.lineHeight')} {terminal.lineHeight}
                  </span>
                  <span
                    className="tool-settings-terminal-tag"
                    title={`${t('tool.settings.fontWeight')}: ${terminalFontWeightLabel(locale, terminal.fontWeight)}`}
                  >
                    {terminalFontWeightLabel(locale, terminal.fontWeight)}
                  </span>
                </div>
              </div>
            </div>
          )}
        </section>
      )}

      {showStartup && (
        <section className={sectionClass(hasStartupUpdates(updates), sectionIndex++)}>
          <h3 className="tool-settings-section">{t('tool.section.startup')}</h3>
          <StartupLayoutDiagram
            connOpen={snapshot.startup.connSidebarOpen}
            copilotOpen={snapshot.startup.copilotOpen}
            editable={editable}
            changedConn={startupFieldChanged(updates, 'connSidebarOpen')}
            changedCopilot={startupFieldChanged(updates, 'copilotOpen')}
            connLabel={t('startup.connSidebar')}
            copilotLabel={t('startup.copilot')}
            onText={t('startup.on')}
            offText={t('startup.off')}
            onToggleConn={() =>
              change(
                patchStartupUpdates(updates, {
                  connSidebarOpen: !snapshot.startup.connSidebarOpen
                })
              )
            }
            onToggleCopilot={() =>
              change(
                patchStartupUpdates(updates, { copilotOpen: !snapshot.startup.copilotOpen })
              )
            }
          />
        </section>
      )}

      {showAi && (
        <section className={sectionClass(hasAiUpdates(updates), sectionIndex++)}>
          <h3 className="tool-settings-section">{t('tool.section.ai')}</h3>

          {editable ? (
            <>
              {aiUpdates?.copilotModelProfile !== undefined && (
                  <div
                    className={`tool-settings-sub${aiFieldChanged(updates, 'copilotModelProfile') ? ' tool-settings-changed' : ''}`}
                  >
                    <span className="tool-settings-field-label">
                      {t('tool.settings.copilotModelProfile')}
                    </span>
                    <div className="seg seg-profile tool-settings-seg">
                      {MODEL_PROFILES.map((profile) => (
                        <button
                          key={profile.id}
                          type="button"
                          className={ai.copilotModelProfile === profile.id ? 'active' : ''}
                          onClick={() =>
                            change(patchAiUpdates(updates, { copilotModelProfile: profile.id }))
                          }
                        >
                          {modelProfileLabel(locale, profile.id)}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

              {aiUpdates?.nlModelProfile !== undefined && (
                <div
                  className={`tool-settings-sub${aiFieldChanged(updates, 'nlModelProfile') ? ' tool-settings-changed' : ''}`}
                >
                  <span className="tool-settings-field-label">{t('tool.settings.nlModelProfile')}</span>
                  <div className="seg seg-profile tool-settings-seg">
                    {MODEL_PROFILES.map((profile) => (
                      <button
                        key={profile.id}
                        type="button"
                        className={ai.nlModelProfile === profile.id ? 'active' : ''}
                        onClick={() =>
                          change(patchAiUpdates(updates, { nlModelProfile: profile.id }))
                        }
                      >
                        {modelProfileLabel(locale, profile.id)}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {(aiUpdates?.models !== undefined || aiUpdates?.contextLengths !== undefined) && (
                <div className="tool-settings-sub">
                  <span className="tool-settings-field-label">{t('settings.ai.editProfile')}</span>
                  <div className="seg seg-profile tool-settings-seg">
                    {MODEL_PROFILES.map((profile) => (
                      <button
                        key={profile.id}
                        type="button"
                        className={editingProfile === profile.id ? 'active' : ''}
                        onClick={() => setEditingProfile(profile.id)}
                      >
                        {modelProfileLabel(locale, profile.id)}
                      </button>
                    ))}
                  </div>
                  {aiUpdates?.models !== undefined && (
                    <div
                      className={`tool-settings-field${aiNestedFieldChanged(updates, 'models', editingProfile) ? ' tool-settings-changed' : ''}`}
                    >
                      <label>{t('settings.ai.model', { profile: modelProfileLabel(locale, editingProfile) })}</label>
                      <input
                        value={ai.models[editingProfile]}
                        onChange={(e) =>
                          change(patchAiNested(updates, 'models', editingProfile, e.target.value))
                        }
                        placeholder="gpt-4o-mini"
                      />
                    </div>
                  )}
                  {aiUpdates?.contextLengths !== undefined && (
                    <div
                      className={`tool-settings-field${aiNestedFieldChanged(updates, 'contextLengths', editingProfile) ? ' tool-settings-changed' : ''}`}
                    >
                      <label>
                        {t('settings.ai.contextLength', {
                          profile: modelProfileLabel(locale, editingProfile)
                        })}
                      </label>
                      <input
                        type="number"
                        min={1024}
                        step={1024}
                        value={ai.contextLengths[editingProfile]}
                        onChange={(e) => {
                          const parsed = Number.parseInt(e.target.value, 10)
                          if (Number.isFinite(parsed)) {
                            change(
                              patchAiNested(updates, 'contextLengths', editingProfile, parsed)
                            )
                          }
                        }}
                      />
                    </div>
                  )}
                </div>
              )}

              {aiUpdates?.baseURL !== undefined && (
                <div
                  className={`tool-settings-field${aiFieldChanged(updates, 'baseURL') ? ' tool-settings-changed' : ''}`}
                >
                  <label>{t('tool.settings.baseURL')}</label>
                  <input
                    className="mono"
                    value={ai.baseURL}
                    onChange={(e) => change(patchAiUpdates(updates, { baseURL: e.target.value }))}
                    placeholder="https://api.openai.com/v1"
                  />
                </div>
              )}

              {aiUpdates?.apiKey !== undefined && (
                <div
                  className={`tool-settings-field${aiFieldChanged(updates, 'apiKey') ? ' tool-settings-changed' : ''}`}
                >
                  <label>{t('tool.settings.apiKey')}</label>
                  <input
                    type="password"
                    value={String(aiUpdates.apiKey ?? '')}
                    onChange={(e) => change(patchAiUpdates(updates, { apiKey: e.target.value }))}
                    placeholder="sk-..."
                  />
                </div>
              )}
            </>
          ) : (
            <div className="tool-settings-ai-read">
              <div className="tool-settings-sub">
                <span className="tool-settings-field-label">{t('tool.settings.copilotModelProfile')}</span>
                <ReadonlyProfileSeg locale={locale} value={ai.copilotModelProfile} />
              </div>
              <div className="tool-settings-sub">
                <span className="tool-settings-field-label">{t('tool.settings.nlModelProfile')}</span>
                <ReadonlyProfileSeg locale={locale} value={ai.nlModelProfile} />
              </div>

              <div className="tool-settings-provider">
                <div className="tool-settings-provider-row">
                  <span className="tool-settings-provider-label">{t('tool.settings.baseURL')}</span>
                  <span className="tool-settings-provider-value mono">
                    {ai.baseURL || t('tool.settings.providerDefault')}
                  </span>
                </div>
                <div className="tool-settings-provider-row">
                  <span className="tool-settings-provider-label">{t('tool.settings.apiKey')}</span>
                  <span className={`tool-settings-keypill${ai.hasApiKey ? ' is-on' : ''}`}>
                    {ai.hasApiKey ? t('tool.settings.keyConfigured') : t('tool.settings.keyMissing')}
                  </span>
                </div>
              </div>

              <div className="tool-settings-model-block">
                <span className="tool-settings-field-label">{t('tool.settings.activeModels')}</span>
                <div className="tool-settings-model-list">
                  {MODEL_PROFILES.filter(
                    (p) =>
                      Boolean(ai.models[p.id]?.trim()) ||
                      p.id === ai.copilotModelProfile ||
                      p.id === ai.nlModelProfile
                  ).map((profile) => {
                    const isCopilot = profile.id === ai.copilotModelProfile
                    const isNl = profile.id === ai.nlModelProfile
                    const model = ai.models[profile.id]?.trim() || AI_MODEL_FALLBACK
                    const ctx = ai.contextLengths[profile.id]
                    return (
                      <div
                        className={`tool-settings-model-row${isCopilot || isNl ? ' is-active' : ''}`}
                        key={profile.id}
                      >
                        <span className="tool-settings-model-profile">
                          {modelProfileLabel(locale, profile.id)}
                        </span>
                        <span className="tool-settings-model-name mono" title={model}>
                          {model}
                        </span>
                        {ctx ? (
                          <span className="tool-settings-model-ctx" title={`${ctx} tokens`}>
                            {formatContextTokens(ctx)}
                          </span>
                        ) : null}
                        {(isCopilot || isNl) && (
                          <span className="tool-settings-model-tags">
                            {isCopilot && (
                              <span className="tool-settings-tag tool-settings-tag--accent">
                                {t('tool.settings.tagCopilot')}
                              </span>
                            )}
                            {isNl && (
                              <span className="tool-settings-tag tool-settings-tag--accent">
                                {t('tool.settings.tagNl')}
                              </span>
                            )}
                          </span>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            </div>
          )}
        </section>
      )}

      {editable && !showUi && !showTerminal && !showStartup && !showAi && (
        <div className="tool-settings-empty">{t('tool.settings.noChanges')}</div>
      )}
    </div>
  )
}
