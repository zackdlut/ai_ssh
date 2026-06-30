import { isDangerous } from './dangerousCommands'

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
  'get_app_settings'
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
export const DANGEROUS_TOOLS = new Set(['exec_command', 'close_tab', 'close_tabs'])

export function isReadonlyTool(name: string): boolean {
  return READONLY_TOOLS.has(name)
}

export function isDisplayTool(name: string): boolean {
  return DISPLAY_TOOLS.has(name)
}

export function isDangerousTool(name: string): boolean {
  return DANGEROUS_TOOLS.has(name)
}

/** Whether an action tool call must wait for explicit user approval before running. */
export function requiresToolApproval(name: string, argsJson = '{}'): boolean {
  if (isReadonlyTool(name)) return false
  if (name === 'exec_command') {
    try {
      const args = JSON.parse(argsJson) as { command?: unknown }
      return isDangerous(String(args.command ?? ''))
    } catch {
      return true
    }
  }
  return true
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
        'Run a shell command in an open, connected SSH terminal tab and return the captured output. Requires a tab_id (resolve via list_open_tabs).',
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
      name: 'get_app_settings',
      description:
        'Read the current application settings: UI theme, language, terminal appearance, and AI configuration (apiKey is not returned; only hasApiKey). Call this when unsure of current values before updating.',
      parameters: { type: 'object', properties: {}, additionalProperties: false }
    }
  },
  {
    type: 'function',
    function: {
      name: 'update_app_settings',
      description:
        'Update application settings. Pass an updates object with only the fields to change. Supports theme (aurora/dawn), locale (zh/en), terminal_appearance (colorScheme, fontFamily, fontSize, lineHeight, fontWeight), and ai (baseURL, apiKey, copilotModelProfile, nlModelProfile, models, contextLengths). Batch multiple categories in one call when the user asks for several changes.',
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
                  baseURL: { type: 'string' },
                  apiKey: { type: 'string' },
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
