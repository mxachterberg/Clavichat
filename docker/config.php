<?php
/**
 * ============================================================================
 *  Clavichat im Container — Einstellungen aus Umgebungsvariablen
 * ============================================================================
 *  Alle Variablen sind optional (Beispiele in compose.yaml):
 *
 *    SECURECOM_PUBLIC_URL         Adresse für Einladungslinks, z. B. https://chat.example.com/
 *    SECURECOM_ACCESS_CODE        Konto und temporäre Sitzung nur mit diesem Code
 *    SECURECOM_RETENTION_DAYS     so lange bleiben Nachrichten liegen (Standard 30)
 *    SECURECOM_TEMP_HOURS         Leerlauf, nach dem temporäre Sitzungen verschwinden (24)
 *    SECURECOM_MAX_IDENTITIES     Obergrenze aller Identitäten (2000)
 *    SECURECOM_STUN               STUN-Server, mit Komma getrennt
 *    SECURECOM_TURN_URLS          eigener TURN-Server, z. B. turn:turn.example.com:3478
 *    SECURECOM_TURN_USERNAME      … dessen Benutzername
 *    SECURECOM_TURN_CREDENTIAL    … dessen Passwort
 *    SECURECOM_CF_TURN_KEY_ID     Cloudflare Realtime TURN: Token-ID
 *    SECURECOM_CF_TURN_API_TOKEN  … und API-Token
 *    SECURECOM_TRUSTED_PROXIES    Proxys, deren X-Forwarded-For gilt (Standard: private)
 *
 *  Eine eigene config.php geht auch: per Volume nach /var/www/html/config.php.
 * ----------------------------------------------------------------------------
 */

$env = function ($name, $default = null) {
    $value = getenv($name);
    return $value === false || trim($value) === '' ? $default : trim($value);
};
$list = function ($value) {
    return array_values(array_filter(array_map('trim', explode(',', (string)$value)), 'strlen'));
};

$turn = [];
if ($env('SECURECOM_TURN_URLS')) {
    $turn[] = [
        'urls'       => $list($env('SECURECOM_TURN_URLS')),
        'username'   => (string)$env('SECURECOM_TURN_USERNAME', ''),
        'credential' => (string)$env('SECURECOM_TURN_CREDENTIAL', ''),
    ];
}

return [
    'storage_dir'              => $env('SECURECOM_STORAGE', '/data'),
    'public_url'               => (string)$env('SECURECOM_PUBLIC_URL', ''),
    // Hinter Caddy, Traefik & Co. kommen alle Anfragen aus dem Docker-Netz.
    'trusted_proxies'          => $list($env('SECURECOM_TRUSTED_PROXIES', 'private')),
    'securecom_access_code'    => (string)$env('SECURECOM_ACCESS_CODE', ''),
    'securecom_retention_days' => (int)$env('SECURECOM_RETENTION_DAYS', 30),
    'securecom_temp_hours'     => (int)$env('SECURECOM_TEMP_HOURS', 24),
    'securecom_temp_room_days' => (int)$env('SECURECOM_TEMP_ROOM_DAYS', 7),
    'securecom_max_identities' => (int)$env('SECURECOM_MAX_IDENTITIES', 2000),
    'securecom_file_max_mb'    => (int)$env('SECURECOM_FILE_MAX_MB', 25),
    'securecom_file_quota_mb'  => (int)$env('SECURECOM_FILE_QUOTA_MB', 100),
    'securecom_files_total_mb' => (int)$env('SECURECOM_FILES_TOTAL_MB', 1024),
    'securecom_stun'           => $list($env('SECURECOM_STUN', 'stun:stun.cloudflare.com:3478')),
    'securecom_turn'           => $turn,
    'securecom_cf_turn'        => $env('SECURECOM_CF_TURN_KEY_ID')
        ? ['key_id' => $env('SECURECOM_CF_TURN_KEY_ID'), 'api_token' => (string)$env('SECURECOM_CF_TURN_API_TOKEN', '')]
        : null,
];
