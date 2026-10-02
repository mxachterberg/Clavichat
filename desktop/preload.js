/* SecureCom — Brücke zwischen Oberfläche und App. */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('securecomDesktop', {
  /** Fenster nach vorn holen (Klick auf eine Benachrichtigung). */
  focus: () => ipcRenderer.send('securecom:focus'),
  /** In der Taskleiste blinken (eingehender Anruf). */
  attention: () => ipcRenderer.send('securecom:attention'),
  /** Updates (updater.js): Stand, Suchen, Automatik, Installieren. */
  updates: {
    get: () => ipcRenderer.invoke('securecom:update', 'get'),
    check: () => ipcRenderer.invoke('securecom:update', 'check'),
    setAuto: (on) => ipcRenderer.invoke('securecom:update', 'auto', !!on),
    seen: () => ipcRenderer.invoke('securecom:update', 'seen'),
    install: () => ipcRenderer.invoke('securecom:update', 'install'),
    /** Neuer Stand vom Updater; gibt eine Funktion zum Abbestellen zurück. */
    onState: (fn) => {
      const handler = (event, state) => fn(state);
      ipcRenderer.on('securecom:update-state', handler);
      return () => ipcRenderer.removeListener('securecom:update-state', handler);
    }
  }
});

/* ---- Titelleiste ---------------------------------------------------------
   Windows zeichnet Minimieren, Maximieren und Schließen. Damit sie zur
   Oberfläche passen, bekommt main.js deren Farben – beim Start und bei
   jedem Wechsel zwischen Hell und Dunkel. Die Seite selbst merkt davon
   nichts (eigene Welt des Preload-Skripts, nur das DOM ist gemeinsam). */
function reportColors() {
  const css = getComputedStyle(document.documentElement);
  ipcRenderer.send('securecom:chrome', {
    color: css.getPropertyValue('--bg').trim(),
    symbolColor: css.getPropertyValue('--text-body').trim()
  });
}

window.addEventListener('DOMContentLoaded', () => {
  reportColors();
  new MutationObserver(reportColors).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
});

// Wie bei Windows: Die Leiste wird blasser, wenn ein anderes Fenster vorn ist.
window.addEventListener('blur', () => document.documentElement.classList.add('sc-window-blur'));
window.addEventListener('focus', () => document.documentElement.classList.remove('sc-window-blur'));
