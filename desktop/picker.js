/* SecureCom — Auswahl beim Bildschirm teilen (Windows-App). */
(function () {
  'use strict';

  var selected = null;
  var share = document.getElementById('pk-share');

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
