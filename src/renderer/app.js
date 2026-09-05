(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const api = window.api;
  const state = {
    app: null, settings: {}, devices: [], selectedId: null, deviceStates: new Map(),
    polling: false, pollTimer: null, initialized: false, disposed: false,
    terminals: new Map(), sessions: new Map(), terminalEvents: new Map(),
    terminalSequence: 0, transfers: [], transferStates: new Map(), drawerOpen: false,
    inputAction: null, previewText: '', previewName: 'output.txt', previewToken: 0,
    connectBusy: false, settingsBusy: false, deviceNameId: null, deviceNameBusy: false, quickBusy: new Set(), unsubscribers: [],
    watchedId: null, watchChain: Promise.resolve(), monitorTimer: null,
    processSort: { key: 'cpuPercent', direction: -1 }, processQuery: '',
    processDeviceId: null, processSelection: null, processDetail: null, processDetailToken: 0,
    processLoading: false, processSignalBusy: false, analysis: null, analysisToken: 0
  };
  const quickLabels = {
    overview: '设备概览', storage: '存储空间', memory: '内存使用',
    network: '网络信息', display: '屏幕信息', kernel: '系统版本'
  };
  const jobLabels = {
    queued: '等待中', running: '传输中', completed: '已完成', failed: '失败', cancelled: '已取消'
  };

  function element(tag, className, content) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (content !== undefined && content !== null) el.textContent = String(content);
    return el;
  }

  function errorMessage(error) {
    const message = typeof error === 'string' ? error : error?.message;
    return (message || '操作未完成，请检查连接后重试。').replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '');
  }

  function toast(message, type = 'success') {
    const item = element('div', `toast ${type}`);
    item.setAttribute('role', type === 'error' ? 'alert' : 'status');
    item.append(element('span', 'toast-mark', type === 'error' ? '!' : '✓'));
    item.append(element('span', 'toast-message', message));
    const close = element('button', 'toast-close', '×');
    close.setAttribute('aria-label', '关闭提示');
    close.onclick = () => item.remove();
    item.append(close);
    $('toast-container').append(item);
    setTimeout(() => item.remove(), type === 'error' ? 14000 : 4500);
    while ($('toast-container').children.length > 4) $('toast-container').firstElementChild.remove();
  }

  function showError(id, message) {
    $(id).textContent = message || '';
    $(id).hidden = !message;
  }

  function deviceInfo(id = state.selectedId) {
    return state.devices.find((device) => device.id === id) || state.deviceStates.get(id)?.info;
  }

  function online(id = state.selectedId) {
    return Boolean(id && state.devices.some((device) => device.id === id && device.status === 'Connected'));
  }

  function displayName(device) {
    if (!device) return '未选择设备';
    return state.settings.deviceNames?.[device.id] || device.name || device.id;
  }

  function deviceState(id = state.selectedId) {
    if (!id) return null;
    if (!state.deviceStates.has(id)) {
      state.deviceStates.set(id, {
        path: state.settings.defaultRemotePath || '/data', entries: [], selected: new Set(),
        anchor: null, query: '', showHidden: false, loading: false, loaded: false, backgroundLoading: false,
        fileScrollTop: 0, monitorScrollTop: 0,
        error: '', loadToken: 0, operation: false, activeTerminal: null, terminalCounter: 0,
        info: state.devices.find((device) => device.id === id),
        monitor: {}, monitorRefreshing: new Set(), networkInterface: '', networkHistory: new Map(), monitorBootId: null
      });
    }
    return state.deviceStates.get(id);
  }

  function joinPath(path, name) {
    return `${path.replace(/\/+$/, '')}/${name}` || '/';
  }

  function parentPath(path) {
    const value = path.replace(/\/+$/, '') || '/';
    return value.slice(0, value.lastIndexOf('/')) || '/';
  }

  function basename(path) {
    return String(path).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '文件';
  }

  function sizeText(bytes) {
    if (bytes === null || bytes === undefined || !Number.isFinite(Number(bytes))) return '—';
    const value = Number(bytes);
    if (value < 1024) return `${Math.round(value)} B`;
    if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
    if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
    return `${(value / 1024 ** 3).toFixed(1)} GB`;
  }

  function dateText(seconds) {
    if (!seconds || !Number.isFinite(Number(seconds))) return '—';
    const date = new Date(Number(seconds) * 1000);
    if (Number.isNaN(date.getTime())) return '—';
    const pad = (value) => String(value).padStart(2, '0');
    return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function createSvg(kind) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const paths = {
      directory: ['M3 7a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9H3z'],
      file: ['M6 3h8l4 4v14H6z', 'M14 3v5h4M9 12h6M9 16h5'],
      symlink: ['M9 9V4h10v11h-5', 'M3 17h9m-4-4 4 4-4 4'],
      other: ['M5 5h14v14H5z', 'M9 9h6v6H9z'],
      device: ['M5 5h14v12H5z', 'M9 21h6M12 17v4M8 8h8'],
      rename: ['m15 4 5 5L9 20H4v-5z', 'm12 7 5 5']
    };
    for (const definition of paths[kind] || paths.file) {
      const path = document.createElementNS(ns, 'path');
      path.setAttribute('d', definition);
      svg.append(path);
    }
    return svg;
  }

  function renderDevices() {
    const list = $('device-list');
    list.replaceChildren();
    let connectedCount = 0;
    for (const device of state.devices) {
      if (device.status === 'Connected') connectedCount++;
      const row = element('div', 'device-card-row');
      const card = element('button', `device-card${device.id === state.selectedId ? ' active' : ''}`);
      card.title = `${displayName(device)}\n${device.id}\n${device.status}`;
      card.setAttribute('aria-pressed', String(device.id === state.selectedId));
      const symbol = element('span', 'device-symbol');
      symbol.append(createSvg('device'));
      const details = element('span', 'device-card-details');
      details.append(element('span', 'device-card-name', displayName(device)));
      details.append(element('span', 'device-card-id', device.id));
      const meta = element('span', 'device-card-meta');
      meta.append(element('span', `tiny-dot${device.status === 'Connected' ? ' online' : ''}`));
      const status = device.status === 'Connected' ? '已连接' : (device.status || '未连接');
      meta.append(element('span', '', `${device.transport || '设备'} · ${status}`));
      details.append(meta);
      card.append(symbol, details);
      card.onclick = () => selectDevice(device.id);
      card.onkeydown = (event) => {
        if (event.key === 'F2') { event.preventDefault(); openDeviceName(device.id); }
      };
      const rename = element('button', 'icon-button device-name-button');
      rename.title = `命名设备：${displayName(device)}`;
      rename.setAttribute('aria-label', rename.title);
      rename.append(createSvg('rename'));
      rename.onclick = () => openDeviceName(device.id);
      row.append(card, rename);
      list.append(row);
    }
    $('device-count').textContent = String(state.devices.length);
    $('sidebar-empty').hidden = state.devices.length > 0;
    $('disconnect-button').hidden = !online() || !isNetworkDevice(deviceInfo());
    const current = deviceInfo();
    const connected = online();
    document.title = current ? `HDC Studio — ${displayName(current)}${connected ? '' : '（已断开）'}` : 'HDC Studio';
    $('offline-banner').hidden = !state.selectedId || connected;
    $('welcome').hidden = Boolean(state.selectedId);
    $('device-workspace').hidden = !state.selectedId;
    $('status-message').textContent = connected ? `${connectedCount} 台设备在线 · ${deviceInfo()?.transport || '设备'} 已连接` : (state.selectedId ? '连接已中断，等待设备重新连接' : '等待连接 · 每 4 秒自动发现设备');
    syncMonitorWatch();
    renderMonitorAges();
    renderAvailability();
  }

  function isNetworkDevice(device) {
    return device && (/tcp|network|网络/i.test(device.transport || '') || /^\[?[\da-f:.]+\]?:\d+$/i.test(device.id));
  }

  function renderEnvironment() {
    const hdc = state.app?.hdc;
    const unavailable = hdc && !hdc.available;
    $('environment-banner').hidden = !unavailable;
    $('environment-message').textContent = unavailable ? `HDC 暂不可用：${hdc.error || '未找到 hdc.exe，请在设置中指定程序路径。'}` : '';
    $('hdc-version').textContent = hdc?.available ? `HDC ${hdc.version || '已就绪'}` : 'HDC 未就绪';
    $('hdc-version').title = hdc?.path || '';
    $('welcome-title').textContent = unavailable ? '先配置 HDC，连接你的设备' : '连接设备，开始工作';
    $('welcome-description').textContent = unavailable ? '在设置中选择本机的 hdc.exe，完成后即可自动发现已连接的开发板。' : '浏览文件、打开终端，在一个窗口里管理你的开发板。';
    $('settings-version').textContent = `HDC Studio ${state.app?.appVersion || ''}`;
  }

  async function pollDevices(manual = false) {
    if (state.polling || state.disposed) return;
    state.polling = true;
    $('refresh-devices').disabled = true;
    if (manual) $('status-message').textContent = '正在刷新设备列表…';
    const oldOnline = new Set(state.devices.filter((device) => device.status === 'Connected').map((device) => device.id));
    try {
      const devices = await api.listDevices();
      if (state.disposed) return;
      state.devices = Array.isArray(devices) ? devices : [];
      for (const device of state.devices) deviceState(device.id).info = device;
      for (const id of oldOnline) {
        if (!online(id)) handleDeviceDisconnected(id);
      }
      showError('device-error', '');
      if (!state.selectedId) {
        const first = state.devices.find((device) => device.status === 'Connected');
        if (first) selectDevice(first.id);
      }
      renderDevices();
      renderTerminal();
      if (state.selectedId && online() && !oldOnline.has(state.selectedId)) {
        const ds = deviceState();
        if (!ds.loading) loadDirectory(state.selectedId, ds.path);
      }
    } catch (error) {
      showError('device-error', errorMessage(error));
      $('status-message').textContent = '设备发现失败，请检查 HDC 设置或连接';
      if (manual) toast(errorMessage(error), 'error');
    } finally {
      state.polling = false;
      $('refresh-devices').disabled = false;
      clearTimeout(state.pollTimer);
      if (!state.disposed) state.pollTimer = setTimeout(() => pollDevices(), 4000);
    }
  }

  function handleDeviceDisconnected(id) {
    const ds = deviceState(id);
    ds.loadToken++;
    ds.loading = false;
    ds.backgroundLoading = false;
    for (const term of state.terminals.values()) {
      if (term.deviceId !== id || term.closed) continue;
      term.disconnected = true;
      if (term.running) term.terminal.writeln('\r\n\x1b[33m[设备连接已中断]\x1b[0m');
      term.running = false;
      if (term.id) {
        const sessionId = term.id;
        state.sessions.delete(sessionId);
        term.id = null;
        Promise.resolve(api.closeTerminal(sessionId)).catch(() => {});
      }
    }
    if (id === state.selectedId) renderFiles();
  }

  function selectDevice(id) {
    if (id === state.selectedId) return;
    const previous = deviceState();
    if (previous) {
      previous.fileScrollTop = $('file-table-container').scrollTop;
      previous.monitorScrollTop = $('monitor-sidebar').scrollTop;
    }
    for (const dialog of ['process-dialog', 'npu-dialog', 'analysis-dialog']) if ($(dialog).open) $(dialog).close();
    state.processSelection = null;
    state.processDetail = null;
    state.processDetailToken++;
    state.processLoading = false;
    state.selectedId = id;
    const ds = deviceState(id);
    $('remote-path').value = ds.path;
    $('file-search').value = ds.query;
    $('show-hidden').checked = ds.showHidden;
    renderDevices();
    renderFiles();
    renderTerminal();
    renderMonitor();
    $('monitor-sidebar').scrollTop = ds.monitorScrollTop;
    if (online(id) && !ds.loading) loadDirectory(id, ds.path, { background: ds.loaded });
    if (online(id) && !deviceTerminals(id).length) createTerminal(id);
    requestAnimationFrame(fitActiveTerminal);
  }

  function visibleEntries(ds = deviceState()) {
    if (!ds) return [];
    const query = ds.query.toLocaleLowerCase();
    return ds.entries.filter((entry) => (ds.showHidden || !entry.name.startsWith('.')) && (!query || entry.name.toLocaleLowerCase().includes(query))).sort((a, b) => {
      const directories = Number(b.type === 'directory') - Number(a.type === 'directory');
      return directories || a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' });
    });
  }

  function selectedEntries(ds = deviceState()) {
    return ds ? ds.entries.filter((entry) => ds.selected.has(entry.path)) : [];
  }

  function renderAvailability() {
    const ds = deviceState();
    const available = online();
    const busy = Boolean(ds?.loading || ds?.operation);
    const selected = selectedEntries(ds);
    for (const id of ['upload-files', 'upload-directory', 'create-directory', 'refresh-files', 'parent-directory']) $(id).disabled = !available || busy;
    $('parent-directory').disabled = !available || busy || ds?.path === '/';
    $('remote-path').disabled = !available || busy;
    $('path-form').querySelector('[type=submit]').disabled = !available || busy;
    $('download-files').disabled = !available || busy || !selected.length;
    $('delete-files').disabled = !available || busy || !selected.length;
    $('preview-file').disabled = !available || busy || selected.length !== 1 || selected[0]?.type === 'directory';
    $('rename-file').disabled = !available || busy || selected.length !== 1;
    $('analyze-directory').disabled = !available || busy;
    $('open-processes').disabled = !available;
    $('open-npu').disabled = !state.selectedId;
    $('new-terminal').disabled = !available;
    $('terminal-empty-open').disabled = !available;
    $('reboot-button').disabled = !available || state.quickBusy.has(state.selectedId);
    for (const button of document.querySelectorAll('[data-quick]')) button.disabled = !available || state.quickBusy.has(state.selectedId);
    $('file-loading').hidden = !ds?.loading || ds.backgroundLoading;
  }

  function renderFiles() {
    const ds = deviceState();
    if (!ds) return;
    const tbody = $('file-table-body');
    const scroll = ds.fileScrollTop;
    tbody.replaceChildren();
    const entries = visibleEntries(ds);
    for (const entry of entries) {
      const row = element('tr', ds.selected.has(entry.path) ? 'selected' : '');
      row.title = `${entry.name}\n${entry.permissions || ''}${entry.linkTarget ? `\n链接到 ${entry.linkTarget}` : ''}`;
      row.dataset.path = entry.path;
      row.setAttribute('aria-selected', String(ds.selected.has(entry.path)));
      const checkCell = element('td', 'checkbox-cell');
      const checkbox = element('input');
      checkbox.type = 'checkbox';
      checkbox.checked = ds.selected.has(entry.path);
      checkbox.setAttribute('aria-label', `选择 ${entry.name}`);
      checkbox.onclick = (event) => {
        event.stopPropagation();
        toggleSelection(entry.path, checkbox.checked);
      };
      checkCell.append(checkbox);
      const nameCell = element('td');
      const content = element('span', 'file-name-cell');
      const icon = element('span', `file-icon ${entry.type}`);
      icon.append(createSvg(entry.type));
      content.append(icon, element('span', '', entry.name));
      nameCell.append(content);
      row.append(checkCell, nameCell, element('td', 'size-cell', entry.type === 'directory' ? '—' : sizeText(entry.size)), element('td', 'permissions-cell', entry.permissions || '—'), element('td', 'date-cell', dateText(entry.modified)));
      row.onclick = (event) => selectEntry(entry.path, event);
      row.ondblclick = () => openEntry(entry);
      row.oncontextmenu = (event) => {
        event.preventDefault();
        if (!ds.selected.has(entry.path)) { ds.selected = new Set([entry.path]); ds.anchor = entry.path; renderSelection(); }
      };
      tbody.append(row);
    }
    $('file-table-container').scrollTop = scroll;
    const empty = $('file-empty');
    empty.hidden = entries.length > 0 || ds.loading;
    empty.classList.toggle('error', Boolean(ds.error));
    $('retry-files').hidden = !ds.error || !online();
    if (ds.error) {
      $('file-empty-title').textContent = '无法读取目录';
      $('file-empty-detail').textContent = ds.error;
    } else if (!online() && !ds.loaded) {
      $('file-empty-title').textContent = '设备当前未连接';
      $('file-empty-detail').textContent = '重新连接后可浏览远程文件';
    } else if (ds.query || (!ds.showHidden && ds.entries.length)) {
      $('file-empty-title').textContent = '没有符合条件的文件';
      $('file-empty-detail').textContent = '试试其他名称，或开启“隐藏文件”';
    } else {
      $('file-empty-title').textContent = '这个目录是空的';
      $('file-empty-detail').textContent = '上传文件或新建一个目录';
    }
    const totalBytes = entries.reduce((sum, entry) => sum + (entry.type === 'file' ? Number(entry.size) || 0 : 0), 0);
    const summary = `${entries.length} 项${entries.length !== ds.entries.length ? ` / 共 ${ds.entries.length} 项` : ''} · ${sizeText(totalBytes)}`;
    $('file-summary').textContent = ds.backgroundLoading ? `${summary} · 更新中` : ds.loading ? '正在读取…' : ds.error ? (ds.loaded ? `${summary} · 刷新失败，保留上次内容` : '目录读取失败') : summary;
    $('file-summary').title = ds.error || '';
    renderSelection();
  }

  function renderSelection() {
    const ds = deviceState();
    if (!ds) return;
    const entries = visibleEntries(ds);
    for (const row of $('file-table-body').rows) {
      const selected = ds.selected.has(row.dataset.path);
      row.classList.toggle('selected', selected);
      row.setAttribute('aria-selected', String(selected));
      row.querySelector('input[type=checkbox]').checked = selected;
    }
    const selectedCount = ds.selected.size;
    $('selection-count').textContent = selectedCount ? `已选 ${selectedCount} 项` : '选择文件以进行操作';
    $('selection-toolbar').classList.toggle('has-selection', selectedCount > 0);
    const selectedVisible = entries.filter((entry) => ds.selected.has(entry.path)).length;
    $('select-all-files').checked = entries.length > 0 && selectedVisible === entries.length;
    $('select-all-files').indeterminate = selectedVisible > 0 && selectedVisible < entries.length;
    $('select-all-files').disabled = !entries.length || ds.loading;
    renderAvailability();
  }

  function toggleSelection(path, selected) {
    const ds = deviceState();
    if (!ds || ds.loading) return;
    if (selected) ds.selected.add(path); else ds.selected.delete(path);
    ds.anchor = path;
    renderSelection();
  }

  function selectEntry(path, event) {
    const ds = deviceState();
    if (!ds || ds.loading) return;
    if (event.shiftKey && ds.anchor) {
      const entries = visibleEntries(ds);
      const from = entries.findIndex((entry) => entry.path === ds.anchor);
      const to = entries.findIndex((entry) => entry.path === path);
      if (!event.ctrlKey && !event.metaKey) ds.selected.clear();
      if (from >= 0 && to >= 0) for (const entry of entries.slice(Math.min(from, to), Math.max(from, to) + 1)) ds.selected.add(entry.path);
      else ds.selected.add(path);
    } else if (event.ctrlKey || event.metaKey) {
      if (ds.selected.has(path)) ds.selected.delete(path); else ds.selected.add(path);
      ds.anchor = path;
    } else {
      ds.selected = new Set([path]);
      ds.anchor = path;
    }
    renderSelection();
  }

  async function loadDirectory(deviceId, path, { background = false } = {}) {
    if (!online(deviceId)) return;
    const ds = deviceState(deviceId);
    if (ds.loading || ds.operation) return;
    const token = ++ds.loadToken;
    const retainSnapshot = ds.loaded && path === ds.path;
    ds.loading = true;
    ds.backgroundLoading = background && retainSnapshot;
    ds.error = '';
    if (deviceId === state.selectedId) renderFiles();
    try {
      const result = await api.listDirectory({ deviceId, path });
      if (token !== ds.loadToken || state.disposed) return;
      ds.path = result.path || path;
      ds.entries = Array.isArray(result.entries) ? result.entries : [];
      if (retainSnapshot) {
        const paths = new Set(ds.entries.map((entry) => entry.path));
        ds.selected = new Set([...ds.selected].filter((entry) => paths.has(entry)));
        if (!paths.has(ds.anchor)) ds.anchor = null;
      } else {
        ds.selected.clear();
        ds.anchor = null;
        ds.fileScrollTop = 0;
      }
      ds.loaded = true;
      if (deviceId === state.selectedId) {
        $('remote-path').value = ds.path;
      }
    } catch (error) {
      if (token !== ds.loadToken) return;
      ds.error = errorMessage(error);
      if (!retainSnapshot) {
        ds.entries = [];
        ds.selected.clear();
        ds.fileScrollTop = 0;
      }
      // Preserve the attempted path so retry never silently targets another directory.
      ds.path = path;
      ds.loaded = retainSnapshot;
      if (deviceId === state.selectedId) $('remote-path').value = path;
    } finally {
      if (token === ds.loadToken) { ds.loading = false; ds.backgroundLoading = false; }
      if (deviceId === state.selectedId) renderFiles();
    }
  }

  function refreshFiles() {
    const ds = deviceState();
    if (ds) return loadDirectory(state.selectedId, ds.path);
  }

  function openEntry(entry) {
    if (!online()) return;
    if (entry.type === 'directory') loadDirectory(state.selectedId, entry.path);
    else previewFile(entry);
  }

  async function withFileOperation(action, successMessage, refresh = true) {
    const deviceId = state.selectedId;
    const ds = deviceState(deviceId);
    if (!ds || !online(deviceId) || ds.operation || ds.loading) return;
    const path = ds.path;
    ds.operation = true;
    renderAvailability();
    try {
      const result = await action(deviceId, ds);
      if (successMessage && result !== false && !result?.cancelled) toast(successMessage);
      return result;
    } catch (error) {
      toast(errorMessage(error), 'error');
      return null;
    } finally {
      ds.operation = false;
      if (deviceId === state.selectedId) renderAvailability();
      if (refresh && online(deviceId) && ds.path === path) loadDirectory(deviceId, path);
    }
  }

  function beginInput(kind) {
    const ds = deviceState();
    if (!ds || !online() || ds.operation || ds.loading) return;
    const selected = selectedEntries(ds);
    if (kind === 'rename' && selected.length !== 1) return;
    const target = kind === 'rename' ? selected[0] : null;
    state.inputAction = { kind, deviceId: state.selectedId, directory: ds.path, target };
    $('input-title').textContent = kind === 'rename' ? '重命名' : '新建目录';
    $('input-description').textContent = target?.path || ds.path;
    $('input-value').value = target?.name || '';
    $('input-submit').textContent = kind === 'rename' ? '保存名称' : '创建目录';
    $('input-submit').disabled = false;
    showError('input-error', '');
    $('input-dialog').showModal();
    $('input-value').focus();
    $('input-value').select();
  }

  async function submitInput(event) {
    event.preventDefault();
    const action = state.inputAction;
    if (!action || $('input-submit').disabled) return;
    const name = $('input-value').value;
    if (!name.trim() || name === '.' || name === '..' || /[/\u0000\r\n]/.test(name)) {
      showError('input-error', '请输入有效的单个名称，不能包含斜杠或换行。');
      return;
    }
    if (!online(action.deviceId)) { showError('input-error', '这台设备已断开，请重新连接后再试。'); return; }
    $('input-submit').disabled = true;
    const ds = deviceState(action.deviceId);
    ds.operation = true;
    renderAvailability();
    try {
      if (action.kind === 'rename') await api.renamePath({ deviceId: action.deviceId, path: action.target.path, newName: name });
      else await api.createDirectory({ deviceId: action.deviceId, path: joinPath(action.directory, name) });
      $('input-dialog').close();
      toast(action.kind === 'rename' ? '名称已更新' : '目录已创建');
    } catch (error) {
      showError('input-error', errorMessage(error));
    } finally {
      $('input-submit').disabled = false;
      ds.operation = false;
      renderAvailability();
      if (!$('input-dialog').open && online(action.deviceId)) loadDirectory(action.deviceId, ds.path);
    }
  }

  async function queueUpload(kind) {
    await withFileOperation(async (deviceId, ds) => {
      const jobs = await api.upload({ deviceId, remotePath: ds.path, kind });
      if (Array.isArray(jobs) && jobs.length) { setDrawerOpen(true); updateTransfers(await api.getTransfers()); }
      return jobs;
    }, '', false);
  }

  async function queueDownload() {
    const paths = selectedEntries().map((entry) => entry.path);
    if (!paths.length) return;
    await withFileOperation(async (deviceId) => {
      const jobs = await api.download({ deviceId, paths });
      if (Array.isArray(jobs) && jobs.length) { setDrawerOpen(true); updateTransfers(await api.getTransfers()); }
      return jobs;
    }, '', false);
  }

  function showPreview({ title, kind, meta, name }) {
    state.previewToken++;
    state.previewText = '';
    state.previewName = name || 'output.txt';
    $('preview-title').textContent = title;
    $('preview-title').title = title;
    $('preview-kind').textContent = kind;
    $('preview-meta').textContent = meta;
    $('preview-content').textContent = '正在读取…';
    $('preview-notice').hidden = true;
    $('preview-status').textContent = '';
    $('preview-copy').disabled = true;
    $('preview-save').disabled = true;
    if (!$('preview-dialog').open) $('preview-dialog').showModal();
    return state.previewToken;
  }

  async function previewFile(entry = selectedEntries()[0]) {
    if (!entry || entry.type === 'directory' || !online()) return;
    const deviceId = state.selectedId;
    const token = showPreview({ title: entry.name, kind: '文本预览', meta: `${displayName(deviceInfo(deviceId))} · ${entry.path}`, name: entry.name });
    try {
      const result = await api.readFile({ deviceId, path: entry.path });
      if (token !== state.previewToken) return;
      if (result.binary) {
        $('preview-content').textContent = '这是一个二进制文件，无法显示文本预览。\n请关闭预览，选中文件后下载到电脑查看。';
        $('preview-status').textContent = sizeText(result.size);
        return;
      }
      state.previewText = result.text || '';
      $('preview-content').textContent = state.previewText;
      $('preview-status').textContent = `${sizeText(result.size)} · 只读预览`;
      $('preview-copy').disabled = false;
      $('preview-save').disabled = false;
      if (result.truncated) {
        $('preview-notice').textContent = '文件较大，只展示前面部分。复制或另存为仅包含当前预览；下载可获取完整文件。';
        $('preview-notice').hidden = false;
      }
    } catch (error) {
      if (token !== state.previewToken) return;
      $('preview-content').textContent = errorMessage(error);
      $('preview-status').textContent = '读取失败';
    }
  }

  async function runQuick(key) {
    const deviceId = state.selectedId;
    if (!online(deviceId) || state.quickBusy.has(deviceId)) return;
    $('quick-menu').open = false;
    state.quickBusy.add(deviceId);
    renderAvailability();
    const token = showPreview({ title: quickLabels[key] || key, kind: '设备信息 · 只读', meta: `${displayName(deviceInfo(deviceId))} · ${deviceId}`, name: `${key}-${new Date().toISOString().slice(0, 10)}.txt` });
    try {
      const result = await api.runQuick({ deviceId, key });
      if (token !== state.previewToken) return;
      state.previewText = `${result.stdout || ''}${result.stderr ? `\n${result.stderr}` : ''}`;
      $('preview-content').textContent = state.previewText || '命令已完成，没有文本输出。';
      $('preview-status').textContent = Number(result.exitCode) === 0 ? '读取完成' : `命令退出码：${result.exitCode}`;
      $('preview-copy').disabled = !state.previewText;
      $('preview-save').disabled = !state.previewText;
    } catch (error) {
      if (token !== state.previewToken) return;
      $('preview-content').textContent = errorMessage(error);
      $('preview-status').textContent = '读取失败';
    } finally {
      state.quickBusy.delete(deviceId);
      renderAvailability();
    }
  }

  function deviceTerminals(deviceId = state.selectedId) {
    return [...state.terminals.values()].filter((entry) => entry.deviceId === deviceId && !entry.closed);
  }

  function activeTerminal() {
    return state.terminals.get(deviceState()?.activeTerminal) || null;
  }

  function terminalError(error) {
    toast(errorMessage(error), 'error');
  }

  function bufferTerminalEvent(type, event) {
    if (!state.terminalEvents.has(event.id)) state.terminalEvents.set(event.id, []);
    const events = state.terminalEvents.get(event.id);
    events.push({ type, event });
    // Bound only the pre-attachment race buffer, never an attached terminal's output.
    if (events.length > 64) events.shift();
    if (state.terminalEvents.size > 24) state.terminalEvents.delete(state.terminalEvents.keys().next().value);
  }

  function handleTerminalData(event) {
    const entry = state.sessions.get(event.id);
    if (!entry) { bufferTerminalEvent('data', event); return; }
    if (entry.closed || entry.id !== event.id) return;
    entry.terminal.write(event.data || '');
  }

  function handleTerminalExit(event) {
    const entry = state.sessions.get(event.id);
    if (!entry) { bufferTerminalEvent('exit', event); return; }
    if (entry.closed || entry.id !== event.id) return;
    entry.running = false;
    entry.opening = false;
    entry.exitCode = event.exitCode;
    entry.terminal.writeln(`\r\n\x1b[90m[终端已退出${event.exitCode === null || event.exitCode === undefined ? '' : `，退出码 ${event.exitCode}`}；可点击“重新连接”]\x1b[0m`);
    if (entry.deviceId === state.selectedId) renderTerminal();
  }

  async function createTerminal(deviceId = state.selectedId) {
    if (!online(deviceId)) return;
    if (typeof window.Terminal !== 'function' || !window.FitAddon?.FitAddon) {
      $('terminal-empty-title').textContent = '终端组件未能加载';
      $('terminal-empty-detail').textContent = '请重新启动应用，或检查安装是否完整。';
      toast('终端组件未能加载，请检查应用安装是否完整。', 'error');
      return;
    }
    const ds = deviceState(deviceId);
    const key = `terminal-${++state.terminalSequence}`;
    const terminal = new window.Terminal({
      fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, "Microsoft YaHei", monospace',
      fontSize: Number(state.settings.terminalFontSize) || 15,
      lineHeight: 1.22, cursorBlink: true, cursorStyle: 'bar', scrollback: 10000,
      convertEol: false, allowProposedApi: false,
      theme: {
        background: '#141c2a', foreground: '#e3eaf5', cursor: '#c3d8fa', cursorAccent: '#141c2a',
        selectionBackground: '#3b578288', black: '#263449', red: '#ef9290', green: '#94cba9',
        yellow: '#dec18f', blue: '#8bb2f2', magenta: '#c3a3e8', cyan: '#83cbd3', white: '#c8d7ed',
        brightBlack: '#9baec8', brightRed: '#ffa5a0', brightGreen: '#a6e1bc', brightYellow: '#f0d19c',
        brightBlue: '#a9caff', brightMagenta: '#dabaff', brightCyan: '#a6e4ea', brightWhite: '#eef4ff'
      }
    });
    const fit = new window.FitAddon.FitAddon();
    terminal.loadAddon(fit);
    const host = element('div', 'terminal-session');
    host.id = key;
    host.hidden = deviceId !== state.selectedId;
    $('terminal-host').append(host);
    const entry = {
      key, id: null, deviceId, terminal, fit, host, name: `终端 ${++ds.terminalCounter}`,
      cwd: ds.path, running: false, opening: false, closed: false, disconnected: false,
      exitCode: null, writeError: false, lastCols: 0, lastRows: 0
    };
    state.terminals.set(key, entry);
    ds.activeTerminal = key;
    terminal.open(host);
    terminal.onData((data) => {
      if (!entry.id || !entry.running || !online(entry.deviceId)) return;
      Promise.resolve(api.writeTerminal({ id: entry.id, data })).catch((error) => {
        if (!entry.writeError) { entry.writeError = true; terminalError(error); }
      });
    });
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type === 'keydown' && event.ctrlKey && event.shiftKey && event.code === 'KeyC') {
        copyText(terminal.getSelection());
        return false;
      }
      if (event.type === 'keydown' && event.ctrlKey && event.shiftKey && event.code === 'KeyV') {
        pasteTerminal(entry);
        return false;
      }
      return true;
    });
    renderTerminal();
    await startTerminal(entry);
  }

  async function startTerminal(entry) {
    if (entry.closed || entry.opening || !online(entry.deviceId)) return;
    entry.opening = true;
    entry.running = false;
    entry.disconnected = false;
    entry.writeError = false;
    entry.exitCode = null;
    renderTerminal();
    if (entry.deviceId === state.selectedId) fitActiveTerminal();
    const cols = entry.terminal.cols || 80;
    const rows = entry.terminal.rows || 24;
    try {
      const result = await api.openTerminal({ deviceId: entry.deviceId, cwd: entry.cwd, cols, rows });
      if (entry.closed || !online(entry.deviceId)) {
        Promise.resolve(api.closeTerminal(result.id)).catch(() => {});
        entry.disconnected = !online(entry.deviceId);
        return;
      }
      entry.id = result.id;
      entry.running = true;
      entry.lastCols = cols;
      entry.lastRows = rows;
      state.sessions.set(result.id, entry);
      const buffered = state.terminalEvents.get(result.id) || [];
      state.terminalEvents.delete(result.id);
      for (const item of buffered) {
        if (item.type === 'data') handleTerminalData(item.event);
        else handleTerminalExit(item.event);
      }
      if (entry.deviceId === state.selectedId) requestAnimationFrame(() => { fitActiveTerminal(); entry.terminal.focus(); });
    } catch (error) {
      entry.terminal.writeln(`\r\n\x1b[33m[无法打开终端]\x1b[0m\r\n${errorMessage(error).replace(/\x1b/g, '')}`);
      terminalError(error);
    } finally {
      entry.opening = false;
      if (!entry.closed && entry.deviceId === state.selectedId) renderTerminal();
    }
  }

  async function reconnectTerminal() {
    const entry = activeTerminal();
    if (!entry) return createTerminal();
    if (entry.running || entry.opening || !online(entry.deviceId)) return;
    if (entry.id) {
      state.sessions.delete(entry.id);
      await Promise.resolve(api.closeTerminal(entry.id)).catch(() => {});
      entry.id = null;
    }
    entry.terminal.writeln('\r\n\x1b[90m[重新连接终端]\x1b[0m');
    return startTerminal(entry);
  }

  async function closeTerminal(key) {
    const entry = state.terminals.get(key);
    if (!entry || entry.closed) return;
    entry.closed = true;
    if (entry.id) {
      state.sessions.delete(entry.id);
      Promise.resolve(api.closeTerminal(entry.id)).catch(terminalError);
    }
    entry.terminal.dispose();
    entry.host.remove();
    state.terminals.delete(key);
    const ds = deviceState(entry.deviceId);
    if (ds.activeTerminal === key) ds.activeTerminal = deviceTerminals(entry.deviceId).at(-1)?.key || null;
    if (entry.deviceId === state.selectedId) { renderTerminal(); requestAnimationFrame(fitActiveTerminal); }
  }

  function renderTerminal() {
    const entries = deviceTerminals();
    const active = activeTerminal();
    $('terminal-tabs').replaceChildren();
    for (const entry of state.terminals.values()) entry.host.hidden = entry !== active;
    for (const entry of entries) {
      const tab = element('div', `terminal-tab${entry === active ? ' active' : ''}${entry.running ? ' live' : ' ended'}`);
      const dot = element('span', 'tab-dot');
      const label = element('button', 'terminal-tab-label', entry.name);
      label.setAttribute('role', 'tab');
      label.setAttribute('aria-selected', String(entry === active));
      label.setAttribute('aria-controls', entry.key);
      label.title = `${entry.cwd}${entry.opening ? ' · 正在连接' : entry.running ? ' · 已连接' : ' · 已结束'}`;
      label.onclick = () => {
        deviceState().activeTerminal = entry.key;
        renderTerminal();
        requestAnimationFrame(() => { fitActiveTerminal(); entry.terminal.focus(); });
      };
      const close = element('button', 'terminal-tab-close', '×');
      close.title = `关闭 ${entry.name}`;
      close.setAttribute('aria-label', `关闭 ${entry.name}`);
      close.onclick = () => closeTerminal(entry.key);
      tab.append(dot, label, close);
      $('terminal-tabs').append(tab);
    }
    $('terminal-empty').hidden = Boolean(active);
    if (!active) {
      $('terminal-empty-title').textContent = online() ? '打开一个终端' : '等待设备连接';
      $('terminal-empty-detail').textContent = online() ? '直接在设备上运行命令' : '设备上线后，可以在这里打开交互终端';
    }
    $('terminal-reconnect').hidden = !active || active.running || active.opening;
    $('terminal-reconnect').disabled = !online();
    $('terminal-footer-label').textContent = active?.opening ? '正在打开终端…' : active?.running && online() ? '已连接' : active?.disconnected ? '设备已断开' : active ? '已退出，可重新连接' : '准备就绪';
    document.querySelector('.terminal-panel').classList.toggle('is-live', Boolean(active?.running && online()));
    $('terminal-copy').disabled = !active;
    $('terminal-clear').disabled = !active;
    $('terminal-save').disabled = !active;
    $('terminal-paste').disabled = !active?.running || !online();
    renderAvailability();
  }

  function fitActiveTerminal() {
    const entry = activeTerminal();
    if (!entry || entry.closed || entry.host.hidden || !entry.host.clientWidth || !entry.host.clientHeight) return;
    try {
      entry.fit.fit();
      const cols = entry.terminal.cols;
      const rows = entry.terminal.rows;
      if (entry.id && entry.running && cols > 0 && rows > 0 && (cols !== entry.lastCols || rows !== entry.lastRows)) {
        entry.lastCols = cols;
        entry.lastRows = rows;
        Promise.resolve(api.resizeTerminal({ id: entry.id, cols, rows })).catch(() => {});
      }
    } catch (error) {
      // A hidden or transitioning pane will be fitted by the next ResizeObserver callback.
    }
  }

  async function copyText(text) {
    if (!text) { toast('请先选中要复制的文本。', 'error'); return; }
    try { await navigator.clipboard.writeText(text); toast('文本已复制'); }
    catch (error) { toast(`复制失败：${errorMessage(error)}`, 'error'); }
  }

  async function pasteTerminal(entry = activeTerminal()) {
    if (!entry?.running || !online(entry.deviceId)) return;
    try {
      const text = await navigator.clipboard.readText();
      if (entry.closed || !entry.running || !online(entry.deviceId)) return;
      entry.terminal.paste(text);
      entry.terminal.focus();
    } catch (error) { toast('无法读取剪贴板。请点击终端后使用 Ctrl+V 粘贴。', 'error'); }
  }

  async function saveTerminal() {
    const entry = activeTerminal();
    if (!entry) return;
    const buffer = entry.terminal.buffer.active;
    const lines = [];
    for (let i = 0; i < buffer.length; i++) lines.push(buffer.getLine(i)?.translateToString(true) || '');
    try {
      const saved = await api.saveText({ name: `terminal-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`, text: lines.join('\n').replace(/\s+$/, '') });
      if (saved) toast(`终端文本已保存到 ${saved}`);
    } catch (error) { toast(errorMessage(error), 'error'); }
  }

  function setDrawerOpen(open) {
    state.drawerOpen = open;
    $('transfer-drawer').hidden = !open;
    $('transfers-toggle').classList.toggle('active', open);
    $('transfers-toggle').setAttribute('aria-expanded', String(open));
  }

  function updateTransfers(jobs) {
    if (!Array.isArray(jobs)) return;
    const refreshDevices = new Set();
    for (const job of jobs) {
      const before = state.transferStates.get(job.id);
      if (before && before !== 'completed' && job.state === 'completed' && job.direction === 'upload') refreshDevices.add(job.deviceId);
      state.transferStates.set(job.id, job.state);
    }
    state.transfers = jobs;
    renderTransfers();
    for (const id of refreshDevices) {
      const ds = state.deviceStates.get(id);
      if (ds && id === state.selectedId && online(id) && !ds.loading && !ds.operation) loadDirectory(id, ds.path);
    }
  }

  function renderTransfers() {
    const jobs = state.transfers;
    const activeCount = jobs.filter((job) => ['queued', 'running'].includes(job.state)).length;
    const failures = jobs.filter((job) => job.state === 'failed').length;
    $('transfer-badge').textContent = String(activeCount || jobs.length);
    $('transfers-toggle').classList.toggle('has-running', activeCount > 0);
    $('transfers-toggle').classList.toggle('has-error', failures > 0 && !activeCount);
    $('transfer-summary').textContent = activeCount ? `${activeCount} 项等待或传输中${failures ? ` · ${failures} 项失败` : ''}` : jobs.length ? `${jobs.length} 项任务${failures ? ` · ${failures} 项失败` : ''}` : '没有进行中的任务';
    $('transfers-empty').hidden = jobs.length > 0;
    const scroll = $('transfer-list').scrollTop;
    $('transfer-list').replaceChildren();
    const sorted = [...jobs].sort((a, b) => {
      const ranks = { running: 0, queued: 1, failed: 2, cancelled: 3, completed: 4 };
      return (ranks[a.state] ?? 5) - (ranks[b.state] ?? 5) || (Number(b.startedAt) || 0) - (Number(a.startedAt) || 0);
    });
    for (const job of sorted) {
      const row = element('div', `transfer-item ${job.state}`);
      const direction = element('div', 'transfer-direction', job.direction === 'upload' ? '↑' : '↓');
      direction.title = job.direction === 'upload' ? '上传到设备' : '下载到电脑';
      const details = element('div', 'transfer-details');
      const title = element('div', 'transfer-name');
      const name = element('span', '', job.name || basename(job.source));
      name.title = job.name || job.source;
      title.append(name, element('span', 'transfer-device', displayName(deviceInfo(job.deviceId)) || job.deviceId));
      const path = element('div', 'transfer-path', `${job.source} → ${job.destination}`);
      path.title = `${job.source}\n→ ${job.destination}`;
      details.append(title, path);
      if (job.detail) details.append(element('div', 'transfer-detail', job.detail));
      else if (job.state === 'cancelled') details.append(element('div', 'transfer-detail', '任务已取消，目标位置可能保留部分文件。'));
      else if (job.state === 'failed') details.append(element('div', 'transfer-detail', '传输未完成，请检查设备连接、空间和访问权限。'));
      const hasProgress = job.progress !== null && job.progress !== undefined && Number.isFinite(Number(job.progress));
      if (job.state === 'running' || job.state === 'completed') {
        const bar = element('div', `transfer-progress${!hasProgress && job.state === 'running' ? ' indeterminate' : ''}`);
        const fill = element('span');
        if (job.state === 'completed') fill.style.width = '100%';
        else if (hasProgress) fill.style.width = `${Math.max(0, Math.min(100, Number(job.progress)))}%`;
        bar.append(fill);
        details.append(bar);
      }
      const label = jobLabels[job.state] || job.state;
      const status = element('div', 'transfer-state', hasProgress && job.state === 'running' ? `${Math.round(Number(job.progress))}%` : label);
      const action = element('div');
      if (job.state === 'queued' || job.state === 'running') {
        const cancel = element('button', 'transfer-cancel', '取消');
        cancel.onclick = async () => {
          cancel.disabled = true;
          try { await api.cancelTransfer(job.id); }
          catch (error) { toast(errorMessage(error), 'error'); cancel.disabled = false; }
        };
        action.append(cancel);
      }
      row.append(direction, details, status, action);
      $('transfer-list').append(row);
    }
    $('transfer-list').scrollTop = scroll;
  }

  function openConnect() {
    showError('connect-error', '');
    if (!$('connect-dialog').open) $('connect-dialog').showModal();
    $('connect-address').focus();
  }

  async function submitConnect(event) {
    event.preventDefault();
    if (state.connectBusy) return;
    const address = $('connect-address').value.trim();
    if (!address) return;
    state.connectBusy = true;
    $('connect-submit').disabled = true;
    $('connect-submit').textContent = '正在连接…';
    showError('connect-error', '');
    try {
      await api.connectDevice(address);
      $('connect-dialog').close();
      toast('连接请求已完成，正在发现设备');
      await pollDevices();
      const match = state.devices.find((device) => device.id === address && device.status === 'Connected');
      if (match) selectDevice(match.id);
    } catch (error) { showError('connect-error', errorMessage(error)); }
    finally { state.connectBusy = false; $('connect-submit').disabled = false; $('connect-submit').textContent = '连接设备'; }
  }

  function openDeviceName(deviceId) {
    if (state.deviceNameBusy || !deviceInfo(deviceId)) return;
    state.deviceNameId = deviceId;
    $('device-name-id').textContent = deviceId;
    $('device-name-value').value = state.settings.deviceNames?.[deviceId] || '';
    $('device-name-value').placeholder = deviceInfo(deviceId).name || '输入便于识别的名称';
    showError('device-name-error', '');
    $('device-name-dialog').showModal();
    $('device-name-value').focus();
    $('device-name-value').select();
  }

  async function saveDeviceName(event) {
    event.preventDefault();
    const deviceId = state.deviceNameId;
    if (!deviceId || state.deviceNameBusy) return;
    const name = $('device-name-value').value.trim();
    if (name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) {
      showError('device-name-error', '名称最多80个字符，不能包含换行或控制字符。');
      return;
    }
    const deviceNames = { ...state.settings.deviceNames };
    if (name) deviceNames[deviceId] = name;
    else delete deviceNames[deviceId];
    state.deviceNameBusy = true;
    $('device-name-submit').disabled = true;
    $('device-name-submit').textContent = '正在保存…';
    try {
      state.settings = await api.saveSettings({ deviceNames });
      if (state.app) state.app.settings = state.settings;
      $('device-name-dialog').close();
      renderDevices();
      renderTransfers();
      toast(name ? '设备名称已保存' : '已恢复设备默认名称');
    } catch (error) { showError('device-name-error', errorMessage(error)); }
    finally {
      state.deviceNameBusy = false;
      $('device-name-submit').disabled = false;
      $('device-name-submit').textContent = '保存名称';
    }
  }

  function applyTypography() {
    document.documentElement.style.setProperty('--font-ui', `${Number(state.settings.uiFontSize) || 14}px`);
    for (const entry of state.terminals.values()) {
      entry.terminal.options.fontSize = Number(state.settings.terminalFontSize) || 15;
    }
    requestAnimationFrame(fitActiveTerminal);
  }

  function openSettings() {
    if (state.settingsBusy) return;
    const settings = state.settings;
    $('setting-hdc').value = settings.hdcPath || '';
    $('setting-server').value = settings.serverAddress || '127.0.0.1:8710';
    $('setting-remote').value = settings.defaultRemotePath || '/data';
    $('setting-downloads').value = settings.downloadsPath || state.app?.downloadsPath || '';
    $('setting-font').value = Number(settings.terminalFontSize) || 15;
    $('font-example').style.fontSize = `${Number(settings.terminalFontSize) || 15}px`;
    $('setting-ui-font').value = Number(settings.uiFontSize) || 14;
    $('ui-font-example').style.fontSize = `${Number(settings.uiFontSize) || 14}px`;
    showError('settings-error', '');
    if (!$('settings-dialog').open) $('settings-dialog').showModal();
  }

  async function saveSettings(event) {
    event.preventDefault();
    if (state.settingsBusy) return;
    const remotePath = $('setting-remote').value.trim();
    if (!remotePath.startsWith('/')) { showError('settings-error', '默认远程目录需要以 / 开头。'); return; }
    const fontSize = Number($('setting-font').value);
    if (!Number.isInteger(fontSize) || fontSize < 10 || fontSize > 28) { showError('settings-error', '字体大小请填写 10–28 之间的整数。'); return; }
    const uiFontSize = Number($('setting-ui-font').value);
    if (!Number.isInteger(uiFontSize) || uiFontSize < 13 || uiFontSize > 18) { showError('settings-error', '界面字号请填写 13–18 之间的整数。'); return; }
    state.settingsBusy = true;
    $('settings-submit').disabled = true;
    $('settings-submit').textContent = '正在保存…';
    try {
      state.settings = await api.saveSettings({
        hdcPath: $('setting-hdc').value.trim(), serverAddress: $('setting-server').value.trim(),
        defaultRemotePath: remotePath, downloadsPath: $('setting-downloads').value.trim(), terminalFontSize: fontSize, uiFontSize
      });
      state.app = await api.getState();
      state.settings = state.app.settings || state.settings;
      applyTypography();
      $('settings-dialog').close();
      renderEnvironment();
      toast('设置已保存');
      fitActiveTerminal();
      await pollDevices();
    } catch (error) { showError('settings-error', errorMessage(error)); }
    finally { state.settingsBusy = false; $('settings-submit').disabled = false; $('settings-submit').textContent = '保存设置'; }
  }

  function setupSplitter() {
    const handle = $('split-handle');
    const split = $('split-workspace');
    split.append(document.querySelector('.terminal-panel'), handle, document.querySelector('.files-panel'));
    let dragging = false;
    const setRatio = (ratio) => {
      const height = split.clientHeight;
      const lower = height ? Math.max(24, 160 / height * 100) : 30;
      const upper = height ? Math.min(78, (height - 224) / height * 100) : 70;
      document.documentElement.style.setProperty('--terminal-ratio', `${Math.max(lower, Math.min(upper, ratio))}%`);
      fitActiveTerminal();
    };
    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      dragging = true;
      handle.setPointerCapture(event.pointerId);
      document.body.classList.add('resizing');
    });
    handle.addEventListener('pointermove', (event) => {
      if (!dragging) return;
      const rect = $('split-workspace').getBoundingClientRect();
      setRatio((event.clientY - rect.top) / rect.height * 100);
    });
    const stop = () => { dragging = false; document.body.classList.remove('resizing'); };
    handle.addEventListener('pointerup', stop);
    handle.addEventListener('pointercancel', stop);
    handle.addEventListener('lostpointercapture', stop);
    handle.addEventListener('keydown', (event) => {
      if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return;
      event.preventDefault();
      const current = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--terminal-ratio')) || 57;
      setRatio(current + (event.key === 'ArrowUp' ? -3 : 3));
    });
    const observer = new ResizeObserver(() => requestAnimationFrame(fitActiveTerminal));
    observer.observe($('terminal-host'));
    state.unsubscribers.push(() => observer.disconnect());
  }

  function numberValue(value) {
    return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
  }

  function percentText(value) {
    const number = numberValue(value);
    return number === null ? '—' : `${number.toFixed(1)}%`;
  }

  function sampledTime(value) {
    if (typeof value === 'number') return value < 100000000000 ? value * 1000 : value;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : Date.now();
  }

  function syncMonitorWatch() {
    const desired = online() ? state.selectedId : null;
    if (desired === state.watchedId) return;
    state.watchedId = desired;
    if (desired) {
      const ds = deviceState(desired);
      ds.monitorRefreshing = new Set(['system', 'storage', 'npu']);
    }
    // Serialize switches so a slow previous IPC completion cannot restart an old device.
    state.watchChain = state.watchChain.catch(() => {}).then(() => {
      if (desired === state.watchedId) return api.watchDevice(desired);
    }).catch((error) => {
      if (desired) deviceState(desired).monitorRefreshing.clear();
      if (desired === state.watchedId) showError('monitor-error', errorMessage(error));
    });
    renderMonitor();
  }

  function handleMonitor(event) {
    if (!event || !state.deviceStates.has(event.deviceId)) return;
    if (!['system', 'storage', 'npu'].includes(event.kind)) return;
    const ds = deviceState(event.deviceId);
    const at = sampledTime(event.sampledAt);
    if (ds.monitor[event.kind]?.attemptAt > at) return;
    ds.monitorRefreshing.delete(event.kind);
    const hasData = event.data !== null && event.data !== undefined &&
      !(event.kind === 'npu' && event.error && event.data.available === false);
    if (event.kind === 'system' && hasData && ds.monitorBootId && event.data.bootId && ds.monitorBootId !== event.data.bootId) {
      // A new boot invalidates other subsystem snapshots and graph history.
      ds.monitor = {};
      ds.networkHistory.clear();
      if (event.deviceId === state.selectedId) {
        state.processSelection = null;
        state.processDetail = null;
        state.processDetailToken++;
      }
    }
    const previous = ds.monitor[event.kind];
    ds.monitor[event.kind] = {
      data: hasData ? event.data : previous?.data || null,
      dataAt: hasData ? sampledTime(event.sampledAt) : previous?.dataAt || null,
      attemptAt: sampledTime(event.sampledAt), error: event.error ? errorMessage(event.error) : '',
      failed: Boolean(event.error && !hasData)
    };
    if (event.kind === 'system' && hasData) {
      ds.monitorBootId = event.data.bootId || ds.monitorBootId;
      for (const network of event.data.network || []) {
        if (!ds.networkHistory.has(network.name)) ds.networkHistory.set(network.name, []);
        const history = ds.networkHistory.get(network.name);
        history.push({ rx: numberValue(network.rxPerSecond), tx: numberValue(network.txPerSecond), at: sampledTime(event.sampledAt) });
        if (history.length > 40) history.splice(0, history.length - 40);
      }
    }
    if (event.deviceId === state.selectedId) renderMonitor();
  }

  function monitorQuality(kind) {
    const record = deviceState()?.monitor[kind];
    const age = record?.dataAt ? Math.max(0, Date.now() - record.dataAt) : null;
    const stale = !online() || Boolean(record?.failed) || (age !== null && age > (kind === 'system' ? 12000 : 35000));
    let label = !state.selectedId ? '等待设备' : !online() ? '已断开' : !record?.data ? (record?.error ? '采样失败' : '等待采样') : record.failed ? '读取失败 · 旧数据' : stale ? '数据已过期' : `${Math.floor(age / 1000)} 秒前`;
    if (online() && record?.data && deviceState()?.monitorRefreshing.has(kind)) label = '上次状态 · 更新中';
    return { record, age, stale, label, data: record?.data || null };
  }

  function renderMonitorAges() {
    const system = monitorQuality('system');
    const npu = monitorQuality('npu');
    const storage = monitorQuality('storage');
    $('monitor-status').textContent = system.label;
    $('monitor-status').classList.toggle('stale', system.stale || Boolean(system.record?.error));
    $('monitor-status').title = system.record?.dataAt ? `上次成功采样：${new Date(system.record.dataAt).toLocaleString()}` : '';
    showError('monitor-error', system.record?.error || '');
    for (const id of ['monitor-system', 'monitor-processes', 'monitor-network']) $(id).classList.toggle('stale', system.stale);
    $('monitor-npu').classList.toggle('stale', npu.stale);
    $('monitor-storage').classList.toggle('stale', storage.stale);
    $('npu-sample-status').textContent = npu.data?.available && npu.record?.error && !npu.stale ? '部分可用' : npu.label;
    $('npu-sample-status').classList.toggle('stale', npu.stale || Boolean(npu.record?.error));
    $('storage-sample-status').textContent = storage.label;
    $('storage-sample-status').classList.toggle('stale', storage.stale);
    if ($('process-dialog').open) {
      $('process-sample-status').textContent = system.label;
      $('process-sample-status').classList.toggle('stale', system.stale);
      document.querySelector('.process-table-scroll').classList.toggle('stale', system.stale);
      renderProcessActions();
    }
    if ($('npu-dialog').open) $('npu-dialog-time').textContent = `${npu.label}${npu.stale && npu.data ? ' · 当前为上次采样内容' : ''}`;
  }

  function setMetric(textId, barId, value) {
    $(textId).textContent = percentText(value);
    const number = numberValue(value);
    $(barId).style.width = number === null ? '0' : `${Math.max(0, Math.min(100, number))}%`;
    $(barId).parentElement.classList.toggle('unknown', number === null);
  }

  function uptimeText(seconds) {
    const value = numberValue(seconds);
    if (value === null) return '—';
    const days = Math.floor(value / 86400);
    const hours = Math.floor(value % 86400 / 3600);
    const minutes = Math.floor(value % 3600 / 60);
    return `${days ? `${days}天 ` : ''}${hours}时 ${minutes}分`;
  }

  function renderMonitor() {
    const ds = deviceState();
    const scroll = $('monitor-sidebar').scrollTop;
    const system = ds?.monitor.system?.data;
    $('monitor-sidebar').classList.toggle('no-device', !state.selectedId);
    $('metric-uptime').textContent = uptimeText(system?.uptimeSeconds);
    $('metric-load').textContent = Array.isArray(system?.load) ? system.load.map((value) => numberValue(value) === null ? '—' : Number(value).toFixed(2)).join(' / ') : '—';
    $('metric-cores').textContent = numberValue(system?.cpu?.cores) === null ? '' : `${system.cpu.cores} 核`;
    setMetric('metric-cpu', 'metric-cpu-bar', system?.cpu?.percent);
    if (system && numberValue(system.cpu?.percent) === null) $('metric-cpu').textContent = '采样中';
    setMetric('metric-memory', 'metric-memory-bar', system?.memory?.percent);
    $('metric-memory-detail').textContent = system?.memory ? `${sizeText(system.memory.used)} / ${sizeText(system.memory.total)}` : '等待采样';
    setMetric('metric-swap', 'metric-swap-bar', system?.memory?.swapPercent);
    $('metric-swap-detail').textContent = system?.memory ? `${sizeText(system.memory.swapUsed)} / ${sizeText(system.memory.swapTotal)}` : '—';
    if (numberValue(system?.memory?.swapTotal) === 0) { $('metric-swap').textContent = '未启用'; $('metric-swap-detail').textContent = '系统未配置 Swap'; }
    renderTopProcesses();
    renderNetwork();
    renderNpuSummary();
    renderStorage();
    if ($('process-dialog').open) renderProcessTable();
    if ($('npu-dialog').open) renderNpuDialog();
    renderMonitorAges();
    $('monitor-sidebar').scrollTop = scroll;
  }

  function sortedProcesses(processes, sort = state.processSort) {
    return [...processes].sort((a, b) => {
      if (sort.key === 'name') return String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN', { numeric: true }) * sort.direction || a.pid - b.pid;
      const av = numberValue(a[sort.key]);
      const bv = numberValue(b[sort.key]);
      if (av === null && bv === null) return (Number(b.rssBytes) || 0) - (Number(a.rssBytes) || 0);
      if (av === null) return 1;
      if (bv === null) return -1;
      return (av - bv) * sort.direction || a.pid - b.pid;
    });
  }

  function sampledProcesses() {
    return deviceState()?.monitor.system?.data?.processes || [];
  }

  function renderTopProcesses() {
    const system = deviceState()?.monitor.system?.data;
    const processes = system?.processes || [];
    $('process-count').textContent = Array.isArray(system?.processes) ? `${processes.length} 个` : '';
    $('top-processes').replaceChildren();
    $('top-processes-empty').hidden = processes.length > 0;
    $('top-processes-empty').textContent = system ? '本次未获取到进程明细' : '等待设备采样';
    for (const process of sortedProcesses(processes, { key: 'cpuPercent', direction: -1 }).slice(0, 4)) {
      const row = element('tr');
      row.title = `${process.name} · PID ${process.pid}\nCPU 100% 表示一个核心`;
      const nameCell = element('td');
      const name = element('span', 'mini-process-name');
      name.append(element('small', '', process.pid), element('span', '', process.name));
      nameCell.append(name);
      row.append(nameCell, element('td', '', percentText(process.cpuPercent)), element('td', '', sizeText(process.rssBytes)));
      row.onclick = () => openProcesses(process);
      $('top-processes').append(row);
    }
  }

  function renderNetwork() {
    const ds = deviceState();
    const networks = ds?.monitor.system?.data?.network || [];
    const select = $('network-interface');
    const names = networks.map((network) => network.name);
    if (ds && !names.includes(ds.networkInterface)) ds.networkInterface = networks.find((network) => network.name !== 'lo')?.name || networks[0]?.name || '';
    if (Array.from(select.options).map((option) => option.value).join('\0') !== names.join('\0')) {
      select.replaceChildren();
      for (const network of networks) {
        const option = element('option', '', network.name);
        option.value = network.name;
        select.append(option);
      }
      if (!networks.length) { const option = element('option', '', '暂无网卡'); option.value = ''; select.append(option); }
    }
    select.value = ds?.networkInterface || '';
    select.disabled = !networks.length;
    const network = networks.find((item) => item.name === ds?.networkInterface);
    $('network-rx').textContent = numberValue(network?.rxPerSecond) === null ? '—' : `${sizeText(network.rxPerSecond)}/s`;
    $('network-tx').textContent = numberValue(network?.txPerSecond) === null ? '—' : `${sizeText(network.txPerSecond)}/s`;
    const history = ds?.networkHistory.get(network?.name) || [];
    const svg = $('network-sparkline');
    svg.replaceChildren();
    const values = history.flatMap((point) => [point.rx, point.tx]).filter((value) => value !== null);
    if (!values.length) {
      const message = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      message.setAttribute('x', '8'); message.setAttribute('y', '29'); message.setAttribute('class', 'chart-placeholder');
      message.textContent = networks.length ? '等待两次采样计算速率' : '暂无网卡数据';
      svg.append(message);
      $('network-chart-scale').textContent = '';
      return;
    }
    const peak = Math.max(...values);
    const scale = peak > 0 ? peak * 1.15 : 1;
    $('network-chart-scale').textContent = `${sizeText(peak)}/s`;
    for (const [field, color] of [['rx', '#709ee2'], ['tx', '#62ad97']]) {
      let segment = [];
      const drawSegment = () => {
        if (!segment.length) return;
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
        path.setAttribute('points', segment.join(' '));
        path.setAttribute('fill', 'none'); path.setAttribute('stroke', color); path.setAttribute('stroke-width', '1.4'); path.setAttribute('stroke-linejoin', 'round');
        svg.append(path);
        segment = [];
      };
      history.forEach((point, index) => {
        if (point[field] === null) { drawSegment(); return; }
        const x = 2 + index / Math.max(39, history.length - 1) * 226;
        const y = 45 - Math.max(0, point[field]) / scale * 42;
        segment.push(`${x.toFixed(2)},${y.toFixed(2)}`);
      });
      drawSegment();
    }
  }

  function renderNpuSummary() {
    const record = deviceState()?.monitor.npu;
    const npu = record?.data;
    const container = $('npu-summary');
    container.replaceChildren();
    if (npu?.available && npu.devices?.length) {
      for (const device of npu.devices) {
        const row = element('div', 'npu-mini');
        row.append(element('span', '', device.name || `NPU ${device.id ?? '—'}`));
        if (numberValue(device.utilization) !== null) row.append(element('strong', '', percentText(device.utilization)));
        container.append(row);
        const memory = numberValue(device.memoryUsed) === null || numberValue(device.memoryTotal) === null ? null : `内存 ${sizeText(device.memoryUsed)} / ${sizeText(device.memoryTotal)}`;
        const info = [memory, numberValue(device.temperature) !== null ? `${Number(device.temperature).toFixed(1)}℃` : null, numberValue(device.power) !== null ? `${Number(device.power).toFixed(1)}W` : null].filter(Boolean).join(' · ');
        if (info) container.append(element('div', 'npu-mini-memory', info));
      }
    }
    container.hidden = !container.childElementCount;
  }

  function renderStorage() {
    const record = deviceState()?.monitor.storage;
    const filesystems = (record?.data?.filesystems || []).filter((filesystem) => !filesystem.virtual);
    const container = $('storage-list');
    container.replaceChildren();
    if (!filesystems.length) {
      container.append(element('span', 'monitor-placeholder', record?.error || (record?.data ? '未获取到磁盘容量信息' : '等待设备采样')));
      return;
    }
    if (record?.error) container.append(element('div', 'npu-reason', record.error));
    for (const disk of filesystems) {
      const item = element('button', 'storage-item');
      item.disabled = !online();
      item.title = `${disk.mount}\n${disk.device || ''}\n可用 ${sizeText(disk.available)} / 总容量 ${sizeText(disk.total)}\n点击浏览此目录`;
      const heading = element('div');
      heading.append(element('span', 'storage-mount', disk.mount), element('span', 'storage-size', `${sizeText(disk.available)} / ${sizeText(disk.total)}`));
      const bar = element('div', `metric-track${numberValue(disk.percent) === null ? ' unknown' : ''}`);
      const fill = element('span');
      fill.style.width = numberValue(disk.percent) === null ? '0' : `${Math.max(0, Math.min(100, Number(disk.percent)))}%`;
      bar.append(fill); item.append(heading, bar);
      const deviceId = state.selectedId;
      item.onclick = () => navigateToPath(deviceId, disk.mount);
      container.append(item);
    }
  }

  async function navigateToPath(deviceId, path, selectPath) {
    if (!online(deviceId)) { toast('设备当前未连接。', 'error'); return; }
    if (deviceId !== state.selectedId) selectDevice(deviceId);
    const ds = deviceState(deviceId);
    if (ds.loading || ds.operation) { toast('当前文件操作尚未完成，请稍后再打开目录。', 'error'); return; }
    await loadDirectory(deviceId, path);
    if (selectPath && state.selectedId === deviceId && !ds.error) {
      ds.selected = new Set(ds.entries.filter((entry) => entry.path === selectPath).map((entry) => entry.path));
      renderSelection();
    }
  }

  function sameProcess(a, b) {
    return Boolean(a && b && Number(a.pid) === Number(b.pid) && String(a.startTime) === String(b.startTime));
  }

  function selectedProcessAlive() {
    return sampledProcesses().some((process) => sameProcess(process, state.processSelection));
  }

  function openProcesses(process) {
    if (!online()) return;
    state.processDeviceId = state.selectedId;
    $('process-device-title').textContent = displayName(deviceInfo());
    $('process-search').value = state.processQuery;
    if (!$('process-dialog').open) $('process-dialog').showModal();
    renderProcessTable();
    renderMonitorAges();
    if (process) selectProcess(process);
    else renderProcessDetail();
  }

  function renderProcessTable() {
    if (state.processDeviceId !== state.selectedId) return;
    const query = state.processQuery.toLocaleLowerCase();
    const all = sampledProcesses();
    const processes = sortedProcesses(all.filter((process) => !query || String(process.pid).includes(query) || String(process.name).toLocaleLowerCase().includes(query)));
    const tbody = $('process-table-body');
    const scroll = tbody.parentElement.parentElement.scrollTop;
    tbody.replaceChildren();
    for (const process of processes) {
      const row = element('tr', sameProcess(process, state.processSelection) ? 'selected' : '');
      row.setAttribute('aria-selected', String(sameProcess(process, state.processSelection)));
      row.title = `${process.name}\nPID ${process.pid} · CPU 100% 表示一个核心`;
      row.append(element('td', '', process.pid), element('td', '', process.name), element('td', '', percentText(process.cpuPercent)), element('td', '', sizeText(process.rssBytes)), element('td', '', process.state ?? '—'), element('td', '', process.threads ?? '—'));
      row.onclick = () => selectProcess(process);
      tbody.append(row);
    }
    tbody.parentElement.parentElement.scrollTop = scroll;
    $('process-list-count').textContent = `${processes.length} / ${all.length} 个进程`;
    $('process-table-empty').hidden = processes.length > 0;
    $('process-table-empty').textContent = query ? '没有匹配的进程' : '本次采样未提供进程明细';
    for (const button of document.querySelectorAll('[data-process-sort]')) {
      const active = button.dataset.processSort === state.processSort.key;
      button.classList.toggle('active', active);
      button.querySelector('span').textContent = active ? state.processSort.direction === -1 ? '↓' : '↑' : '';
    }
    if (state.processSelection && !selectedProcessAlive()) {
      $('process-detail-state').textContent = '此进程已不在最新采样中';
    } else if (state.processDetail) {
      $('process-detail-state').textContent = `PID ${state.processDetail.pid} · ${state.processDetail.state ?? '—'}`;
    }
    renderProcessActions();
  }

  async function selectProcess(process) {
    const deviceId = state.processDeviceId;
    if (!online(deviceId) || deviceId !== state.selectedId) return;
    state.processSelection = { ...process };
    state.processDetail = null;
    state.processLoading = true;
    const token = ++state.processDetailToken;
    showError('process-detail-error', '');
    renderProcessTable();
    renderProcessDetail();
    try {
      const detail = await api.getProcessDetail({ deviceId, pid: process.pid, startTime: String(process.startTime) });
      if (token !== state.processDetailToken || deviceId !== state.selectedId) return;
      state.processDetail = detail;
    } catch (error) {
      if (token === state.processDetailToken) showError('process-detail-error', errorMessage(error));
    } finally {
      if (token === state.processDetailToken) { state.processLoading = false; renderProcessDetail(); }
    }
  }

  function renderProcessDetail() {
    const detail = state.processDetail;
    const selected = state.processSelection;
    const container = $('process-detail-content');
    container.replaceChildren();
    $('process-detail-title').textContent = selected?.name || '选择一个进程';
    $('process-detail-state').textContent = selected ? `PID ${selected.pid}${state.processLoading ? ' · 正在读取…' : ''}` : '';
    if (!detail) {
      container.append(element('p', 'detail-placeholder', state.processLoading ? '正在读取进程的运行信息…' : selected ? '暂无进程详情，可重新读取。' : '单击进程，查看运行位置、命令行和详细状态。'));
      renderProcessActions();
      return;
    }
    const fields = element('dl', 'process-detail-fields');
    const pairs = [['名称', detail.name], ['PID', detail.pid], ['父进程', detail.ppid], ['用户', detail.uid], ['组', detail.gid], ['状态', detail.state], ['线程', detail.threads], ['优先级', detail.nice], ['内存', sizeText(detail.rssBytes)], ['程序', detail.exe], ['目录', detail.cwd]];
    for (const [label, value] of pairs) {
      const row = element('div');
      row.append(element('dt', '', label), element('dd', '', value === null || value === undefined || value === '' ? '未提供' : value));
      fields.append(row);
    }
    container.append(fields, element('h4', '', '命令行'), element('pre', '', Array.isArray(detail.cmdline) ? detail.cmdline.join(' ') : detail.cmdline || '未提供命令行'));
    const raw = element('details');
    raw.append(element('summary', '', '完整状态信息'), element('pre', '', detail.status || '未提供状态信息'));
    container.append(raw);
    $('process-detail-state').textContent = selectedProcessAlive() ? `PID ${detail.pid} · ${detail.state ?? '—'}` : '此进程已不在最新采样中';
    renderProcessActions();
  }

  function renderProcessActions() {
    const fresh = !monitorQuality('system').stale;
    const valid = state.processDeviceId === state.selectedId && online() && selectedProcessAlive() && fresh;
    const ready = valid && !state.processLoading && !state.processSignalBusy;
    $('process-term').disabled = !ready || !state.processDetail;
    $('process-kill').disabled = !ready || !state.processDetail;
    $('process-open-exe').disabled = !online(state.processDeviceId) || !state.processDetail?.exe?.startsWith('/');
    $('process-open-cwd').disabled = !online(state.processDeviceId) || !state.processDetail?.cwd?.startsWith('/');
    $('process-refresh-detail').disabled = !valid || state.processLoading || state.processSignalBusy;
  }

  async function sendProcessSignal(signal) {
    const process = state.processSelection;
    const deviceId = state.processDeviceId;
    if (!process || !selectedProcessAlive() || state.processSignalBusy || monitorQuality('system').stale || !online(deviceId)) return;
    state.processSignalBusy = true;
    renderProcessActions();
    try {
      const result = await api.signalProcess({ deviceId, pid: process.pid, startTime: String(process.startTime), signal });
      if (result?.sent) toast(`${signal} 信号已发送给 PID ${process.pid}。进程状态以设备后续采样为准。`);
    } catch (error) {
      showError('process-detail-error', errorMessage(error));
    } finally {
      state.processSignalBusy = false;
      renderProcessActions();
    }
  }

  function openNpu() {
    $('npu-device-title').textContent = displayName(deviceInfo());
    renderNpuDialog();
    if (!$('npu-dialog').open) $('npu-dialog').showModal();
    renderMonitorAges();
  }

  function renderNpuDialog() {
    const quality = monitorQuality('npu');
    const npu = quality.data;
    $('npu-dialog-status').textContent = npu?.reason || quality.record?.error || (npu?.available ? '以下为设备工具提供的实际数据。未提供的字段显示为“—”。' : '尚未获取到 NPU 数据。');
    $('npu-device-table').replaceChildren();
    $('npu-process-table').replaceChildren();
    const devices = npu?.devices || [];
    const processes = npu?.processes || [];
    for (const device of devices) {
      const row = element('tr');
      row.append(element('td', '', `${device.id ?? '—'} / ${device.chipId ?? '—'}`), element('td', '', device.name || '—'), element('td', '', device.health ?? '—'), element('td', '', percentText(device.utilization)), element('td', '', `${sizeText(device.memoryUsed)} / ${sizeText(device.memoryTotal)}`), element('td', '', numberValue(device.temperature) === null ? '—' : `${Number(device.temperature).toFixed(1)}℃`), element('td', '', numberValue(device.power) === null ? '—' : `${Number(device.power).toFixed(1)}W`));
      $('npu-device-table').append(row);
    }
    for (const process of processes) {
      const row = element('tr');
      row.append(element('td', '', process.pid ?? '—'), element('td', '', process.name || '—'), element('td', '', `${process.deviceId ?? '—'} / ${process.chipId ?? '—'}`), element('td', '', sizeText(process.memoryUsed)));
      const action = element('td');
      const button = element('button', 'text-button', '查看进程');
      const sampled = sampledProcesses().find((item) => Number(item.pid) === Number(process.pid));
      button.disabled = !sampled || !online();
      button.onclick = () => { $('npu-dialog').close(); openProcesses(sampled); };
      action.append(button); row.append(action); $('npu-process-table').append(row);
    }
    $('npu-devices-empty').hidden = devices.length > 0;
    $('npu-devices-empty').textContent = npu?.available ? '设备工具未提供设备明细' : npu?.reason || 'NPU 设备信息暂不可用';
    $('npu-processes-empty').hidden = processes.length > 0;
    $('npu-processes-empty').textContent = '未获取到 NPU 进程明细；这不代表没有进程在使用 NPU。';
    $('npu-raw-output').textContent = npu?.raw || '暂无原始输出';
    $('npu-dialog-time').textContent = `${quality.label}${npu?.tool ? ` · ${npu.tool}` : ''}`;
  }

  async function openAnalysis(deviceId = state.selectedId, path = deviceState()?.path) {
    if (!online(deviceId) || !path) return;
    if (state.analysis?.loading) {
      if (state.analysis.deviceId !== deviceId || state.analysis.path !== path) toast('上一次目录分析仍在进行，请等待结果后再扫描其他目录。', 'error');
      if (!$('analysis-dialog').open) $('analysis-dialog').showModal();
      return;
    }
    const token = ++state.analysisToken;
    state.analysis = { deviceId, path, loading: true, result: null, error: '' };
    renderAnalysis();
    if (!$('analysis-dialog').open) $('analysis-dialog').showModal();
    try {
      const result = await api.analyzeDirectory({ deviceId, path });
      if (token === state.analysisToken) state.analysis.result = result;
    } catch (error) {
      if (token === state.analysisToken) state.analysis.error = errorMessage(error);
    } finally {
      if (token === state.analysisToken) { state.analysis.loading = false; renderAnalysis(); }
    }
  }

  function renderAnalysis() {
    const analysis = state.analysis;
    if (!analysis) return;
    $('analysis-title').textContent = analysis.path;
    $('analysis-meta').textContent = `${displayName(deviceInfo(analysis.deviceId))} · ${analysis.deviceId}`;
    $('analysis-table-body').replaceChildren();
    $('analysis-refresh').disabled = analysis.loading || !online(analysis.deviceId);
    const entries = analysis.result?.entries || [];
    $('analysis-empty').hidden = !analysis.loading && !analysis.error && entries.length > 0;
    $('analysis-empty').replaceChildren();
    if (analysis.loading) $('analysis-empty').append(element('span', 'spinner'), document.createTextNode('正在读取目录占用，大目录可能需要一些时间…'));
    else $('analysis-empty').textContent = analysis.error || '这个目录没有可显示的条目';
    const partial = analysis.result?.partial || entries.some((entry) => entry.warning || numberValue(entry.bytes) === null);
    $('analysis-notice').classList.toggle('warning', Boolean(partial || analysis.error));
    $('analysis-notice').textContent = analysis.error ? '分析未完成，未显示任何估算值。' : partial ? (analysis.result?.warning || '部分条目因权限或读取限制未能完整统计，未知占用显示为“—”。') : '按需扫描结果。点击条目右侧可进入目录或在文件管理器中定位。';
    let total = 0;
    for (const entry of [...entries].sort((a, b) => {
      const av = numberValue(a.bytes); const bv = numberValue(b.bytes);
      return av === null ? 1 : bv === null ? -1 : bv - av;
    })) {
      if (numberValue(entry.bytes) !== null) total += Number(entry.bytes);
      const row = element('tr');
      const name = element('td', '', entry.name || basename(entry.path));
      if (entry.warning) name.append(element('span', 'analysis-entry-warning', entry.warning));
      row.append(name, element('td', '', sizeText(entry.bytes)));
      const actions = element('td');
      if (entry.type === 'directory' || !entry.type) {
        const enter = element('button', 'text-button', entry.type === 'directory' ? '进入目录' : '尝试进入');
        enter.onclick = () => { $('analysis-dialog').close(); navigateToPath(analysis.deviceId, entry.path); };
        actions.append(enter);
      }
      const locate = element('button', 'text-button', '定位');
      locate.onclick = () => { $('analysis-dialog').close(); navigateToPath(analysis.deviceId, parentPath(entry.path), entry.path); };
      actions.append(locate); row.append(actions); $('analysis-table-body').append(row);
    }
    $('analysis-summary').textContent = analysis.loading ? '扫描中…' : analysis.error ? '读取失败' : `${entries.length} 个条目 · 已统计 ${sizeText(total)}${partial ? '（不完整）' : ''}`;
  }

  function wireMonitorEvents() {
    $('network-interface').onchange = () => { const ds = deviceState(); if (ds) { ds.networkInterface = $('network-interface').value; renderNetwork(); } };
    $('open-processes').onclick = () => openProcesses();
    $('open-npu').onclick = openNpu;
    $('process-search').oninput = () => { state.processQuery = $('process-search').value; renderProcessTable(); };
    for (const button of document.querySelectorAll('[data-process-sort]')) button.onclick = () => {
      const key = button.dataset.processSort;
      state.processSort = { key, direction: state.processSort.key === key ? -state.processSort.direction : ['pid', 'name'].includes(key) ? 1 : -1 };
      renderProcessTable();
    };
    $('process-term').onclick = () => sendProcessSignal('TERM');
    $('process-kill').onclick = () => sendProcessSignal('KILL');
    $('process-refresh-detail').onclick = () => { if (state.processSelection) selectProcess(state.processSelection); };
    $('process-open-exe').onclick = () => {
      const path = state.processDetail?.exe;
      const id = state.processDeviceId;
      if (!path) return;
      $('process-dialog').close();
      navigateToPath(id, parentPath(path), path);
    };
    $('process-open-cwd').onclick = () => {
      const path = state.processDetail?.cwd;
      const id = state.processDeviceId;
      if (!path) return;
      $('process-dialog').close();
      navigateToPath(id, path);
    };
    $('process-dialog').addEventListener('close', () => { state.processDetailToken++; state.processLoading = false; });
    $('analyze-directory').onclick = () => openAnalysis();
    $('analysis-refresh').onclick = () => { if (state.analysis) openAnalysis(state.analysis.deviceId, state.analysis.path); };
    // This timer updates age labels only. All sampling is owned by DeviceMonitor in main.
    state.monitorTimer = setInterval(renderMonitorAges, 1000);
    renderMonitor();
  }

  function wireEvents() {
    $('file-table-container').addEventListener('scroll', () => {
      const ds = deviceState();
      if (ds) ds.fileScrollTop = $('file-table-container').scrollTop;
    }, { passive: true });
    $('monitor-sidebar').addEventListener('scroll', () => {
      const ds = deviceState();
      if (ds) ds.monitorScrollTop = $('monitor-sidebar').scrollTop;
    }, { passive: true });
    $('refresh-devices').onclick = () => pollDevices(true);
    $('offline-refresh').onclick = () => pollDevices(true);
    $('connect-button').onclick = openConnect;
    $('welcome-connect').onclick = openConnect;
    $('connect-form').onsubmit = submitConnect;
    $('settings-button').onclick = openSettings;
    $('environment-settings').onclick = openSettings;
    $('settings-form').onsubmit = saveSettings;
    $('device-name-form').onsubmit = saveDeviceName;
    $('sidebar-toggle').onclick = () => {
      const collapsed = $('app-shell').classList.toggle('sidebar-collapsed');
      $('sidebar-toggle').setAttribute('aria-expanded', String(!collapsed));
      $('sidebar-toggle').title = collapsed ? '展开设备栏' : '折叠设备栏';
      $('sidebar-toggle').setAttribute('aria-label', $('sidebar-toggle').title);
      requestAnimationFrame(fitActiveTerminal);
    };
    for (const button of document.querySelectorAll('[data-close-dialog]')) button.onclick = () => button.closest('dialog')?.close();
    $('preview-dialog').addEventListener('close', () => state.previewToken++);
    $('input-form').onsubmit = submitInput;
    $('path-form').onsubmit = (event) => {
      event.preventDefault();
      const path = $('remote-path').value.trim();
      if (!path.startsWith('/')) { toast('请输入以 / 开头的远程绝对路径。', 'error'); return; }
      loadDirectory(state.selectedId, path);
    };
    $('parent-directory').onclick = () => { const ds = deviceState(); if (ds) loadDirectory(state.selectedId, parentPath(ds.path)); };
    $('refresh-files').onclick = refreshFiles;
    $('retry-files').onclick = refreshFiles;
    $('file-search').oninput = () => { const ds = deviceState(); if (ds) { ds.query = $('file-search').value; renderFiles(); } };
    $('show-hidden').onchange = () => { const ds = deviceState(); if (ds) { ds.showHidden = $('show-hidden').checked; renderFiles(); } };
    $('select-all-files').onchange = () => {
      const ds = deviceState();
      if (!ds) return;
      const checked = $('select-all-files').checked;
      for (const entry of visibleEntries(ds)) { if (checked) ds.selected.add(entry.path); else ds.selected.delete(entry.path); }
      renderSelection();
    };
    $('upload-files').onclick = () => queueUpload('files');
    $('upload-directory').onclick = () => queueUpload('directory');
    $('download-files').onclick = queueDownload;
    $('create-directory').onclick = () => beginInput('create');
    $('rename-file').onclick = () => beginInput('rename');
    $('preview-file').onclick = () => previewFile();
    $('delete-files').onclick = () => {
      const paths = selectedEntries().map((entry) => entry.path);
      if (!paths.length) return;
      // The main process owns the native confirmation and exact target display.
      withFileOperation((deviceId) => api.deletePaths({ deviceId, paths }), '删除操作已完成');
    };
    $('file-table-container').addEventListener('keydown', (event) => {
      if (event.target.tagName === 'INPUT') return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
        event.preventDefault();
        const ds = deviceState();
        if (ds) { ds.selected = new Set(visibleEntries(ds).map((entry) => entry.path)); renderSelection(); }
      } else if (event.key === 'Enter') {
        const entries = selectedEntries();
        if (entries.length === 1) { event.preventDefault(); openEntry(entries[0]); }
      } else if (event.key === 'F2' && !$('rename-file').disabled) {
        event.preventDefault(); beginInput('rename');
      } else if (event.key === 'Delete' && !$('delete-files').disabled) {
        event.preventDefault(); $('delete-files').click();
      }
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'F5' && !document.querySelector('dialog[open]')) { event.preventDefault(); refreshFiles(); }
      if (event.key === 'Escape') $('quick-menu').open = false;
    });
    document.addEventListener('click', (event) => { if (!$('quick-menu').contains(event.target)) $('quick-menu').open = false; });
    for (const button of document.querySelectorAll('[data-quick]')) button.onclick = () => runQuick(button.dataset.quick);
    $('reboot-button').onclick = async () => {
      const id = state.selectedId;
      if (!online(id) || state.quickBusy.has(id)) return;
      state.quickBusy.add(id);
      renderAvailability();
      try {
        const result = await api.rebootDevice(id);
        if (result && result !== '已取消') toast('重启请求已发送');
        await pollDevices();
      } catch (error) { toast(errorMessage(error), 'error'); }
      finally { state.quickBusy.delete(id); renderAvailability(); }
    };
    $('disconnect-button').onclick = async () => {
      const id = state.selectedId;
      if (!online(id)) return;
      $('disconnect-button').disabled = true;
      try { await api.disconnectDevice(id); await pollDevices(); toast('网络设备已断开'); }
      catch (error) { toast(errorMessage(error), 'error'); }
      finally { $('disconnect-button').disabled = false; }
    };
    $('new-terminal').onclick = () => createTerminal();
    $('terminal-empty-open').onclick = () => createTerminal();
    $('terminal-reconnect').onclick = reconnectTerminal;
    $('terminal-copy').onclick = () => copyText(activeTerminal()?.terminal.getSelection());
    $('terminal-paste').onclick = () => pasteTerminal();
    $('terminal-clear').onclick = () => { const entry = activeTerminal(); if (entry) { entry.terminal.clear(); entry.terminal.focus(); } };
    $('terminal-save').onclick = saveTerminal;
    $('transfers-toggle').onclick = () => setDrawerOpen(!state.drawerOpen);
    $('close-transfers').onclick = () => setDrawerOpen(false);
    $('open-downloads').onclick = () => Promise.resolve(api.openDownloads()).catch((error) => toast(errorMessage(error), 'error'));
    $('preview-copy').onclick = () => copyText(state.previewText);
    $('preview-save').onclick = async () => {
      try { const path = await api.saveText({ name: state.previewName, text: state.previewText }); if (path) toast(`文本已保存到 ${path}`); }
      catch (error) { toast(errorMessage(error), 'error'); }
    };
    $('choose-hdc').onclick = async () => {
      try { const path = await api.chooseHdc(); if (path) $('setting-hdc').value = path; }
      catch (error) { showError('settings-error', errorMessage(error)); }
    };
    $('choose-downloads').onclick = async () => {
      try { const path = await api.chooseDownloads(); if (path) $('setting-downloads').value = path; }
      catch (error) { showError('settings-error', errorMessage(error)); }
    };
    $('setting-font').oninput = () => { const size = Number($('setting-font').value); if (size >= 10 && size <= 28) $('font-example').style.fontSize = `${size}px`; };
    $('setting-ui-font').oninput = () => { const size = Number($('setting-ui-font').value); if (size >= 13 && size <= 18) $('ui-font-example').style.fontSize = `${size}px`; };
    wireMonitorEvents();
    setupSplitter();
  }

  async function initialize() {
    if (!api) {
      $('welcome-title').textContent = '应用初始化失败';
      $('welcome-description').textContent = '设备服务未能加载，请关闭窗口后重新启动 HDC Studio。';
      $('status-message').textContent = '设备服务不可用';
      return;
    }
    // Terminal data can arrive before openTerminal resolves, so subscribe first.
    for (const unsubscribe of [api.onTerminalData(handleTerminalData), api.onTerminalExit(handleTerminalExit), api.onTransfers(updateTransfers), api.onMonitor(handleMonitor)]) {
      if (typeof unsubscribe === 'function') state.unsubscribers.push(unsubscribe);
    }
    wireEvents();
    try {
      state.app = await api.getState();
      state.settings = state.app.settings || {};
      applyTypography();
      renderEnvironment();
    } catch (error) {
      showError('environment-message', errorMessage(error));
      $('environment-banner').hidden = false;
      toast(errorMessage(error), 'error');
    }
    try { updateTransfers(await api.getTransfers()); }
    catch (error) { toast(`读取传输任务失败：${errorMessage(error)}`, 'error'); }
    state.initialized = true;
    await pollDevices();
  }

  window.addEventListener('beforeunload', () => {
    state.disposed = true;
    clearTimeout(state.pollTimer);
    clearInterval(state.monitorTimer);
    for (const unsubscribe of state.unsubscribers) { try { unsubscribe(); } catch (error) { /* Window is closing. */ } }
  });

  initialize().catch((error) => {
    $('welcome-title').textContent = '初始化未完成';
    $('welcome-description').textContent = errorMessage(error);
    $('status-message').textContent = '请重新启动应用';
    toast(errorMessage(error), 'error');
  });
})();
