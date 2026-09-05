'use strict';

const { EventEmitter } = require('node:events');
const { shellQuote } = require('./hdc');

const INTERVALS = { system: 3000, storage: 10000, npu: 10000 };
const SYSTEM_COMMAND = String.raw`
_hdcm_emit_file() {
  _hdcm_value=
  IFS= read -r -d '' _hdcm_value 2>/dev/null < "$2"
  printf '%s\0%s\0' "$1" "$_hdcm_value"
}
_hdcm_emit_file boot /proc/sys/kernel/random/boot_id
_hdcm_emit_file uptime /proc/uptime
_hdcm_emit_file load /proc/loadavg
_hdcm_emit_file cpu /proc/stat
_hdcm_emit_file memory /proc/meminfo
_hdcm_emit_file network /proc/net/dev
_hdcm_hz=$(getconf CLK_TCK 2>/dev/null)
_hdcm_page=$(getconf PAGESIZE 2>/dev/null)
printf 'clock\0%s\0page\0%s\0' "$_hdcm_hz" "$_hdcm_page"
for _hdcm_file in /proc/[0-9]*/stat; do
  _hdcm_value=
  IFS= read -r -d '' _hdcm_value 2>/dev/null < "$_hdcm_file"
  [ -n "$_hdcm_value" ] && printf 'process\0%s\0' "$_hdcm_value"
done
printf 'done\0ok\0'
`;

const STORAGE_COMMAND = String.raw`
printf 'mounts\0'
cat /proc/mounts || exit $?
printf '\0df\0'
df -Pk || exit $?
printf '\0'
`;

const NPU_DISCOVERY = String.raw`
_hdcm_tool=$(command -v npu-smi 2>/dev/null)
if [ -n "$_hdcm_tool" ] && [ -x "$_hdcm_tool" ]; then
  printf '%s' "$_hdcm_tool"
  exit 0
fi
for _hdcm_tool in /usr/local/sbin/npu-smi /usr/sbin/npu-smi /usr/local/bin/npu-smi /usr/bin/npu-smi /var/davinci/npu-smi /var/davinci/driver/tools/npu-smi /usr/local/Ascend/driver/tools/npu-smi /system/bin/npu-smi /vendor/bin/npu-smi; do
  if [ -f "$_hdcm_tool" ] && [ -x "$_hdcm_tool" ]; then
    printf '%s' "$_hdcm_tool"
    exit 0
  fi
done
printf '%s' '__NO_NPU_SMI__'
`;

function numeric(value) {
  if (value === undefined || value === null || !String(value).trim() || !/^-?\d+(?:\.\d+)?$/.test(String(value).trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function nonnegative(value) {
  const number = numeric(value);
  return number !== null && number >= 0 ? number : null;
}

function percent(used, total) {
  return used !== null && total !== null && total > 0 ? Math.min(100, Math.max(0, used / total * 100)) : null;
}

function pairs(text) {
  const fields = text.split('\0');
  if (fields.pop() !== '' || fields.length % 2) throw new Error('监视数据不完整');
  const values = new Map();
  const processes = [];
  for (let i = 0; i < fields.length; i += 2) {
    if (fields[i] === 'process') processes.push(fields[i + 1]);
    else values.set(fields[i], fields[i + 1]);
  }
  return { values, processes };
}

function parseProcess(record, pageSize) {
  // comm (field 2) may contain spaces, parentheses and newlines. The final
  // ") state " boundary, rather than whitespace splitting, locates field 3.
  const match = record.trimEnd().match(/^(\d+) \(([\s\S]*)\) ([A-Za-z]) (.*)$/);
  if (!match) return null;
  const fields = `${match[3]} ${match[4]}`.split(/\s+/);
  if (fields.length < 22 || !/^\d+$/.test(fields[19])) return null;
  const user = nonnegative(fields[11]);
  const kernel = nonnegative(fields[12]);
  const rss = nonnegative(fields[21]);
  return {
    pid: Number(match[1]), ppid: nonnegative(fields[1]), name: match[2], state: fields[0],
    cpuPercent: null, rssBytes: rss !== null && pageSize !== null ? rss * pageSize : null,
    threads: nonnegative(fields[17]), nice: numeric(fields[16]), startTime: fields[19],
    ticks: user !== null && kernel !== null ? user + kernel : null,
  };
}

function parseNetwork(text) {
  const entries = [];
  for (const line of text.split('\n')) {
    const match = line.match(/^\s*([^:]+):\s*(.*)$/);
    if (!match) continue;
    const fields = match[2].trim().split(/\s+/);
    const rxBytes = nonnegative(fields[0]);
    const txBytes = nonnegative(fields[8]);
    if (fields.length < 16 || rxBytes === null || txBytes === null) continue;
    entries.push({ name: match[1].trim(), rxBytes, txBytes, rxPerSecond: null, txPerSecond: null });
  }
  return entries;
}

function parseMemory(text) {
  const entries = new Map();
  for (const match of text.matchAll(/^([A-Za-z_()]+):\s+(\d+)(?:\s+(kB))?/gm)) {
    entries.set(match[1], Number(match[2]) * (match[3] ? 1024 : 1));
  }
  const get = name => entries.has(name) ? entries.get(name) : null;
  const total = get('MemTotal');
  const available = get('MemAvailable');
  const used = total !== null && available !== null ? Math.max(0, total - available) : null;
  const swapTotal = get('SwapTotal');
  const swapFree = get('SwapFree');
  const swapUsed = swapTotal !== null && swapFree !== null ? Math.max(0, swapTotal - swapFree) : null;
  return { total, available, used, percent: percent(used, total), swapTotal, swapUsed,
    swapPercent: swapTotal === 0 && swapUsed === 0 ? 0 : percent(swapUsed, swapTotal) };
}

function unescapeMount(value) {
  return value.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
}

function parseStorage(text) {
  const { values } = pairs(text);
  const mounts = new Map();
  for (const line of (values.get('mounts') || '').split('\n')) {
    const fields = line.split(/\s+/);
    if (fields.length >= 3) mounts.set(unescapeMount(fields[1]), fields[2]);
  }
  const virtualTypes = /^(?:tmpfs|devtmpfs|proc|sysfs|devpts|selinuxfs|debugfs|tracefs|configfs|securityfs|pstore|cgroup2?|bpf|mqueue|ramfs|fusectl|hmdfs|overlay)$/;
  const filesystems = [];
  for (const line of (values.get('df') || '').split('\n')) {
    const match = line.match(/^\s*(.+?)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s+(.+?)\s*$/);
    if (!match) continue;
    const mount = unescapeMount(match[6]);
    const device = unescapeMount(match[1]);
    const type = mounts.get(mount) || '';
    filesystems.push({ device, mount, total: Number(match[2]) * 1024, used: Number(match[3]) * 1024,
      available: Number(match[4]) * 1024, percent: Number(match[5]), virtual: virtualTypes.test(type) || virtualTypes.test(device) });
  }
  if (!filesystems.length) throw new Error('df 没有返回可识别的文件系统空间信息');
  return { filesystems };
}

function parseNpuTable(raw) {
  const devices = [];
  const processes = [];
  const warnings = [];
  let pending = null;
  let inProcesses = false;
  let processTableSeen = false;
  for (const line of raw.split('\n')) {
    if (!line.trim().startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map(cell => cell.trim());
    if (cells.some(cell => /Process\s+(?:id|name|memory)/i.test(cell))) {
      inProcesses = true; processTableSeen = true; continue;
    }
    if (inProcesses) {
      if (/No running processes/i.test(line)) continue;
      const identity = cells[0]?.match(/^(\d+)\s+(\d+)$/);
      const pid = nonnegative(cells[1]);
      if (identity && pid !== null && cells.length >= 4) {
        const memory = nonnegative(cells[3]);
        processes.push({ pid, name: cells[2] || null, memoryUsed: memory === null ? null : memory * 1024 * 1024,
          deviceId: identity[1], chipId: identity[2] });
      }
      continue;
    }
    if (cells.length < 3) continue;
    const identity = cells[0].match(/^(\d+)\s+([A-Za-z0-9_.-]*[A-Za-z][A-Za-z0-9_. -]*)$/);
    if (identity) {
      const powerTemperature = cells[2].split(/\s+/);
      pending = { id: identity[1], chipId: null, name: identity[2],
        health: /^(?:NA|N\/A|-)$/i.test(cells[1]) ? null : cells[1] || null,
        utilization: null, memoryUsed: null, memoryTotal: null,
        temperature: numeric(powerTemperature[1]), power: nonnegative(powerTemperature[0]) };
      continue;
    }
    const chip = cells[0].match(/^(\d+)(?:\s+\d+)?$/);
    if (pending && chip) {
      const numbers = cells[2].match(/^(\S+)\s+(\S+)\s*\/\s*(\S+)/);
      pending.chipId = chip[1];
      pending.utilization = numbers ? nonnegative(numbers[1]) : nonnegative(cells[2].split(/\s+/)[0]);
      const used = numbers ? nonnegative(numbers[2]) : null;
      const total = numbers ? nonnegative(numbers[3]) : null;
      // Some 310B driver builds print 0/0 despite reporting a DSMI memory error.
      // A zero capacity is unavailable telemetry, not healthy zero usage.
      if (total !== null && total > 0 && used !== null && used <= total) {
        pending.memoryUsed = used * 1024 * 1024; pending.memoryTotal = total * 1024 * 1024;
      }
      devices.push(pending); pending = null;
    }
  }
  if (pending) devices.push(pending);
  const errorLines = raw.split('\n').filter(line => /\[ERROR\]|\[Fail\]|call error|failed|not support/i.test(line));
  if (errorLines.some(line => /memory/i.test(line))) {
    for (const device of devices) { device.memoryUsed = null; device.memoryTotal = null; }
    warnings.push('NPU 驱动未能读取内存指标');
  }
  if (errorLines.some(line => /aicore|utilization|usage rate/i.test(line))) {
    for (const device of devices) device.utilization = null;
  }
  if (errorLines.length && !warnings.length) warnings.push('NPU 工具报告了错误，请查看原始输出');
  if (devices.some(device => device.memoryTotal === null) && !warnings.length) warnings.push('NPU 内存指标不可用');
  return { devices, processes, warnings, processTableSeen };
}

function parseNpuProcesses(raw, deviceId) {
  const processes = [];
  const table = parseNpuTable(raw);
  if (table.processTableSeen) return { processes: table.processes, supported: true };
  if (/not support|not supported|invalid|usage:|\[ERROR\]|failed/i.test(raw)) {
    return { processes, supported: false, reason: /not support/i.test(raw) ? '当前 NPU 驱动不支持查询进程占用' : 'NPU 进程查询失败' };
  }
  let chipId = null;
  let current = null;
  for (const line of raw.split('\n')) {
    const field = line.match(/^\s*([^:]+?)\s*:\s*(.*?)\s*$/);
    if (!field) continue;
    const key = field[1].trim();
    if (/^Chip ID$/i.test(key)) chipId = field[2];
    if (/^(?:Process ID|PID)$/i.test(key)) {
      if (current) processes.push(current);
      const pid = nonnegative(field[2]);
      current = pid === null ? null : { pid, name: null, memoryUsed: null, deviceId, chipId };
    } else if (current && /^Process name$/i.test(key)) current.name = field[2] || null;
    else if (current && /(?:Process memory|Memory usage|Memory used).*\(MB\)/i.test(key)) {
      const memory = nonnegative(field[2]); current.memoryUsed = memory === null ? null : memory * 1024 * 1024;
    }
  }
  if (current) processes.push(current);
  if (processes.length || /No running processes|no process|process.*(?:count|number)\s*:\s*0/i.test(raw)) return { processes, supported: true };
  return { processes, supported: false, reason: 'NPU 进程输出格式无法识别，未将未知结果当作空闲' };
}

class DeviceMonitor extends EventEmitter {
  constructor(client) {
    super();
    this.client = client;
    this.deviceId = null;
    this.generation = 0;
    this.closed = false;
    this.tasks = new Map();
    // Only the selected device is polled. Its last counters and discovered
    // capabilities remain available when another device temporarily takes focus.
    this.contexts = new Map();
  }

  watch(deviceId) {
    if (deviceId !== null && (typeof deviceId !== 'string' || !deviceId || deviceId.startsWith('-') || /[\s\0]/.test(deviceId))) throw new Error('设备标识格式不正确');
    if (this.closed) return;
    if (this.deviceId === deviceId) return;
    this.generation += 1;
    for (const task of this.tasks.values()) { clearTimeout(task.timer); task.controller?.abort(); }
    this.tasks.clear();
    this.deviceId = deviceId;
    if (deviceId === null) return;
    if (!this.contexts.has(deviceId)) {
      this.contexts.set(deviceId, { previous: null, bootId: null, bootRevision: 0,
        npuTool: undefined, npuProcessSupport: new Map() });
    }
    const generation = this.generation;
    for (const kind of Object.keys(INTERVALS)) {
      const task = { timer: null, controller: null };
      this.tasks.set(kind, task);
      task.timer = setTimeout(() => this.poll(kind, task, generation, deviceId), 0);
      task.timer.unref?.();
    }
  }

  close() {
    if (this.closed) return;
    this.watch(null);
    this.contexts.clear();
    this.closed = true;
  }

  reset() {
    if (this.closed) return;
    const deviceId = this.deviceId;
    this.watch(null);
    this.contexts.clear();
    this.watch(deviceId);
  }

  isCurrent(generation, deviceId) {
    return !this.closed && this.generation === generation && this.deviceId === deviceId;
  }

  async poll(kind, task, generation, deviceId) {
    if (!this.isCurrent(generation, deviceId)) return;
    const context = this.contexts.get(deviceId);
    const bootRevision = context.bootRevision;
    const acceptsSample = () => this.isCurrent(generation, deviceId)
      && (kind === 'system' || context.bootRevision === bootRevision);
    task.controller = new AbortController();
    let timedOut = false;
    const deadline = setTimeout(() => { timedOut = true; task.controller?.abort(); }, kind === 'npu' ? 15000 : 9000);
    deadline.unref?.();
    try {
      let sample;
      if (kind === 'system') sample = await this.system(deviceId, task.controller.signal, generation);
      else if (kind === 'storage') sample = { data: parseStorage((await this.client.shell(deviceId, STORAGE_COMMAND, { signal: task.controller.signal, timeoutMs: 8000 })).stdout) };
      else sample = await this.npu(deviceId, task.controller.signal, generation);
      if (sample && acceptsSample()) this.emit('sample', { deviceId, kind, ...sample, sampledAt: Date.now() });
    } catch (error) {
      if (!acceptsSample()) return;
      const message = timedOut ? '设备监视采样超时，本次指标不可用' : error.message;
      // A failed read says nothing about whether the device rebooted. Keep its
      // baseline until a successful sample validates boot identity and counters.
      const data = kind === 'npu' ? { available: false, reason: message, tool: context.npuTool || undefined,
        raw: error.stdout || '', devices: [], processes: [] } : null;
      this.emit('sample', { deviceId, kind, data, error: message, sampledAt: Date.now() });
    } finally {
      clearTimeout(deadline);
      task.controller = null;
      if (this.isCurrent(generation, deviceId)) {
        // Schedule after completion, never overlap a slow request with its successor.
        task.timer = setTimeout(() => this.poll(kind, task, generation, deviceId), INTERVALS[kind]);
        task.timer.unref?.();
      }
    }
  }

  async system(deviceId, signal, generation) {
    const result = await this.client.shell(deviceId, SYSTEM_COMMAND, { signal, timeoutMs: 7000 });
    if (!this.isCurrent(generation, deviceId)) return null;
    const context = this.contexts.get(deviceId);
    const { values, processes: records } = pairs(result.stdout);
    if (values.get('done') !== 'ok') throw new Error('设备进程清单未完整返回');
    const bootId = (values.get('boot') || '').trim();
    const uptimeSeconds = nonnegative((values.get('uptime') || '').trim().split(/\s+/)[0]);
    const cpuText = values.get('cpu') || '';
    const cpuLine = cpuText.match(/^cpu\s+(.+)$/m);
    const cores = (cpuText.match(/^cpu\d+\s/gm) || []).length;
    if (!bootId || uptimeSeconds === null || !cpuLine || !cores) throw new Error('无法读取完整的 /proc 系统状态，请检查设备权限');
    const ticks = cpuLine[1].trim().split(/\s+/).slice(0, 8).map(nonnegative);
    if (ticks.length < 4 || ticks.some(value => value === null)) throw new Error('/proc/stat CPU 计数格式不正确');
    // guest/guest_nice are already included in user/nice: do not count twice.
    const totalTicks = ticks.reduce((total, tick) => total + tick, 0);
    const idleTicks = ticks[3] + (ticks[4] || 0);
    const load = (values.get('load') || '').trim().split(/\s+/).slice(0, 3).map(nonnegative);
    while (load.length < 3) load.push(null);
    const hzValue = nonnegative((values.get('clock') || '').trim());
    const pageValue = nonnegative((values.get('page') || '').trim());
    const hz = hzValue && hzValue > 0 ? hzValue : null;
    const page = pageValue && pageValue > 0 ? pageValue : null;
    const memory = parseMemory(values.get('memory') || '');
    const network = parseNetwork(values.get('network') || '');
    const processes = records.map(record => parseProcess(record, page)).filter(Boolean);
    if ((context.bootId && context.bootId !== bootId)
      || (context.previous && uptimeSeconds < context.previous.uptimeSeconds)) {
      context.previous = null;
      context.npuTool = undefined;
      context.npuProcessSupport.clear();
      // Also invalidate in-flight storage/NPU work started before this reboot.
      context.bootRevision += 1;
    }
    const previous = context.previous;
    const sameBoot = previous && previous.bootId === bootId && uptimeSeconds > previous.uptimeSeconds;
    const elapsed = sameBoot ? uptimeSeconds - previous.uptimeSeconds : null;
    let cpuPercent = null;
    if (sameBoot && cores === previous.cores && ticks.length === previous.ticks.length
      && ticks.every((tick, index) => tick >= previous.ticks[index])) {
      const totalDelta = totalTicks - previous.totalTicks;
      const idleDelta = idleTicks - previous.idleTicks;
      if (totalDelta > 0 && idleDelta >= 0 && idleDelta <= totalDelta) cpuPercent = percent(totalDelta - idleDelta, totalDelta);
    }
    if (elapsed !== null) {
      for (const entry of network) {
        const last = previous.network.get(entry.name);
        if (!last) continue;
        if (entry.rxBytes >= last.rxBytes) entry.rxPerSecond = (entry.rxBytes - last.rxBytes) / elapsed;
        if (entry.txBytes >= last.txBytes) entry.txPerSecond = (entry.txBytes - last.txBytes) / elapsed;
      }
      for (const entry of processes) {
        const last = previous.processes.get(entry.pid);
        if (hz !== null && hz === previous.hz && last && last.startTime === entry.startTime && last.ticks !== null && entry.ticks !== null && entry.ticks >= last.ticks) {
          entry.cpuPercent = (entry.ticks - last.ticks) / hz / elapsed * 100;
        }
      }
    }
    context.bootId = bootId;
    context.previous = { bootId, uptimeSeconds, ticks, totalTicks, idleTicks, cores, hz,
      network: new Map(network.map(entry => [entry.name, { rxBytes: entry.rxBytes, txBytes: entry.txBytes }])),
      processes: new Map(processes.map(entry => [entry.pid, { startTime: entry.startTime, ticks: entry.ticks }])) };
    for (const entry of processes) delete entry.ticks;
    processes.sort((a, b) => (b.cpuPercent ?? -1) - (a.cpuPercent ?? -1) || (b.rssBytes ?? -1) - (a.rssBytes ?? -1) || a.pid - b.pid);
    const warnings = [];
    if (memory.total === null || memory.available === null) warnings.push('内存总量或 MemAvailable 不可读');
    if (hz === null || page === null) warnings.push('getconf 未返回时钟或页面大小，相关进程指标未知');
    if (!network.length) warnings.push('网卡计数不可读');
    if (!processes.length) warnings.push('没有读取到进程统计，请检查 /proc 权限');
    return { data: { bootId, uptimeSeconds, load, cpu: { percent: cpuPercent, cores }, memory, network, processes },
      ...(warnings.length ? { error: warnings.join('；') } : {}) };
  }

  async npu(deviceId, signal, generation) {
    const context = this.contexts.get(deviceId);
    const bootRevision = context.bootRevision;
    const isCurrent = () => this.isCurrent(generation, deviceId) && context.bootRevision === bootRevision;
    if (context.npuTool === undefined) {
      const discovered = (await this.client.shell(deviceId, NPU_DISCOVERY, { signal, timeoutMs: 6000 })).stdout.trim();
      if (!isCurrent()) return null;
      context.npuTool = discovered.startsWith('/') && !/[\r\n\0]/.test(discovered) ? discovered : null;
    }
    if (!context.npuTool) return { data: { available: false, reason: '未在当前设备的可执行路径中找到 npu-smi', devices: [], processes: [] } };
    const tool = context.npuTool;
    const raw = (await this.client.shell(deviceId, `${shellQuote(tool)} info`, { signal, timeoutMs: 7000 })).stdout;
    if (!isCurrent()) return null;
    const parsed = parseNpuTable(raw);
    if (!parsed.devices.length) return { data: { available: false, tool, raw, reason: 'npu-smi 未返回可识别的芯片指标', devices: [], processes: [] }, error: 'npu-smi 输出无法解析，请查看原始结果' };
    let fullRaw = raw;
    const warnings = [...parsed.warnings];
    if (!parsed.processTableSeen) {
      for (const id of [...new Set(parsed.devices.map(device => device.id))]) {
        const support = context.npuProcessSupport.get(id);
        if (support?.supported === false) { warnings.push(support.reason); continue; }
        try {
          const output = (await this.client.shell(deviceId, `${shellQuote(tool)} info -t proc-mem -i ${id}`, { signal, timeoutMs: 5000 })).stdout;
          if (!isCurrent()) return null;
          fullRaw += `\n--- NPU ${id} process memory ---\n${output}`;
          const found = parseNpuProcesses(output, id);
          if (!found.supported) {
            warnings.push(found.reason);
            // Cache only explicit lack of capability, not transient tool failures.
            if (/does not support|not supported/i.test(output)) context.npuProcessSupport.set(id, found);
          } else {
            context.npuProcessSupport.set(id, { supported: true });
            parsed.processes.push(...found.processes);
          }
        } catch (error) {
          if (signal.aborted) throw error;
          warnings.push(`NPU ${id} 进程查询失败：${error.message}`);
        }
      }
    }
    const reason = [...new Set(warnings)].join('；');
    return { data: { available: true, tool, raw: fullRaw, devices: parsed.devices, processes: parsed.processes,
      ...(reason ? { reason } : {}) }, ...(reason ? { error: reason } : {}) };
  }
}

module.exports = { DeviceMonitor };
