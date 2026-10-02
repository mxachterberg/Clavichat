/* Clavichat — Auswahl beim Bildschirm teilen (Windows-App). */
(function () {
  'use strict';

  var selected = null;
  var share = document.getElementById('pk-share');

  /* ---- Qualität ---------------------------------------------------------
     Dieselben Kennungen wie SCREEN_QUALITY in server/assets/securecom.js.
     Die Wahl landet in localStorage; das Hauptfenster (gleiche Herkunft)
     liest sie, sobald die Übertragung startet. */
  var QUALITY = [
    { id: 'normal', name: 'Ausgewogen', info: '1080p · 30 fps', note: 'Für das meiste genau richtig.' },
    { id: 'text', name: 'Text & Code', info: 'Originalauflösung · 15 fps', note: 'Gestochen scharf für Code, Dokumente und Tabellen.' },
    { id: 'smooth', name: 'Flüssig', info: '720p · 60 fps', note: 'Für Videos und Spiele: Bewegung vor Schärfe.' },
    { id: 'max', name: 'Hoch', info: '1440p · 60 fps', note: 'Scharf und flüssig, braucht einen schnellen Upload.' },
    { id: 'source', name: 'Quelle', info: 'Originalauflösung · 60 fps', note: 'Der Bildschirm 1:1 und flüssig – braucht den meisten Upload.' },
    { id: 'low', name: 'Sparsam', info: '720p · 10 fps', note: 'Für schwache Leitungen und Mobilfunk.' }
  ];
  var KEY = 'sc-screen-quality';
  var quality = document.getElementById('pk-quality');
  var note = document.getElementById('pk-quality-note');
  var current = null;
  try { current = localStorage.getItem(KEY); } catch (e) { /* gesperrt: Standard */ }
  QUALITY.forEach(function (q) {
    var option = document.createElement('option');
    option.value = q.id;
    option.textContent = q.name + ' – ' + q.info;
    option.selected = q.id === current;
    quality.appendChild(option);
  });
  function showNote() {
    var q = QUALITY.filter(function (x) { return x.id === quality.value; })[0];
    note.textContent = q ? q.note : '';
  }
  quality.addEventListener('change', showNote);
  showNote();

  function card(source) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'pk-card';
    button.setAttribute('aria-pressed', 'false');
    var frame = document.createElement('span');
    frame.className = 'pk-thumb';
    if (source.thumb && source.thumb.indexOf('data:image/') === 0) {
      var img = document.createElement('img');
      img.src = source.thumb;
      img.alt = '';
      frame.appendChild(img);
    }
    var name = document.createElement('span');
    name.className = 'pk-name';
    name.textContent = source.name || (source.screen ? 'Bildschirm' : 'Fenster');
    button.append(frame, name);
    button.addEventListener('click', function () {
      document.querySelectorAll('.pk-card').forEach(function (c) { c.setAttribute('aria-pressed', 'false'); });
      button.setAttribute('aria-pressed', 'true');
      selected = source.id;
      share.disabled = false;
    });
    button.addEventListener('dblclick', function () { selected = source.id; done(); });
    return button;
  }

  function done() {
    if (!selected) return;
    try { localStorage.setItem(KEY, quality.value); } catch (e) { /* dann Standard */ }
    window.picker.choose({ id: selected, audio: document.getElementById('pk-audio').checked });
  }

  window.picker.onSources(function (data) {
    var screens = document.getElementById('pk-screens');
    var windows = document.getElementById('pk-windows');
    var list = data && Array.isArray(data.list) ? data.list : [];
    list.forEach(function (s) { (s.screen ? screens : windows).appendChild(card(s)); });
    document.getElementById('pk-screens-head').hidden = !screens.children.length;
    document.getElementById('pk-windows-head').hidden = !windows.children.length;
    document.getElementById('pk-audio-row').hidden = !(data && data.audio);
    // Gibt es nur einen Bildschirm, ist er schon gewählt.
    if (screens.children.length === 1) screens.firstChild.click();
  });

  share.addEventListener('click', done);
  document.getElementById('pk-cancel').addEventListener('click', function () { window.picker.choose(null); });
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape') window.picker.choose(null);
    if (ev.key === 'Enter' && selected) done();
  });
})();
