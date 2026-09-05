'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const invoke = (channel) => (payload) => ipcRenderer.invoke(channel, payload);
const subscribe = (channel) => (callback) => {
  if (typeof callback !== 'function') throw new TypeError('callback required');
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};
contextBridge.exposeInMainWorld('api', {
  getState: invoke('app:state'),
  listDevices: invoke('devices:list'),
  connectDevice: invoke('devices:connect'),
  disconnectDevice: invoke('devices:disconnect'),
  listDirectory: invoke('files:list'),
  readFile: invoke('files:read'),
  createDirectory: invoke('files:mkdir'),
  renamePath: invoke('files:rename'),
  deletePaths: invoke('files:delete'),
  upload: invoke('transfer:upload'),
  download: invoke('transfer:download'),
  getTransfers: invoke('transfer:list'),
  cancelTransfer: invoke('transfer:cancel'),
  onTransfers: subscribe('transfer:changed'),
  openTerminal: invoke('terminal:open'),
  writeTerminal: (payload) => ipcRenderer.send('terminal:write', payload),
  resizeTerminal: (payload) => ipcRenderer.send('terminal:resize', payload),
  closeTerminal: invoke('terminal:close'),
  onTerminalData: subscribe('terminal:data'),
  onTerminalExit: subscribe('terminal:exit'),
  runQuick: invoke('devices:quick'),
  watchDevice: invoke('monitor:watch'),
  onMonitor: subscribe('monitor:sample'),
  getProcessDetail: invoke('process:detail'),
  signalProcess: invoke('process:signal'),
  analyzeDirectory: invoke('storage:analyze'),
  rebootDevice: invoke('devices:reboot'),
  saveSettings: invoke('settings:save'),
  chooseHdc: invoke('settings:choose-hdc'),
  chooseDownloads: invoke('settings:choose-downloads'),
  openDownloads: invoke('app:open-downloads'),
  saveText: invoke('app:save-text')
});
