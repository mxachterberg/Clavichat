/* SecureCom — Brücke zwischen Oberfläche und App (nur zwei Handgriffe). */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('securecomDesktop', {
  /** Fenster nach vorn holen (Klick auf eine Benachrichtigung). */
  focus: () => ipcRenderer.send('securecom:focus'),
  /** In der Taskleiste blinken (eingehender Anruf). */
  attention: () => ipcRenderer.send('securecom:attention')
});
