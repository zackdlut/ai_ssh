/**
 * Function-calling tool definitions shared between the main process (passed to
 * the OpenAI-compatible Chat Completions API) and the renderer (the dispatcher
 * that actually executes the calls against tabs / saved configs / SSH).
 *
 * The shape matches OpenAI's `tools` array; the provider casts it to the SDK
 * type. Kept free of any OpenAI import so the renderer can use the metadata
 * helpers without pulling the SDK into the renderer bundle.
 */
export interface AIToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

/** Tools that only READ state — they change nothing, anywhere. */
export const READONLY_TOOLS = new Set([
  'list_ssh_configs',
  'list_open_tabs',
  'list_folders',
  'diff_panes',
  'get_app_settings',
  'read_skill',
  'read_file',
  'grep',
  'glob'
])

/**
 * Tools that write, but only to the agent's own bookkeeping inside the app —
 * never to a host, a saved config, or a user setting.
 *
 * These share every behaviour with the read-only tools (auto-approved, absent
 * from the action ledger, not "work done") but are NOT read-only, so the system
 * prompt must not advertise them as such: telling a model that the tool it
 * records progress with is read-only is a small but real lie about its effect.
 */
export const LOCAL_BOOKKEEPING_TOOLS = new Set(['update_plan'])

/**
 * Read-only tools that fully render their result as a rich card the user asked
 * to see (list cards / the settings card). When a turn runs only these, the
 * card IS the answer: the agent loop must not nudge a silent follow-up turn into
 * restating the same data as prose.
 */
export const DISPLAY_TOOLS = new Set([
  'list_ssh_configs',
  'list_open_tabs',
  'list_folders',
  'get_app_settings'
])

/** Action tools whose effect is destructive and deserves a stronger warning. */
export const DANGEROUS_TOOLS = new Set([
  'exec_command',
  'run_in_terminal',
  'close_tab',
  'close_tabs'
])

export function isReadonlyTool(name: string): boolean {
  return READONLY_TOOLS.has(name)
}

/**
 * Whether a call runs without approval and leaves no state worth reporting:
 * true for reads and for the agent's own bookkeeping. This — not
 * `isReadonlyTool` — is the test for approval, the action ledger, and whether a
 * turn actually did anything.
 */
export function isAutoApprovedTool(name: string): boolean {
  return READONLY_TOOLS.has(name) || LOCAL_BOOKKEEPING_TOOLS.has(name)
}

export function isDisplayTool(name: string): boolean {
  return DISPLAY_TOOLS.has(name)
}

export function isDangerousTool(name: string): boolean {
  return DANGEROUS_TOOLS.has(name)
}

/**
 * Tools exposed on the `core` tier.
 *
 * Every tool schema costs tokens on every single turn, and the full set runs to
 * several thousand — affordable for a hosted frontier model, ruinous for a
 * local 32k-context one, which also degrades sharply as the tool list grows.
 * The core tier keeps exactly what a task needs end to end (inspect, read,
 * search, edit, execute, plan) and drops the app-management tools, which a
 * small model can neither drive reliably nor is usually asked to.
 */
const CORE_TIER_TOOLS = new Set([
  'exec_command',
  'read_file',
  'edit_file',
  'grep',
  'glob',
  'list_open_tabs',
  'update_plan',
  'read_skill'
])

/** Size of the tool surface handed to the model. */
export type ToolTier = 'core' | 'full'

/**
 * Local/small models run on the `fast` profile in this app, so that is the tier
 * that gets the trimmed schema. The renderer dispatcher always accepts every
 * tool regardless of tier, so an older chat whose history references a
 * now-hidden tool still replays correctly.
 */
export function toolTierForProfile(profile: string | undefined): ToolTier {
  return profile === 'fast' ? 'core' : 'full'
}

/** What the installed configuration makes worth sending, beyond the tier. */
export interface ToolSurfaceOptions {
  /**
   * Whether at least one skill is installed AND enabled. With none, `read_skill`
   * has nothing to load: its schema, the skills catalog and the prompt
   * paragraphs gated on it would all be paid for on every turn to describe a
   * capability with an empty backing store. Defaults to false, so a caller that
   * has not checked does not advertise skills that may not exist.
   */
  hasSkills?: boolean
  /**
   * Whether this turn's request is about AI configuration (see
   * AI_SETTINGS_INTENT). Only then does update_app_settings carry its `ai`
   * branch, the single largest schema in the app.
   */
  aiSettingsIntent?: boolean
}

export function buildAITools(tier: ToolTier, opts: ToolSurfaceOptions = {}): AIToolDefinition[] {
  const inTier =
    tier === 'full' ? AI_TOOLS : AI_TOOLS.filter((t) => CORE_TIER_TOOLS.has(t.function.name))
  const withSkills = opts.hasSkills
    ? inTier
    : inTier.filter((t) => t.function.name !== 'read_skill')
  if (!opts.aiSettingsIntent) return withSkills
  return withSkills.map((t) =>
    t.function.name === 'update_app_settings' ? UPDATE_APP_SETTINGS_FULL : t
  )
}

/**
 * Names of the tools a tier sends. The system prompt is assembled from these,
 * so it can never advertise or explain a tool the model was not given.
 */
export function toolNamesFor(tier: ToolTier, opts: ToolSurfaceOptions = {}): string[] {
  return buildAITools(tier, opts).map((t) => t.function.name)
}

/**
 * The tab_id parameter, shared by every host-facing tool. One definition rather
 * than a per-tool rewording: the schemas are re-sent on every single turn, so a
 * phrase repeated eight times is paid for eight times, and the wording drifting
 * between tools taught the model nothing extra.
 */
const TAB_ID_PARAM = {
  type: 'string',
  description:
    'Connected tab to act on, by tab_id from the snapshot. Defaults to the pinned tab when omitted.'
} as const

/** Suffix shared by the list_* tools, whose ids the snapshot already carries. */
const SNAPSHOT_NOTE =
  'The snapshot already carries these ids, so call this to show the user the list, or when the snapshot lacks what you need.'

/** Every tool but update_app_settings, whose shape is decided per turn below. */
const BASE_TOOLS: AIToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'list_ssh_configs',
      description: `List the saved SSH connection configs (no secrets) with their config_id. ${SNAPSHOT_NOTE}`,
      parameters: { type: 'object', properties: {}, additionalProperties: false }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_open_tabs',
      description: `List the open SSH terminal tabs with their tab_id, host and connection status. ${SNAPSHOT_NOTE}`,
      parameters: { type: 'object', properties: {}, additionalProperties: false }
    }
  },
  {
    type: 'function',
    function: {
      name: 'diff_panes',
      description:
        "Compare two terminal tabs' output line by line and return a unified diff. Use it when the user asks what differs between two hosts or panes; it reads the existing buffers, so it never runs anything on either host.",
      parameters: {
        type: 'object',
        properties: {
          left_tab_id: { type: 'string', description: 'tab_id of the left (old) side.' },
          right_tab_id: { type: 'string', description: 'tab_id of the right (new) side.' },
          range: {
            type: 'string',
            enum: ['viewport', 'recent', 'all'],
            description:
              "How much of each buffer to read: 'viewport' for what is on screen, 'recent' for the last ~1000 lines (default), 'all' for the whole scrollback."
          },
          normalize: {
            type: 'boolean',
            description:
              'When true (default), fold trailing whitespace and mask volatile values such as timestamps and PIDs so they do not swamp the diff.'
          }
        },
        required: ['left_tab_id', 'right_tab_id'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_folders',
      description: `List the saved bookmark folders (the connection sidebar tree) with their folder_id, name and parent_folder_id. ${SNAPSHOT_NOTE}`,
      parameters: { type: 'object', properties: {}, additionalProperties: false }
    }
  },
  {
    type: 'function',
    function: {
      name: 'open_ssh',
      description:
        'Open a new SSH terminal tab. Prefer passing config_id (from list_ssh_configs). Otherwise pass host + username (+ optional port/password/privateKey) to connect ad-hoc.',
      parameters: {
        type: 'object',
        properties: {
          config_id: {
            type: 'string',
            description: 'Id of a saved connection config to open.'
          },
          host: { type: 'string', description: 'Hostname or IP (when not using config_id).' },
          username: { type: 'string', description: 'SSH username (required with host).' },
          port: { type: 'number', description: 'SSH port (defaults to 22).' },
          password: { type: 'string', description: 'Password (optional).' },
          privateKey: {
            type: 'string',
            description: 'Private key path or PEM contents (optional).'
          }
        },
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'close_tab',
      description:
        'Close ONE open SSH terminal tab and end its session. Use close_tabs instead when the user asks for several or all of them.',
      parameters: {
        type: 'object',
        properties: {
          tab_id: { type: 'string', description: 'Id of the open tab to close.' }
        },
        required: ['tab_id'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'close_tabs',
      description:
        'Close MULTIPLE open SSH terminal tabs in one call. Pass tab_ids (array of ids) to close specific tabs, or set all=true to close every open tab. ALWAYS use this (not repeated close_tab) when the user asks to close several / all tabs.',
      parameters: {
        type: 'object',
        properties: {
          tab_ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'Ids of the open tabs to close.'
          },
          all: { type: 'boolean', description: 'Close all open tabs.' }
        },
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'create_ssh_config',
      description:
        'Save a new SSH connection config locally so it appears in the sidebar and can be reopened later. This only stores the connection — it does not connect; call open_ssh to do that.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Display name for the saved connection.' },
          host: { type: 'string', description: 'Hostname or IP.' },
          username: { type: 'string', description: 'SSH username.' },
          port: { type: 'number', description: 'SSH port (defaults to 22).' },
          password: { type: 'string', description: 'Password (optional).' },
          privateKey: {
            type: 'string',
            description: 'Private key path or PEM contents (optional).'
          },
          passphrase: { type: 'string', description: 'Private key passphrase (optional).' }
        },
        required: ['name', 'host', 'username'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'update_ssh_config',
      description:
        'Update fields of an existing saved SSH config. Pass config_id plus an updates object containing only the fields to change.',
      parameters: {
        type: 'object',
        properties: {
          config_id: { type: 'string', description: 'Id of the saved config to update.' },
          updates: {
            type: 'object',
            description: 'Only the fields to change; anything omitted keeps its current value.',
            properties: {
              name: { type: 'string', description: 'Display name for the saved connection.' },
              host: { type: 'string', description: 'Hostname or IP.' },
              username: { type: 'string', description: 'SSH username.' },
              port: { type: 'number', description: 'SSH port.' },
              password: { type: 'string', description: 'Password.' },
              privateKey: { type: 'string', description: 'Private key path or PEM contents.' },
              passphrase: { type: 'string', description: 'Private key passphrase.' }
            },
            additionalProperties: false
          }
        },
        required: ['config_id', 'updates'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'create_folder',
      description:
        'Create a new bookmark folder in the connection sidebar tree (or return the existing one if a folder with the same name already exists under the same parent). Pass a display name and, optionally, parent_folder_id or parent_folder_name to nest it inside an existing folder (omit both for a top-level folder).',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Display name for the new folder.' },
          parent_folder_id: {
            type: 'string',
            description: 'Id of the parent folder to nest under. Omit for a top-level folder.'
          },
          parent_folder_name: {
            type: 'string',
            description:
              'Name of the parent folder to nest under (alternative to parent_folder_id). Omit both for a top-level folder.'
          }
        },
        required: ['name'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'move_connection_to_folder',
      description:
        'Move a saved SSH connection into a bookmark folder (or to the top level). Identify the connection by config_id (preferred, from list_ssh_configs) or connection_name. Identify the destination by folder_id (preferred, from list_folders) or folder_name; omit both to move the connection to the top level. If you are NOT certain of the exact folder_id, pass folder_name instead of guessing an id. The destination folder must already exist — call create_folder first if it does not.',
      parameters: {
        type: 'object',
        properties: {
          config_id: { type: 'string', description: 'Id of the saved connection to move.' },
          connection_name: {
            type: 'string',
            description: 'Name of the saved connection (alternative to config_id).'
          },
          folder_id: {
            type: 'string',
            description: 'Id of the destination folder. Omit (with folder_name) to move to the top level.'
          },
          folder_name: {
            type: 'string',
            description:
              'Name of the destination folder (alternative to folder_id). Use this when unsure of the exact id. Omit both folder_id and folder_name to move to the top level.'
          }
        },
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'exec_command',
      description:
        'Run a shell command on the host behind an open, CONNECTED tab, on a private channel that neither disturbs nor is disturbed by the user typing. Returns a header (status, exit_code, cwd, optional verify hint) then the output.',
      parameters: {
        type: 'object',
        properties: {
          tab_id: TAB_ID_PARAM,
          command: {
            type: 'string',
            description:
              'The command to execute. Each call starts fresh in the last observed cwd, so `cd` does not persist between calls — pass an absolute path, or chain `cd /x && cmd` inside this one command.'
          }
        },
        required: ['tab_id', 'command'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_in_terminal',
      description:
        "Run a command in the user's visible terminal session, so they watch it execute and keep its output in their scrollback. Use ONLY when being seen matters (a demo, a long build the user asked to watch, or a command that leaves the shell in a state later commands depend on, like an interactive login). For everything else use exec_command.",
      parameters: {
        type: 'object',
        properties: {
          tab_id: TAB_ID_PARAM,
          command: { type: 'string', description: 'The shell command to execute.' }
        },
        required: ['tab_id', 'command'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description:
        'Read a file on the host over SFTP, returned with line numbers. Unclamped by the shell capture buffer, and pageable via offset/limit.',
      parameters: {
        type: 'object',
        properties: {
          tab_id: TAB_ID_PARAM,
          path: { type: 'string', description: 'Absolute path of the file to read.' },
          offset: {
            type: 'number',
            description: '1-based line to start at (default 1); a truncated read suggests the next value.'
          },
          limit: { type: 'number', description: 'Max lines to return (default 800, max 3000).' }
        },
        required: ['tab_id', 'path'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description:
        'Replace an exact block of text in a file on the host. old_string must appear EXACTLY ONCE unless replace_all is true, so copy it verbatim from read_file (including indentation). The previous contents are backed up automatically.',
      parameters: {
        type: 'object',
        properties: {
          tab_id: TAB_ID_PARAM,
          path: { type: 'string', description: 'Absolute path of the file to edit.' },
          old_string: {
            type: 'string',
            description: 'Exact text to replace, verbatim from read_file WITHOUT the line-number prefix.'
          },
          new_string: { type: 'string', description: 'Replacement text; empty string deletes.' },
          replace_all: {
            type: 'boolean',
            description: 'Replace every occurrence instead of requiring a unique match (default false).'
          }
        },
        required: ['tab_id', 'path', 'old_string', 'new_string'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description:
        'Create a file on the host, or overwrite one completely with new contents. Use edit_file for targeted changes to an existing file; use this only for new files or full rewrites. Existing contents are backed up automatically.',
      parameters: {
        type: 'object',
        properties: {
          tab_id: TAB_ID_PARAM,
          path: { type: 'string', description: 'Absolute path of the file to write.' },
          content: { type: 'string', description: 'Full contents of the file.' }
        },
        required: ['tab_id', 'path', 'content'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'grep',
      description:
        'Search file CONTENTS on the host with an extended regular expression, returning path:line:text matches. Use it to locate a config directive or log entry instead of paging whole files.',
      parameters: {
        type: 'object',
        properties: {
          tab_id: TAB_ID_PARAM,
          pattern: { type: 'string', description: 'Extended regular expression (grep -E syntax).' },
          path: { type: 'string', description: 'Directory or file to search (default: cwd).' },
          glob: { type: 'string', description: 'Only search files whose name matches this glob, e.g. "*.conf".' },
          max_results: { type: 'number', description: 'Max matches to return (default 100, max 500).' }
        },
        required: ['tab_id', 'pattern'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'glob',
      description: 'Find files on the host by NAME or path pattern, to discover where something lives.',
      parameters: {
        type: 'object',
        properties: {
          tab_id: TAB_ID_PARAM,
          pattern: {
            type: 'string',
            description: 'Name pattern such as "*.conf", or a path pattern containing "/" such as "*/sites-enabled/*".'
          },
          path: { type: 'string', description: 'Directory to search under (default: cwd).' },
          max_results: { type: 'number', description: 'Max paths to return (default 100, max 500).' }
        },
        required: ['tab_id', 'pattern'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'update_plan',
      description:
        'Create or update the task plan shown to the user, then call it again to mark each step done. Send the COMPLETE list every time — it replaces the previous plan. Exactly one step is in_progress at a time.',
      parameters: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            description: 'The full ordered list of plan steps.',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string', description: 'Short imperative description of the step.' },
                status: {
                  type: 'string',
                  enum: ['pending', 'in_progress', 'completed', 'cancelled']
                }
              },
              required: ['title', 'status'],
              additionalProperties: false
            }
          }
        },
        required: ['items'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_skill',
      description:
        "Load the full step-by-step instructions of an installed skill by its exact name. The per-turn snapshot lists each available skill as a name plus a short description. When a skill clearly matches the user's task, call this FIRST to read its instructions, then follow them. Pass the exact name from the available-skills list; never invent a skill name.",
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'The exact skill name from the available-skills list.'
          }
        },
        required: ['name'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_app_settings',
      description:
        'Read the current application settings: UI theme, language, terminal appearance, startup panel preferences, user_rules (custom copilot instructions), and AI configuration (apiKey is not returned; only hasApiKey). Call this when unsure of current values before updating.',
      parameters: { type: 'object', properties: {}, additionalProperties: false }
    }
  },
]

/**
 * The `ai` branch of update_app_settings: provider endpoints, keys, per-profile
 * models and context windows.
 *
 * Lifted out because it is by far the largest schema in the app — roughly a
 * quarter of the whole tool payload, re-sent on every single turn — while being
 * the one branch users almost always drive from the Settings dialog rather than
 * by asking. It rides along only on turns whose request is actually about AI
 * configuration; see AI_SETTINGS_INTENT.
 */
const AI_SETTINGS_SCHEMA = {
  type: 'object',
  description: 'AI provider and model settings.',
  properties: {
    baseURL: { type: 'string', description: 'Base URL for the default profile.' },
    apiKey: { type: 'string', description: 'API key for the default profile.' },
    httpProxy: {
      type: 'string',
      description:
        'HTTP(S) proxy URL for AI API requests (e.g. http://127.0.0.1:7890). Empty disables the app setting; env HTTPS_PROXY/HTTP_PROXY may still apply.'
    },
    baseURLs: {
      type: 'object',
      description: 'Base URL per profile tier (empty inherits default).',
      properties: {
        default: { type: 'string' },
        fast: { type: 'string' },
        medium: { type: 'string' },
        high: { type: 'string' },
        custom: { type: 'string' }
      },
      additionalProperties: false
    },
    apiKeys: {
      type: 'object',
      description: 'API key per profile tier (empty inherits default).',
      properties: {
        default: { type: 'string' },
        fast: { type: 'string' },
        medium: { type: 'string' },
        high: { type: 'string' },
        custom: { type: 'string' }
      },
      additionalProperties: false
    },
    copilotModelProfile: {
      type: 'string',
      enum: ['default', 'fast', 'medium', 'high', 'custom'],
      description:
        'Which profile this chat copilot runs on. "fast" also trims the tool set for small local models.'
    },
    nlModelProfile: {
      type: 'string',
      enum: ['default', 'fast', 'medium', 'high', 'custom'],
      description: 'Which profile the in-terminal natural-language mode runs on.'
    },
    models: {
      type: 'object',
      description: 'Model name per profile tier, e.g. { "fast": "qwen2.5:7b" }.',
      properties: {
        default: { type: 'string' },
        fast: { type: 'string' },
        medium: { type: 'string' },
        high: { type: 'string' },
        custom: { type: 'string' }
      },
      additionalProperties: false
    },
    contextLengths: {
      type: 'object',
      description:
        "Context window (tokens) per profile tier. Must match the model's real window: too high overflows it, too low compresses the chat early.",
      properties: {
        default: { type: 'number' },
        fast: { type: 'number' },
        medium: { type: 'number' },
        high: { type: 'number' },
        custom: { type: 'number' }
      },
      additionalProperties: false
    }
  },
  additionalProperties: false
} as const

/**
 * Requests that want the AI-configuration branch of the settings tool.
 *
 * Deliberately precise rather than greedy. Bare `model`, `profile`, `token` and
 * `context` all occur constantly in ordinary SSH work — `.bash_profile` alone
 * would fire on a large share of turns — and a term that matches everything
 * gates nothing. Precision is affordable here because a miss is recoverable:
 * the slim schema still accepts an `ai` object and points the model at
 * get_app_settings for the field names, so the worst case is one extra read
 * rather than a lost capability.
 */
export const AI_SETTINGS_INTENT =
  /\b(?:llm|api[\s_-]?keys?|base[\s_-]?urls?|ollama|openai|anthropic|deepseek|context[\s_-]?(?:length|window)|copilot\s+model|model\s+profile|ai\s+(?:settings?|model|provider|config\w*))\b|ai\s*(?:设置|配置)|模型|接口地址|密钥|上下文长度|上下文窗口|档位|供应商/i

/**
 * update_app_settings, with or without the heavyweight `ai` branch. The tool
 * keeps ONE name across both shapes: the dispatcher, approval policy, result
 * card and i18n labels all key off the name, and a task that started on the slim
 * shape must not see the tool disappear and reappear under another identity.
 */
function buildUpdateAppSettingsTool(withAI: boolean): AIToolDefinition {
  return {
    type: 'function',
    function: {
      name: 'update_app_settings',
      description:
        'Change application settings. Batch several categories into one call when the user asks for several changes.',
      parameters: {
        type: 'object',
        properties: {
          updates: {
            type: 'object',
            description:
              'Only the settings to change; anything omitted keeps its value. Nest each under its category — a terminal font in terminal_appearance, a startup panel in startup.',
            properties: {
              theme: {
                type: 'string',
                enum: ['aurora', 'dawn'],
                description: 'Application UI theme. aurora = dark, dawn = light.'
              },
              locale: {
                type: 'string',
                enum: ['zh', 'en'],
                description: 'UI display language.'
              },
              startup: {
                type: 'object',
                description: 'Which side panels open automatically on app launch.',
                properties: {
                  connSidebarOpen: { type: 'boolean', description: 'Left connection sidebar.' },
                  copilotOpen: { type: 'boolean', description: 'Right AI Copilot chat sidebar.' }
                },
                additionalProperties: false
              },
              terminal_appearance: {
                type: 'object',
                description: 'Terminal font and color settings.',
                properties: {
                  colorScheme: {
                    type: 'string',
                    enum: [
                      'auto',
                      'aurora',
                      'dawn',
                      'campbell',
                      'campbell-powershell',
                      'one-half-dark',
                      'one-half-light',
                      'solarized-dark',
                      'solarized-light',
                      'dark-plus',
                      'tango-dark',
                      'tango-light'
                    ],
                    description:
                      'Terminal color palette. "auto" follows the app theme; the rest are fixed palettes.'
                  },
                  fontFamily: {
                    type: 'string',
                    description: 'CSS font-family list for the terminal, e.g. "JetBrains Mono".'
                  },
                  fontSize: { type: 'number', description: '8–32 px.' },
                  lineHeight: { type: 'number', description: '1.0–2.5.' },
                  fontWeight: {
                    type: 'string',
                    description: 'Terminal font weight.',
                    enum: [
                      'thin',
                      'extra-light',
                      'light',
                      'semi-light',
                      'normal',
                      'medium',
                      'semi-bold',
                      'bold',
                      'extra-bold',
                      'black',
                      'extra-black'
                    ]
                  }
                },
                additionalProperties: false
              },
              // Without the full branch the field still exists, so a request the
              // intent test missed is one get_app_settings away from working
              // rather than dead — the dispatcher accepts the same shape either
              // way.
              ai: withAI
                ? AI_SETTINGS_SCHEMA
                : {
                    type: 'object',
                    description:
                      'AI provider, model and context-length settings. Field names are not listed here: read them from get_app_settings and mirror that shape.'
                  },
              user_rules: {
                type: 'string',
                description:
                  'Custom instructions injected into the copilot system prompt to guide agent behavior (plain text, multi-line allowed).'
              }
            },
            additionalProperties: false
          }
        },
        required: ['updates'],
        additionalProperties: false
      }
    }
  }
}

const UPDATE_APP_SETTINGS_SLIM = buildUpdateAppSettingsTool(false)
const UPDATE_APP_SETTINGS_FULL = buildUpdateAppSettingsTool(true)

/**
 * The canonical full tool surface. Carries the SLIM settings tool, because that
 * is what a turn gets unless it asks about AI configuration — so consumers that
 * measure "the whole tool set" measure the common case.
 */
export const AI_TOOLS: AIToolDefinition[] = [...BASE_TOOLS, UPDATE_APP_SETTINGS_SLIM]
