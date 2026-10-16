<?php
/**
 * ============================================================================
 *  Clavichat — Seite (eigenständige Fassung)
 * ============================================================================
 *  Läuft unter jeder Adresse, etwa https://example.com/clavichat/. Startet
 *  keine PHP-Sitzung, lädt nichts von fremden Servern und erlaubt per
 *  Content-Security-Policy nur eigene Skripte – kein einziges Inline-Skript.
 * ----------------------------------------------------------------------------
 */

if (function_exists('mb_internal_encoding')) {
    mb_internal_encoding('UTF-8');
}
ini_set('display_errors', '0');
error_reporting(E_ALL);

require_once __DIR__ . '/lib/util.php';

header('Content-Type: text/html; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');
header('X-Frame-Options: SAMEORIGIN');
header('Referrer-Policy: no-referrer');
header('Permissions-Policy: camera=(self), microphone=(self), display-capture=(self), '
     . 'geolocation=(), payment=(), usb=()');
header("Content-Security-Policy: default-src 'self'; "
     . "script-src 'self' 'wasm-unsafe-eval'; "
     . "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; "
     . "font-src 'self'; connect-src 'self'; worker-src 'self' blob:; "
     . "frame-ancestors 'self'; base-uri 'none'; form-action 'none'; object-src 'none'");

// Adresse dieser Seite – Einladungslinks zeigen hierher. Fest einstellbar
// über 'public_url' in config.php (empfohlen hinter Proxys).
$web = (string)cfg('public_url', '');
if ($web === '') {
    $dir = rtrim(str_replace('\\', '/', dirname((string)($_SERVER['SCRIPT_NAME'] ?? '/'))), '/') . '/';
    $web = (is_https() ? 'https' : 'http') . '://' . ($_SERVER['HTTP_HOST'] ?? 'localhost') . $dir;
}
$web = rtrim($web, '/') . '/';

$v = function ($file) { return asset_v($file); };
$core = 'assets/securecom-core.js?v=' . $v('securecom-core.js');
?>
<!DOCTYPE html>
<html lang="de" data-theme="dark">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Clavichat</title>
<meta name="robots" content="noindex, nofollow">
<meta name="description" content="Ende-zu-Ende verschlüsselt schreiben, telefonieren und den Bildschirm teilen.">
<link rel="icon" type="image/svg+xml" href="assets/securecom-icon.svg">
<link rel="stylesheet" href="assets/securecom-base.css?v=<?= $v('securecom-base.css') ?>">
<link rel="stylesheet" href="assets/securecom.css?v=<?= $v('securecom.css') ?>">
<link rel="modulepreload" href="<?= e($core) ?>">
<link rel="modulepreload" href="assets/vendor/openpgp-6.3.2.min.js">
<meta name="theme-color" content="#f6f6f4" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0b0b0d" media="(prefers-color-scheme: dark)">
<script src="assets/securecom-boot.js?v=<?= $v('securecom-boot.js') ?>"></script>
</head>
<body class="sc-body sc-in-frame">

<div class="sc" id="sc" hidden>
  <nav class="sc-rail" id="sc-rail" aria-label="Räume">
    <button type="button" class="sc-rail-btn sc-rail-home" id="sc-home" aria-current="true" title="Direktnachrichten">
      <svg width="24" height="24" viewBox="7.3 5.5 49.4 49.4" aria-hidden="true"><path d="M27 26V8.5M38 26V21.5" fill="none" stroke="#0b0b0d" stroke-width="5.8" stroke-linecap="round"/><rect x="20" y="26" width="24" height="26" rx="4" fill="#0b0b0d" stroke="#0b0b0d" stroke-width="5.8"/><rect x="27.4" y="6.8" width="9" height="13.4" rx="1.2" fill="#0b0b0d"/><path d="M28.6 8h6.6v4h-2.6v3h2.6v4h-6.6z" fill="#f97316"/><path d="M27 26V8.5M38 26V21.5" fill="none" stroke="#ededec" stroke-width="3.4" stroke-linecap="round"/><rect x="20" y="26" width="24" height="26" rx="4" fill="none" stroke="#ededec" stroke-width="3.4"/><path d="M26.5 33.5h11M26.5 39h11" fill="none" stroke="#ededec" stroke-width="3" stroke-linecap="round"/><circle cx="32" cy="46" r="2.6" fill="#f97316"/></svg>
      <span class="sc-rail-badge" id="sc-home-badge" hidden></span>
    </button>
    <span class="sc-rail-sep" aria-hidden="true"></span>
    <div class="sc-rail-rooms" id="sc-rail-rooms"></div>
    <button type="button" class="sc-rail-btn sc-rail-add" id="sc-add-room" title="Raum erstellen oder beitreten">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
    </button>
  </nav>

  <aside class="sc-side" id="sc-side">
    <header class="sc-side-head" id="sc-side-head"></header>
    <div class="sc-side-body" id="sc-side-body"></div>
    <div class="sc-voicebar" id="sc-voicebar" hidden></div>
    <footer class="sc-user" id="sc-user"></footer>
  </aside>

  <main class="sc-main" id="sc-main">
    <header class="sc-main-head" id="sc-main-head"></header>
    <div class="sc-banner" id="sc-banner" hidden></div>
    <section class="sc-stage" id="sc-stage" hidden aria-label="Anruf"></section>
    <div class="sc-thread" id="sc-thread" role="log" aria-live="polite"></div>
    <div class="sc-typing" id="sc-typing" aria-live="polite"></div>
    <form class="sc-compose" id="sc-compose" hidden autocomplete="off">
      <textarea id="sc-input" rows="1" maxlength="8000" placeholder="Nachricht" spellcheck="true"></textarea>
      <button type="submit" class="sc-send" id="sc-send" title="Senden (Enter)">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12l16-8-6 16-2.5-6.5z"/><path d="M11.5 13.5L20 4"/></svg>
      </button>
      <p class="sc-compose-note"><span class="sc-lock" aria-hidden="true"></span>Ende-zu-Ende verschlüsselt &middot; Enter senden, Umschalt+Enter neue Zeile</p>
    </form>
  </main>

  <aside class="sc-members" id="sc-members" hidden></aside>
  <div class="sc-scrim" id="sc-scrim" hidden></div>
</div>

<div class="sc-gate" id="sc-gate" hidden>
  <div class="sc-gate-card tickbox" id="sc-gate-card"></div>
</div>

<div class="sc-boot" id="sc-boot" role="status" aria-live="polite">
  <div class="sc-boot-box">
    <p class="sc-boot-head"><span class="sc-boot-sq"></span>CLAVICHAT</p>
    <div class="sc-boot-bar"><span id="sc-boot-fill"></span></div>
    <p class="sc-boot-status" id="sc-boot-status">WIRD GELADEN</p>
    <p class="sc-boot-error" id="sc-boot-error" hidden></p>
    <button class="sc-boot-retry" id="sc-boot-retry" type="button">NEU LADEN</button>
  </div>
</div>

<div class="sc-modal" id="sc-modal" hidden>
  <div class="sc-modal-panel tickbox" id="sc-modal-panel" role="dialog" aria-modal="true"></div>
</div>
<div class="sc-toasts" id="sc-toasts" aria-live="polite"></div>
<div id="sc-audio" hidden></div>

<noscript><p class="sc-noscript">Clavichat braucht JavaScript &ndash; die Verschlüsselung passiert in deinem Browser, nicht auf dem Server.</p></noscript>

<script type="module" id="sc-script" src="assets/securecom.js?v=<?= $v('securecom.js') ?>"
        data-core="<?= e($core) ?>" data-api="api.php" data-web="<?= e($web) ?>"></script>
</body>
</html>
