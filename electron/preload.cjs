'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const invoke = (channel, value) => ipcRenderer.invoke(channel, value);
const subscribe = (channel, callback) => {
  const handler = (_event, data) => callback(data);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};
contextBridge.exposeInMainWorld('pupa', Object.freeze({
  getState: () => invoke('pupa:state'), copyEntry: id => invoke('pupa:copy', id),
  deleteEntry: id => invoke('pupa:delete', id), togglePin: id => invoke('pupa:pin', id),
  clearHistory: () => invoke('pupa:clear'), setPaused: paused => invoke('pupa:pause', paused),
  updateSettings: settings => invoke('pupa:settings', settings), hide: () => invoke('pupa:hide'),
  quit: () => invoke('pupa:quit'), onState: callback => subscribe('pupa:changed', callback),
  onShown: callback => subscribe('pupa:shown', callback),
  onSettings: callback => subscribe('pupa:open-settings', callback)
}));
