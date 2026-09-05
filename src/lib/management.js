'use strict';
const path = require('node:path');
const { shellQuote } = require('./hdc');

function processIdentity(pid, startTime, requireIdentity = true) {
  const number = Number(pid);
  if (!Number.isInteger(number) || number < 1 || number > 4194304) throw new Error('无效的进程PID');
  const identity = startTime == null ? '' : String(startTime);
  if ((requireIdentity && !identity) || (identity && !/^\d+$/.test(identity)))
    throw new Error('进程身份信息已失效，请刷新进程列表');
  return { pid: number, startTime: identity };
}

function identityGuard(pid, startTime) {
  return `_ps_stat=$(cat /proc/${pid}/stat 2>/dev/null) || { printf '%s\\n' '进程已经结束，请刷新列表'; exit 1; }; ` +
    `_ps_tail=\${_ps_stat##*) }; set -- $_ps_tail; shift 19; ` +
    (startTime ? `[ "$1" = ${shellQuote(startTime)} ] || { printf '%s\\n' 'PID已被其他进程复用，操作已停止，请刷新列表'; exit 1; }; ` : '');
}

function parseStat(text) {
  const open = text.indexOf('(');
  const close = text.lastIndexOf(')');
  if (open < 0 || close <= open) throw new Error('无法解析进程信息');
  const values = text.slice(close + 2).trim().split(/\s+/);
  if (values.length < 22) throw new Error('进程信息不完整，可能已退出');
  return { name: text.slice(open + 1, close), state: values[0], ppid: Number(values[1]),
    nice: Number(values[16]), threads: Number(values[17]), startTime: values[19] };
}

class DeviceManagement {
  constructor(client) { this.client = client; }

  async processDetail({ deviceId, pid, startTime }) {
    const identity = processIdentity(pid, startTime);
    const base = `/proc/${identity.pid}`;
    const guard = identityGuard(identity.pid, identity.startTime);
    const command = guard +
      `printf 'STAT\\0%s\\0' "$_ps_stat"; ` +
      `printf 'STATUS\\0'; cat ${base}/status; printf '\\0'; ` +
      `printf 'EXE\\0'; readlink ${base}/exe 2>/dev/null || :; printf '\\0'; ` +
      `printf 'CWD\\0'; readlink ${base}/cwd 2>/dev/null || :; printf '\\0'; ` +
      `printf 'CMDLINE\\0'; base64 ${base}/cmdline 2>/dev/null || :; printf '\\0'; ` + guard + 'true';
    const { stdout } = await this.client.shell(deviceId, command, { timeoutMs: 10000 });
    const parts = stdout.split('\0');
    const fields = {};
    for (let i = 0; i + 1 < parts.length; i += 2) fields[parts[i]] = parts[i + 1];
    const stat = parseStat(fields.STAT || '');
    const status = fields.STATUS || '';
    const statusValue = (key) => status.match(new RegExp(`^${key}:\\s*(\\d+)`, 'm'))?.[1];
    const args = Buffer.from((fields.CMDLINE || '').replace(/\s/g, ''), 'base64').toString('utf8').split('\0').filter(Boolean);
    const rss = statusValue('VmRSS');
    return { pid: identity.pid, ...stat, uid: statusValue('Uid') ?? null, gid: statusValue('Gid') ?? null,
      rssBytes: rss === undefined ? null : Number(rss) * 1024,
      exe: (fields.EXE || '').replace(/\n$/, ''), cwd: (fields.CWD || '').replace(/\n$/, ''),
      cmdline: args.map(shellQuote).join(' '), status };
  }

  async signal({ deviceId, pid, startTime, signal }) {
    const identity = processIdentity(pid, startTime);
    if (identity.pid <= 1) throw new Error('系统init进程不能通过此处结束');
    if (!['TERM', 'KILL'].includes(signal)) throw new Error('不支持的进程操作');
    await this.client.shell(deviceId,
      identityGuard(identity.pid, identity.startTime) + `kill -${signal} ${identity.pid}`, { timeoutMs: 10000 });
    return { sent: true, signal };
  }

  async analyzeDirectory({ deviceId, path: directory }) {
    if (typeof directory !== 'string' || !directory.startsWith('/') || directory.includes('\0'))
      throw new Error('请选择有效的远程目录');
    const normalized = path.posix.normalize(directory);
    const quoted = shellQuote(normalized);
    // One user-requested HDC command, not a background scan. Each top-level
    // item is measured on its own filesystem; symbolic links are not followed.
    const command = `[ -d ${quoted} ] || { printf '%s\\n' '目录不存在或不可访问'; exit 1; }; ` +
      `for _du_path in ${quoted}/* ${quoted}/.[!.]* ${quoted}/..?*; do ` +
      `[ -L "$_du_path" ] && continue; ` +
      `if [ -d "$_du_path" ]; then _du_type=directory; elif [ -f "$_du_path" ]; then _du_type=file; else continue; fi; ` +
      `_du_result=$(du -skx "$_du_path" 2>/dev/null); _du_rc=$?; ` +
      `_du_kb=\${_du_result%%[!0-9]*}; ` +
      `printf '%s\\0%s\\0%s\\0%s\\0' "$_du_path" "$_du_type" "$_du_kb" "$_du_rc"; done; true`;
    const { stdout } = await this.client.shell(deviceId, command, { timeoutMs: 60000 });
    const fields = stdout.split('\0');
    if (fields.pop() !== '' || fields.length % 4) throw new Error('目录统计结果不完整');
    const entries = [];
    for (let i = 0; i < fields.length; i += 4) entries.push({
      name: path.posix.basename(fields[i]), path: path.posix.normalize(fields[i]), type: fields[i + 1],
      bytes: /^\d+$/.test(fields[i + 2]) ? Number(fields[i + 2]) * 1024 : null,
      partial: fields[i + 3] !== '0'
    });
    entries.sort((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1));
    return { path: normalized, entries,
      warning: entries.some((entry) => entry.partial) ? '部分项目未完整读取，可能存在权限限制或文件在扫描时变化' : '' };
  }
}
module.exports = { DeviceManagement };
