<?php
/**
 * ============================================================================
 *  Clavichat — kleine Helfer (eigenständige Fassung)
 * ============================================================================
 *  Dieselben Funktionsnamen wie auf achterberg.dev, damit lib/SecureCom.php
 *  in beiden Fassungen unverändert läuft.
 * ----------------------------------------------------------------------------
 */

/**
 * Einstellungen aus config.php (neben api.php) – oder aus der Datei, die
 * SECURECOM_CONFIG nennt (Windows-Server, Container). Ohne Datei:
 * Standardwerte.
 */
function cfg($key = null, $default = null)
{
    static $conf = null;
    if ($conf === null) {
        $file = getenv('SECURECOM_CONFIG') ?: __DIR__ . '/../config.php';
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

/**
 * Adresse des Besuchers (für die Rate-Limits). Hinter einem Proxy – etwa
 * im Container oder beim Windows-Server – kämen sonst alle von derselben
 * Adresse. Dem Kopf X-Forwarded-For wird aber nur geglaubt, wenn die
 * Anfrage von einem Proxy aus 'trusted_proxies' stammt.
 */
function client_ip()
{
    $ip = $_SERVER['REMOTE_ADDR'] ?? '0.0.0.0';
    if (!empty($_SERVER['HTTP_X_FORWARDED_FOR']) && from_trusted_proxy()) {
        // Den letzten Eintrag hat der eigene Proxy geschrieben; davor kann
        // ein Besucher beliebiges eintragen.
        $hops = array_map('trim', explode(',', (string)$_SERVER['HTTP_X_FORWARDED_FOR']));
        $last = (string)end($hops);
        if (filter_var($last, FILTER_VALIDATE_IP)) $ip = $last;
    }
    return $ip;
}

/**
 * 'trusted_proxies' in config.php: einzelne Adressen, Bereiche wie
 * "172.16.0.0/12" oder "private" (Loopback und private Netze).
 */
function from_trusted_proxy()
{
    $remote = (string)($_SERVER['REMOTE_ADDR'] ?? '');
    foreach ((array)cfg('trusted_proxies', []) as $range) {
        if (ip_in_range($remote, (string)$range)) return true;
    }
    return false;
}

function ip_in_range($ip, $range)
{
    if (filter_var($ip, FILTER_VALIDATE_IP) === false) return false;
    if ($range === 'private') {
        return filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE) === false;
    }
    if (strpos($range, '/') === false) return inet_pton($ip) === @inet_pton($range);
    list($net, $bits) = explode('/', $range, 2);
    $a = inet_pton($ip);
    $b = @inet_pton($net);
    $bits = (int)$bits;
    if ($b === false || strlen($a) !== strlen($b) || $bits < 0 || $bits > strlen($a) * 8) return false;
    $whole = intdiv($bits, 8);
    if (strncmp($a, $b, $whole) !== 0) return false;
    $rest = $bits % 8;
    if ($rest === 0) return true;
    $mask = (0xFF << (8 - $rest)) & 0xFF;
    return (ord($a[$whole]) & $mask) === (ord($b[$whole]) & $mask);
}
