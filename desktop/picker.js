/* Clavichat — Auswahl beim Bildschirm teilen (Windows-App). */
(function () {
  'use strict';

  var selected = null;
  var share = document.getElementById('pk-share');

  /* ---- Qualität ---------------------------------------------------------
     Dieselben Kennungen und dieselbe Reihenfolge (aufsteigend nach
     Datenrate) wie SCREEN_QUALITY in server/assets/securecom.js. Die Wahl
     landet in localStorage; das Hauptfenster (gleiche Herkunft) liest sie,
     sobald die Übertragung startet. Auswahl im Stil der App statt <select>:
     klappt nach oben auf, weil sie unten in der Fußzeile steht. */
  var QUALITY = [
    { id: 'low', name: 'Sparsam', info: '720p · 10 fps · bis 0,8 Mbit/s', note: 'Für schwache Leitungen und Mobilfunk.' },
    { id: 'normal', name: 'Ausgewogen', info: '1080p · 30 fps · bis 3 Mbit/s', note: 'Für das meiste genau richtig.' },
    { id: 'text', name: 'Text & Code', info: 'Originalauflösung · 15 fps · bis 4 Mbit/s', note: 'Gestochen scharf für Code, Dokumente und Tabellen.' },
    { id: 'smooth', name: 'Flüssig', info: '720p · 60 fps · bis 4 Mbit/s', note: 'Für Videos und Spiele: Bewegung vor Schärfe.' },
    { id: 'max', name: 'Hoch', info: '1440p · 60 fps · bis 10 Mbit/s', note: 'Scharf und flüssig, braucht einen schnellen Upload.' },
    { id: 'source', name: 'Quelle', info: 'Originalauflösung · 60 fps · bis 16 Mbit/s', note: 'Der Bildschirm 1:1 und flüssig – braucht den meisten Upload.' }
  ];
  var KEY = 'sc-screen-quality';
  var box = document.getElementById('pk-quality');
  var note = document.getElementById('pk-quality-note');
  var current = null;
  try { current = localStorage.getItem(KEY); } catch (e) { /* gesperrt: Standard */ }
  if (!QUALITY.some(function (q) { return q.id === current; })) current = 'normal';

  var qButton = document.createElement('button');
  qButton.type = 'button';
  qButton.className = 'pk-choice-btn';
  qButton.setAttribute('aria-haspopup', 'listbox');
  qButton.setAttribute('aria-expanded', 'false');
  qButton.setAttribute('aria-labelledby', 'pk-quality-label');
  var qList = document.createElement('div');
  qList.className = 'pk-choice-list';
  qList.setAttribute('role', 'listbox');
  qList.hidden = true;
  box.append(qButton, qList);

  function span(cls, text) {
    var s = document.createElement('span');
    s.className = cls;
    s.textContent = text;
    return s;
  }
  function drawQuality() {
    var q = QUALITY.filter(function (x) { return x.id === current; })[0];
    qButton.textContent = '';
    qButton.append(span('pk-choice-name', q.name), span('pk-choice-info', q.info), span('pk-choice-arrow', '▾'));
    note.textContent = q.note;
    qList.textContent = '';
    QUALITY.forEach(function (x) {
      var opt = document.createElement('button');
      opt.type = 'button';
      opt.className = 'pk-choice-opt';
      opt.setAttribute('role', 'option');
      opt.setAttribute('aria-selected', x.id === current ? 'true' : 'false');
      opt.append(span('pk-choice-name', x.name), span('pk-choice-info', x.info), span('pk-choice-note', x.note));
      opt.addEventListener('click', function () { current = x.id; drawQuality(); closeQuality(true); });
      qList.appendChild(opt);
    });
  }
  function openQuality() {
    qList.hidden = false;
    box.classList.add('is-open');
    qButton.setAttribute('aria-expanded', 'true');
    var sel = qList.querySelector('[aria-selected="true"]');
    if (sel) sel.focus();
  }
  function closeQuality(refocus) {
    if (qList.hidden) return;
    qList.hidden = true;
    box.classList.remove('is-open');
    qButton.setAttribute('aria-expanded', 'false');
    if (refocus) qButton.focus();
  }
  qButton.addEventListener('click', function () { if (qList.hidden) openQuality(); else closeQuality(false); });
  qList.addEventListener('keydown', function (ev) {
    var opts = Array.prototype.slice.call(qList.children);
    var i = opts.indexOf(document.activeElement);
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      var n = ev.key === 'ArrowDown' ? (i + 1) % opts.length : (i - 1 + opts.length) % opts.length;
      opts[n].focus();
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();   // sonst schlösse Escape gleich das ganze Fenster
      closeQuality(true);
    }
  });
  document.addEventListener('pointerdown', function (ev) { if (!box.contains(ev.target)) closeQuality(false); });
  drawQuality();

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
    try { localStorage.setItem(KEY, current); } catch (e) { /* dann Standard */ }
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
    // Enter in der Qualitätsauswahl wählt nur die Qualität, teilt noch nicht.
    if (ev.key === 'Enter' && selected && !box.contains(document.activeElement)) done();
  });
})();
