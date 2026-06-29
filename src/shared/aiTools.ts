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
export const READONLY_TOOLS = new Set(['list_ssh_configs', 'list_open_tabs'])

/** Action tools whose effect is destructive and deserves a stronger warning. */
export const DANGEROUS_TOOLS = new Set(['exec_command', 'close_tab', 'close_tabs'])

export function isReadonlyTool(name: string): boolean {
  return READONLY_TOOLS.has(name)
}

export function isDangerousTool(name: string): boolean {
  return DANGEROUS_TOOLS.has(name)
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
  }
]
