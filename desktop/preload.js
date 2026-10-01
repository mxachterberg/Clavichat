/* SecureCom — Brücke zwischen Oberfläche und App. */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('securecomDesktop', {
  /** Fenster nach vorn holen (Klick auf eine Benachrichtigung). */
  focus: () => ipcRenderer.send('securecom:focus'),
  /** In der Taskleiste blinken (eingehender Anruf). */
  attention: () => ipcRenderer.send('securecom:attention')
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
