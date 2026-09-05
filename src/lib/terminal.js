'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const pty = require('node-pty');
const { shellQuote } = require('./hdc');

class TerminalManager extends EventEmitter {
  constructor(client) {
    super();
    this.client = client;
    this.sessions = new Map();
  }

  open({ deviceId, cwd = '/data', cols = 90, rows = 28 }) {
    if (typeof deviceId !== 'string' || !deviceId || /[\0\r\n]/.test(deviceId))
      throw new Error('请选择在线设备');
    if (typeof cwd !== 'string' || !cwd.startsWith('/') || cwd.includes('\0'))
      throw new Error('远程目录必须是绝对路径');
    const executable = this.client.resolvePath();
    const id = crypto.randomUUID();
    const process = pty.spawn(executable, [...this.client.baseArgs(), '-t', deviceId, 'shell'], {
      name: 'xterm-256color',
      cols: Math.max(10, Math.min(500, Number(cols) || 90)),
      rows: Math.max(4, Math.min(250, Number(rows) || 28)),
      cwd: path.dirname(executable),
      env: { ...global.process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
      useConpty: true,
      conptyInheritCursor: false
    });
    const session = { process, deviceId, initialized: false, initialInput: '', timer: null };
    this.sessions.set(id, session);
    // Keep HDC's real interactive shell; enter the requested directory once the
    // remote prompt appears. Never inject a command during an existing session.
    const initialize = () => {
      if (session.initialized || !this.sessions.has(id)) return;
      session.initialized = true;
      clearTimeout(session.timer);
      try { process.write(`cd ${shellQuote(cwd)}\r`); } catch { /* process has exited */ }
      if (session.initialInput) {
        try { process.write(session.initialInput); } catch { /* process has exited */ }
        session.initialInput = '';
      }
    };
    session.timer = setTimeout(initialize, 1200);
    process.onData((data) => {
      this.emit('data', { id, data });
      if (!session.initialized && /[#$>]\s*(?:\x1b\[[\d;]*[A-Za-z])*\s*$/.test(data)) initialize();
    });
    process.onExit(({ exitCode, signal }) => {
      clearTimeout(session.timer);
      this.sessions.delete(id);
      this.emit('exit', { id, exitCode, signal });
    });
    return { id, deviceId };
  }

  write({ id, data }) {
    if (typeof data !== 'string') return;
    const session = this.sessions.get(id);
    if (!session) return;
    // Keep early keystrokes in order, after the initial directory command.
    if (!session.initialized) {
      session.initialInput += data;
      return;
    }
    try { session.process.write(data); } catch { this.close(id); }
  }

  resize({ id, cols, rows }) {
    const session = this.sessions.get(id);
    if (!session) return;
    try {
      session.process.resize(Math.max(10, Math.min(500, Number(cols) || 90)),
        Math.max(4, Math.min(250, Number(rows) || 28)));
    } catch { /* resizing an exited ConPTY can race its exit callback */ }
  }

  close(id) {
    const session = this.sessions.get(id);
    if (!session) return;
    clearTimeout(session.timer);
    this.sessions.delete(id);
    try { session.process.kill(); } catch { /* already exited */ }
  }

  closeAll() { for (const id of [...this.sessions.keys()]) this.close(id); }
}
module.exports = { TerminalManager };
