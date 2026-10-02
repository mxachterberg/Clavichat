/* Clavichat Server — Brücke zwischen Fenster und Programm. */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('host', {
  state: () => ipcRenderer.invoke('host:state'),
  onState: (callback) => ipcRenderer.on('host:state', (_event, state) => callback(state)),
  restart: () => ipcRenderer.invoke('host:restart'),
  apply: (settings) => ipcRenderer.invoke('host:apply', settings),
  copy: (text) => ipcRenderer.invoke('host:copy', text),
  open: (what) => ipcRenderer.invoke('host:open', what),
  quit: () => ipcRenderer.invoke('host:quit')
});
