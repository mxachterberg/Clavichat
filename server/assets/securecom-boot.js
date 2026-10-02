/* ==========================================================================
   Clavichat — Start: Hell/Dunkel und Ladebalken
   --------------------------------------------------------------------------
   Ein klassisches Skript (kein Modul), im <head> geladen. Es läuft also
   auch dann, wenn ein Programmteil nicht lädt, und zeigt in dem Fall den
   Fehler, statt ewig zu warten. securecom.js meldet seine Startschritte
   über window.scBoot.step(), am Ende scBoot.done().
   ========================================================================== */
(function () {
  'use strict';

  /* ---- Hell/Dunkel sofort, damit nichts aufblitzt ---------------------- */
  var theme;
  try { theme = localStorage.getItem('theme'); } catch (e) { /* privater Modus */ }
  if (theme !== 'light' && theme !== 'dark') {
    theme = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  document.documentElement.setAttribute('data-theme', theme);

  /* ---- Ladebalken ------------------------------------------------------ */
  var finished = false;
  var share = 0;
  var text = '';

  function part(id) { return document.getElementById(id); }

  function paint() {
    var fill = part('sc-boot-fill');
    var status = part('sc-boot-status');
    if (fill) fill.style.transform = 'scaleX(' + share + ')';
    if (status && text) status.textContent = text;
  }

  window.scBoot = {
    step: function (value, label) {
      if (finished) return;
      share = Math.max(share, Math.min(1, Number(value) || 0));
      if (label) text = label;
      paint();
    },
    done: function () {
      if (finished) return;
      share = 1;
      paint();
      finished = true;
      var boot = part('sc-boot');
      if (!boot) return;
      boot.classList.add('is-done');
      setTimeout(function () { boot.hidden = true; }, 260);
    },
    fail: function (message) {
      if (finished) return;
      finished = true;
      var boot = part('sc-boot');
      var status = part('sc-boot-status');
      var error = part('sc-boot-error');
      if (!boot) return;
      boot.classList.add('is-failed');
      if (status) status.textContent = 'FEHLER BEIM LADEN';
      if (error) {
        error.textContent = message || '';
        error.hidden = !message;
      }
    }
  };

  // Lädt ein Programmteil nicht oder bricht der Start mit einem Fehler ab.
  window.addEventListener('error', function (ev) {
    if (finished) return;
    var t = ev.target;
    if (t && t.tagName === 'SCRIPT') {
      window.scBoot.fail('Ein Programmteil ließ sich nicht laden (' + String(t.src || '').split('/').pop().split('?')[0] + ').');
    } else if (ev.message) {
      window.scBoot.fail(ev.message);
    }
  }, true);

  // Hängt es, gibt es einen Ausweg.
  setTimeout(function () {
    if (finished) return;
    var boot = part('sc-boot');
    var status = part('sc-boot-status');
    if (boot) boot.classList.add('is-slow');
    if (status) status.textContent = 'DAUERT LÄNGER ALS ÜBLICH';
  }, 15000);

  document.addEventListener('click', function (ev) {
    if (ev.target && ev.target.id === 'sc-boot-retry') location.reload();
  });

  document.addEventListener('DOMContentLoaded', paint);
})();
