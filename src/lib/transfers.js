'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const { shellQuote } = require('./hdc');

function cancelled() {
  const error = new Error('传输已取消');
  error.code = 'ABORT_ERR';
  return error;
}

function validateRemote(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.includes('\0')) throw new Error('设备路径必须是绝对路径且不能含 NUL');
  return path.posix.normalize(value);
}

function validateLocal(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) throw new Error('本地路径必须是绝对路径且不能含 NUL');
  return path.resolve(value);
}

function transferPath(value) {
  // HDC re-parses its file arguments after Windows argv has been decoded.
  // Its parser removes double quotes, and only space-containing argv get
  // automatically re-quoted. Never silently send a different path.
  if (/["\t\r\n]/.test(value)) throw new Error(`HDC 文件协议不能可靠传输含双引号、制表或换行符的路径：${value}`);
  return value;
}

function windowsName(name) {
  if (!name || name === '.' || name === '..' || /[<>:"/\\|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name) || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(name)) {
    throw new Error(`此设备文件名无法原样保存到 Windows：${JSON.stringify(name)}`);
  }
  return name;
}

function childLocal(root, relative) {
  const result = path.resolve(root, ...relative.split('/').filter(Boolean).map(windowsName));
  const fromRoot = path.relative(root, result);
  if (fromRoot === '..' || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot)) throw new Error('下载路径越出了所选目录');
  return result;
}

async function localInfo(value) {
  try {
    const stat = await fsp.lstat(value);
    return { type: stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other', size: stat.size, modified: stat.mtimeMs };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

class TransferManager extends EventEmitter {
  constructor(client) {
    super();
    this.client = client;
    this.jobs = [];
    this.options = new Map();
    this.controllers = new Map();
    this.active = false;
    this.closed = false;
  }

  list() {
    return this.jobs.map(job => ({ ...job }));
  }

  changed() {
    this.emit('changed', this.list());
  }

  async enqueue({ deviceId, direction, localPath, remotePath, isDirectory, overwrite = false }) {
    if (this.closed) throw new Error('传输队列已关闭');
    if (typeof deviceId !== 'string' || !deviceId || deviceId.startsWith('-') || /[\s\0]/.test(deviceId)) throw new Error('设备标识格式不正确');
    if (!['upload', 'download'].includes(direction)) throw new Error('未知的传输方向');
    const local = validateLocal(localPath);
    const remote = validateRemote(remotePath);
    transferPath(local); transferPath(remote);
    const sourceInfo = direction === 'upload' ? await localInfo(local) : await this.remoteInfo(deviceId, remote);
    if (!sourceInfo) throw new Error(`源文件或目录不存在：${direction === 'upload' ? local : remote}`);
    if (!['file', 'directory'].includes(sourceInfo.type)) throw new Error('暂不传输符号链接、设备节点或套接字；请选择实际文件或目录');
    if (typeof isDirectory === 'boolean' && isDirectory !== (sourceInfo.type === 'directory')) throw new Error('源项目类型发生变化，请刷新后重试');
    if (direction === 'download') windowsName(path.basename(local));
    if (remote === '/' && direction === 'upload') throw new Error('上传的精确目标不能是设备根目录');
    if (this.closed) throw new Error('传输队列已关闭');
    const job = {
      id: randomUUID(), deviceId, direction,
      source: direction === 'upload' ? local : remote,
      destination: direction === 'upload' ? remote : local,
      name: direction === 'upload' ? path.basename(local) : path.posix.basename(remote) || '/',
      isDirectory: sourceInfo.type === 'directory', state: 'queued', progress: null,
      detail: overwrite ? '等待传输；合并目录，同名文件覆盖' : '等待传输；保留已有同名文件', startedAt: null, endedAt: null,
    };
    this.jobs.push(job);
    this.options.set(job.id, { localPath: local, remotePath: remote, overwrite: Boolean(overwrite) });
    this.changed();
    queueMicrotask(() => this.drain());
    return { ...job };
  }

  cancel(id) {
    const job = this.jobs.find(item => item.id === id);
    if (!job || !['queued', 'running'].includes(job.state)) return false;
    if (job.state === 'queued') {
      job.state = 'cancelled'; job.endedAt = Date.now(); job.detail = '已取消，尚未开始传输';
      this.options.delete(id);
    } else {
      job.detail = '正在取消；已完成文件会保留，当前临时文件可能保留';
      this.controllers.get(id)?.abort();
    }
    this.changed();
    return true;
  }

  close() {
    this.closed = true;
    for (const job of this.jobs) this.cancel(job.id);
  }

  async drain() {
    if (this.active || this.closed) return;
    this.active = true;
    try {
      let job;
      while (!this.closed && (job = this.jobs.find(item => item.state === 'queued'))) {
        const controller = new AbortController();
        this.controllers.set(job.id, controller);
        job.state = 'running'; job.startedAt = Date.now(); job.detail = '正在读取文件清单';
        this.changed();
        try {
          await this.execute(job, this.options.get(job.id), controller.signal);
          if (controller.signal.aborted) throw cancelled();
          job.state = 'completed'; job.progress = 100;
        } catch (error) {
          job.state = controller.signal.aborted || error.code === 'ABORT_ERR' ? 'cancelled' : 'failed';
          job.detail = `${job.state === 'cancelled' ? '已取消' : error.message}；已完成文件会保留，当前临时文件可能保留${job.partialPath ? `：${job.partialPath}` : ''}`;
        } finally {
          job.endedAt = Date.now();
          this.controllers.delete(job.id); this.options.delete(job.id);
          this.changed();
        }
      }
    } finally {
      this.active = false;
    }
  }

  check(signal) {
    if (signal?.aborted || this.closed) throw cancelled();
  }

  async remoteInfo(deviceId, remote, signal) {
    const quoted = shellQuote(validateRemote(remote));
    const { stdout } = await this.client.shell(deviceId,
      `if [ -e ${quoted} ] || [ -L ${quoted} ]; then stat -c '%f %s' ${quoted}; else printf '%s' '__MISSING__'; fi`, { signal });
    if (stdout.trim() === '__MISSING__') return null;
    const match = stdout.trim().match(/^([0-9a-fA-F]+)\s+(\d+)$/);
    if (!match) throw new Error(`无法读取设备文件属性：${remote}`);
    const typeBits = parseInt(match[1], 16) & 0xf000;
    return { type: typeBits === 0x4000 ? 'directory' : typeBits === 0x8000 ? 'file' : typeBits === 0xa000 ? 'symlink' : 'other', size: Number(match[2]) };
  }

  async planUpload(local, remote, isDirectory, signal) {
    const operations = [];
    const visit = async (source, destination) => {
      this.check(signal);
      transferPath(source); transferPath(destination);
      const info = await localInfo(source);
      if (!info) throw new Error(`源项目在扫描时消失：${source}`);
      if (info.type === 'symlink' || info.type === 'other') throw new Error(`无法传输符号链接或特殊文件：${source}`);
      operations.push({ source, destination, ...info });
      if (info.type === 'directory') {
        const names = await fsp.readdir(source);
        for (const name of names.sort()) await visit(path.join(source, name), path.posix.join(destination, name));
      }
    };
    await visit(local, remote);
    if ((operations[0].type === 'directory') !== isDirectory) throw new Error('源项目类型发生变化，请刷新后重试');
    return operations;
  }

  async planDownload(deviceId, remote, local, isDirectory, signal) {
    const operations = [];
    const rootInfo = await this.remoteInfo(deviceId, remote, signal);
    if (!rootInfo || !['directory', 'file'].includes(rootInfo.type)) throw new Error('下载源已消失或变成符号链接/特殊文件');
    if ((rootInfo.type === 'directory') !== isDirectory) throw new Error('下载源类型发生变化，请刷新后重试');
    const visit = async (source, relative, info) => {
      this.check(signal);
      const destination = relative ? childLocal(local, relative) : local;
      transferPath(source); transferPath(destination);
      operations.push({ source, destination, ...info });
      if (info.type === 'directory') {
        const listing = await this.client.listDirectory(deviceId, source, { signal, timeoutMs: 30000 });
        for (const entry of listing.entries) {
          if (!['directory', 'file'].includes(entry.type)) throw new Error(`目录含符号链接或特殊文件，未开始复制：${entry.path}`);
          windowsName(entry.name);
          await visit(entry.path, relative ? `${relative}/${entry.name}` : entry.name, entry);
        }
      }
    };
    await visit(remote, '', rootInfo);
    // A Linux directory can contain A.txt and a.txt; Windows cannot preserve both.
    const seen = new Set();
    for (const operation of operations) {
      const key = operation.destination.toLocaleLowerCase('en-US');
      if (seen.has(key)) throw new Error(`设备目录含 Windows 无法区分的同名项目：${operation.destination}`);
      seen.add(key);
    }
    return operations;
  }

  async ensureLocalParent(directory, signal) {
    this.check(signal);
    const parsed = path.parse(directory);
    let current = parsed.root;
    for (const component of directory.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, component);
      const info = await localInfo(current);
      if (info && info.type !== 'directory') throw new Error(`下载目标路径经过链接或非目录项目：${current}`);
      if (!info) await fsp.mkdir(current);
    }
  }

  async ensureRemoteParent(deviceId, directory, signal) {
    this.check(signal);
    const quoted = shellQuote(directory);
    // Check existing path components for symlinks so a directory upload cannot
    // accidentally escape through a pre-existing link at its destination.
    await this.client.shell(deviceId,
      `_hdcs_path=${quoted}; while [ "$_hdcs_path" != / ]; do ` +
      `if [ -L "$_hdcs_path" ]; then printf '目标路径经过符号链接：%s\\n' "$_hdcs_path" >&2; exit 1; fi; ` +
      `_hdcs_path=\${_hdcs_path%/*}; [ -n "$_hdcs_path" ] || _hdcs_path=/; done; mkdir -p ${quoted}`, { signal, timeoutMs: 30000 });
  }

  async execute(job, options, signal) {
    const { localPath, remotePath, overwrite } = options;
    const operations = job.direction === 'upload'
      ? await this.planUpload(localPath, remotePath, job.isDirectory, signal)
      : await this.planDownload(job.deviceId, remotePath, localPath, job.isDirectory, signal);
    this.check(signal);
    const files = operations.filter(operation => operation.type === 'file');
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    let finishedBytes = 0;
    let finishedFiles = 0;
    let finishedOperations = 0;
    job.progress = 0;
    job.detail = `共 ${files.length} 个文件，${this.formatBytes(totalBytes)}；开始传输`;
    this.changed();

    for (const operation of operations) {
      this.check(signal);
      if (operation.type === 'directory') {
        if (job.direction === 'upload') await this.ensureRemoteParent(job.deviceId, operation.destination, signal);
        else await this.ensureLocalParent(operation.destination, signal);
      } else {
        job.detail = `正在${job.direction === 'upload' ? '上传' : '下载'} ${path.basename(operation.source)}；已完成 ${finishedFiles}/${files.length} 个文件`;
        this.changed();
        if (job.direction === 'upload') await this.uploadFile(job, operation, overwrite, signal);
        else await this.downloadFile(job, operation, overwrite, signal);
        finishedFiles += 1;
        finishedBytes += operation.size;
      }
      finishedOperations += 1;
      job.progress = totalBytes > 0 ? Math.floor(finishedBytes * 100 / totalBytes) : Math.floor(finishedOperations * 100 / operations.length);
      job.detail = `已完成 ${finishedFiles}/${files.length} 个文件，${this.formatBytes(finishedBytes)}/${this.formatBytes(totalBytes)}`;
      this.changed();
    }
    job.detail = `完成：${files.length} 个文件，${this.formatBytes(totalBytes)}${job.isDirectory ? '，空目录已保留' : ''}`;
  }

  async uploadFile(job, operation, overwrite, signal) {
    const parent = path.posix.dirname(operation.destination);
    await this.ensureRemoteParent(job.deviceId, parent, signal);
    const existing = await this.remoteInfo(job.deviceId, operation.destination, signal);
    if (existing && (existing.type !== 'file' || !overwrite)) throw new Error(`目标已存在${existing.type !== 'file' ? '且不是普通文件' : '，未授权覆盖'}：${operation.destination}`);
    const current = await localInfo(operation.source);
    if (!current || current.type !== 'file' || current.size !== operation.size || current.modified !== operation.modified) throw new Error(`上传源在扫描后发生变化：${operation.source}`);
    const temporary = path.posix.join(parent, `.hdc-studio-${randomUUID()}.part`);
    job.partialPath = temporary;
    this.changed();
    // HDC versions can retain source path components when given an absolute
    // source. Send a basename from its parent cwd so the wire source is flat.
    // A leading '-' needs an explicit current-directory prefix to avoid HDC's
    // file-option parser treating a valid filename as an option.
    const basename = path.basename(operation.source);
    const sourceArgument = basename.startsWith('-') ? `.${path.sep}${basename}` : basename;
    await this.client.raw(['-t', job.deviceId, 'file', 'send', sourceArgument, temporary], {
      cwd: path.dirname(operation.source), timeoutMs: 0, signal,
    });
    this.check(signal);
    const uploaded = await this.remoteInfo(job.deviceId, temporary, signal);
    if (!uploaded || uploaded.type !== 'file' || uploaded.size !== operation.size) throw new Error(`设备接收长度不一致：${temporary}`);
    const from = shellQuote(temporary);
    const to = shellQuote(operation.destination);
    // -T prevents mv's "move inside this directory" behavior, -n closes the
    // normal no-overwrite race. Detect skipped moves instead of claiming success.
    await this.client.shell(job.deviceId,
      `if [ -L ${to} ] || [ -d ${to} ]; then printf '%s\\n' '目标已变成链接或目录' >&2; exit 1; fi; ` +
      `mv -T ${overwrite ? '-f' : '-n'} ${from} ${to} || exit $?; ` +
      `if [ -e ${from} ]; then printf '%s\\n' '目标文件已存在，未覆盖；临时文件保留' >&2; exit 1; fi`, { signal, timeoutMs: 30000 });
    delete job.partialPath;
  }

  async downloadFile(job, operation, overwrite, signal) {
    const parent = path.dirname(operation.destination);
    await this.ensureLocalParent(parent, signal);
    const existing = await localInfo(operation.destination);
    if (existing && (existing.type !== 'file' || !overwrite)) throw new Error(`目标已存在${existing.type !== 'file' ? '且不是普通文件' : '，未授权覆盖'}：${operation.destination}`);
    const current = await this.remoteInfo(job.deviceId, operation.source, signal);
    if (!current || current.type !== 'file' || current.size !== operation.size) throw new Error(`下载源在扫描后发生变化：${operation.source}`);
    const temporary = path.join(parent, `.hdc-studio-${randomUUID()}.part`);
    job.partialPath = temporary;
    this.changed();
    await this.client.raw(['-t', job.deviceId, 'file', 'recv', operation.source, temporary], { timeoutMs: 0, signal });
    this.check(signal);
    const received = await localInfo(temporary);
    if (!received || received.type !== 'file' || received.size !== operation.size) throw new Error(`下载文件长度不一致：${temporary}`);
    const destinationNow = await localInfo(operation.destination);
    if (destinationNow && (destinationNow.type !== 'file' || !overwrite)) throw new Error(`本地目标已存在或类型发生变化：${operation.destination}`);
    if (overwrite) {
      // Same-directory rename replaces an existing ordinary file atomically on
      // Windows. If the file is locked, leave both original and .part intact.
      await fsp.rename(temporary, operation.destination);
    } else {
      try {
        await fsp.link(temporary, operation.destination);
        await fsp.unlink(temporary);
      } catch (error) {
        if (error.code === 'EEXIST') throw new Error(`本地目标已存在，未覆盖：${operation.destination}`);
        // FAT/exFAT cannot hard-link. COPYFILE_EXCL still guarantees no overwrite;
        // cancellation is observed after the commit, never by deleting user data.
        if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'EINVAL', 'ENOSYS'].includes(error.code)) throw error;
        await fsp.copyFile(temporary, operation.destination, fs.constants.COPYFILE_EXCL);
        await fsp.unlink(temporary);
      }
    }
    delete job.partialPath;
  }

  formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }
}

module.exports = { TransferManager };
