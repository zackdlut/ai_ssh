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

/** Tools that only read state and are safe to run without user approval. */
export const READONLY_TOOLS = new Set([
  'list_ssh_configs',
  'list_open_tabs',
  'list_folders',
  'get_app_settings',
  'read_skill',
  'read_file',
  'grep',
  'glob',
  'update_plan'
])

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

export function buildAITools(tier: ToolTier): AIToolDefinition[] {
  if (tier === 'full') return AI_TOOLS
  return AI_TOOLS.filter((t) => CORE_TIER_TOOLS.has(t.function.name))
}

export const AI_TOOLS: AIToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'list_ssh_configs',
      description:
        'List the locally saved SSH connection configs (no secrets). Use this to resolve a config_id before opening, updating, or referencing a saved connection.',
      parameters: { type: 'object', properties: {}, additionalProperties: false }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_open_tabs',
      description:
        'List the currently open SSH terminal tabs with their tab_id, host and connection status. Use this to resolve a tab_id before closing a tab or executing a command.',
      parameters: { type: 'object', properties: {}, additionalProperties: false }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_folders',
      description:
        'List the locally saved bookmark folders (the connection sidebar tree). Returns each folder with its folder_id, name and parent_folder_id. Use this to resolve a folder_id before creating a subfolder or moving a connection into a folder.',
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
      description: 'Close an open SSH terminal tab and end its session. Requires a tab_id.',
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
      description: 'Create and save a new SSH connection config locally.',
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
            description: 'Partial fields to change.',
            properties: {
              name: { type: 'string' },
              host: { type: 'string' },
              username: { type: 'string' },
              port: { type: 'number' },
              password: { type: 'string' },
              privateKey: { type: 'string' },
              passphrase: { type: 'string' }
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
        'Run a shell command on the host behind an open, connected terminal tab and return its output and exit code. Runs on a private channel, so it neither disturbs nor is disturbed by what the user is typing. Requires a tab_id (resolve via list_open_tabs).',
      parameters: {
        type: 'object',
        properties: {
          tab_id: { type: 'string', description: 'Id of the connected tab to run the command in.' },
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
      name: 'run_in_terminal',
      description:
        "Run a command in the user's visible terminal session, so they watch it execute and keep its output in their scrollback. Use ONLY when being seen matters (a demo, a long build the user asked to watch, or a command that leaves the shell in a state later commands depend on, like an interactive login). For everything else use exec_command.",
      parameters: {
        type: 'object',
        properties: {
          tab_id: { type: 'string', description: 'Id of the connected tab to run the command in.' },
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
        'Read a file on the host over SFTP and return it with line numbers. Prefer this over `cat` via exec_command: it does not disturb the terminal, is not clamped by the shell capture buffer, and supports paging. Read a file BEFORE editing it so edit_file can match exact text.',
      parameters: {
        type: 'object',
        properties: {
          tab_id: { type: 'string', description: 'Id of the connected tab whose host to read from.' },
          path: { type: 'string', description: 'Absolute path of the file to read.' },
          offset: {
            type: 'number',
            description: '1-based line to start at (default 1). Use the value suggested by a previous truncated read.'
          },
          limit: { type: 'number', description: 'Maximum number of lines to return (default 800, max 3000).' }
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
        'Replace an exact block of text in a file on the host. old_string must appear EXACTLY ONCE unless replace_all is true, so read_file first and copy the target text verbatim (including indentation). This is the preferred way to change a config or script — never use `sed -i` for a targeted edit. The previous contents are backed up automatically.',
      parameters: {
        type: 'object',
        properties: {
          tab_id: { type: 'string', description: 'Id of the connected tab whose host to edit on.' },
          path: { type: 'string', description: 'Absolute path of the file to edit.' },
          old_string: {
            type: 'string',
            description: 'Exact text to replace, copied verbatim from read_file output (WITHOUT the line-number prefix).'
          },
          new_string: { type: 'string', description: 'Replacement text. Pass an empty string to delete.' },
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
          tab_id: { type: 'string', description: 'Id of the connected tab whose host to write to.' },
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
        'Search file CONTENTS on the host with an extended regular expression, returning path:line:text matches. Use this to locate a config directive or log entry instead of paging whole files with read_file.',
      parameters: {
        type: 'object',
        properties: {
          tab_id: { type: 'string', description: 'Id of the connected tab whose host to search.' },
          pattern: { type: 'string', description: 'Extended regular expression (grep -E syntax).' },
          path: { type: 'string', description: 'Directory or file to search (default: current directory).' },
          glob: { type: 'string', description: 'Only search files whose name matches this glob, e.g. "*.conf".' },
          max_results: { type: 'number', description: 'Maximum matches to return (default 100, max 500).' }
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
      description:
        'Find files by NAME or path pattern on the host. Use this to discover where something lives before reading it.',
      parameters: {
        type: 'object',
        properties: {
          tab_id: { type: 'string', description: 'Id of the connected tab whose host to search.' },
          pattern: {
            type: 'string',
            description: 'Name pattern such as "*.conf", or a path pattern containing "/" such as "*/sites-enabled/*".'
          },
          path: { type: 'string', description: 'Directory to search under (default: current directory).' },
          max_results: { type: 'number', description: 'Maximum paths to return (default 100, max 500).' }
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
        "Create or update the task plan shown to the user. Call this FIRST for any task needing more than one or two steps, then call it again to mark each step completed as you go. Send the COMPLETE list every time — it replaces the previous plan. Exactly one step should be in_progress at a time. Single-step requests need no plan.",
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
                  enum: ['pending', 'in_progress', 'completed', 'cancelled'],
                  description: 'Current state of this step.'
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
  {
    type: 'function',
    function: {
      name: 'update_app_settings',
      description:
        'Update application settings. Pass an updates object with only the fields to change. Supports theme (aurora/dawn), locale (zh/en), terminal_appearance (colorScheme, fontFamily, fontSize, lineHeight, fontWeight), startup (connSidebarOpen, copilotOpen — whether each side panel opens on app launch), user_rules (custom copilot instructions as plain text), and ai (baseURL, apiKey — these target the default profile; baseURLs and apiKeys per-profile objects; copilotModelProfile, nlModelProfile, models, contextLengths). baseURLs/apiKeys are keyed by profile (default/fast/medium/high/custom); a profile left empty inherits the default profile. Batch multiple categories in one call when the user asks for several changes.',
      parameters: {
        type: 'object',
        properties: {
          updates: {
            type: 'object',
            description: 'Partial settings to change.',
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
                  connSidebarOpen: {
                    type: 'boolean',
                    description: 'Open the left connection sidebar on startup.'
                  },
                  copilotOpen: {
                    type: 'boolean',
                    description: 'Open the right AI Copilot chat sidebar on startup.'
                  }
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
                    ]
                  },
                  fontFamily: { type: 'string' },
                  fontSize: { type: 'number', description: '8–32 px.' },
                  lineHeight: { type: 'number', description: '1.0–2.5.' },
                  fontWeight: {
                    type: 'string',
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
              ai: {
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
                    enum: ['default', 'fast', 'medium', 'high', 'custom']
                  },
                  nlModelProfile: {
                    type: 'string',
                    enum: ['default', 'fast', 'medium', 'high', 'custom']
                  },
                  models: {
                    type: 'object',
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
]
