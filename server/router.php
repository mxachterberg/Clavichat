<?php
/**
 * ============================================================================
 *  Clavichat — Weiche für den eingebauten PHP-Server
 * ============================================================================
 *    php -S 127.0.0.1:8130 -t server server/router.php
 *
 *  Der eingebaute Server kennt keine .htaccess. Hier wird deshalb gesperrt,
 *  was nie nach außen darf: Programmteile, Daten, Einstellungen und
 *  versteckte Dateien. Alles andere liefert der Server wie gewohnt aus.
 *  Apache braucht diese Datei nicht (dort gilt die .htaccess).
 * ----------------------------------------------------------------------------
 */

$path = rawurldecode((string)parse_url((string)($_SERVER['REQUEST_URI'] ?? '/'), PHP_URL_PATH));

if (preg_match('#(^|/)(lib|storage)(/|$)'
    . '|(^|/)\.'
    . '|(^|/)(config|config\.sample|router)\.php$'
    . '|\.(md|log|key|json|jsonl|n|lock)$#i', $path)) {
    http_response_code(404);
    header('Content-Type: text/plain; charset=utf-8');
    header('X-Content-Type-Options: nosniff');
    echo 'Nicht gefunden';
    return true;
}
return false;
