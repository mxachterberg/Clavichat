<?php
/**
 * ============================================================================
 *  SecureCom — kleine Helfer (eigenständige Fassung)
 * ============================================================================
 *  Dieselben Funktionsnamen wie auf achterberg.dev, damit lib/SecureCom.php
 *  in beiden Fassungen unverändert läuft.
 * ----------------------------------------------------------------------------
 */

/** Einstellungen aus config.php (neben api.php). Ohne Datei: Standardwerte. */
function cfg($key = null, $default = null)
{
    static $conf = null;
    if ($conf === null) {
        $file = __DIR__ . '/../config.php';
        $conf = is_file($file) ? require $file : [];
        if (!is_array($conf)) $conf = [];
    }
    if ($key === null) return $conf;
    return array_key_exists($key, $conf) ? $conf[$key] : $default;
}

function e($s)
{
    return htmlspecialchars((string)$s, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}

/** Versionskennung für Skripte und Stile: ändert sich mit jedem Upload. */
function asset_v($file)
{
    static $cache = [];
    if (isset($cache[$file])) return $cache[$file];
    $path = __DIR__ . '/../assets/' . $file;
    return $cache[$file] = is_file($path) ? (string)filemtime($path) : '0';
}

/**
 * Datenverzeichnis. Am besten außerhalb des Webroots einstellen
 * ('storage_dir' in config.php). Ohne Angabe: storage/ neben api.php –
 * dann sperrt eine .htaccess den Zugriff von außen.
 */
function storage_dir()
{
    static $dir = null;
    if ($dir !== null) return $dir;

    $configured = cfg('storage_dir');
    $dir = $configured ? rtrim($configured, '/\\') : dirname(__DIR__) . '/storage';
    if (!is_dir($dir) && !@mkdir($dir, 0770, true)) {
        throw new RuntimeException('Datenverzeichnis nicht anlegbar: ' . $dir);
    }
    if (!is_writable($dir)) {
        throw new RuntimeException('Datenverzeichnis nicht beschreibbar: ' . $dir);
    }
    $ht = $dir . '/.htaccess';
    if (!$configured && !file_exists($ht)) {
        @file_put_contents($ht,
            "<IfModule mod_authz_core.c>\nRequire all denied\n</IfModule>\n" .
            "<IfModule !mod_authz_core.c>\nOrder allow,deny\nDeny from all\n</IfModule>\n");
    }
    return $dir;
}

/** Geheimer Server-Schlüssel (für die Rate-Limits), entsteht beim ersten Aufruf. */
function app_key()
{
    static $key = null;
    if ($key !== null) return $key;
    $file = storage_dir() . '/app.key';
    if (is_file($file)) $key = trim((string)file_get_contents($file));
    if (!$key) {
        $key = bin2hex(random_bytes(32));
        file_put_contents($file, $key, LOCK_EX);
        @chmod($file, 0600);
    }
    return $key;
}

function is_https()
{
    if (!empty($_SERVER['HTTPS']) && strtolower($_SERVER['HTTPS']) !== 'off') return true;
    if (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https') return true;
    return ($_SERVER['SERVER_PORT'] ?? '') == 443;
}

function json_out($data, $status = 200)
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('X-Content-Type-Options: nosniff');
    header('Cache-Control: no-store, no-cache, must-revalidate');
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
    exit;
}

function json_fail($message, $status = 400)
{
    json_out(['ok' => false, 'error' => $message], $status);
}

/** Einfaches Rate-Limit auf Dateibasis. */
function rate_limit($bucket, $maxAttempts, $windowSeconds)
{
    $dir = storage_dir() . '/ratelimit';
    if (!is_dir($dir)) @mkdir($dir, 0770, true);
    $file = $dir . '/' . hash('sha256', $bucket) . '.json';

    $now  = time();
    $hits = is_file($file) ? (json_decode((string)file_get_contents($file), true) ?: []) : [];
    $hits = array_values(array_filter($hits, function ($t) use ($now, $windowSeconds) {
        return $t > $now - $windowSeconds;
    }));
    if (count($hits) >= $maxAttempts) return false;
    $hits[] = $now;
    @file_put_contents($file, json_encode($hits), LOCK_EX);
    return true;
}

function rate_limit_clear($bucket)
{
    $file = storage_dir() . '/ratelimit/' . hash('sha256', $bucket) . '.json';
    if (is_file($file)) @unlink($file);
}

function client_ip()
{
    return $_SERVER['REMOTE_ADDR'] ?? '0.0.0.0';
}
