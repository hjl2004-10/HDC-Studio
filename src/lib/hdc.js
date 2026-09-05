'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');
const { TextDecoder } = require('node:util');

const MAX_OUTPUT = 16 * 1024 * 1024;
const PREVIEW_BYTES = 256 * 1024;

function stringValue(value, label) {
  if (typeof value !== 'string' || !value.length || value.includes('\0')) {
    throw new Error(`${label}不能为空，也不能包含 NUL 字符`);
  }
  return value;
}

function shellQuote(value) {
  if (typeof value !== 'string' || value.includes('\0')) throw new Error('Shell 参数不能包含 NUL 字符');
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function deviceKey(value) {
  stringValue(value, '设备标识');
  if (value.startsWith('-') || /\s/.test(value)) throw new Error('设备标识格式不正确');
  return value;
}

function remotePath(value) {
  stringValue(value, '设备路径');
  if (!value.startsWith('/')) throw new Error('设备路径必须是以 / 开头的绝对路径');
  return path.posix.normalize(value);
}

function commandError(message, result, code = 'HDC_ERROR') {
  const error = new Error(message);
  error.code = code;
  if (result) Object.assign(error, result);
  return error;
}

function errorText(text) {
  return String(text || '').replace(/\0/g, ' ').trim().slice(-3000);
}

function hdcFailure(stdout, stderr) {
  // HDC can report a failed task and still exit with status 0.
  const match = `${stdout}\n${stderr}`.match(/(?:^|[\r\n])\s*(\[Fail\][^\r\n]*)/i);
  return match ? match[1].trim() : null;
}

class HdcClient {
  constructor({ getSettings, bundledPath } = {}) {
    this.getSettings = getSettings || (() => ({}));
    this.bundledPath = bundledPath;
  }

  resolvePath() {
    const explicit = this.getSettings().hdcPath;
    const isFile = candidate => {
      try { return fs.statSync(candidate).isFile(); } catch { return false; }
    };
    if (explicit) {
      stringValue(explicit, 'HDC 程序路径');
      if (!path.isAbsolute(explicit) || !isFile(explicit)) throw new Error(`找不到设置中的 HDC 程序：${explicit}`);
      return path.resolve(explicit);
    }
    const executableName = process.platform === 'win32' ? 'hdc.exe' : 'hdc';
    const sdkRoot = process.env.DEVECO_SDK_HOME;
    const candidates = [
      this.bundledPath,
      process.env.HDC_PATH,
      sdkRoot && path.join(sdkRoot, 'default', 'openharmony', 'toolchains', executableName),
      sdkRoot && path.join(sdkRoot, 'openharmony', 'toolchains', executableName),
      sdkRoot && path.join(sdkRoot, 'toolchains', executableName),
      ...(process.env.PATH || '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir.replace(/^"|"$/g, ''), executableName)),
    ];
    const found = candidates.find(candidate => candidate && path.isAbsolute(candidate) && isFile(candidate));
    if (!found) throw new Error('未找到 HDC，请在设置中选择 hdc.exe 所在位置');
    return path.resolve(found);
  }

  baseArgs() {
    const server = this.getSettings().serverAddress || '127.0.0.1:8710';
    stringValue(server, 'HDC 服务地址');
    if (!/^(?:(?:[a-zA-Z0-9_.-]+|\[[a-fA-F0-9:]+\]):)?\d{1,5}$/.test(server)) {
      throw new Error('HDC 服务地址格式应为 127.0.0.1:8710');
    }
    const port = Number(server.slice(server.lastIndexOf(':') + 1));
    if (port < 1 || port > 65535) throw new Error('HDC 服务端口须在 1～65535 之间');
    return ['-s', server];
  }

  async describe() {
    let executable = '';
    try {
      executable = this.resolvePath();
      const result = await this.raw(['-v'], { timeoutMs: 5000 });
      return { path: executable, version: result.stdout.trim() || result.stderr.trim(), available: true };
    } catch (error) {
      return { path: executable || this.getSettings().hdcPath || '', version: '', available: false, error: error.message };
    }
  }

  raw(args, { timeoutMs = 15000, cwd, onData, signal } = {}) {
    if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) {
      return Promise.reject(new Error('HDC 参数格式不正确'));
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) return Promise.reject(new Error('超时时间格式不正确'));
    let executable;
    let base;
    try { executable = this.resolvePath(); base = this.baseArgs(); } catch (error) { return Promise.reject(error); }
    if (signal?.aborted) return Promise.reject(commandError('操作已取消', null, 'ABORT_ERR'));
    return new Promise((resolve, reject) => {
      const child = spawn(executable, [...base, ...args], {
        shell: false, windowsHide: true, cwd: cwd || path.dirname(executable), stdio: ['ignore', 'pipe', 'pipe'],
      });
      const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
      const output = { stdout: '', stderr: '' };
      let bytes = 0;
      let timer;
      let killTimer;
      let failure;
      let settled = false;
      const stop = error => {
        if (failure || settled) return;
        failure = error;
        child.kill();
        killTimer = setTimeout(() => child.kill('SIGKILL'), 1000);
        killTimer.unref();
      };
      const abort = () => stop(commandError('操作已取消；已写入的部分内容可能保留', null, 'ABORT_ERR'));
      const cleanup = () => {
        clearTimeout(timer); clearTimeout(killTimer);
        signal?.removeEventListener('abort', abort);
      };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      if (timeoutMs > 0) {
        timer = setTimeout(() => stop(commandError(`HDC 操作超过 ${Math.ceil(timeoutMs / 1000)} 秒未完成`, null, 'HDC_TIMEOUT')), timeoutMs);
        timer.unref();
      }
      for (const stream of ['stdout', 'stderr']) {
        child[stream].on('data', chunk => {
          bytes += chunk.length;
          if (bytes > MAX_OUTPUT) {
            stop(commandError('命令输出过大，请缩小查询范围或使用交互终端', null, 'OUTPUT_LIMIT'));
            return;
          }
          const text = decoders[stream].write(chunk);
          output[stream] += text;
          if (onData && text) {
            try { onData(text); } catch (error) { stop(error); }
          }
        });
      }
      child.on('error', error => {
        if (settled) return;
        settled = true; cleanup();
        reject(commandError(`无法运行 HDC：${error.message}`, output, error.code));
      });
      child.on('close', (exitCode, exitSignal) => {
        if (settled) return;
        settled = true; cleanup();
        output.stdout += decoders.stdout.end(); output.stderr += decoders.stderr.end();
        const result = { ...output, exitCode: exitCode == null ? -1 : exitCode };
        if (failure) { Object.assign(failure, result); reject(failure); return; }
        const reported = hdcFailure(output.stdout, output.stderr);
        if (reported || exitCode !== 0) {
          reject(commandError(reported || errorText(output.stderr || output.stdout) || `HDC 退出：${exitSignal || exitCode}`, result));
          return;
        }
        resolve(result);
      });
    });
  }

  async listDevices() {
    const { stdout } = await this.raw(['list', 'targets', '-v']);
    const names = this.getSettings().deviceNames || {};
    return stdout.split(/\r?\n/).map(line => line.trim()).filter(line => line && !/^\[Empty\]/i.test(line))
      .map(line => {
        const columns = line.split(/\s+/);
        const statusIndex = columns.findIndex((column, index) => index > 0 && /^(Connected|Ready|Offline|Unauthorized|Unknow|Unknown|Offline|Connecting|Disconnected)$/i.test(column));
        if (statusIndex < 0 || columns[0].startsWith('[')) return null;
        const id = columns[0];
        return { id, transport: columns[1] || 'Unknown', status: columns[statusIndex], name: names[id] || columns[statusIndex + 1] || id };
      }).filter(Boolean);
  }

  async connect(address) {
    deviceKey(address);
    if (!/^(?:[a-zA-Z0-9_.-]+|\[[a-fA-F0-9:]+\])(?::\d{1,5})?$/.test(address)) throw new Error('请输入设备 IP 或 IP:端口');
    const { stdout, stderr } = await this.raw(['tconn', address], { timeoutMs: 20000 });
    return (stdout || stderr).trim();
  }

  async disconnect(id) {
    deviceKey(id);
    const { stdout, stderr } = await this.raw(['tconn', id, '-remove']);
    return (stdout || stderr).trim();
  }

  async shell(id, command, { timeoutMs = 15000, signal } = {}) {
    deviceKey(id);
    stringValue(command, '远端命令');
    const marker = `__HDC_STUDIO_EXIT_${randomBytes(16).toString('hex')}__`;
    // hdc 3.2.0c prints remote shell output as a C string and truncates NULs.
    // Encode the complete remote stream INCLUDING the exit marker before it
    // reaches HDC. A child shell means `exit` in the command cannot omit marker.
    // Remote stderr is combined intentionally; local transport stderr is separate.
    const envelope = `{ sh -c ${shellQuote(command)} 2>&1; _hdcs_status=$?; printf '\\n${marker}%s\\n' "$_hdcs_status"; } | base64`;
    const result = await this.raw(['-t', id, 'shell', envelope], { timeoutMs, signal });
    const encoded = result.stdout.replace(/\s/g, '');
    if (!encoded || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
      throw commandError(`设备未返回完整命令结果（需要 sh 和 base64）：${errorText(result.stdout || result.stderr)}`, result, 'REMOTE_PROTOCOL');
    }
    const decoded = Buffer.from(encoded, 'base64');
    const markerBytes = Buffer.from(`\n${marker}`);
    const markerOffset = decoded.lastIndexOf(markerBytes);
    if (markerOffset < 0) throw commandError('设备连接中断或命令结果不完整，未收到退出状态', result, 'REMOTE_PROTOCOL');
    const statusText = decoded.subarray(markerOffset + markerBytes.length).toString('ascii');
    if (!/^\d+\n$/.test(statusText)) throw commandError('远端命令退出状态格式不正确', result, 'REMOTE_PROTOCOL');
    const exitCode = Number(statusText.trim());
    const bytes = decoded.subarray(0, markerOffset);
    const response = { stdout: bytes.toString('utf8'), stderr: '', exitCode };
    // Keep byte fidelity for preview while retaining the public string contract.
    Object.defineProperty(response, 'bytes', { value: bytes, enumerable: false });
    if (exitCode !== 0) throw commandError(errorText(response.stdout) || `设备命令执行失败，退出码 ${exitCode}`, response, 'REMOTE_EXIT');
    return response;
  }

  async listDirectory(id, directory, options = {}) {
    const normalized = remotePath(directory);
    const { stdout } = await this.shell(id,
      `cd ${shellQuote(normalized)} && find . -mindepth 1 -maxdepth 1 -printf '%f\\0%M\\0%s\\0%T@\\0%l\\0'`, options);
    if (!stdout) return { path: normalized, entries: [] };
    const fields = stdout.split('\0');
    if (fields.pop() !== '' || fields.length % 5 !== 0) throw new Error('设备目录信息不完整，目录可能在读取时发生变化');
    const entries = [];
    for (let i = 0; i < fields.length; i += 5) {
      const [name, permissions, size, modified, linkTarget] = fields.slice(i, i + 5);
      if (!name || name === '.' || name === '..' || name.includes('/') || !/^[-dlbcps?]/.test(permissions) || !/^\d+$/.test(size) || !/^-?\d+(?:\.\d+)?$/.test(modified)) {
        throw new Error('设备 stat/find 返回了无法识别的目录记录');
      }
      const type = permissions[0] === 'd' ? 'directory' : permissions[0] === 'l' ? 'symlink' : permissions[0] === '-' ? 'file' : 'other';
      const entry = { name, path: path.posix.join(normalized, name), type, size: Number(size), modified: Math.floor(Number(modified)), permissions };
      if (type === 'symlink') entry.linkTarget = linkTarget;
      entries.push(entry);
    }
    entries.sort((a, b) => (a.type === 'directory' ? 0 : 1) - (b.type === 'directory' ? 0 : 1) || a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
    return { path: normalized, entries };
  }

  async readFile(id, file) {
    const quoted = shellQuote(remotePath(file));
    const result = await this.shell(id,
      `[ -f ${quoted} ] || { printf '%s\\n' '只能预览普通文件，不能读取目录或设备节点' >&2; exit 1; }; ` +
      `_hdcs_size=$(stat -L -c '%s' ${quoted}) || exit $?; printf '%s\\0' "$_hdcs_size"; head -c ${PREVIEW_BYTES + 1} ${quoted}`);
    const divider = result.bytes.indexOf(0);
    if (divider < 1) throw new Error('设备没有返回文件长度');
    const sizeString = result.bytes.subarray(0, divider).toString('ascii');
    if (!/^\d+$/.test(sizeString)) throw new Error('设备返回了无效文件长度');
    const size = Number(sizeString);
    const available = result.bytes.subarray(divider + 1);
    const truncated = available.length > PREVIEW_BYTES || size > PREVIEW_BYTES;
    const bytes = available.subarray(0, PREVIEW_BYTES);
    let encoding = 'utf-8';
    if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = 'utf-16le';
    else if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = 'utf-16be';
    let text;
    try { text = new TextDecoder(encoding, { fatal: true }).decode(bytes, { stream: truncated }); }
    catch { return { text: '', size, truncated, binary: true }; }
    const controls = (text.match(/[\x00-\x08\x0b\x0e-\x1f]/g) || []).length;
    if (text.includes('\0') || controls > Math.max(2, text.length * 0.01)) return { text: '', size, truncated, binary: true };
    return { text, truncated, size, binary: false };
  }

  async createDirectory(id, directory) {
    const result = await this.shell(id, `mkdir -p ${shellQuote(remotePath(directory))}`);
    return result.stdout.trim() || '目录已创建';
  }

  async renamePath(id, source, newName) {
    const normalized = remotePath(source);
    stringValue(newName, '新名称');
    if (normalized === '/' || newName === '.' || newName === '..' || newName.includes('/')) throw new Error('新名称不能是路径，也不能重命名根目录');
    const destination = path.posix.join(path.posix.dirname(normalized), newName);
    if (destination === normalized) return '名称未改变';
    const from = shellQuote(normalized);
    const to = shellQuote(destination);
    await this.shell(id, `if [ -e ${to} ] || [ -L ${to} ]; then printf '%s\\n' '目标名称已存在' >&2; exit 1; fi; mv ${from} ${to}`);
    return '已重命名';
  }

  async deletePaths(id, paths) {
    if (!Array.isArray(paths) || !paths.length) throw new Error('请选择要删除的文件或目录');
    const normalized = [...new Set(paths.map(remotePath))];
    if (normalized.includes('/')) throw new Error('不能删除设备根目录');
    await this.shell(id, `rm -rf ${normalized.map(shellQuote).join(' ')}`, { timeoutMs: 60000 });
    return `已删除 ${normalized.length} 项`;
  }

  runQuick(id, key) {
    const commands = {
      overview: "printf '=== 系统 ===\\n'; uname -a; printf '\\n=== 产品信息 ===\\n'; param get const.product; printf '\\n=== 运行时间 ===\\n'; uptime",
      storage: "df -h",
      memory: "cat /proc/meminfo",
      network: "ip addr; printf '\\n=== 路由 ===\\n'; ip route",
      display: "for d in /sys/class/drm/card*-*; do [ -d \"$d\" ] || continue; printf '\\n=== %s ===\\n' \"${d##*/}\"; for f in status enabled modes; do [ -r \"$d/$f\" ] || continue; printf '%s:\\n' \"$f\"; cat \"$d/$f\"; done; done",
      kernel: "set -o pipefail; dmesg | tail -n 200",
    };
    if (!Object.prototype.hasOwnProperty.call(commands, key)) return Promise.reject(new Error('未知的快捷命令'));
    return this.shell(id, commands[key], { timeoutMs: 20000 });
  }

  async reboot(id) {
    deviceKey(id);
    const { stdout, stderr } = await this.raw(['-t', id, 'target', 'boot']);
    return (stdout || stderr).trim() || '已发送重启请求';
  }
}

module.exports = { HdcClient, shellQuote };
