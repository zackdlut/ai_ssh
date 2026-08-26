import { describe, expect, it } from 'vitest'
import { isInteractiveTuiCommand } from './interactiveCommands'

describe('isInteractiveTuiCommand', () => {
  it('rejects full-screen editors, pagers and process monitors', () => {
    for (const cmd of [
      'vim /etc/hosts',
      'vi /etc/nginx.conf',
      'sudo nano /etc/ssh/sshd_config',
      'htop',
      'top',
      'top | grep nginx',
      'less /var/log/syslog',
      'journalctl | less',
      'man systemd',
      'tmux new -s ops'
    ]) {
      expect(isInteractiveTuiCommand(cmd), cmd).toBe(true)
    }
  })

  it('allows ordinary print-and-exit commands', () => {
    for (const cmd of [
      'top -b',
      'top -bn1',
      'top -b | grep idle',
      'ls -la',
      'systemctl status nginx',
      'ps aux',
      'git status',
      'sed -n 1,20p /etc/hosts',
      'nginx -t'
    ]) {
      expect(isInteractiveTuiCommand(cmd), cmd).toBe(false)
    }
  })
})
