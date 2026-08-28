import { describe, expect, it } from 'vitest'
import { decideToolCall, isReadOnlyCommand, usesSudo, type ToolDecision } from './toolPolicy'

function decideExec(command: string, mode: 'conservative' | 'balanced' | 'autonomous'): ToolDecision {
  return decideToolCall({
    tool: 'exec_command',
    argsJson: JSON.stringify({ tab_id: 't1', command }),
    mode
  })
}

describe('isReadOnlyCommand', () => {
  it('accepts the common investigative commands', () => {
    for (const cmd of [
      'ls -la /etc',
      'cat /var/log/syslog',
      'ps aux | grep nginx',
      'df -h',
      'systemctl status nginx',
      'journalctl -u nginx -n 200',
      'git status'
    ]) {
      expect(isReadOnlyCommand(cmd), cmd).toBe(true)
    }
  })

  it('rejects writes hiding behind an observational command', () => {
    for (const cmd of [
      'cat x > /etc/hosts',
      'echo test >> /etc/fstab',
      'sed -i s/a/b/ /etc/nginx.conf',
      'cat file | tee /etc/motd',
      'ls $(rm -rf /tmp/x)',
      'ls `whoami`'
    ]) {
      expect(isReadOnlyCommand(cmd), cmd).toBe(false)
    }
  })

  it('rejects mutating subcommands of otherwise safe tools', () => {
    for (const cmd of ['systemctl stop nginx', 'git push origin main', 'docker rm -f web', 'kubectl delete pod x']) {
      expect(isReadOnlyCommand(cmd), cmd).toBe(false)
    }
  })

  it('rejects anything it does not positively recognize', () => {
    expect(isReadOnlyCommand('some-unknown-binary --flag')).toBe(false)
    expect(isReadOnlyCommand('')).toBe(false)
  })

  it('treats privilege escalation as never read-only', () => {
    expect(usesSudo('sudo ls')).toBe(true)
    expect(isReadOnlyCommand('sudo ls /root')).toBe(false)
  })
})

describe('decideToolCall', () => {
  it('runs read-only tools without asking, in every mode', () => {
    for (const mode of ['conservative', 'balanced', 'autonomous'] as const) {
      expect(decideToolCall({ tool: 'read_file', mode })).toBe('auto')
      expect(decideToolCall({ tool: 'grep', mode })).toBe('auto')
      expect(decideToolCall({ tool: 'update_plan', mode })).toBe('auto')
    }
  })

  it('runs git_read unattended and always asks before git_commit', () => {
    // The whole point of the dedicated read tool: "show me git status" must not
    // produce an approval card, while the one git tool that writes always does.
    for (const mode of ['conservative', 'balanced', 'autonomous'] as const) {
      expect(decideToolCall({ tool: 'git_read', mode }), mode).toBe('auto')
    }
    expect(decideToolCall({ tool: 'git_commit', mode: 'balanced' })).toBe('ask')
    expect(decideToolCall({ tool: 'git_commit', mode: 'conservative' })).toBe('ask')
  })

  it('lets git_read through Plan mode but not git_commit or apply_patch', () => {
    expect(decideToolCall({ tool: 'git_read', mode: 'balanced', agentMode: 'plan' })).toBe('auto')
    expect(decideToolCall({ tool: 'git_commit', mode: 'autonomous', agentMode: 'plan' })).toBe('deny')
    expect(decideToolCall({ tool: 'apply_patch', mode: 'autonomous', agentMode: 'plan' })).toBe('deny')
  })

  it('treats apply_patch exactly like the other host writes', () => {
    expect(decideToolCall({ tool: 'apply_patch', mode: 'balanced' })).toBe('ask')
    expect(decideToolCall({ tool: 'apply_patch', mode: 'conservative' })).toBe('ask')
    expect(decideToolCall({ tool: 'apply_patch', mode: 'autonomous' })).toBe('auto')
  })

  it('fixes the inversion this policy was written for', () => {
    // Previously: a theme change needed a click, `systemctl stop` did not.
    expect(decideToolCall({ tool: 'update_app_settings', mode: 'balanced' })).toBe('auto')
    expect(decideExec('systemctl stop nginx', 'balanced')).toBe('ask')
  })

  it('auto-runs investigation but asks before writes in balanced mode', () => {
    expect(decideExec('journalctl -u nginx -n 100', 'balanced')).toBe('auto')
    expect(decideExec('apt-get install -y nginx', 'balanced')).toBe('ask')
  })

  it('asks for everything but denies destruction in conservative mode', () => {
    expect(decideExec('ls -la', 'conservative')).toBe('ask')
    expect(decideExec('rm -rf /', 'conservative')).toBe('deny')
  })

  it('still asks before a destructive command in autonomous mode', () => {
    expect(decideExec('ls -la', 'autonomous')).toBe('auto')
    expect(decideExec('write_file-ish anything', 'autonomous')).toBe('auto')
    expect(decideExec('rm -rf /', 'autonomous')).toBe('ask')
  })

  it('does not read unparseable arguments as safe', () => {
    expect(decideToolCall({ tool: 'exec_command', argsJson: '{"command":', mode: 'autonomous' })).toBe('ask')
  })

  it('honours a session-scoped grant for a non-destructive tool', () => {
    const allow = new Set(['write_file'])
    expect(decideToolCall({ tool: 'write_file', mode: 'balanced' })).toBe('ask')
    expect(decideToolCall({ tool: 'write_file', mode: 'balanced', sessionAllowlist: allow })).toBe('auto')
  })

  it('applies the command policy to run_in_terminal as well', () => {
    const args = JSON.stringify({ tab_id: 't1', command: 'rm -rf /' })
    expect(decideToolCall({ tool: 'run_in_terminal', argsJson: args, mode: 'autonomous' })).toBe('ask')
  })

  it('in plan mode auto-runs read-only exec and denies writes', () => {
    expect(
      decideToolCall({
        tool: 'exec_command',
        argsJson: JSON.stringify({ command: 'ls -la' }),
        mode: 'balanced',
        agentMode: 'plan'
      })
    ).toBe('auto')
    expect(
      decideToolCall({
        tool: 'exec_command',
        argsJson: JSON.stringify({ command: 'systemctl restart nginx' }),
        mode: 'balanced',
        agentMode: 'plan'
      })
    ).toBe('deny')
    expect(decideToolCall({ tool: 'edit_file', mode: 'autonomous', agentMode: 'plan' })).toBe('deny')
    expect(
      decideToolCall({
        tool: 'write_file',
        mode: 'balanced',
        agentMode: 'plan',
        sessionAllowlist: new Set(['write_file'])
      })
    ).toBe('deny')
  })

  it('runs a delegated sub-agent unattended everywhere it is offered', () => {
    // The tool cannot write: read-only surface, Plan mode's policy inside, and
    // tab_id rewritten on every child call. Making the user approve it per host
    // taxed the one fan-out the prompt explicitly asks for.
    expect(decideToolCall({ tool: 'delegate_to_host', mode: 'balanced' })).toBe('auto')
    expect(decideToolCall({ tool: 'delegate_to_host', mode: 'autonomous' })).toBe('auto')
    // Plan mode ADVERTISES the tool (PLAN_MODE_TOOLS), so denying it there
    // handed the model a tool it could never successfully call.
    expect(decideToolCall({ tool: 'delegate_to_host', mode: 'balanced', agentMode: 'plan' })).toBe(
      'auto'
    )
  })

  it('still asks before delegating in conservative mode', () => {
    // Conservative means the user wants to see things before they happen, and a
    // sub-agent is a lot of activity to start without being asked.
    expect(decideToolCall({ tool: 'delegate_to_host', mode: 'conservative' })).toBe('ask')
  })

  it('denies delegation in execute mode, where the user watches every command', () => {
    // Execute mode omits the tool from the schema; a leftover call is refused
    // rather than quietly run on a private channel.
    expect(decideToolCall({ tool: 'delegate_to_host', mode: 'autonomous', agentMode: 'execute' })).toBe(
      'deny'
    )
  })

  it('in execute mode denies leftover exec_command and still asks before writes', () => {
    expect(
      decideToolCall({
        tool: 'exec_command',
        argsJson: JSON.stringify({ command: 'ls -la' }),
        mode: 'autonomous',
        agentMode: 'execute'
      })
    ).toBe('deny')
    expect(
      decideToolCall({
        tool: 'run_in_terminal',
        argsJson: JSON.stringify({ command: 'ls -la' }),
        mode: 'balanced',
        agentMode: 'execute'
      })
    ).toBe('auto')
    expect(
      decideToolCall({
        tool: 'run_in_terminal',
        argsJson: JSON.stringify({ command: 'systemctl restart nginx' }),
        mode: 'balanced',
        agentMode: 'execute'
      })
    ).toBe('ask')
  })
})
