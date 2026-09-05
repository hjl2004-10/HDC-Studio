'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { HdcClient } = require('./lib/hdc');
const { TransferManager } = require('./lib/transfers');
const { TerminalManager } = require('./lib/terminal');
const { DeviceMonitor } = require('./lib/monitor');
const { DeviceManagement } = require('./lib/management');

if (process.env.HDC_STUDIO_USER_DATA) app.setPath('userData', process.env.HDC_STUDIO_USER_DATA);
app.setName('HDC Studio');
app.setAppUserModelId('local.hdcstudio.desktop');
let window;
let client;
let transfers;
let terminals;
let monitor;
let management;
let watchedDeviceId = null;
let settings;
let settingsFile;
let settingsWrite = Promise.resolve();
let closing = false;
let closeDialogOpen = false;
const rendererFile = path.join(__dirname, 'renderer', 'index.html');
const rendererUrl = pathToFileURL(rendererFile).href;

function trusted(event) {
  return window && !window.isDestroyed() && event.sender === window.webContents &&
    event.senderFrame && event.senderFrame.url === rendererUrl;
}

function send(channel, payload) {
  if (window && !window.isDestroyed()) window.webContents.send(channel, payload);
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (event, payload) => {
    if (!trusted(event)) throw new Error('拒绝来自其他页面的请求');
    try { return await fn(payload); }
    catch (error) { throw new Error(error && error.message ? error.message : String(error)); }
  });
}

function loadSettings() {
  const directory = app.getPath('userData');
  fs.mkdirSync(directory, { recursive: true });
  // Windows can redirect AppData to a different volume. Resolve the directory
  // before constructing BOTH paths, including a destination that does not exist.
  settingsFile = path.join(fs.realpathSync.native(directory), 'settings.json');
  const defaults = {
    hdcPath: '', serverAddress: '127.0.0.1:8710', defaultRemotePath: '/data',
    downloadsPath: path.join(app.getPath('downloads'), 'HDC Studio'),
    terminalFontSize: 15, uiFontSize: 14, deviceNames: {}
  };
  try {
    const loaded = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    settings = sanitizeSettings({ ...defaults, ...loaded });
  } catch { settings = defaults; }
}

function sanitizeSettings(value) {
  const hdcPath = String(value.hdcPath || '').trim();
  const serverAddress = String(value.serverAddress || '127.0.0.1:8710').trim();
  if (!/^(?:[\w.-]+:)?\d{1,5}$/.test(serverAddress))
    throw new Error('HDC服务地址格式应为127.0.0.1:8710');
  const port = Number(serverAddress.split(':').at(-1));
  if (port < 1 || port > 65535) throw new Error('端口范围为1–65535');
  const defaultRemotePath = String(value.defaultRemotePath || '/data');
  if (!defaultRemotePath.startsWith('/') || defaultRemotePath.includes('\0'))
    throw new Error('默认远程目录须为绝对路径，例如/data');
  const downloadsPath = String(value.downloadsPath || path.join(app.getPath('downloads'), 'HDC Studio'));
  if (!path.isAbsolute(downloadsPath)) throw new Error('下载目录须为本机绝对路径');
  const deviceNames = {};
  if (value.deviceNames && typeof value.deviceNames === 'object') {
    for (const [key, name] of Object.entries(value.deviceNames)) {
      if (!['__proto__', 'prototype', 'constructor'].includes(key)) deviceNames[key] = String(name).slice(0, 80);
    }
  }
  const terminalFontSize = Number(value.terminalFontSize ?? 15);
  const uiFontSize = Number(value.uiFontSize ?? 14);
  if (!Number.isInteger(terminalFontSize) || terminalFontSize < 10 || terminalFontSize > 28)
    throw new Error('终端字号须为10–28之间的整数');
  if (!Number.isInteger(uiFontSize) || uiFontSize < 13 || uiFontSize > 18)
    throw new Error('界面字号须为13–18之间的整数');
  return { hdcPath, serverAddress, defaultRemotePath: path.posix.normalize(defaultRemotePath),
    downloadsPath: path.resolve(downloadsPath), terminalFontSize, uiFontSize, deviceNames };
}

function persistSettings(partial) {
  // Each write merges with the last committed settings; failed writes do not
  // block future saves or expose partially updated values to the renderer.
  const pending = settingsWrite.then(() => writeSettings(partial));
  settingsWrite = pending.catch(() => {});
  return pending;
}

async function writeSettings(partial) {
  const merged = sanitizeSettings({ ...settings, ...partial });
  const connectionChanged = merged.hdcPath !== settings.hdcPath || merged.serverAddress !== settings.serverAddress;
  if (connectionChanged && transfers?.list().some((job) => ['queued', 'running'].includes(job.state))) {
    throw new Error('请先完成或取消传输，再修改HDC路径或服务地址，避免任务在传输中切换连接');
  }
  if (merged.hdcPath) {
    const stat = await fsp.stat(merged.hdcPath).catch(() => null);
    if (!stat?.isFile() || path.extname(merged.hdcPath).toLowerCase() !== '.exe')
      throw new Error('请选择有效的hdc.exe文件');
  }
  await fsp.mkdir(path.dirname(settingsFile), { recursive: true });
  const temp = settingsFile + '.tmp';
  await fsp.writeFile(temp, JSON.stringify(merged, null, 2), { encoding: 'utf8', flush: true });
  await fsp.rename(temp, settingsFile);
  settings = merged;
  if (connectionChanged) {
    terminals?.closeAll();
    monitor?.watch(null);
    monitor?.reset();
    if (watchedDeviceId) monitor?.watch(watchedDeviceId);
  }
  return settings;
}

async function confirmOverwrite(conflicts) {
  if (!conflicts.length) return false;
  const result = await dialog.showMessageBox(window, {
    type: 'warning', title: '确认合并与覆盖', buttons: ['取消传输', '继续并覆盖'],
    defaultId: 0, cancelId: 0,
    message: `目标中已有${conflicts.length}个同名条目`,
    detail: conflicts.slice(0, 12).join('\n') + '\n\n同名文件夹将合并，同名文件将覆盖。取消不会开始传输。'
  });
  return result.response === 1;
}

function setupIpc() {
  handle('app:state', async () => ({ appVersion: app.getVersion(), settings,
    hdc: await client.describe(), downloadsPath: settings.downloadsPath }));
  handle('devices:list', () => client.listDevices());
  handle('devices:connect', (address) => client.connect(address));
  handle('devices:disconnect', (id) => client.disconnect(id));
  handle('files:list', ({ deviceId, path: remotePath }) => client.listDirectory(deviceId, remotePath));
  handle('files:read', ({ deviceId, path: remotePath }) => client.readFile(deviceId, remotePath));
  handle('files:mkdir', ({ deviceId, path: remotePath }) => client.createDirectory(deviceId, remotePath));
  handle('files:rename', ({ deviceId, path: remotePath, newName }) => client.renamePath(deviceId, remotePath, newName));
  handle('files:delete', async ({ deviceId, paths }) => {
    if (!Array.isArray(paths) || !paths.length) return { cancelled: true };
    const result = await dialog.showMessageBox(window, {
      type: 'warning', title: '删除远程文件', buttons: ['取消', '删除'], defaultId: 0, cancelId: 0,
      message: `从设备删除${paths.length}个条目？`,
      detail: `设备：${deviceId}\n${paths.slice(0, 12).join('\n')}\n\n文件夹会连同其内容删除，远程删除不经过Windows回收站。`
    });
    if (result.response !== 1) return { cancelled: true };
    return client.deletePaths(deviceId, paths);
  });
  handle('transfer:upload', async ({ deviceId, remotePath, kind }) => {
    const choice = await dialog.showOpenDialog(window, {
      title: kind === 'directory' ? '选择要上传的文件夹' : '选择要上传的文件',
      properties: kind === 'directory' ? ['openDirectory'] : ['openFile', 'multiSelections']
    });
    if (choice.canceled || !choice.filePaths.length) return [];
    const remote = await client.listDirectory(deviceId, remotePath);
    const items = await Promise.all(choice.filePaths.map(async (localPath) => ({
      localPath, name: path.basename(localPath), isDirectory: (await fsp.lstat(localPath)).isDirectory()
    })));
    const existingNames = new Set(remote.entries.map((entry) => entry.name));
    const conflicts = items.filter((item) => existingNames.has(item.name)).map((item) => item.name);
    const overwrite = await confirmOverwrite(conflicts);
    if (conflicts.length && !overwrite) return [];
    const jobs = [];
    for (const item of items) jobs.push(await transfers.enqueue({
      deviceId, direction: 'upload', localPath: item.localPath,
      remotePath: path.posix.join(remote.path, item.name), isDirectory: item.isDirectory, overwrite
    }));
    return jobs;
  });
  handle('transfer:download', async ({ deviceId, paths }) => {
    if (!Array.isArray(paths) || !paths.length) return [];
    await fsp.mkdir(settings.downloadsPath, { recursive: true });
    const choice = await dialog.showOpenDialog(window, { title: '选择下载到的文件夹',
      defaultPath: settings.downloadsPath, properties: ['openDirectory', 'createDirectory'] });
    if (choice.canceled || !choice.filePaths.length) return [];
    const destination = choice.filePaths[0];
    const entries = [];
    for (const remotePath of paths) {
      const normalized = path.posix.normalize(remotePath);
      const name = path.posix.basename(normalized);
      if (!name || normalized === '/') throw new Error('请选择具体文件或文件夹');
      if (/[<>:"/\\|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name) ||
          /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(name)) {
        throw new Error(`这个设备文件名无法原样保存到Windows：${name}`);
      }
      const parent = await client.listDirectory(deviceId, path.posix.dirname(normalized));
      const entry = parent.entries.find((item) => item.name === name);
      if (!entry) throw new Error(`远程条目已不存在：${normalized}`);
      if (entry.type === 'symlink' || entry.type === 'other') throw new Error('请选择普通文件或文件夹进行下载；符号链接只支持浏览');
      entries.push({ remotePath: normalized, localPath: path.join(destination, name),
        isDirectory: entry.type === 'directory', name });
    }
    const conflicts = entries.filter((entry) => fs.existsSync(entry.localPath)).map((entry) => entry.name);
    const overwrite = await confirmOverwrite(conflicts);
    if (conflicts.length && !overwrite) return [];
    const jobs = [];
    for (const entry of entries) jobs.push(await transfers.enqueue({ deviceId, direction: 'download',
      ...entry, overwrite }));
    return jobs;
  });
  handle('transfer:list', () => transfers.list());
  handle('transfer:cancel', (id) => transfers.cancel(id));
  handle('terminal:open', (options) => terminals.open(options));
  handle('terminal:close', (id) => terminals.close(id));
  ipcMain.on('terminal:write', (event, payload) => { if (trusted(event)) terminals.write(payload); });
  ipcMain.on('terminal:resize', (event, payload) => { if (trusted(event)) terminals.resize(payload); });
  handle('devices:quick', ({ deviceId, key }) => client.runQuick(deviceId, key));
  handle('monitor:watch', (deviceId) => {
    if (deviceId !== null && (typeof deviceId !== 'string' || !deviceId || /[\s\0]/.test(deviceId)))
      throw new Error('无效的监视设备');
    watchedDeviceId = deviceId;
    monitor.watch(deviceId);
  });
  handle('process:detail', (request) => management.processDetail(request));
  handle('process:signal', async (request) => {
    if (Number(request.pid) <= 1) throw new Error('系统init进程不能通过此处结束');
    if (!['TERM', 'KILL'].includes(request.signal)) throw new Error('无效的进程操作');
    const detail = await management.processDetail(request);
    const force = request.signal === 'KILL';
    const confirmation = await dialog.showMessageBox(window, {
      type: 'warning', title: force ? '强制结束进程' : '请求结束进程',
      buttons: ['取消', force ? '强制结束' : '发送结束请求'], defaultId: 0, cancelId: 0,
      message: `${force ? '强制结束' : '请求结束'} ${detail.name}（PID ${detail.pid}）？`,
      detail: `${detail.cmdline || detail.exe || detail.name}\n\n${force ? '强制结束不会给程序保存和清理的机会。' : '将发送SIGTERM，让程序有机会正常退出。'}\n系统管理的服务可能会被自动重新启动。`
    });
    if (confirmation.response !== 1) return { cancelled: true };
    // Revalidate PID/start-time after the person has reviewed the confirmation.
    return management.signal(request);
  });
  handle('storage:analyze', (request) => management.analyzeDirectory(request));
  handle('devices:reboot', async (deviceId) => {
    const result = await dialog.showMessageBox(window, { type: 'warning', title: '重启设备',
      buttons: ['取消', '重启设备'], defaultId: 0, cancelId: 0, message: '确认重启当前设备？',
      detail: `${deviceId}\n活动终端和传输将断开，请先保存设备上的工作。` });
    if (result.response !== 1) return '已取消';
    return client.reboot(deviceId);
  });
  handle('settings:save', persistSettings);
  handle('settings:choose-hdc', async () => {
    const result = await dialog.showOpenDialog(window, { title: '选择HDC工具',
      defaultPath: settings.hdcPath || undefined, properties: ['openFile'],
      filters: [{ name: 'HDC executable', extensions: ['exe'] }] });
    return result.canceled ? null : result.filePaths[0];
  });
  handle('settings:choose-downloads', async () => {
    const result = await dialog.showOpenDialog(window, { title: '选择默认下载目录',
      defaultPath: settings.downloadsPath, properties: ['openDirectory', 'createDirectory'] });
    return result.canceled ? null : result.filePaths[0];
  });
  handle('app:open-downloads', async () => {
    await fsp.mkdir(settings.downloadsPath, { recursive: true });
    const error = await shell.openPath(settings.downloadsPath);
    if (error) throw new Error(error);
  });
  handle('app:save-text', async ({ name = 'hdc-output.txt', text = '' }) => {
    if (typeof text !== 'string') throw new Error('无效文本');
    const result = await dialog.showSaveDialog(window, { title: '保存到本机',
      defaultPath: path.join(app.getPath('downloads'), path.basename(name)),
      filters: [{ name: '文本文件', extensions: ['txt', 'log'] }] });
    if (result.canceled || !result.filePath) return null;
    await fsp.writeFile(result.filePath, text, 'utf8');
    return result.filePath;
  });
}

async function createWindow() {
  loadSettings();
  const bundledPath = app.isPackaged ? path.join(process.resourcesPath, 'hdc', 'hdc.exe') :
    path.join(__dirname, '..', 'resources', 'hdc', 'hdc.exe');
  client = new HdcClient({ getSettings: () => settings, bundledPath });
  transfers = new TransferManager(client);
  terminals = new TerminalManager(client);
  monitor = new DeviceMonitor(client);
  management = new DeviceManagement(client);
  transfers.on('changed', (jobs) => send('transfer:changed', jobs));
  terminals.on('data', (payload) => send('terminal:data', payload));
  terminals.on('exit', (payload) => send('terminal:exit', payload));
  monitor.on('sample', (payload) => send('monitor:sample', payload));
  setupIpc();
  Menu.setApplicationMenu(null);
  window = new BrowserWindow({ width: 1380, height: 890, minWidth: 1050, minHeight: 680,
    title: 'HDC Studio · 开发预览', backgroundColor: '#f3f6fa', show: false,
    icon: path.join(__dirname, '..', 'resources', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true,
      nodeIntegration: false, sandbox: true, spellcheck: false, webSecurity: true }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (url !== rendererUrl) event.preventDefault(); });
  window.webContents.session.setPermissionRequestHandler((wc, permission, callback) => {
    callback(wc === window?.webContents && wc.getURL() === rendererUrl &&
      ['clipboard-read', 'clipboard-sanitized-write'].includes(permission));
  });
  window.once('ready-to-show', () => window.show());
  window.on('close', (event) => {
    const running = transfers.list().filter((job) => ['queued', 'running'].includes(job.state));
    if (!closing && running.length) {
      event.preventDefault();
      if (closeDialogOpen) return;
      closeDialogOpen = true;
      dialog.showMessageBox(window, { type: 'warning', buttons: ['继续传输', '取消传输并退出'],
        defaultId: 0, cancelId: 0, title: '传输尚未完成', message: `还有${running.length}个传输任务`,
        detail: '退出会中断任务，目标中可能保留已完成的文件。' }).then((result) => {
        closeDialogOpen = false;
        if (result.response === 1) { closing = true; window.close(); }
      });
      return;
    }
    terminals.closeAll();
    transfers.close();
    monitor.close();
  });
  window.on('closed', () => { window = null; });
  await window.loadFile(rendererFile);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });
  app.whenReady().then(createWindow).catch((error) => {
    dialog.showErrorBox('HDC Studio启动失败', error.stack || String(error));
    app.quit();
  });
  app.on('window-all-closed', () => app.quit());
}
