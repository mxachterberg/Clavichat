/* Clavichat — Brücke für die Bildschirmauswahl. */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('picker', {
  onSources: (callback) => ipcRenderer.on('picker:sources', (_event, data) => callback(data)),
  choose: (choice) => ipcRenderer.send('picker:choose', choice)
});
