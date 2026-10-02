/* SecureCom Server — Statusfenster. Alles Handeln läuft über window.host (preload.js). */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var current = null;
  var editing = false;     // Einstellungen nicht überschreiben, während jemand tippt
  var TITLES = { start: 'Startet …', 'läuft': 'Läuft', fehler: 'Läuft nicht', gestoppt: 'Gestoppt' };

  function button(text, onclick) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn';
    b.textContent = text;
    b.addEventListener('click', onclick);
    return b;
  }

  function flash(b, text) {
    var before = b.textContent;
    b.textContent = text;
    setTimeout(function () { b.textContent = before; }, 1200);
  }

  function render(s) {
    current = s;
    $('hs-status').dataset.state = s.status;
    $('hs-title').textContent = TITLES[s.status] || s.status;
    $('hs-sub').textContent = s.status === 'fehler' ? (s.error || '')
      : s.status === 'läuft' ? (s.settings.lan ? 'Im Heimnetz erreichbar, Port ' + s.settings.port : 'Nur auf diesem Rechner, Port ' + s.settings.port)
      : '';

    var box = $('hs-urls');
    box.textContent = '';
    s.urls.forEach(function (url) {
      var row = document.createElement('div');
      row.className = 'hs-url';
      var code = document.createElement('code');
      code.textContent = url;
      var copy = button('Kopieren', function () { window.host.copy(url); flash(copy, 'Kopiert'); });
      row.append(code, copy, button('Öffnen', function () { window.host.open(url); }));
      box.appendChild(row);
    });

    $('hs-fp').textContent = s.fingerprint || '–';
    $('hs-client').textContent = s.client;
    if (!editing) {
      $('hs-port').value = s.settings.port;
      $('hs-lan').checked = s.settings.lan;
      $('hs-auto').checked = s.settings.autostart;
    }
    var log = $('hs-log');
    var atEnd = log.scrollTop + log.clientHeight >= log.scrollHeight - 8;
    log.textContent = s.log.join('\n');
    if (atEnd) log.scrollTop = log.scrollHeight;
    $('hs-version').textContent = 'SecureCom Server ' + s.version;
  }

  $('hs-restart').addEventListener('click', function () { window.host.restart(); });
  $('hs-fp-copy').addEventListener('click', function () {
    if (current) window.host.copy(current.fingerprint);
    flash($('hs-fp-copy'), 'Kopiert');
  });
  $('hs-client-copy').addEventListener('click', function () {
    if (current) window.host.copy(current.client);
    flash($('hs-client-copy'), 'Kopiert');
  });
  $('hs-client-folder').addEventListener('click', function () { window.host.open('client'); });
  $('hs-data').addEventListener('click', function () { window.host.open('data'); });
  $('hs-config').addEventListener('click', function () { window.host.open('config'); });
  $('hs-quit').addEventListener('click', function () { window.host.quit(); });

  $('hs-form').addEventListener('focusin', function () { editing = true; });
  $('hs-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    editing = false;
    window.host.apply({ port: $('hs-port').value.trim(), lan: $('hs-lan').checked, autostart: $('hs-auto').checked })
      .then(render, function (e) {
        $('hs-sub').textContent = String(e && e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
      });
  });

  window.host.onState(render);
  window.host.state().then(render);
})();
