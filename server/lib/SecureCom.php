<?php
/**
 * ============================================================================
 *  Clavichat — Ende-zu-Ende verschlüsselte Nachrichten, Anrufe und Räume.
 * ============================================================================
 *  Der Server ist hier nur Briefkasten und Vermittler. Er bekommt nie einen
 *  privaten Schlüssel, nie ein Passwort und nie einen Klartext:
 *
 *    - Direktnachrichten und Anruf-Signale sind im Browser mit OpenPGP
 *      verschlüsselt (an Empfänger + Absender) und signiert.
 *    - Räume nutzen einen symmetrischen Raumschlüssel (AES-256-GCM), den nur
 *      die Mitglieder kennen. Er steht im Einladungslink hinter dem "#" –
 *      dieser Teil einer Adresse wird nie an einen Server geschickt – oder
 *      kommt PGP-verschlüsselt vom Raumbesitzer.
 *    - Ton, Bild und Bildschirm laufen per WebRTC direkt zwischen den
 *      Geräten (DTLS-SRTP). Hier kommen nur die signierten und
 *      verschlüsselten Verbindungsangaben vorbei.
 *
 *  Was der Server sieht und speichert: zufällige Kennungen, öffentliche
 *  Schlüssel, wer online ist, welcher Briefkasten wann wie viele (auf feste
 *  Größen aufgefüllte) Einträge bekommt, und wer in welchem Raum ist. Einen
 *  Absender legt er bei Nachrichten nicht ab.
 *
 *  Konten brauchen keine E-Mail. Das Passwort verlässt den Browser nie: Dort
 *  entstehen daraus ein Anmeldeschlüssel (hier nur als Hash gespeichert) und
 *  ein Schlüssel, der den privaten PGP-Schlüssel und den Tresor einpackt.
 *  Temporäre Sitzungen erzeugen ihr Schlüsselpaar im Browser und
 *  verschwinden samt allen Daten nach der Leerlaufzeit.
 *
 *  Ablage (storage_dir()/securecom):
 *    ids/<id>.json           Identität: öffentlicher Schlüssel, signierte Karte
 *    tokens/<sha256>.json    Sitzungstoken (nur als Hash)
 *    accounts/<sha256>.json  Konto: Name, Hash des Anmeldeschlüssels,
 *                            eingepackter privater Schlüssel, Tresor
 *    inbox/<id>.jsonl|.n     Briefkasten (Einträge + Zähler)
 *    rooms/<rid>.json        Raum: Mitglieder, Einladungen, wer in welchem
 *                            Sprachkanal ist (Namen der Kanäle: verschlüsselt),
 *                            letzte Aktivität, Ränge (Kennung, Rechte, Reihenfolge,
 *                            wer welchen hat; Namen verschlüsselt) und Kanal-Rechte;
 *                            von einer temporären Sitzung
 *                            angelegt: nach tempRoomDays() ohne Aktivität weg;
 *                            Einmal-Meeting (ot): nach ONCE_IDLE weg
 *    feeds/<rid>.jsonl|.n    Verlauf eines Raums (Beiträge von API-Zugängen: k "hook")
 *    avatars/<id>.json       Profilbild eines Kontos (öffentlich wie der Name)
 *    mem/<id>.json           Räume einer Identität
 *    presence.json           zuletzt gesehen, Kartenversion, sichtbar
 *    pres/<fach>             Status eines Freundes (verschlüsselt, nur der
 *                            jüngste Stand, nach PRES_TTL Sekunden weg)
 *    temp.json               temporäre Identitäten (für das Aufräumen)
 *    guests.json             Gäste von Einmal-Meetings (für das Aufräumen)
 *
 *  Gäste: Wer einen Link zu einem Einmal-Meeting (#once=…) hat, bekommt mit
 *  der gültigen Einladung eine temporäre Identität mit Merkmal "g" – ohne
 *  Zugangscode. Gäste sind nur im Meeting: keine Online-Liste, keine Suche,
 *  keine Direktnachrichten, keine Freunde, keine eigenen Räume oder
 *  Einladungen (außer Links zu ihrem Meeting), höchstens ein Raum (und nur
 *  ein Einmal-Meeting).
 *
 *  Beitritt mit Bestätigung (nur Einmal-Meetings): Links des aktuellen
 *  Besitzers (Gastgebers) führen direkt hinein. Links von allen anderen
 *  Mitgliedern – auch Gäste dürfen in ihrem Meeting welche erstellen –
 *  stellen nur eine Anfrage (room['pend']). Der Gastgeber lässt zu oder
 *  lehnt ab (room.kick mit "pend"); unbeantwortet verfällt sie nach
 *  PEND_TTL. Wer wartet, fragt per poll ("w") nach.
 * ----------------------------------------------------------------------------
 */

class SecureComException extends RuntimeException
{
    public $status;
    public $extra;

    public function __construct($message, $status = 400, array $extra = [])
    {
        parent::__construct($message);
        $this->status = $status;
        $this->extra  = $extra;
    }
}

class SecureCom
{
    const ONLINE_WINDOW = 40;        // Sekunden seit dem letzten Abruf = online
    const SEEN_EVERY    = 12;        // "zuletzt gesehen" höchstens so oft schreiben
    const VOICE_WINDOW  = 25;        // so lange gilt jemand im Sprachkanal als da
    const SIGNAL_TTL    = 120;       // Anruf-Signale verfallen nach zwei Minuten
    const TOKEN_IDLE    = 2592000;   // Konto-Sitzungen: 30 Tage ohne Nutzung
    const DEFAULT_TTL   = 604800;    // Aufbewahrung, wenn nichts gewählt ist: 7 Tage
    // Räume „Permanent“: 100 Jahre. Ein großer Wert statt 0 – ältere Apps (bis
    // 1.8.8) rechnen damit wie mit ihrer Höchstgrenze (30 Tage) weiter.
    const PERMANENT     = 3153600000;
    const PRES_TTL      = 150;       // Status-Fach eines Freundes: so lange gilt der letzte Stand
    const MAX_PRES      = 512;       // verschlüsselter Status (Base64)
    const MAX_SLOTS     = 200;       // Fächer je Aufruf (schreiben, lesen, löschen)
    const ACTIVE_EVERY  = 3600;      // letzte Aktivität eines Raums höchstens stündlich schreiben
    const ONCE_IDLE     = 43200;     // Einmal-Meeting: 12 Stunden ohne Aktivität, dann weg
    const GUEST_IDLE    = 7200;      // Gäste: zwei Stunden ohne Abruf, dann weg (Tab zu)
    const GUEST_GRACE   = 600;       // Gäste ohne Meeting (verlassen, beendet): nach zehn Minuten weg
    const PEND_TTL      = 600;       // Beitrittsanfrage an den Gastgeber: zehn Minuten, dann verfallen
    const DENY_KEEP     = 600;       // so lange erfährt, wer abgelehnt wurde, davon
    const MAX_PEND      = 20;        // offene Beitrittsanfragen je Meeting

    const MAX_ENTRY     = 98304;     // verschlüsselter Eintrag (Base64)
    const MAX_HOOK      = 22000;     // Beitrag eines API-Zugangs (Base64; 16 KB Klartext, aufgefüllt)
    const MAX_HOOKS     = 5;         // API-Zugänge je Raum
    const HOOK_SEEN     = 60;        // "zuletzt benutzt" höchstens so oft schreiben
    const MAX_CTTL      = 30;        // Textkanäle mit eigener Aufbewahrung je Raum (wie Kanäle höchstens)
    const MAX_TAG       = 50000;     // Einträge, die room.cttl nachträglich einem Kanal zuordnet
    const MAX_DEL       = 200;       // Einträge je room.del (Nachricht samt Änderungen)
    const MAX_ROLES     = 20;        // Ränge je Raum
    const MAX_CPERM     = 50;        // Kanäle mit eigenen Rechten (Schreiben bzw. Betreten) je Raum

    // Rechte (Bits) – an Discord angelehnt. Der Besitzer hat immer alle;
    // Schlüssel (erneuern, an neue Mitglieder verteilen), „Nur Konten“,
    // Beitrittsanfragen und Raum löschen bleiben trotzdem bei ihm allein.
    const P_SEND      = 1;      // Nachrichten schreiben
    const P_REACT     = 2;      // auf Nachrichten reagieren
    const P_VOICE     = 4;      // Sprachkanäle betreten
    const P_INVITE    = 8;      // nur noch in Einmal-Meetings: Links teilen (sonst laden Besitzer und Administratoren ein)
    const P_CHANNELS  = 16;     // Kanäle anlegen/umbenennen/löschen/verschieben, Kanal-Aufbewahrung und -Rechte
    const P_ROOM      = 32;     // Name, Bild, Aufbewahrung, Sprachqualität des Raums
    const P_MESSAGES  = 64;     // fremde Nachrichten löschen (room.del)
    const P_KICK      = 128;    // Mitglieder entfernen (nur unterhalb des eigenen Rangs)
    const P_HOOKS     = 256;    // API-Zugänge
    const P_ROLES     = 512;    // Ränge unterhalb des eigenen verwalten und vergeben
    const P_ADMIN     = 1024;   // alle Rechte, Kanal-Beschränkungen gelten nicht
    const P_ALL       = 2047;
    const P_BASE      = 15;     // Rang „@alle“ ohne eigene Einstellung: schreiben, reagieren, Sprache (+ Bit 8, ohne Wirkung außer in Meetings)
    // Wer davon eins hat, darf die (verschlüsselten) Raumdaten neu schreiben.
    const P_META      = self::P_CHANNELS | self::P_ROOM | self::P_HOOKS | self::P_ROLES | self::P_ADMIN;
    const MAX_SIGNAL    = 49152;
    const MAX_REACT     = 4096;      // Reaktion ohne Schreibrecht (verschlüsselt, Base64) – echte sind gut 1 KB
    // Anruf-Signale im Raumverlauf: je Fenster (SIGNAL_TTL) höchstens so viele
    // Byte je Absender bzw. je Raum. Sie verfallen nach zwei Minuten und
    // dürfen ältere Nachrichten nie verdrängen (siehe dropOldest).
    const SIG_SENDER    = 1572864;   // 1,5 MB: ein voller Sprachkanal (8) samt Neuverbindungen
    const SIG_ROOM      = 6291456;   // 6 MB
    const RATE_KEEP     = 172800;    // Ratenbegrenzung: Dateien ohne Treffer seit zwei Tagen weg (größtes Fenster: 1 Tag)
    const MAX_CARD      = 4096;
    const MAX_PUB       = 16384;
    const MAX_WRAPPED   = 65536;
    const MAX_VAULT     = 524288;
    const MAX_META      = 65536;     // Raumdaten samt Raumbild (verschlüsselt)
    const MAX_AVATAR    = 65536;     // Profilbild (Base64)
    const MAX_INBOX     = 8388608;   // 8 MB je Briefkasten
    const MAX_FEED      = 16777216;  // 16 MB je Raum
    const MAX_ROOMS     = 20;        // Räume je Identität
    const MAX_MEMBERS   = 50;
    const MAX_VOICE     = 8;         // Direktverbindungen: jeder mit jedem
    const MAX_TOKENS    = 10;        // angemeldete Geräte je Konto
    const MAX_DEVICES   = 50;        // gemerkte Geräte-Kennungen (bekannt bzw. abgemeldet)
    const FILE_CHUNK    = 524288;    // Dateistück im Klartext; verschlüsselt 16 Byte mehr
    const PAGE          = 250;       // Einträge je Abruf
    const PAGE_BYTES    = 1500000;

    /** bcrypt-Kosten wie bei den Budgetmaxxer-Konten. */
    const HASH_OPTS = ['cost' => 12];

    const RESERVED = ['admin', 'administrator', 'root', 'system', 'securecom',
                      'support', 'moderator', 'mod', 'server', 'hetzner', 'clavichat'];

    /* ======================================================================
       Einstellungen (config.php; alle mit Standardwert, weil config.php auf
       dem Server nicht überschrieben wird)
       ====================================================================== */
    public static function retentionDays()
    {
        return max(1, min(365, (int)cfg('securecom_retention_days', 30)));
    }

    public static function tempHours()
    {
        return max(1, min(168, (int)cfg('securecom_temp_hours', 24)));
    }

    /** Räume aus temporären Sitzungen: so viele Tage ohne Aktivität, dann weg. */
    public static function tempRoomDays()
    {
        return max(1, min(365, (int)cfg('securecom_temp_room_days', 7)));
    }

    /**
     * Raumverlauf „Permanent“: höchstens so viele Megabyte (Standard 16 wie
     * jeder Verlauf); ist er voll, fallen die ältesten Nachrichten weg.
     */
    public static function permanentBytes()
    {
        return max(1, min(64, (int)cfg('securecom_permanent_mb', 16))) * 1048576;
    }

    /**
     * Raumverlauf „Permanent“: so viele Megabyte darf ein Mitglied (bzw. ein
     * API-Zugang) je Stunde anhängen (Standard 2). Ohne Grenze könnte ein
     * einzelnes Mitglied den ganzen Verlauf in Minuten hinausdrängen.
     */
    public static function memberHourBytes()
    {
        return max(1, min(64, (int)cfg('securecom_permanent_member_mb', 2))) * 1048576;
    }

    public static function accessCode()
    {
        return trim((string)cfg('securecom_access_code', ''));
    }

    public static function maxIdentities()
    {
        return max(10, (int)cfg('securecom_max_identities', 2000));
    }

    /** Dateien (MB): größte Datei, Speicher je Identität, alle zusammen. */
    public static function fileMaxBytes()
    {
        return max(1, min(100, (int)cfg('securecom_file_max_mb', 25))) * 1048576;
    }

    public static function fileQuotaBytes()
    {
        return max(1, min(10240, (int)cfg('securecom_file_quota_mb', 100))) * 1048576;
    }

    public static function filesTotalBytes()
    {
        return max(10, min(102400, (int)cfg('securecom_files_total_mb', 1024))) * 1048576;
    }

    /** Öffentliche Angaben für den Browser: Verbindungsserver und Grenzen. */
    /**
     * Öffentliche Angaben (vor der Anmeldung): nur STUN. Zugangsdaten eines
     * Relay-Servers (TURN) gibt es erst nach der Anmeldung über "ice" – sonst
     * könnte jeder fremde Datenverkehr über das eigene TURN-Kontingent leiten.
     */
    public static function config()
    {
        return [
            'ice'            => self::iceServers(false),
            'relay'          => self::hasRelay(),
            'retention_days' => self::retentionDays(),      // höchste Aufbewahrung
            'default_ttl'    => min(self::DEFAULT_TTL, self::retentionDays() * 86400),
            'temp_hours'     => self::tempHours(),
            'temp_room_days' => self::tempRoomDays(),
            'once_hours'     => self::ONCE_IDLE / 3600,      // Einmal-Meetings: Ruhezeit bis zum Löschen
            'access'       => self::accessCode() !== '' ? 'code' : 'open',
            // Anmelden mit dem Postfach: Adresse, unter der das Dashboard von
            // achterberg.dev Tickets ausstellt (siehe ssoTicket). Sonst leer.
            'sso'            => defined('CLAVICHAT_SSO') ? (string)CLAVICHAT_SSO : '',
            'file_max'       => self::fileMaxBytes(),        // Dateien: größte, Stückgröße
            'file_chunk'     => self::FILE_CHUNK,
            'permanent'      => self::PERMANENT,             // Räume: Aufbewahrung „Permanent“ (ttl-Wert)
            'permanent_mb'   => self::permanentBytes() / 1048576,
            'hooks'          => self::MAX_HOOKS,             // API-Zugänge je Raum
            'cttl'           => self::MAX_CTTL,              // Aufbewahrung je Textkanal (room.cttl)
            'rdel'           => self::MAX_DEL,               // Besitzer entfernt Raumnachrichten (room.del)
            'roles'          => self::MAX_ROLES,             // Ränge und Rechte (role.*, room.cperm)
            'limits'         => [
                'voice'   => self::MAX_VOICE,
                'members' => self::MAX_MEMBERS,
                'rooms'   => self::MAX_ROOMS,
            ],
        ];
    }

    /**
     * STUN (eigene öffentliche Adresse herausfinden) und optional TURN
     * (Weiterleitung, wenn keine direkte Verbindung zustande kommt).
     *
     *   'securecom_stun'    => ['stun:stun.cloudflare.com:3478']
     *   'securecom_turn'    => [['urls' => 'turn:…', 'username' => '…', 'credential' => '…']]
     *   'securecom_cf_turn' => ['key_id' => '…', 'api_token' => '…']   Cloudflare Realtime
     */
    /** Verbindungsserver; mit $withTurn auch Relay-Server samt Zugangsdaten. */
    public static function iceServers($withTurn = true)
    {
        $list = [];
        $stun = cfg('securecom_stun', ['stun:stun.cloudflare.com:3478']);
        if (is_string($stun)) $stun = [$stun];
        $stun = array_values(array_filter((array)$stun, 'is_string'));
        if ($stun) $list[] = ['urls' => $stun];
        if (!$withTurn) return $list;

        foreach ((array)cfg('securecom_turn', []) as $turn) {
            if (!is_array($turn) || empty($turn['urls'])) continue;
            $entry = ['urls' => $turn['urls']];
            if (isset($turn['username']))   $entry['username']   = (string)$turn['username'];
            if (isset($turn['credential'])) $entry['credential'] = (string)$turn['credential'];
            $list[] = $entry;
        }

        $cf = self::cloudflareConfig();
        if ($cf) {
            foreach (self::cloudflareTurn($cf['key_id'], $cf['api_token']) as $server) $list[] = $server;
        }
        return $list;
    }

    /** Ist ein Relay-Server eingetragen? (ohne Cloudflare zu fragen) */
    public static function hasRelay()
    {
        foreach ((array)cfg('securecom_turn', []) as $turn) {
            if (is_array($turn) && !empty($turn['urls'])) return true;
        }
        return self::cloudflareConfig() !== null;
    }

    /**
     * Cloudflare-Zugang: aus der Konfiguration oder – auf achterberg.dev –
     * aus einer eigenen kleinen Datei (CLAVICHAT_TURN_FILE), in die man nur
     * die beiden Werte einträgt. Ein Tippfehler dort schaltet nur das Relay
     * ab, nicht die ganze Seite.
     */
    private static function cloudflareConfig()
    {
        $cf = cfg('securecom_cf_turn', null);
        if (!is_array($cf) && defined('CLAVICHAT_TURN_FILE') && is_file(CLAVICHAT_TURN_FILE)) {
            try {
                $cf = include CLAVICHAT_TURN_FILE;
            } catch (Throwable $ex) {
                error_log('[securecom] TURN-Datei: ' . $ex->getMessage());
                $cf = null;
            }
        }
        if (!is_array($cf)) return null;
        $id    = trim((string)($cf['key_id'] ?? ''));
        $token = trim((string)($cf['api_token'] ?? ''));
        return $id !== '' && $token !== '' ? ['key_id' => $id, 'api_token' => $token] : null;
    }

    /** Kurzlebige TURN-Zugangsdaten bei Cloudflare holen und 12 h merken. */
    /**
     * Kurzlebige Zugangsdaten von Cloudflare Realtime TURN (12 Stunden
     * zwischengespeichert). Cloudflare antwortet je nach Schnittstelle mit
     * einem Server-Eintrag oder einer Liste – beides wird zu einer Liste.
     */
    private static function cloudflareTurn($keyId, $token)
    {
        $cache = self::dir() . '/turn-cache.json';
        $data  = self::readJson($cache);
        if ($data && ($data['x'] ?? 0) > time() && isset($data['list'])) return (array)$data['list'];
        if (!function_exists('curl_init')) return [];

        $ch = curl_init('https://rtc.live.cloudflare.com/v1/turn/keys/' . rawurlencode($keyId) . '/credentials/generate');
        curl_setopt_array($ch, [
            CURLOPT_POST           => true,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT        => 5,
            CURLOPT_HTTPHEADER     => ['Authorization: Bearer ' . $token, 'Content-Type: application/json'],
            CURLOPT_POSTFIELDS     => json_encode(['ttl' => 86400]),
        ]);
        // Windows (Clavichat Server): Zertifikate aus der Windows-Ablage prüfen.
        if (PHP_OS_FAMILY === 'Windows' && defined('CURLSSLOPT_NATIVE_CA')) {
            curl_setopt($ch, CURLOPT_SSL_OPTIONS, CURLSSLOPT_NATIVE_CA);
        }
        $raw  = curl_exec($ch);
        $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);
        $json = is_string($raw) ? json_decode($raw, true) : null;
        if ($code < 200 || $code >= 300 || !is_array($json) || empty($json['iceServers'])) {
            error_log('[securecom] Cloudflare TURN: HTTP ' . $code);
            return [];
        }
        $servers = isset($json['iceServers']['urls']) ? [$json['iceServers']] : (array)$json['iceServers'];
        $list = [];
        foreach ($servers as $server) {
            if (!is_array($server) || empty($server['urls']) || empty($server['username'])) continue;
            // Nur die TURN-Adressen – STUN steht schon in der Liste.
            $urls = array_values(array_filter((array)$server['urls'], function ($u) {
                return is_string($u) && stripos($u, 'turn') === 0;
            }));
            if ($urls) $list[] = ['urls' => $urls, 'username' => (string)$server['username'], 'credential' => (string)($server['credential'] ?? '')];
        }
        if ($list) self::writeJson($cache, ['x' => time() + 43200, 'list' => $list]);
        return $list;
    }

    /* ======================================================================
       Konten und Sitzungen
       ====================================================================== */
    public static function register(array $b)
    {
        // Mit Postfach-Ticket (achterberg.dev) ist das Postfach bestätigt –
        // dann braucht es keinen Zugangscode. Ein Konto je Postfach.
        $mailbox = self::str($b, 'sso') !== '' ? self::ssoMailbox(self::str($b, 'sso')) : null;
        if ($mailbox === null) self::checkAccess($b);
        $username = trim(self::str($b, 'username'));
        if (!preg_match('/^[A-Za-z0-9][A-Za-z0-9_.-]{2,23}$/', $username)) {
            throw new SecureComException('Der Name braucht 3–24 Zeichen: Buchstaben, Ziffern, Punkt, Strich, Unterstrich.', 422);
        }
        if (in_array(strtolower($username), self::RESERVED, true)) {
            throw new SecureComException('Dieser Name ist reserviert.', 422);
        }
        $auth = self::hex64(self::str($b, 'auth'));
        $id   = self::idOf(self::str($b, 'id'));
        $pub  = self::pubKey(self::str($b, 'pub'));
        $fp   = self::fingerprint(self::str($b, 'fp'));
        $card = self::b64(self::str($b, 'card'), self::MAX_CARD, 'Karte');
        $wrap = self::b64(self::str($b, 'wrapped'), self::MAX_WRAPPED, 'Schlüssel');
        $vault = self::str($b, 'vault') === '' ? '' : self::b64(self::str($b, 'vault'), self::MAX_VAULT, 'Tresor');
        self::checkCapacity();

        // Verknüpfung zum Postfach zuerst und exklusiv anlegen: Zwei
        // gleichzeitige Anmeldungen ergeben so nie zwei Konten.
        $link = null;
        if ($mailbox !== null) {
            $link = self::ssoFile($mailbox);
            $old = self::readJson($link);
            if ($old && is_string($old['u'] ?? null) && is_file(self::accountFile($old['u']))) {
                throw new SecureComException('Zu diesem Postfach gibt es schon ein Clavichat-Konto („' . $old['u'] . '“). Melde dich damit an.', 409);
            }
            if ($old) @unlink($link);   // Konto gibt es nicht mehr
            $h = @fopen($link, 'x');
            if (!$h) throw new SecureComException('Zu diesem Postfach wird gerade schon ein Konto angelegt.', 409);
            fclose($h);
        }

        $file = self::accountFile($username);
        $h = @fopen($file, 'x');
        if (!$h) {
            if ($link) @unlink($link);
            throw new SecureComException('Dieser Name ist schon vergeben.', 409);
        }
        fclose($h);

        try {
            self::createIdentity($id, 'account', $pub, $fp, $card, $username);
        } catch (Throwable $ex) {
            @unlink($file);
            if ($link) @unlink($link);
            throw $ex;
        }
        $account = [
            'u'     => $username,
            'id'    => $id,
            'auth'  => password_hash($auth, PASSWORD_DEFAULT, self::HASH_OPTS),
            'w'     => $wrap,
            'vault' => $vault,
            'vv'    => 1,
            'c'     => time(),
        ];
        if ($mailbox !== null) $account['sso'] = hash('sha256', $mailbox);   // nur der Hash des Postfachs
        self::writeJson($file, $account);
        if ($link) self::writeJson($link, ['u' => $username, 'c' => time()]);
        $token = self::issueToken($id, self::devOf($b));
        return ['token' => $token, 'id' => $id, 'kind' => 'account', 'username' => $username, 'vv' => 1, 'tv' => 1];
    }

    public static function login(array $b)
    {
        $username = trim(self::str($b, 'username'));
        $auth     = self::str($b, 'auth');
        $acc      = self::readJson(self::accountFile($username));
        // Gleiche Antwort für "gibt es nicht" und "falsches Passwort".
        if (!$acc || !preg_match('/^[0-9a-f]{64}$/', $auth) || !password_verify($auth, (string)$acc['auth'])) {
            throw new SecureComException('Name, Passwort oder Code stimmen nicht.', 401);
        }
        $ident = self::identity($acc['id']);
        if (!$ident) throw new SecureComException('Das Konto ist beschädigt.', 500);

        // Aus der Ferne abgemeldetes Gerät: Still (mit gespeichertem Code)
        // kommt es nicht wieder rein – wer Passwort oder Code eintippt, schon.
        $dev = self::devOf($b);
        if ($dev !== '' && in_array($dev, (array)($ident['rev'] ?? []), true)) {
            if (!empty($b['silent'])) {
                throw new SecureComException('Dieses Gerät wurde aus deinem Konto abgemeldet. Melde dich neu an.', 403, ['revoked' => true]);
            }
            self::mutate(self::idFile($acc['id']), function (&$i) use ($dev) {
                if ($i) $i['rev'] = array_values(array_diff((array)($i['rev'] ?? []), [$dev]));
            });
        }

        if (password_needs_rehash($acc['auth'], PASSWORD_DEFAULT, self::HASH_OPTS)) {
            self::mutate(self::accountFile($username), function (&$a) use ($auth) {
                if ($a) $a['auth'] = password_hash($auth, PASSWORD_DEFAULT, self::HASH_OPTS);
            });
        }
        $token = self::issueToken($acc['id'], $dev);
        $after = self::identity($acc['id']);
        return [
            'tv'       => (int)($after['tv'] ?? 0),
            'token'    => $token,
            'id'       => $acc['id'],
            'kind'     => 'account',
            'username' => $acc['u'],
            'wrapped'  => $acc['w'],
            'vault'    => (string)($acc['vault'] ?? ''),
            'vv'       => (int)($acc['vv'] ?? 1),
            'pub'      => $ident['pub'],
            'card'     => $ident['card'],
            'vis'      => self::listed($ident),
        ];
    }

    /**
     * Temporäre Sitzung. Mit "guest" (dazu "room" und "code") als Gast eines
     * Einmal-Meetings: Die gültige Einladung ersetzt den Zugangscode – der
     * Gast kommt damit aber nur in dieses eine Meeting (siehe guestOnly()).
     */
    public static function startTemp(array $b)
    {
        $guest = !empty($b['guest']);
        if ($guest) self::checkGuestInvite(self::str($b, 'room'), self::str($b, 'code'));
        else self::checkAccess($b);
        $id   = self::idOf(self::str($b, 'id'));
        $pub  = self::pubKey(self::str($b, 'pub'));
        $fp   = self::fingerprint(self::str($b, 'fp'));
        $card = self::b64(self::str($b, 'card'), self::MAX_CARD, 'Karte');
        self::checkCapacity();

        self::createIdentity($id, 'temp', $pub, $fp, $card, null, $guest ? ['g' => 1, 'vis' => false] : []);
        self::mutate(self::dir() . '/temp.json', function (&$t) use ($id) {
            if (!is_array($t)) $t = [];
            $t[$id] = time();
        });
        if ($guest) {
            self::mutate(self::dir() . '/guests.json', function (&$g) use ($id) {
                if (!is_array($g)) $g = [];
                $g[$id] = time();
            });
        }
        $token = self::issueToken($id);
        return ['token' => $token, 'id' => $id, 'kind' => 'temp', 'guest' => $guest, 'exp' => time() + self::tempHours() * 3600];
    }

    /** Gast: Gibt es das Einmal-Meeting, und gilt die Einladung noch? */
    private static function checkGuestInvite($rid, $code)
    {
        $bad = new SecureComException('Dieser Meeting-Link ist ungültig oder abgelaufen.', 403);
        if (!preg_match('/^[A-Za-z0-9_-]{22}$/', $rid) || !preg_match('/^[A-Za-z0-9_-]{22}$/', $code)) throw $bad;
        $room = self::readJson(self::roomFile($rid), true);
        if (!$room || empty($room['ot']) || !self::inviteValid($room, $code)) throw $bad;
        if (count((array)$room['mem']) >= self::MAX_MEMBERS) throw new SecureComException('Das Meeting ist voll.', 409);
    }

    private static function inviteValid(array $room, $code)
    {
        $inv = is_string($code) ? ($room['inv'][$code] ?? null) : null;
        return is_array($inv) && self::inviteOpen($room, $inv);
    }

    /**
     * Offen und gültig: nicht abgelaufen, nicht aufgebraucht – und (außer in
     * Einmal-Meetings) vom Besitzer oder einem Administrator erstellt, und
     * zwar nach heutigem Stand. Links von Mitgliedern, die nicht (mehr)
     * Administrator sind, gelten nicht (auch ältere von vor dieser Regel).
     */
    private static function inviteOpen(array $room, array $inv)
    {
        if ((int)($inv['x'] ?? 0) < time() || (int)($inv['n'] ?? 0) >= (int)($inv['max'] ?? 0)) return false;
        return !empty($room['ot']) || self::isAdmin($room, (string)($inv['b'] ?? ''));
    }

    /** Besitzer oder Rang mit „Administrator“ (nur sie laden in Räume ein). */
    private static function isAdmin(array $room, $id)
    {
        if ($id === '' || !isset($room['mem'][$id])) return false;
        return $room['o'] === $id || (bool)(self::permsOf($room, $id) & self::P_ADMIN);
    }

    /**
     * Einladungen, deren Ersteller nicht (mehr) einladen darf, entfernen –
     * bei jedem Schreibzugriff auf den Raum (roomMutate). Einmal-Meetings
     * nicht: Dort teilen Teilnehmer Links, der Gastgeber bestätigt.
     */
    private static function dropForeignInvites(array &$room)
    {
        if (!empty($room['ot']) || empty($room['inv']) || !is_array($room['inv'])) return;
        foreach ($room['inv'] as $code => $inv) {
            if (!is_array($inv) || !self::isAdmin($room, (string)($inv['b'] ?? ''))) unset($room['inv'][$code]);
        }
    }

    private static function isGuest(array $ident)
    {
        return !empty($ident['g']);
    }

    /** Gäste eines Einmal-Meetings dürfen das nicht (Antwort 403). */
    private static function guestOnly(array $me, $message)
    {
        if (self::isGuest($me)) throw new SecureComException($message, 403);
    }

    /* ======================================================================
       Anmelden mit dem Postfach von achterberg.dev
       ----------------------------------------------------------------------
       Das Dashboard stellt angemeldeten Postfächern ein Ticket aus
       (app/clavichat/sso.php): Postfach, Ablauf und ein Zufallswert,
       signiert mit HMAC-SHA-256. Der Schlüssel dafür ist aus dem geheimen
       Server-Schlüssel abgeleitet und verlässt den Server nie. Ein Ticket
       gilt fünf Minuten und nur einmal. Es bestätigt nur das Postfach – den
       privaten Schlüssel schützt beim Konto weiter ein Geheimnis, das nur
       der Browser kennt (hier: ein Wiederherstellungscode statt Passwort).
       Eigenständige Server ohne Dashboard stellen keine Tickets aus.
       ====================================================================== */
    const SSO_TTL = 300;

    /** Für das Dashboard: Ticket für das angemeldete Postfach. */
    public static function ssoTicket($mailbox)
    {
        $mailbox = strtolower(trim((string)$mailbox));
        if ($mailbox === '' || strlen($mailbox) > 254 || strpos($mailbox, '@') === false) {
            throw new SecureComException('Kein Postfach angemeldet.', 401);
        }
        $payload = self::urlB64(json_encode(['v' => 1, 'm' => $mailbox, 'e' => time() + self::SSO_TTL,
                                             'n' => self::urlB64(random_bytes(16))]));
        return [
            'ticket'  => $payload . '.' . self::urlB64(hash_hmac('sha256', $payload, self::ssoKey(), true)),
            'mailbox' => $mailbox,
            'name'    => self::nameFromMailbox($mailbox),
        ];
    }

    /** Neues Gerät: Welches Konto gehört zu diesem Postfach? */
    public static function ssoWho(array $b)
    {
        $mailbox = self::ssoMailbox(self::str($b, 'sso'));
        $link = self::readJson(self::ssoFile($mailbox));
        $user = $link && is_string($link['u'] ?? null) && is_file(self::accountFile($link['u'])) ? $link['u'] : null;
        return ['username' => $user, 'name' => self::nameFromMailbox($mailbox)];
    }

    /** Ticket prüfen: Signatur, Ablauf, nur einmal. Gibt das Postfach. */
    private static function ssoMailbox($ticket)
    {
        $parts = explode('.', (string)$ticket);
        if (count($parts) !== 2 || strlen($parts[0]) > 600
            || !hash_equals(self::urlB64(hash_hmac('sha256', $parts[0], self::ssoKey(), true)), $parts[1])) {
            throw new SecureComException('Die Bestätigung von achterberg.dev ist ungültig.', 403);
        }
        $t = json_decode((string)self::urlB64Decode($parts[0]), true);
        if (!is_array($t) || ($t['v'] ?? 0) !== 1 || !is_string($t['m'] ?? null) || !is_string($t['n'] ?? null)
            || (int)($t['e'] ?? 0) < time()) {
            throw new SecureComException('Die Bestätigung von achterberg.dev ist abgelaufen – bitte noch einmal.', 403);
        }
        // Jedes Ticket nur einmal; die Liste behält nur noch nicht abgelaufene.
        $fresh = false;
        self::mutate(self::dir() . '/sso-used.json', function (&$used) use ($t, &$fresh) {
            if (!is_array($used)) $used = [];
            $now = time();
            foreach ($used as $n => $until) {
                if ((int)$until < $now) unset($used[$n]);
            }
            if (isset($used[$t['n']])) return;
            $used[$t['n']] = (int)$t['e'];
            $fresh = true;
        });
        if (!$fresh) throw new SecureComException('Diese Bestätigung wurde schon benutzt – bitte noch einmal.', 403);
        return $t['m'];
    }

    /** Eigener Schlüssel für die Tickets, abgeleitet vom geheimen Server-Schlüssel. */
    private static function ssoKey()
    {
        return hash_hmac('sha256', 'clavichat-sso-v1', app_key(), true);
    }

    private static function ssoFile($mailbox)
    {
        return self::dir('sso') . '/' . hash('sha256', $mailbox) . '.json';
    }

    /** Vorschlag für den Kontonamen: der Teil vor dem @, auf erlaubte Zeichen gekürzt. */
    private static function nameFromMailbox($mailbox)
    {
        $local = (string)strstr($mailbox, '@', true);
        $name = ltrim((string)preg_replace('/[^A-Za-z0-9_.-]/', '', $local), '_.-');
        return substr($name, 0, 24);
    }

    private static function urlB64($bin)
    {
        return rtrim(strtr(base64_encode($bin), '+/', '-_'), '=');
    }

    private static function urlB64Decode($text)
    {
        $text = strtr((string)$text, '-_', '+/');
        return base64_decode($text . str_repeat('=', (4 - strlen($text) % 4) % 4), true);
    }

    /** Sitzung aus dem Kopf "X-SC-Token". Gibt die Identität zurück. */
    public static function authenticate($token)
    {
        if (!is_string($token) || !preg_match('/^[A-Za-z0-9_-]{43}$/', $token)) {
            throw new SecureComException('Nicht angemeldet.', 401);
        }
        $file = self::dir('tokens') . '/' . hash('sha256', $token) . '.json';
        $tok  = self::readJson($file);
        if (!$tok) throw new SecureComException('Die Sitzung ist abgelaufen.', 401);
        if (!empty($tok['x'])) {
            // Grabstein (revokeToken): Das Gerät soll erfahren, warum es draußen ist.
            throw new SecureComException('Dieses Gerät wurde aus deinem Konto abgemeldet.', 401, ['revoked' => true]);
        }

        $ident = self::identity($tok['id']);
        if (!$ident) {
            @unlink($file);
            throw new SecureComException('Die Sitzung ist abgelaufen.', 401);
        }
        $now = time();
        if ($ident['k'] === 'account' && $now - (int)($tok['s'] ?? 0) > self::TOKEN_IDLE) {
            self::dropToken($ident['id'], hash('sha256', $token));
            throw new SecureComException('Die Sitzung ist abgelaufen.', 401);
        }
        if ($ident['k'] === 'account' && $now - (int)($tok['s'] ?? 0) > 86400) {
            self::mutate($file, function (&$t) use ($now) { if ($t) $t['s'] = $now; });
        }
        $ident['_th'] = hash('sha256', $token);
        return $ident;
    }

    public static function me(array $me)
    {
        $out = self::publicIdentity($me, true);
        $out['kind'] = $me['k'];
        $out['guest'] = self::isGuest($me);
        if ($me['k'] === 'temp') $out['exp'] = self::lastSeen($me['id']) + self::tempHours() * 3600;
        if ($me['k'] === 'account') {
            // Hat diese Sitzung schon einen (verschlüsselten) Gerätenamen?
            $tok = self::readJson(self::dir('tokens') . '/' . $me['_th'] . '.json');
            $out['dl'] = !empty($tok['n']);
        }
        return $out;
    }

    public static function logout(array $me)
    {
        self::dropToken($me['id'], $me['_th']);
    }

    /** Temporäre Sitzung beenden: alles löschen, was dazugehört. */
    public static function endTemp(array $me)
    {
        if ($me['k'] !== 'temp') throw new SecureComException('Nur für temporäre Sitzungen.', 400);
        self::purgeIdentity($me['id']);
    }

    public static function deleteAccount(array $me, array $b)
    {
        $acc = self::accountFor($me);
        if (!password_verify(self::str($b, 'auth'), (string)$acc['auth'])) {
            throw new SecureComException('Passwort oder Code stimmen nicht.', 403);
        }
        self::purgeIdentity($me['id']);
    }

    public static function changePassword(array $me, array $b)
    {
        $acc = self::accountFor($me);
        if (!password_verify(self::str($b, 'old_auth'), (string)$acc['auth'])) {
            throw new SecureComException('Bisheriges Passwort oder Code stimmen nicht.', 403);
        }
        $auth  = self::hex64(self::str($b, 'auth'));
        $wrap  = self::b64(self::str($b, 'wrapped'), self::MAX_WRAPPED, 'Schlüssel');
        $vault = self::str($b, 'vault') === '' ? '' : self::b64(self::str($b, 'vault'), self::MAX_VAULT, 'Tresor');
        $vv = 0;
        self::mutate(self::accountFile($acc['u']), function (&$a) use ($auth, $wrap, $vault, &$vv) {
            $a['auth']  = password_hash($auth, PASSWORD_DEFAULT, self::HASH_OPTS);
            $a['w']     = $wrap;
            $a['vault'] = $vault;
            $a['vv']    = $vv = (int)($a['vv'] ?? 1) + 1;
        });
        // Alle anderen Geräte abmelden – sie kennen den alten Schlüssel.
        $ident = self::identity($me['id']);
        foreach ((array)($ident['tok'] ?? []) as $th) {
            if ($th !== $me['_th']) self::dropToken($me['id'], $th);
        }
        return ['vv' => $vv];
    }

    /** Tresor (Kontakte, Raumschlüssel) – verschlüsselt, mit Versionsprüfung. */
    public static function saveVault(array $me, array $b)
    {
        $acc   = self::accountFor($me);
        $vault = self::b64(self::str($b, 'vault'), self::MAX_VAULT, 'Tresor');
        $expected = (int)($b['vv'] ?? 0);
        $result = null;
        self::mutate(self::accountFile($acc['u']), function (&$a) use ($vault, $expected, &$result) {
            $current = (int)($a['vv'] ?? 1);
            if ($expected !== $current) {
                $result = ['conflict' => true, 'vault' => (string)($a['vault'] ?? ''), 'vv' => $current];
                return;
            }
            $a['vault'] = $vault;
            $a['vv']    = $current + 1;
            $result = ['vv' => $current + 1];
        });
        if (!empty($result['conflict'])) {
            throw new SecureComException('Der Tresor wurde auf einem anderen Gerät geändert.', 409,
                ['vault' => $result['vault'], 'vv' => $result['vv']]);
        }
        return $result;
    }

    public static function loadVault(array $me)
    {
        $acc = self::accountFor($me);
        return ['vault' => (string)($acc['vault'] ?? ''), 'vv' => (int)($acc['vv'] ?? 1)];
    }

    /** Karte (Name/Alias, signiert) und Sichtbarkeit (nur temporär) ändern. */
    public static function updateCard(array $me, array $b)
    {
        $card = self::str($b, 'card');
        $vis  = array_key_exists('vis', $b) ? !empty($b['vis']) : null;
        if ($card !== '') $card = self::b64($card, self::MAX_CARD, 'Karte');
        $out = null;
        self::mutate(self::idFile($me['id']), function (&$i) use ($card, $vis, &$out) {
            if (!$i) return;
            if ($card !== '') { $i['card'] = $card; $i['cv'] = (int)($i['cv'] ?? 1) + 1; }
            if ($vis !== null && $i['k'] === 'temp') $i['vis'] = $vis;
            $out = $i;
        });
        if (!$out) throw new SecureComException('Identität nicht gefunden.', 404);
        self::touchPresence($out, true);
        return ['cv' => (int)$out['cv'], 'vis' => self::listed($out)];
    }

    /* ======================================================================
       Forward Secrecy: Die Geräte hängen regelmäßig einen neuen
       Verschlüsselungs-Unterschlüssel an und löschen alte, sobald alles damit
       Verschlüsselte abgelaufen ist. Der Hauptschlüssel (Fingerabdruck) bleibt.
       ====================================================================== */
    /**
     * Nur ein Gerät eines Kontos wechselt gleichzeitig – sonst entstünden zwei
     * neue Unterschlüssel und eins der Geräte kennte den des anderen nicht.
     * Die Sperre gilt zwei Minuten (oder bis zum neuen Schlüssel).
     */
    public static function keyLease(array $me)
    {
        $now = time();
        $ok = self::mutate(self::idFile($me['id']), function (&$i) use ($now) {
            if (!$i || (int)($i['kl'] ?? 0) > $now) return false;
            $i['kl'] = $now + 120;
            return true;
        });
        return ['lease' => (bool)$ok];   // nicht 'ok': das setzt api.php schon
    }

    /**
     * Neuer öffentlicher Schlüssel: gleicher Hauptschlüssel, andere
     * Unterschlüssel. Ob der Schlüssel wirklich zum Fingerabdruck passt,
     * prüfen die anderen Geräte selbst (resolveIdentity) – passt er nicht,
     * gilt die Identität dort als ungültig.
     */
    public static function updateKey(array $me, array $b)
    {
        $pub = self::pubKey(self::str($b, 'pub'));
        $fp  = self::fingerprint(self::str($b, 'fp'));
        $out = null;
        self::mutate(self::idFile($me['id']), function (&$i) use ($pub, $fp, &$out) {
            if (!$i) return;
            if (strtolower((string)$i['fp']) !== $fp) { $out = 'fp'; return; }
            $i['pub'] = $pub;
            $i['kv']  = (int)($i['kv'] ?? 1) + 1;
            unset($i['kl']);
            $out = $i;
        });
        if ($out === 'fp') throw new SecureComException('Der Hauptschlüssel darf sich nicht ändern.', 409);
        if (!is_array($out)) throw new SecureComException('Identität nicht gefunden.', 404);
        return ['kv' => (int)$out['kv']];
    }

    /**
     * Den beim Server eingepackten Schlüssel durch den aktuellen ersetzen
     * (ohne gelöschte Unterschlüssel). Nur mit Passwort bzw. Code – mit einer
     * gestohlenen Sitzung allein lässt er sich nicht überschreiben.
     */
    public static function rewrapKey(array $me, array $b)
    {
        $acc = self::accountFor($me);
        if (!password_verify(self::str($b, 'auth'), (string)$acc['auth'])) {
            throw new SecureComException('Passwort oder Code stimmen nicht.', 403);
        }
        $wrap = self::b64(self::str($b, 'wrapped'), self::MAX_WRAPPED, 'Schlüssel');
        self::mutate(self::accountFile($acc['u']), function (&$a) use ($wrap) {
            if ($a) $a['w'] = $wrap;
        });
        return [];
    }

    /* ======================================================================
       Wer ist da? Wer ist wer?
       In der Online-Liste stehen nur temporäre Sitzungen (siehe listed()).
       ====================================================================== */
    public static function online(array $me)
    {
        self::guestOnly($me, 'Gäste eines Meetings sehen keine Online-Liste.');
        $presence = self::readJson(self::dir() . '/presence.json', true) ?: [];
        $now  = time();
        $list = [];
        arsort($presence);
        foreach ($presence as $id => $p) {
            if ($id === $me['id'] || count($list) >= 200) continue;
            if (!is_array($p) || $now - (int)$p[0] > self::ONLINE_WINDOW || empty($p[2])) continue;
            $ident = self::identity($id);
            if ($ident && self::listed($ident)) $list[] = self::publicIdentity($ident) + ['on' => true];
        }
        return $list;
    }

    /** Mehrere Identitäten auf einmal (Raummitglieder, Absender). */
    public static function identities(array $me, array $b)
    {
        $ids = isset($b['ids']) && is_array($b['ids']) ? array_slice($b['ids'], 0, 100) : [];
        $presence = self::readJson(self::dir() . '/presence.json', true) ?: [];
        $out = [];
        foreach ($ids as $id) {
            if (!is_string($id) || !preg_match('/^[A-Za-z0-9_-]{22}$/', $id)) continue;
            $ident = self::identity($id);
            if ($ident) $out[] = self::publicIdentity($ident) + ['on' => self::isOnline($ident, $presence)];
        }
        return $out;
    }

    /** Anrufen oder anschreiben per PGP-Schlüssel: Suche nach Fingerabdruck. */
    public static function find(array $me, array $b)
    {
        self::guestOnly($me, 'Gäste eines Meetings können niemanden suchen.');
        $fp =self::fingerprint(self::str($b, 'fp'));
        $index = self::readJson(self::dir() . '/fp.json', true) ?: [];
        $presence = self::readJson(self::dir() . '/presence.json', true) ?: [];
        $out = [];
        foreach ((array)($index[$fp] ?? []) as $id) {
            $ident = self::identity($id);
            if ($ident && $ident['fp'] === $fp) {
                $out[] = self::publicIdentity($ident) + ['on' => self::isOnline($ident, $presence)];
            }
        }
        return $out;
    }

    /* ======================================================================
       Freunde: Status in Fächern
       Jedes Freundespaar leitet aus einem gemeinsamen Geheimnis zwei
       zufällige Fächer ab, je eins pro Person; darin liegt der Status,
       verschlüsselt. Der Server kennt das Geheimnis nicht und merkt sich
       nicht, wer welches Fach beschreibt oder liest. Er hebt nur den
       jüngsten Stand auf und vergisst ihn nach PRES_TTL Sekunden.
       ====================================================================== */
    public static function presence(array $me, array $b)
    {
        self::guestOnly($me, 'Gäste eines Meetings haben keine Freunde-Liste.');
        $put =isset($b['put']) && is_array($b['put']) ? $b['put'] : [];
        $del = isset($b['del']) && is_array($b['del']) ? $b['del'] : [];
        $get = isset($b['get']) && is_array($b['get']) ? $b['get'] : [];
        if (count($put) > self::MAX_SLOTS || count($del) > self::MAX_SLOTS || count($get) > self::MAX_SLOTS) {
            throw new SecureComException('Zu viele Fächer auf einmal.', 422);
        }
        $dir = self::dir('pres');
        foreach ($put as $p) {
            if (!is_array($p)) throw new SecureComException('Ungültiges Fach.', 422);
            $slot = self::slotOf($p['i'] ?? '');
            $data = self::b64(is_string($p['d'] ?? null) ? $p['d'] : '', self::MAX_PRES, 'Status');
            // Erst daneben schreiben, dann umbenennen: Leser sehen nie einen halben Stand.
            $tmp = $dir . '/' . $slot . '.' . bin2hex(random_bytes(4)) . '.tmp';
            if (file_put_contents($tmp, $data) === false || !@rename($tmp, $dir . '/' . $slot)) {
                @unlink($tmp);
                throw new RuntimeException('Status nicht beschreibbar.');
            }
        }
        foreach ($del as $slot) @unlink($dir . '/' . self::slotOf($slot));

        $now = time();
        $out = [];
        foreach ($get as $slot) {
            $slot = self::slotOf($slot);
            $file = $dir . '/' . $slot;
            clearstatcache(true, $file);
            $t = @filemtime($file);
            if ($t === false) continue;
            if ($now - $t > self::PRES_TTL) { @unlink($file); continue; }
            $d = @file_get_contents($file);
            if (is_string($d) && $d !== '') $out[$slot] = ['t' => $t, 'd' => $d];
        }
        return ['now' => $now, 'got' => (object)$out];
    }

    private static function slotOf($slot)
    {
        if (!is_string($slot) || !preg_match('/^[0-9a-f]{64}$/', $slot)) {
            throw new SecureComException('Ungültiges Fach.', 422);
        }
        return $slot;
    }

    /* ======================================================================
       Briefkasten: Direktnachrichten und Signale
       ====================================================================== */
    public static function send(array $me, array $b)
    {
        // Gäste schreiben und telefonieren nur im Meeting (room.post) –
        // Direktnachrichten, Anrufe und Freundschaftsanfragen gehen in beide
        // Richtungen nicht.
        self::guestOnly($me, 'Gäste eines Meetings können keine Direktnachrichten senden oder direkt anrufen.');
        $to   = self::idOf(self::str($b, 'to'));
        $kind = self::str($b, 'k');
        if (!in_array($kind, ['dm', 'sig'], true)) throw new SecureComException('Unbekannte Art.', 422);
        $max  = $kind === 'sig' ? self::MAX_SIGNAL : self::MAX_ENTRY;
        $data = self::b64(self::str($b, 'd'), $max, 'Nachricht');
        $target = self::identity($to);
        if (!$target) throw new SecureComException('Diese Identität gibt es nicht (mehr).', 404);
        if (self::isGuest($target)) {
            throw new SecureComException('Gäste eines Meetings sind nur im Meeting erreichbar – schreib ihnen dort.', 403);
        }

        // Aufbewahrung: wählt die Unterhaltung (Standard 7 Tage), höchstens
        // die Grenze des Servers. Signale verfallen nach zwei Minuten.
        $ttl = $kind === 'sig' ? self::SIGNAL_TTL : self::entryTtl($b);
        $entry = ['t' => time(), 'k' => $kind, 'x' => time() + $ttl, 'd' => $data];

        $seq = self::append(self::dir('inbox') . '/' . $to, $entry, self::MAX_INBOX);
        $own = null;
        if (!empty($b['self']) && $to !== $me['id']) {
            // Eigene Kopie (dieselbe Nachricht, auch an einen selbst
            // verschlüsselt): So sehen alle eigenen Geräte den Verlauf.
            $own = self::append(self::dir('inbox') . '/' . $me['id'], $entry, self::MAX_INBOX);
        }
        return ['s' => $seq, 'own' => $own];
    }

    /**
     * Ein Abruf: neue Einträge im Briefkasten und in den Räumen, dazu wer
     * online und wer im Sprachkanal ist. Hält nebenbei "zuletzt gesehen"
     * und die Anwesenheit im Sprachkanal frisch.
     */
    public static function poll(array $me, array $b)
    {
        $now = time();
        $presence = self::touchPresence($me);

        $tail = isset($b['tail']) ? max(0, min(1000, (int)$b['tail'])) : 0;
        $cur  = isset($b['i']) && is_array($b['i']) ? $b['i'] : [];
        $inbox = self::readSince(self::dir('inbox') . '/' . $me['id'],
            (int)($cur['s'] ?? 0), (int)($cur['o'] ?? 0), (int)($cur['g'] ?? 0), $tail, null);

        $mine  = self::roomsOf($me['id']);
        $voice = isset($b['v']) && is_array($b['v']) ? $b['v'] : [];
        $want  = isset($b['r']) && is_array($b['r']) ? $b['r'] : [];
        $rooms = [];
        $feeds = [];
        foreach ($mine as $rid) {
            $room = self::readJson(self::roomFile($rid), true);
            if (!$room || !isset($room['mem'][$me['id']])) continue;

            if (in_array($rid, $voice, true)) {
                $room = self::refreshVoice($rid, $me['id']) ?: $room;
            }
            $rooms[$rid] = ['rev' => (int)$room['rev'], 'vc' => self::voiceList($room), 'vcs' => (object)self::voiceMap($room)];

            if (isset($want[$rid]) && is_array($want[$rid])) {
                $c = $want[$rid];
                $myId = $me['id'];
                $feeds[$rid] = self::readSince(self::dir('feeds') . '/' . $rid,
                    (int)($c['s'] ?? 0), (int)($c['o'] ?? 0), (int)($c['g'] ?? 0), (int)($c['tail'] ?? 0),
                    function ($e) use ($myId) {
                        // Signale an andere Mitglieder überspringen.
                        return !isset($e['to']) || $e['to'] === $myId;
                    });
            }
        }

        self::maybeCollectGarbage();
        $out = [
            'now'   => $now,
            'i'     => $inbox,
            'r'     => (object)$feeds,
            'rooms' => (object)$rooms,
            'pv'    => self::presenceVersion($presence, $me['id']),
            'tv'    => $me['k'] === 'account' ? (int)($me['tv'] ?? 0) : null,   // Anmeldungen am Konto
        ];
        // Wartet auf den Gastgeber: Wie steht die Beitrittsanfrage?
        if (isset($b['w']) && is_string($b['w']) && preg_match('/^[A-Za-z0-9_-]{22}$/', $b['w'])) {
            $out['w'] = self::waitState($b['w'], $me['id']);
        }
        return $out;
    }

    /**
     * Stand einer Beitrittsanfrage: 'in' (zugelassen), 'wait' (offen),
     * 'no' (abgelehnt) oder 'gone' (verfallen, Meeting weg).
     */
    private static function waitState($rid, $id)
    {
        $room = self::readJson(self::roomFile($rid), true);
        if (!$room) return 'gone';
        if (isset($room['mem'][$id])) return 'in';
        $now = time();
        if (isset($room['pend'][$id]) && (int)$room['pend'][$id]['x'] >= $now) return 'wait';
        if (isset($room['deny'][$id]) && $now - (int)$room['deny'][$id] <= self::DENY_KEEP) return 'no';
        return 'gone';
    }

    /* ======================================================================
       Räume
       ====================================================================== */
    public static function rooms(array $me)
    {
        $out = [];
        foreach (self::roomsOf($me['id']) as $rid) {
            $room = self::readJson(self::roomFile($rid), true);
            if ($room && isset($room['mem'][$me['id']])) $out[] = self::publicRoom($room, $me['id']);
        }
        return $out;
    }

    public static function createRoom(array $me, array $b)
    {
        self::guestOnly($me, 'Gäste eines Meetings können keine Räume oder Meetings anlegen.');
        $once = !empty($b['once']);   // Einmal-Meeting: Gäste mit Link, nach ONCE_IDLE Ruhe weg
        $tmp  = $me['k'] === 'temp' || !empty($b['tmp']) || $once;
        // Nur Mitglieder mit Konto: nur für bleibende Räume von Konten (keine Meetings).
        $ao   = !empty($b['ao']);
        if ($ao && $tmp) {
            throw new SecureComException('„Nur Mitglieder mit Konto“ gibt es nur für Räume, die ein Konto erstellt – nicht für Meetings und temporäre Räume.', 422);
        }
        $rid  = self::idOf(self::str($b, 'id'));
        $meta = self::b64(self::str($b, 'meta'), self::MAX_META, 'Raumdaten');
        if (count(self::roomsOf($me['id'])) >= self::MAX_ROOMS) {
            throw new SecureComException('Du bist schon in ' . self::MAX_ROOMS . ' Räumen.', 409);
        }
        $file = self::roomFile($rid);
        $h = @fopen($file, 'x');
        if (!$h) throw new SecureComException('Diese Raumkennung ist vergeben.', 409);
        fclose($h);

        $room = [
            'id'  => $rid,
            'o'   => $me['id'],
            'c'   => time(),
            'e'   => 1,
            'm'   => $meta,
            'me'  => 1,
            'rev' => 1,
            'mem' => [$me['id'] => time()],
            'inv' => [],
            'vc'  => [],
            // Aus einer temporären Sitzung oder ausdrücklich gewünscht: verfällt ohne Aktivität.
            'tmp' => $tmp ? 1 : 0,
            'la'  => time(),                         // letzte Aktivität
        ];
        if ($once) $room['ot'] = 1;
        if ($ao) $room['ao'] = 1;
        self::writeJson($file, $room);
        self::addMembership($me['id'], $rid);
        return self::publicRoom($room, $me['id']);
    }

    public static function updateMeta(array $me, array $b)
    {
        $rid  = self::idOf(self::str($b, 'id'));
        $meta = self::b64(self::str($b, 'meta'), self::MAX_META, 'Raumdaten');
        $epoch = (int)($b['e'] ?? 0);
        return self::roomMutate($rid, function (&$room) use ($me, $meta, $epoch) {
            // Besitzer oder ein Rang, der Kanäle, Raum, API-Zugänge oder Ränge
            // verwaltet: Was davon sich in den verschlüsselten Daten ändert,
            // sieht der Server nicht.
            self::requirePerm($room, $me['id'], self::P_META, 'Das darf nur der Besitzer oder ein Rang mit Verwaltungsrechten.');
            if ($epoch !== (int)$room['e']) throw new SecureComException('Veralteter Raumschlüssel.', 409);
            $room['m']  = $meta;
            $room['me'] = $epoch;
            $room['la'] = time();
            $room['rev']++;
            return self::publicRoom($room, $me['id']);
        });
    }

    public static function createInvite(array $me, array $b)
    {
        // Gäste: nur Links zu ihrem Einmal-Meeting – wer damit kommt, lässt der Gastgeber erst zu.
        $guest = self::isGuest($me);
        $rid  = self::idOf(self::str($b, 'id'));
        $days = max(1, min(90, (int)($b['days'] ?? 7)));   // Gültigkeit: 1–90 Tage (Auswahl im Einladen-Dialog)
        $max  = max(1, min(100, (int)($b['max'] ?? 25)));
        return self::roomMutate($rid, function (&$room) use ($me, $days, $max, $guest) {
            if ($guest && (empty($room['ot']) || !isset($room['mem'][$me['id']]))) {
                throw new SecureComException('Gäste eines Meetings können nur Links zu ihrem Meeting erstellen.', 403);
            }
            self::requireMember($room, $me['id']);
            if (empty($room['ot'])) {
                // Räume: Einladungslinks und Direkt-Einladungen nur Besitzer und Administratoren.
                if (!self::isAdmin($room, $me['id'])) {
                    throw new SecureComException('Einladungen erstellt der Besitzer oder ein Admin.', 403);
                }
            } else {
                // Meetings wie bisher: Teilnehmer teilen Links, der Gastgeber bestätigt den Beitritt.
                self::requirePerm($room, $me['id'], self::P_INVITE, 'Du darfst in diesem Raum niemanden einladen.');
            }
            $now = time();
            foreach ($room['inv'] as $code => $inv) {
                if ((int)$inv['x'] < $now || (int)$inv['n'] >= (int)$inv['max']) unset($room['inv'][$code]);
            }
            $approve = self::needsApproval($room, $me['id']);
            if ($approve) {
                // Nicht der Gastgeber: ein Link je Mitglied genügt (sonst füllten
                // Gäste mit jedem Klick die Liste der offenen Einladungen).
                foreach ($room['inv'] as $code => $inv) {
                    if (($inv['b'] ?? '') === $me['id']) {
                        return ['code' => $code, 'epoch' => (int)$room['e'], 'x' => (int)$inv['x'], 'ap' => true];
                    }
                }
            }
            if (count($room['inv']) >= 50) throw new SecureComException('Zu viele offene Einladungen.', 409);
            $code = self::randomId();
            $room['inv'][$code] = ['b' => $me['id'], 'c' => $now, 'x' => $now + $days * 86400, 'n' => 0, 'max' => $max];
            $room['la'] = $now;
            return ['code' => $code, 'epoch' => (int)$room['e'], 'x' => $now + $days * 86400, 'ap' => $approve];
        });
    }

    /**
     * Raum: „Nur Mitglieder mit Konto“ an- oder ausschalten (nur der
     * Besitzer). Gilt für neue Beitritte – wer schon drin ist, bleibt.
     * Einschalten nur als Konto und nicht für Meetings oder verfallende Räume.
     */
    public static function setRoomAccounts(array $me, array $b)
    {
        $rid = self::idOf(self::str($b, 'id'));
        $on  = !empty($b['on']);
        if ($on && $me['k'] !== 'account') {
            throw new SecureComException('Nur ein Konto kann „Nur Mitglieder mit Konto“ einschalten.', 403);
        }
        return self::roomMutate($rid, function (&$room) use ($me, $on) {
            self::requireOwner($room, $me['id']);
            if ($on && (!empty($room['ot']) || !empty($room['tmp']))) {
                throw new SecureComException('„Nur Mitglieder mit Konto“ gibt es nicht für Meetings und temporäre Räume.', 422);
            }
            if ($on) $room['ao'] = 1; else unset($room['ao']);
            $room['la'] = time();
            $room['rev']++;
            return self::publicRoom($room, $me['id']);
        });
    }

    /**
     * Ohne Anmeldung: Lässt der Raum hinter dieser Einladung nur Konten zu?
     * Damit zeigt die App zu einem Link gleich die Kontoerstellung statt der
     * temporären Sitzung. Ohne gültige Einladung immer nur "ao": false (wie
     * ein Raum ohne Merkmal) – kein Hinweis, ob es den Raum gibt. Der Beitritt
     * selbst prüft das Merkmal ohnehin (joinRoom).
     *
     * Mit gültiger Einladung zusätzlich für die Vorschau „Du wirst eingeladen
     * in …“: die verschlüsselten Raumdaten ("m", Generation "me") und die
     * Zahl der Mitglieder ("n"). Name und Bild entschlüsselt nur, wer den
     * Schlüssel aus dem Link hat – genau die Daten, die er beim Beitritt
     * ohnehin bekäme. Ausnahme: Links von Teilnehmern eines Einmal-Meetings
     * (Beitritt erst nach Zustimmung des Gastgebers) – dort bleibt es beim
     * Merkmal, wie der Verlauf für Wartende verschlossen bleibt.
     */
    public static function inviteInfo(array $b)
    {
        $rid  = self::str($b, 'id');
        $code = self::str($b, 'code');
        if (!preg_match('/^[A-Za-z0-9_-]{22}$/', $rid) || !preg_match('/^[A-Za-z0-9_-]{22}$/', $code)) return ['ao' => false];
        $room = self::readJson(self::roomFile($rid), true);
        if (!is_array($room) || !self::inviteValid($room, $code)) return ['ao' => false];
        $out = ['ao' => !empty($room['ao'])];
        if (!self::needsApproval($room, (string)($room['inv'][$code]['b'] ?? '')) && is_string($room['m'] ?? null) && $room['m'] !== '') {
            $out['m']  = $room['m'];
            $out['me'] = (int)($room['me'] ?? $room['e'] ?? 1);
            $out['n']  = count((array)($room['mem'] ?? []));
        }
        return $out;
    }

    /**
     * Braucht ein Beitritt über einen Link von $by die Zustimmung des
     * Gastgebers? Nur in Einmal-Meetings, und nur, wenn der Link nicht vom
     * aktuellen Besitzer stammt (geht der Besitzer, gilt das auch für seine
     * alten Links – sein Nachfolger entscheidet).
     */
    private static function needsApproval(array $room, $by)
    {
        return !empty($room['ot']) && $by !== $room['o'];
    }

    /** Abgelaufene Anfragen und alte Ablehnungen entfernen (im roomMutate). */
    private static function prunePending(array &$room, $now)
    {
        foreach ((array)($room['pend'] ?? []) as $id => $p) {
            if ((int)$p['x'] < $now || isset($room['mem'][$id])) unset($room['pend'][$id]);
        }
        foreach ((array)($room['deny'] ?? []) as $id => $t) {
            if ($now - (int)$t > self::DENY_KEEP) unset($room['deny'][$id]);
        }
        if (empty($room['pend'])) unset($room['pend']);
        if (empty($room['deny'])) unset($room['deny']);
    }

    /** Wartet $id auf einen Raum? (mem/<id>.json "w": Raum => bis wann) */
    private static function setWaiting($id, $rid, $until)
    {
        self::mutate(self::dir('mem') . '/' . $id . '.json', function (&$m) use ($rid, $until) {
            if (!is_array($m)) $m = ['r' => []];
            $w = isset($m['w']) && is_array($m['w']) ? $m['w'] : [];
            if ($until) $w[$rid] = $until; else unset($w[$rid]);
            if ($w) $m['w'] = $w; else unset($m['w']);
        });
    }

    private static function waitingFor($id)
    {
        $data = self::readJson(self::dir('mem') . '/' . $id . '.json', true);
        $out = [];
        foreach ((array)($data['w'] ?? []) as $rid => $until) {
            if ((int)$until >= time() && is_string($rid)) $out[] = $rid;
        }
        return $out;
    }

    public static function joinRoom(array $me, array $b)
    {
        $rid  = self::idOf(self::str($b, 'id'));
        $code = self::str($b, 'code');
        $mine  = self::roomsOf($me['id']);
        $guest = self::isGuest($me);
        if (count($mine) >= self::MAX_ROOMS) {
            throw new SecureComException('Du bist schon in ' . self::MAX_ROOMS . ' Räumen.', 409);
        }
        if ($guest && $mine && !in_array($rid, $mine, true)) {
            throw new SecureComException('Als Gast bist du nur in einem Meeting. Verlasse es zuerst.', 403);
        }
        $state = 'in';
        $was   = false;
        $room = self::roomMutate($rid, function (&$room) use ($me, $code, $guest, &$state, &$was) {
            if (isset($room['mem'][$me['id']])) { $was = true; return $room; }
            if ($guest && empty($room['ot'])) {
                throw new SecureComException('Gäste können nur dem Meeting beitreten, zu dem ihr Link gehört.', 403);
            }
            $now = time();
            self::prunePending($room, $now);
            $valid   = self::inviteValid($room, $code);
            $approve = $valid && self::needsApproval($room, (string)($room['inv'][$code]['b'] ?? ''));
            // Schon angefragt: weiter warten (die Einladung kann inzwischen verbraucht
            // sein) – außer mit einem Link des Gastgebers, der führt direkt hinein.
            if (isset($room['pend'][$me['id']]) && !($valid && !$approve)) { $state = 'wait'; return $room; }
            if (!$valid) {
                throw new SecureComException('Die Einladung ist ungültig oder abgelaufen.', 403);
            }
            // Nur Mitglieder mit Konto: temporäre Sitzungen und Gäste nicht (wer schon drin ist, bleibt).
            if (!empty($room['ao']) && ($me['k'] !== 'account' || $guest)) {
                throw new SecureComException('Diesem Raum treten nur Mitglieder mit Konto bei. Erstelle ein Konto oder melde dich an.', 403, ['account' => true]);
            }
            if (count($room['mem']) >= self::MAX_MEMBERS) {
                throw new SecureComException('Der Raum ist voll.', 409);
            }
            if ($approve) {
                if (isset($room['deny'][$me['id']])) {
                    throw new SecureComException('Der Gastgeber hat deinen Beitritt abgelehnt.', 403, ['denied' => true]);
                }
                if (count((array)($room['pend'] ?? [])) >= self::MAX_PEND) {
                    throw new SecureComException('Gerade warten zu viele auf den Gastgeber. Bitte später erneut versuchen.', 409);
                }
                $room['pend'][$me['id']] = ['t' => $now, 'x' => $now + self::PEND_TTL, 'c' => $code];
                $room['rev']++;   // der Gastgeber merkt es beim nächsten Abruf
                $state = 'wait';
                return $room;
            }
            $room['inv'][$code]['n']++;
            $room['mem'][$me['id']] = $now;
            unset($room['pend'][$me['id']]);
            if (empty($room['pend'])) unset($room['pend']);
            $room['la'] = $now;
            $room['rev']++;
            return $room;
        }, true);
        if ($state === 'in' && !$was) self::setWaiting($me['id'], $rid, 0);
        if ($state === 'wait') {
            $until = (int)$room['pend'][$me['id']]['x'];
            self::setWaiting($me['id'], $rid, $until);
            // Gast ohne Meeting, aber mit offener Anfrage: nicht vorzeitig aufräumen.
            if ($guest) {
                self::mutate(self::dir() . '/guests.json', function (&$g) use ($me) {
                    if (is_array($g) && isset($g[$me['id']])) $g[$me['id']] = max((int)$g[$me['id']], time());
                });
            }
            return ['id' => $rid, 'pending' => true, 'x' => $until];
        }
        self::addMembership($me['id'], $rid);
        if (!$was) self::appendSys($rid, 'join', $me['id']);
        return self::publicRoom($room, $me['id']);
    }

    /**
     * Gastgeber entscheidet über eine Beitrittsanfrage (room.kick mit
     * "pend": "yes" oder "no"). Zulassen wirkt wie ein Beitritt mit Link.
     */
    private static function decidePending(array $me, $rid, $who, $yes)
    {
        $ident = self::identity($who);
        if ($yes && !$ident) throw new SecureComException('Diese Person ist nicht mehr da.', 404);
        if ($yes) {
            $theirs = self::roomsOf($who);
            if (count($theirs) >= self::MAX_ROOMS || (self::isGuest($ident) && $theirs && !in_array($rid, $theirs, true))) {
                throw new SecureComException('Diese Person kann gerade keinem weiteren Raum beitreten.', 409);
            }
        }
        $joined = false;
        self::roomMutate($rid, function (&$room) use ($me, $who, $yes, &$joined) {
            self::requireOwner($room, $me['id']);
            $now = time();
            self::prunePending($room, $now);
            if (!isset($room['pend'][$who])) {
                if (isset($room['mem'][$who])) return;
                throw new SecureComException('Die Anfrage gibt es nicht mehr (verfallen oder zurückgezogen).', 404);
            }
            $code = (string)($room['pend'][$who]['c'] ?? '');
            unset($room['pend'][$who]);
            if ($yes) {
                if (count($room['mem']) >= self::MAX_MEMBERS) throw new SecureComException('Das Meeting ist voll.', 409);
                if (isset($room['inv'][$code])) $room['inv'][$code]['n']++;
                $room['mem'][$who] = $now;
                $room['la'] = $now;
                $joined = true;
            } else {
                $room['deny'][$who] = $now;
                if (count($room['deny']) > 50) { asort($room['deny']); array_shift($room['deny']); }
            }
            if (empty($room['pend'])) unset($room['pend']);
            $room['rev']++;
        });
        if ($ident) self::setWaiting($who, $rid, 0);
        if ($joined) {
            self::addMembership($who, $rid);
            self::appendSys($rid, 'join', $who);
        }
    }

    public static function leaveRoom(array $me, array $b)
    {
        $rid = self::idOf(self::str($b, 'id'));
        // Wartet nur (Beitrittsanfrage): zurückziehen – Mitglied war er nie.
        if (self::cancelPending($rid, $me['id'])) return;
        self::removeMember($rid, $me['id'], 'leave');
    }

    /** Wartende zieht ihre Anfrage zurück (room.leave, Sitzung beendet). */
    private static function cancelPending($rid, $id)
    {
        if (!is_file(self::roomFile($rid))) return false;
        $found = false;
        try {
            self::roomMutate($rid, function (&$room) use ($id, &$found) {
                if (!isset($room['pend'][$id])) return;
                unset($room['pend'][$id]);
                if (empty($room['pend'])) unset($room['pend']);
                $room['rev']++;
                $found = true;
            });
        } catch (SecureComException $ex) { /* Raum schon weg */ }
        if ($found) self::setWaiting($id, $rid, 0);
        return $found;
    }

    /**
     * Mitglied entfernen – oder mit "pend" ("yes"/"no") über eine
     * Beitrittsanfrage entscheiden (nur der Besitzer, siehe decidePending).
     */
    public static function kick(array $me, array $b)
    {
        $rid    = self::idOf(self::str($b, 'id'));
        $member = self::idOf(self::str($b, 'member'));
        if (isset($b['pend'])) {
            self::decidePending($me, $rid, $member, $b['pend'] === 'yes' || $b['pend'] === true || $b['pend'] === 1);
            return;
        }
        $room = self::readJson(self::roomFile($rid), true);
        if (!$room) throw new SecureComException('Raum nicht gefunden.', 404);
        // Besitzer oder Recht „Mitglieder entfernen“ – dann nur unterhalb des
        // eigenen höchsten Rangs. Den neuen Raumschlüssel verteilt danach der
        // Besitzer (seine App reagiert auf den Hinweis „kick“ im Verlauf).
        self::requirePerm($room, $me['id'], self::P_KICK, 'Das darf nur der Besitzer oder ein Rang mit dem Recht „Mitglieder entfernen“.');
        if ($member === $me['id']) throw new SecureComException('Dich selbst entfernst du über „Raum verlassen“.', 422);
        if (isset($room['mem'][$member]) && $room['o'] !== $me['id'] && self::topOf($room, $member) >= self::topOf($room, $me['id'])) {
            throw new SecureComException('Du kannst nur Mitglieder mit niedrigerem Rang entfernen.', 403);
        }
        self::removeMember($rid, $member, 'kick');
    }

    /**
     * Neuer Raumschlüssel (nach Entfernen/Verlassen): Der Besitzer schickt
     * den Schlüssel PGP-verschlüsselt an alle verbliebenen Mitglieder. Alte
     * Einladungen verfallen, weil in ihnen der alte Schlüssel steht.
     */
    public static function rotate(array $me, array $b)
    {
        $rid   = self::idOf(self::str($b, 'id'));
        $epoch = (int)($b['e'] ?? 0);
        $env   = self::b64(self::str($b, 'env'), self::MAX_ENTRY, 'Schlüsselpaket');
        $meta  = self::b64(self::str($b, 'meta'), self::MAX_META, 'Raumdaten');
        $room = self::roomMutate($rid, function (&$room) use ($me, $epoch, $meta) {
            self::requireOwner($room, $me['id']);
            if ($epoch !== (int)$room['e'] + 1) throw new SecureComException('Veralteter Raumschlüssel.', 409);
            $room['e']   = $epoch;
            $room['m']   = $meta;
            $room['me']  = $epoch;
            $room['inv'] = [];
            // Offene Beitrittsanfragen hängen an alten Links (alter Schlüssel) – sie verfallen mit.
            unset($room['pend']);
            $room['la']  = time();
            $room['rev']++;
            return $room;
        }, true);
        self::feedAppend($rid, $room, [
            't' => time(), 'k' => 'key', 'x' => time() + self::retentionDays() * 86400, 'e' => $epoch, 'd' => $env,
        ]);
        return self::publicRoom($room, $me['id']);
    }

    public static function deleteRoom(array $me, array $b)
    {
        $rid  = self::idOf(self::str($b, 'id'));
        $room = self::readJson(self::roomFile($rid), true);
        if (!$room) throw new SecureComException('Raum nicht gefunden.', 404);
        self::requireOwner($room, $me['id']);
        self::destroyRoom($rid, $room);
    }

    public static function post(array $me, array $b)
    {
        $rid  = self::idOf(self::str($b, 'id'));
        $kind = self::str($b, 'k');
        if (!in_array($kind, ['msg', 'sig'], true)) throw new SecureComException('Unbekannte Art.', 422);
        $data = self::b64(self::str($b, 'd'), $kind === 'sig' ? self::MAX_SIGNAL : self::MAX_ENTRY, 'Nachricht');
        $room = self::readJson(self::roomFile($rid), true);
        if (!$room) throw new SecureComException('Raum nicht gefunden.', 404);
        self::requireMember($room, $me['id']);
        // Rechte: Reaktionen (rx) brauchen „reagieren“, alles andere „schreiben“
        // und – in Kanälen mit Schreibrecht nur für bestimmte Ränge (c) – einen
        // davon. Ohne c weiß der Server nicht, wohin ein Beitrag geht; solche
        // Beiträge zeigen die Apps in beschränkten Kanälen nur von Berechtigten.
        $rx = $kind === 'msg' && !empty($b['rx']);
        $c  = $kind === 'msg' ? self::taggedChannel($room, $b['c'] ?? '') : '';
        if ($rx) {
            self::requirePerm($room, $me['id'], self::P_REACT, 'Du darfst in diesem Raum nicht reagieren.');
            // Ohne Schreibrecht nur so groß wie eine Reaktion – sonst wäre rx ein Umweg zum Schreiben.
            if (strlen($data) > self::MAX_REACT && !self::canWrite($room, $me['id'], $c)) {
                throw new SecureComException('Reaktion zu groß.', 413);
            }
        } elseif ($kind === 'msg' && !self::canWrite($room, $me['id'], $c)) {
            throw new SecureComException('Hier darfst du nicht schreiben.', 403);
        }
        // Letzte Aktivität (fürs Aufräumen temporärer Räume) – höchstens stündlich schreiben.
        if ($kind === 'msg' && time() - self::lastActive($room) >= self::ACTIVE_EVERY) {
            self::roomMutate($rid, function (&$r) { $r['la'] = time(); });
        }

        $entry = ['t' => time(), 'k' => $kind];
        if ($kind === 'sig') {
            $to = self::idOf(self::str($b, 'to'));
            if (!isset($room['mem'][$to])) throw new SecureComException('Kein Mitglied dieses Raums.', 404);
            // Signale gibt es nur für Sprachkanäle: Recht „Sprache“ und Absender
            // oder Empfänger gerade in einem Sprachkanal dieses Raums.
            if (!(self::permsOf($room, $me['id']) & (self::P_VOICE | self::P_ADMIN))) {
                throw new SecureComException('Du darfst in diesem Raum keine Sprachkanäle betreten.', 403);
            }
            $inVoice = array_merge([], ...array_values(self::voiceMap($room)));
            if (!in_array($me['id'], $inVoice, true) && !in_array($to, $inVoice, true)) {
                throw new SecureComException('Signale gibt es nur im Sprachkanal.', 409);
            }
            $entry['x']  = time() + self::SIGNAL_TTL;
            $entry['to'] = $to;
        } else {
            // Kanal nur, wenn er eine eigene Aufbewahrung oder eigene Rechte hat
            // (sonst schickt der Browser keinen) – so lernt der Server möglichst
            // wenig Zuordnung.
            $entry['x'] = time() + self::chanTtl($room, $c);   // legt der Besitzer fest
            if ($c !== '') $entry['c'] = $c;
            if ($rx) $entry['r'] = 1;                         // nur als Reaktion geprüft
        }
        $entry['d'] = $data;
        return ['s' => self::feedAppend($rid, $room, $entry, $me['id'])];
    }

    /**
     * Besitzer: Nachrichten und API-Beiträge aus dem Verlauf entfernen (id,
     * s = Nummer oder Liste von Nummern, f = Dateien der Nachricht). Wer etwas
     * geschrieben hat, weiß der Server nicht (steht nur verschlüsselt im
     * Eintrag) – deshalb darf das nur der Besitzer; Mitglieder löschen eigene
     * Nachrichten wie bisher verschlüsselt (t "del"). Ein Hinweis-Eintrag
     * k "del" (n = Nummern) sagt verbundenen Apps, dass sie die Einträge
     * ausblenden sollen; ältere Apps ignorieren ihn und sehen die Nachricht
     * nach dem Neuladen nicht mehr.
     */
    public static function deleteEntries(array $me, array $b)
    {
        $rid  = self::idOf(self::str($b, 'id'));
        $want = [];
        foreach (array_slice(is_array($b['s'] ?? null) ? $b['s'] : [$b['s'] ?? null], 0, self::MAX_DEL) as $s) {
            if ((is_int($s) || (is_string($s) && ctype_digit($s))) && (int)$s > 0) $want[(int)$s] = true;
        }
        if (!$want) throw new SecureComException('Keine Nachricht angegeben.', 422);
        $room = self::readJson(self::roomFile($rid), true);
        if (!$room) throw new SecureComException('Raum nicht gefunden.', 404);
        self::requirePerm($room, $me['id'], self::P_MESSAGES, 'Das darf nur der Besitzer oder ein Rang mit dem Recht „Nachrichten verwalten“.');
        $gone = [];
        self::rewriteLog(self::dir('feeds') . '/' . $rid, function ($e) use ($want, &$gone) {
            $hit = in_array($e['k'] ?? '', ['msg', 'hook'], true) && isset($want[(int)($e['s'] ?? 0)]);
            if ($hit) $gone[] = (int)$e['s'];
            return $hit;
        });
        // compact() fragt jede Zeile zweimal (zählen, dann schreiben)
        $gone = array_values(array_unique($gone));
        sort($gone);
        if ($gone) {
            self::feedAppend($rid, $room, [
                't' => time(), 'k' => 'del', 'x' => time() + self::retentionDays() * 86400, 'n' => $gone,
            ]);
        }
        // Dateien der Nachricht: nur, wenn sie für diesen Raum hochgeladen wurden
        // (r, seit 1.9.4). Ältere Dateien ohne r gehören womöglich zu einer
        // Direktnachricht oder einem anderen Raum – die löscht nur ihr Hochlader.
        $files = 0;
        foreach (array_slice(is_array($b['f'] ?? null) ? $b['f'] : [], 0, 10) as $fid) {
            if (!is_string($fid) || !preg_match('/^[A-Za-z0-9_-]{22}$/', $fid)) continue;
            $m = self::readJson(self::fileMeta($fid));
            if (!$m) continue;
            $fr = (string)($m['r'] ?? '');
            if ($fr !== '' ? $fr === $rid : ($m['o'] ?? '') === $me['id']) { self::dropFile($fid); $files++; }
        }
        return ['n' => count($gone), 'files' => $files];
    }

    /* ======================================================================
       Ränge (an Discord angelehnt)
       Wer „Ränge verwalten“ hat, legt Ränge unterhalb seines eigenen
       höchsten an, ändert, löscht, verschiebt und vergibt sie – und gibt
       dabei nur Rechte weiter, die er selbst hat. Der Besitzer steht über
       allen. Der Server kennt Kennung, Rechte und Reihenfolge, Namen und
       Farben nur verschlüsselt (Raumdaten). Für Meetings mit Gästen nicht.
       ====================================================================== */
    private static function roleMutate(array $me, array $b, callable $fn)
    {
        $rid = self::idOf(self::str($b, 'id'));
        return self::roomMutate($rid, function (&$room) use ($me, $fn) {
            self::requirePerm($room, $me['id'], self::P_ROLES, 'Das darf nur der Besitzer oder ein Rang mit dem Recht „Ränge verwalten“.');
            if (!empty($room['ot'])) throw new SecureComException('Ränge gibt es nicht für Meetings mit Gästen.', 422);
            $fn($room, self::permsOf($room, $me['id']), self::topOf($room, $me['id']), $room['o'] === $me['id']);
            $room['la'] = time();
            $room['rev']++;
            return self::publicRoom($room, $me['id']);
        });
    }

    /** Ändert $from → $to nur Rechte, die der Handelnde selbst hat? */
    private static function requireGrantable($from, $to, $mine)
    {
        if ((($from ^ $to) & self::P_ALL) & ~$mine) {
            throw new SecureComException('Du kannst nur Rechte vergeben oder entziehen, die du selbst hast.', 403);
        }
    }

    /**
     * Rang anlegen oder seine Rechte ändern: r (Kennung; "" = „@alle“), p (Bits).
     * Neue Ränge kommen ganz nach unten (direkt über „@alle“).
     */
    public static function setRole(array $me, array $b)
    {
        $r = isset($b['r']) && $b['r'] === '' ? '' : self::roleIdOf($b['r'] ?? null);
        $p = isset($b['p']) && is_numeric($b['p']) ? ((int)$b['p'] & self::P_ALL) : 0;
        return self::roleMutate($me, $b, function (&$room, $mine, $top, $owner) use ($r, $p) {
            if ($r === '') {
                if (!$owner) self::requireGrantable(self::basePerms($room), $p, $mine);
                if ($p === self::P_BASE) unset($room['dp']); else $room['dp'] = $p;
                return;
            }
            if (isset($room['rl'][$r])) {
                if (!$owner && (int)$room['rl'][$r]['o'] >= $top) {
                    throw new SecureComException('Du kannst nur Ränge unterhalb deines eigenen ändern.', 403);
                }
                if (!$owner) self::requireGrantable((int)$room['rl'][$r]['p'], $p, $mine);
                $room['rl'][$r]['p'] = $p;
                return;
            }
            if (count((array)($room['rl'] ?? [])) >= self::MAX_ROLES) {
                throw new SecureComException('Mehr als ' . self::MAX_ROLES . ' Ränge je Raum gehen nicht.', 409);
            }
            if (!$owner) self::requireGrantable(0, $p, $mine);
            foreach (array_keys((array)($room['rl'] ?? [])) as $k) $room['rl'][$k]['o']++;
            $room['rl'][$r] = ['p' => $p, 'o' => 1];
        });
    }

    /** Rang löschen: weg bei allen Mitgliedern und aus den Kanal-Rechten. */
    public static function deleteRole(array $me, array $b)
    {
        $r = self::roleIdOf($b['r'] ?? null);
        return self::roleMutate($me, $b, function (&$room, $mine, $top, $owner) use ($r) {
            if (!isset($room['rl'][$r])) throw new SecureComException('Diesen Rang gibt es nicht (mehr).', 404);
            if (!$owner && (int)$room['rl'][$r]['o'] >= $top) {
                throw new SecureComException('Du kannst nur Ränge unterhalb deines eigenen löschen.', 403);
            }
            // Wie beim Vergeben: nur Ränge, deren Rechte man selbst alle hat.
            if (!$owner) self::requireGrantable(0, (int)$room['rl'][$r]['p'], $mine);
            unset($room['rl'][$r]);
            foreach ((array)($room['mr'] ?? []) as $id => $list) {
                $list = array_values(array_diff((array)$list, [$r]));
                if ($list) $room['mr'][$id] = $list; else unset($room['mr'][$id]);
            }
            if (empty($room['mr'])) unset($room['mr']);
            // Kanäle bleiben beschränkt (ohne den Rang) – lieber zu streng als plötzlich offen.
            foreach ((array)($room['cw'] ?? []) as $c => $v) $room['cw'][$c]['r'] = array_values(array_diff((array)($v['r'] ?? []), [$r]));
            foreach ((array)($room['vw'] ?? []) as $c => $v) $room['vw'][$c] = array_values(array_diff((array)$v, [$r]));
            self::renumberRoles($room);
        });
    }

    /**
     * Reihenfolge: ids = alle Ränge von unten nach oben. Ränge ab dem
     * eigenen höchsten aufwärts müssen bleiben, wo sie sind.
     */
    public static function orderRoles(array $me, array $b)
    {
        $ids = isset($b['ids']) && is_array($b['ids']) ? array_values($b['ids']) : null;
        if ($ids === null) throw new SecureComException('Reihenfolge fehlt.', 422);
        return self::roleMutate($me, $b, function (&$room, $mine, $top, $owner) use ($ids) {
            $have = array_map('strval', array_keys((array)($room['rl'] ?? [])));
            $want = array_map(function ($x) { return is_string($x) ? $x : ''; }, $ids);
            $a = $have; $c = $want;
            sort($a); sort($c);
            if ($a !== $c) throw new SecureComException('Die Ränge haben sich inzwischen geändert – bitte neu laden.', 409);
            foreach ($want as $i => $r) {
                $old = (int)$room['rl'][$r]['o'];
                if (!$owner && $old >= $top && $old !== $i + 1) {
                    throw new SecureComException('Du kannst nur Ränge unterhalb deines eigenen verschieben.', 403);
                }
            }
            foreach ($want as $i => $r) $room['rl'][$r]['o'] = $i + 1;
        });
    }

    /** Rang vergeben oder entziehen: member, r, on. */
    public static function assignRole(array $me, array $b)
    {
        $r      = self::roleIdOf($b['r'] ?? null);
        $member = self::idOf(self::str($b, 'member'));
        $on     = !empty($b['on']);
        return self::roleMutate($me, $b, function (&$room, $mine, $top, $owner) use ($r, $member, $on, $me) {
            if (!isset($room['rl'][$r])) throw new SecureComException('Diesen Rang gibt es nicht (mehr).', 404);
            if (!isset($room['mem'][$member])) throw new SecureComException('Kein Mitglied dieses Raums.', 404);
            if (!$owner) {
                if ((int)$room['rl'][$r]['o'] >= $top) throw new SecureComException('Du kannst nur Ränge unterhalb deines eigenen vergeben.', 403);
                if ($member !== $me['id'] && self::topOf($room, $member) >= $top) {
                    throw new SecureComException('Du kannst nur Mitgliedern mit niedrigerem Rang Ränge geben oder nehmen.', 403);
                }
                // Geben und Nehmen nur für Ränge, deren Rechte man selbst alle hat –
                // sonst verschaffte sich „Ränge verwalten“ über einen tiefer
                // stehenden Rang mit mehr Rechten (etwa Administrator) alles.
                self::requireGrantable(0, (int)$room['rl'][$r]['p'], $mine);
            }
            $list = self::rolesOf($room, $member);
            if ($on && !in_array($r, $list, true)) $list[] = $r;
            if (!$on) $list = array_values(array_diff($list, [$r]));
            if ($list) $room['mr'][$member] = $list; else unset($room['mr'][$member]);
            if (empty($room['mr'])) unset($room['mr']);
        });
    }

    /**
     * Kanal-Rechte (Recht „Kanäle verwalten“): c = Kanal, w = Ränge, die dort
     * schreiben (Textkanal) bzw. ihn betreten (v: 1, Sprachkanal) dürfen;
     * [] = nur Besitzer und Administratoren, null = wieder alle. Lesen
     * können immer alle Mitglieder – der Raumschlüssel gilt raumweit.
     */
    public static function setChannelPerms(array $me, array $b)
    {
        $rid   = self::idOf(self::str($b, 'id'));
        $voice = !empty($b['v']);
        $c     = $voice ? self::channelOf(self::str($b, 'c')) : self::str($b, 'c');
        if (!$voice && !preg_match('/^[A-Za-z0-9_-]{1,22}$/', $c)) throw new SecureComException('Ungültiger Kanal.', 422);
        $w = $b['w'] ?? null;
        return self::roomMutate($rid, function (&$room) use ($me, $c, $w, $voice) {
            self::requirePerm($room, $me['id'], self::P_CHANNELS, 'Das darf nur der Besitzer oder ein Rang mit dem Recht „Kanäle verwalten“.');
            if (!empty($room['ot'])) throw new SecureComException('Kanal-Rechte gibt es nicht für Meetings mit Gästen.', 422);
            $key = $voice ? 'vw' : 'cw';
            $map = (array)($room[$key] ?? []);
            if ($w === null) {
                unset($map[$c]);
            } else {
                $list = self::roleList($room, $w);
                if (!isset($map[$c]) && count((array)($room['cw'] ?? [])) + count((array)($room['vw'] ?? [])) >= self::MAX_CPERM) {
                    throw new SecureComException('Mehr als ' . self::MAX_CPERM . ' Kanäle mit eigenen Rechten gehen nicht.', 409);
                }
                // seit wann beschränkt: ältere Beiträge zeigen die Apps weiter
                $map[$c] = $voice ? $list : ['r' => $list, 't' => (int)($map[$c]['t'] ?? time())];
            }
            if ($map) $room[$key] = $map; else unset($room[$key]);
            $room['la'] = time();
            $room['rev']++;
            return self::publicRoom($room, $me['id']);
        });
    }

    /* ======================================================================
       API-Zugänge: nur posten
       Der Besitzer eines bleibenden Raums (Konto) legt einen Zugang an. Hier
       liegt davon nur die Kennung und der SHA-256 eines zufälligen Tokens
       (room['hk'][hid] = {h, c, u}); Name, Ziel-Kanal und der private
       Schlüssel stehen verschlüsselt in den Raumdaten. Mit dem Token geht
       genau eins: hook.post hängt einen verschlüsselten Beitrag an den
       Verlauf. Lesen, Mitglieder, Raumschlüssel, andere Aktionen – nichts
       davon nimmt ein Token an (es ist kein Sitzungstoken).
       ====================================================================== */
    public static function hookCreate(array $me, array $b)
    {
        if ($me['k'] !== 'account') {
            throw new SecureComException('API-Zugänge gibt es nur für Konten.', 403);
        }
        $rid  = self::idOf(self::str($b, 'id'));
        $hid  = self::idOf(self::str($b, 'hid'));
        $hash = self::str($b, 'th');
        if (!preg_match('/^[0-9a-f]{64}$/', $hash)) throw new SecureComException('Ungültiges Token.', 422);
        $chan = $b['c'] ?? '';   // Ziel-Kanal – nur, wenn er eine eigene Aufbewahrung hat
        return self::roomMutate($rid, function (&$room) use ($me, $hid, $hash, $chan) {
            self::requirePerm($room, $me['id'], self::P_HOOKS, 'Das darf nur der Besitzer oder ein Rang mit dem Recht „API-Zugänge“.');
            if (!empty($room['tmp']) || !empty($room['ot'])) {
                throw new SecureComException('API-Zugänge gibt es nicht für Meetings und temporäre Räume.', 422);
            }
            $hooks = (array)($room['hk'] ?? []);
            if (isset($hooks[$hid])) throw new SecureComException('Diese Kennung ist vergeben.', 409);
            if (count($hooks) >= self::MAX_HOOKS) {
                throw new SecureComException('Mehr als ' . self::MAX_HOOKS . ' API-Zugänge je Raum gehen nicht.', 409);
            }
            $hooks[$hid] = ['h' => $hash, 'c' => time(), 'u' => 0];
            $c = self::taggedChannel($room, $chan);
            if ($c !== '') $hooks[$hid]['ch'] = $c;
            $room['hk'] = $hooks;
            $room['la'] = time();
            return ['hid' => $hid];
        });
    }

    /** Zugänge eines Raums für den Besitzer: Kennung, angelegt, zuletzt benutzt. */
    public static function hookList(array $me, array $b)
    {
        $rid  = self::idOf(self::str($b, 'id'));
        $room = self::readJson(self::roomFile($rid), true);
        if (!$room) throw new SecureComException('Raum nicht gefunden.', 404);
        self::requirePerm($room, $me['id'], self::P_HOOKS, 'Das darf nur der Besitzer oder ein Rang mit dem Recht „API-Zugänge“.');
        $out = [];
        foreach ((array)($room['hk'] ?? []) as $hid => $h) {
            $out[] = ['id' => (string)$hid, 'c' => (int)($h['c'] ?? 0), 'u' => (int)($h['u'] ?? 0)];
        }
        return $out;
    }

    /** Zugang widerrufen (Besitzer): Danach nimmt der Server kein Token dazu mehr an. */
    public static function hookDel(array $me, array $b)
    {
        $rid = self::idOf(self::str($b, 'id'));
        $hid = self::idOf(self::str($b, 'hid'));
        return self::roomMutate($rid, function (&$room) use ($me, $hid) {
            self::requirePerm($room, $me['id'], self::P_HOOKS, 'Das darf nur der Besitzer oder ein Rang mit dem Recht „API-Zugänge“.');
            unset($room['hk'][$hid]);
            if (empty($room['hk'])) unset($room['hk']);
            return ['n' => count((array)($room['hk'] ?? []))];
        });
    }

    /**
     * Ohne Anmeldung: Beitrag eines API-Zugangs. Prüft nur das Token und hängt
     * den Chiffretext an – den Klartext sieht der Server nie (verschlüsselt
     * mit dem öffentlichen Schlüssel des Zugangs, siehe securecom-core.js).
     * Jeder Fehler beim Zugang selbst heißt gleich, damit nichts verrät, ob
     * es Raum oder Zugang gibt. Antwort: nur "ok".
     *
     * $limit (aus api.php) zählt die Grenzen je Zugang – erst NACH bestandener
     * Token-Prüfung, mit hookTag(). Sonst könnte jeder, der Raum- und
     * Zugangskennung kennt, mit falschen Tokens die Grenze des Zugangs
     * aufbrauchen (und für jeden ausgedachten Zugang eine Datei anlegen).
     * Fehlversuche zählen nur je Adresse (api.php).
     */
    public static function hookPost(array $b, ?callable $limit = null)
    {
        $rid   = self::str($b, 'r');
        $hid   = self::str($b, 'h');
        $token = self::str($b, 't');
        $deny  = new SecureComException('Zugang ungültig oder widerrufen.', 403);
        if (!preg_match('/^[A-Za-z0-9_-]{22}$/', $rid) || !preg_match('/^[A-Za-z0-9_-]{22}$/', $hid)
            || !preg_match('/^[A-Za-z0-9_-]{43}$/', $token)) {
            throw $deny;
        }
        $data  = self::b64(self::str($b, 'd'), self::MAX_HOOK, 'Beitrag');
        $room = self::readJson(self::roomFile($rid), true);
        $hook = $room ? ($room['hk'][$hid] ?? null) : null;
        // Immer einen Hash vergleichen, auch ohne Zugang (gleiche Laufzeit).
        $want = is_array($hook) ? (string)($hook['h'] ?? '') : str_repeat('0', 64);
        if (!hash_equals($want, hash('sha256', $token)) || !is_array($hook) || !empty($room['tmp']) || !empty($room['ot'])) {
            throw $deny;
        }
        if ($limit) $limit(self::hookTag($rid, $hid));
        $now = time();
        // Zuletzt benutzt (für die Liste des Besitzers) und letzte Aktivität – selten schreiben.
        if ($now - (int)($hook['u'] ?? 0) >= self::HOOK_SEEN) {
            self::roomMutate($rid, function (&$r) use ($hid, $now) {
                if (!isset($r['hk'][$hid])) return;
                $r['hk'][$hid]['u'] = $now;
                if ($now - self::lastActive($r) >= self::ACTIVE_EVERY) $r['la'] = $now;
            });
        }
        $c = self::taggedChannel($room, $hook['ch'] ?? '');
        $entry = ['t' => $now, 'k' => 'hook', 'x' => $now + self::chanTtl($room, $c)];
        if ($c !== '') $entry['c'] = $c;
        self::feedAppend($rid, $room, $entry + ['h' => $hid, 'd' => $data], 'h:' . $hid);
        return [];
    }

    /** Kennung eines Zugangs für die Ratenbegrenzung (wie bisher in api.php). */
    public static function hookTag($rid, $hid)
    {
        return hash('sha256', $rid . '/' . $hid);
    }

    /* ======================================================================
       Aufbewahrung: wie lange Nachrichten liegen bleiben
       Direktnachrichten: Die Unterhaltung legt es fest (beide Seiten, im
       Browser abgestimmt); jeder Eintrag bringt seine Dauer mit. Räume: der
       Besitzer, durchgesetzt hier. Abgelaufenes wird nicht mehr ausgeliefert
       und stündlich aus den Dateien gelöscht.
       ====================================================================== */
    private static function entryTtl(array $b)
    {
        $max = self::retentionDays() * 86400;
        $ttl = isset($b['ttl']) && is_numeric($b['ttl']) ? (int)$b['ttl'] : self::DEFAULT_TTL;
        return max(60, min($max, $ttl));
    }

    private static function roomTtl(array $room)
    {
        if (self::isPermanent($room)) return self::PERMANENT;
        $max = self::retentionDays() * 86400;
        return max(3600, min($max, (int)($room['ttl'] ?? self::DEFAULT_TTL)));
    }

    /** Raum mit Aufbewahrung „Permanent“: Nachrichten verfallen nicht nach Zeit. */
    private static function isPermanent(array $room)
    {
        return (int)($room['ttl'] ?? 0) >= self::PERMANENT && empty($room['tmp']) && empty($room['ot']);
    }

    /**
     * Aufbewahrung eines Textkanals: seine eigene (room['ct'][Kanal], legt der
     * Besitzer fest), sonst die des Raums. Grenzen wie beim Raum.
     */
    private static function chanTtl(array $room, $c)
    {
        $c = (string)$c;
        if ($c === '' || !isset($room['ct'][$c])) return self::roomTtl($room);
        $ttl = (int)$room['ct'][$c];
        if ($ttl >= self::PERMANENT && empty($room['tmp']) && empty($room['ot'])) return self::PERMANENT;
        return max(3600, min(self::retentionDays() * 86400, $ttl));
    }

    /** Kanal-Kennung nur übernehmen, wenn der Kanal eine eigene Aufbewahrung oder eigene Schreibrechte hat – sonst "". */
    private static function taggedChannel(array $room, $c)
    {
        return is_string($c) && $c !== '' && (isset($room['ct'][$c]) || isset($room['cw'][$c])) && preg_match('/^[A-Za-z0-9_-]{1,22}$/', $c) ? $c : '';
    }

    /** Gültige Aufbewahrung je Kanal mit eigener (für die Mitglieder). */
    private static function channelTtls(array $room)
    {
        $out = [];
        foreach (array_keys((array)($room['ct'] ?? [])) as $c) $out[(string)$c] = self::chanTtl($room, (string)$c);
        return $out;
    }

    /** Bleibt hier etwas dauerhaft (Raum oder ein Kanal „Permanent“)? Dann gilt die große Verlaufsgrenze. */
    private static function keepsPermanent(array $room)
    {
        if (self::isPermanent($room)) return true;
        foreach (array_keys((array)($room['ct'] ?? [])) as $c) {
            if (self::chanTtl($room, (string)$c) >= self::PERMANENT) return true;
        }
        return false;
    }

    /**
     * Raum: Aufbewahrung ändern (nur der Besitzer). Gilt auch für die schon
     * vorhandenen Nachrichten: Ältere verfallen sofort, die übrigen bekommen
     * die neue Frist. „Permanent“ (ttl >= PERMANENT) nur als Konto und nur für
     * bleibende Räume – Meetings und temporäre Räume verfallen ohnehin.
     */
    public static function setRoomTtl(array $me, array $b)
    {
        $rid = self::idOf(self::str($b, 'id'));
        $ttl = isset($b['ttl']) && is_numeric($b['ttl']) ? (int)$b['ttl'] : 0;
        if ($ttl < 3600) throw new SecureComException('Ungültige Aufbewahrung.', 422);
        $perm = $ttl >= self::PERMANENT;
        if ($perm && $me['k'] !== 'account') {
            throw new SecureComException('„Permanent“ kann nur ein Konto einstellen.', 403);
        }
        $room = self::roomMutate($rid, function (&$room) use ($me, $ttl, $perm) {
            self::requirePerm($room, $me['id'], self::P_ROOM, 'Das darf nur der Besitzer oder ein Rang mit dem Recht „Raum verwalten“.');
            if ($perm && (!empty($room['tmp']) || !empty($room['ot']))) {
                throw new SecureComException('„Permanent“ gibt es nicht für Meetings und temporäre Räume.', 422);
            }
            $room['ttl'] = $perm ? self::PERMANENT : $ttl;
            $room['la']  = time();
            $room['rev']++;
            return $room;
        });
        // Einträge von Kanälen mit eigener Aufbewahrung behalten ihre Frist.
        self::retimeLog(self::dir('feeds') . '/' . $rid, $room);
        return self::publicRoom($room, $me['id']);
    }

    /**
     * Textkanal: eigene Aufbewahrung (nur der Besitzer). id, c (Kanal-Kennung
     * aus den Raumdaten), ttl (wie bei room.ttl; 0/leer = wieder wie der Raum).
     * Dafür erfährt der Server, welche Einträge zu diesem Kanal gehören – nicht
     * Name oder Inhalt: Neue Nachrichten bringen c mit, ältere ordnet der
     * Besitzer mit s (ihre Nummern) zu, API-Zugänge mit h (Kennungen der
     * Zugänge, die in diesen Kanal posten). Gilt wie beim Raum auch für die
     * schon vorhandenen Einträge. Zurücksetzen löscht die Zuordnung wieder.
     */
    public static function setChannelTtl(array $me, array $b)
    {
        $rid = self::idOf(self::str($b, 'id'));
        $c   = self::str($b, 'c');
        if (!preg_match('/^[A-Za-z0-9_-]{1,22}$/', $c)) throw new SecureComException('Ungültiger Kanal.', 422);
        $raw   = $b['ttl'] ?? null;
        $reset = $raw === null || $raw === '' || $raw === 0 || $raw === '0';
        $ttl   = 0;
        if (!$reset) {
            $ttl = is_numeric($raw) ? (int)$raw : 0;
            if ($ttl < 3600) throw new SecureComException('Ungültige Aufbewahrung.', 422);
        }
        $perm = $ttl >= self::PERMANENT;
        if ($perm && $me['k'] !== 'account') {
            throw new SecureComException('„Permanent“ kann nur ein Konto einstellen.', 403);
        }
        $seqs = [];
        $hids = [];
        if (!$reset) {
            foreach (isset($b['s']) && is_array($b['s']) ? array_slice($b['s'], 0, self::MAX_TAG) : [] as $s) {
                if (is_int($s) || (is_string($s) && ctype_digit($s))) $seqs[(int)$s] = true;
            }
            foreach (isset($b['h']) && is_array($b['h']) ? array_slice($b['h'], 0, self::MAX_HOOKS) : [] as $h) {
                if (is_string($h) && preg_match('/^[A-Za-z0-9_-]{22}$/', $h)) $hids[$h] = true;
            }
        }
        $before = null;
        $room = self::roomMutate($rid, function (&$room) use ($me, $c, $ttl, $perm, $reset, $hids, &$before) {
            self::requirePerm($room, $me['id'], self::P_CHANNELS, 'Das darf nur der Besitzer oder ein Rang mit dem Recht „Kanäle verwalten“.');
            $before = $room;
            if ($perm && (!empty($room['tmp']) || !empty($room['ot']))) {
                throw new SecureComException('„Permanent“ gibt es nicht für Meetings und temporäre Räume.', 422);
            }
            $ct = (array)($room['ct'] ?? []);
            if ($reset) {
                unset($ct[$c]);
            } else {
                if (!isset($ct[$c]) && count($ct) >= self::MAX_CTTL) {
                    throw new SecureComException('Mehr als ' . self::MAX_CTTL . ' Kanäle mit eigener Aufbewahrung gehen nicht.', 409);
                }
                $ct[$c] = $perm ? self::PERMANENT : $ttl;
            }
            // API-Zugänge dieses Kanals: Ziel merken (nur solange er eine eigene Aufbewahrung hat).
            foreach (array_keys((array)($room['hk'] ?? [])) as $hid) {
                if (!$reset && isset($hids[$hid])) $room['hk'][$hid]['ch'] = $c;
                elseif ((string)($room['hk'][$hid]['ch'] ?? '') === $c) unset($room['hk'][$hid]['ch']);
            }
            if ($ct) $room['ct'] = $ct;
            else unset($room['ct']);
            $room['la'] = time();
            $room['rev']++;
            return $room;
        }, true);
        // Bestehende Einträge (s, h) diesem Kanal zuordnen: Bekämen sie dadurch
        // eine kürzere Frist als bisher, wäre das ein Löschen fremder
        // Nachrichten – das darf nur, wer auch „Nachrichten verwalten“ hat
        // (Besitzer, Administratoren). Sonst bleiben solche Einträge, wo sie sind.
        $any = (bool)(self::permsOf($room, $me['id']) & self::P_MESSAGES);
        // Kanal mit eigenen Schreibrechten: Zuordnung behalten (sie belegt, dass
        // der Server das Schreibrecht geprüft hat).
        self::retimeLog(self::dir('feeds') . '/' . $rid, $room,
            $reset ? null : ['c' => $c, 's' => $seqs, 'h' => $hids, 'old' => $any ? null : $before],
            $reset && !isset($room['cw'][$c]) ? $c : null);
        return self::publicRoom($room, $me['id']);
    }

    /**
     * Aufbewahrung auf den Verlauf anwenden (unter der Sperre von append):
     * Nachrichten und API-Beiträge bekommen Zeitpunkt + Frist ihres Kanals
     * (eigene oder die des Raums) als Ablauf, was danach schon abgelaufen
     * ist, fällt weg. $tag ordnet Einträge einem Kanal zu (c, s: Nummern von
     * Nachrichten, h: Kennungen von API-Zugängen; old: Raum vorher – dann nur
     * Einträge, deren Frist dadurch nicht kürzer wird), $untag löscht die
     * Zuordnung zu diesem Kanal wieder.
     */
    private static function retimeLog($base, array $room, $tag = null, $untag = null)
    {
        if (!is_file($base . '.n')) return;
        $h = fopen($base . '.n', 'c+');
        if (!$h) return;
        flock($h, LOCK_EX);
        try {
            $state = json_decode((string)stream_get_contents($h), true);
            if (!is_array($state)) $state = ['n' => 0, 'c' => 0, 'g' => 0];
            $src = $base . '.jsonl';
            if (!is_file($src)) return;
            $now = time();
            $in  = fopen($src, 'r');
            $out = fopen($src . '.tmp', 'w');
            while (($line = fgets($in)) !== false) {
                if (substr($line, -1) !== "\n") continue;              // halb geschrieben
                $e = json_decode($line, true);
                if (!is_array($e)) continue;
                $k = $e['k'] ?? '';
                if ($k === 'msg' || $k === 'hook') {
                    if ($untag !== null && (string)($e['c'] ?? '') === $untag) unset($e['c']);
                    if ($tag && (($k === 'msg' && isset($tag['s'][(int)($e['s'] ?? 0)]))
                        || ($k === 'hook' && isset($tag['h'][(string)($e['h'] ?? '')])))
                        && (empty($tag['old']) || self::chanTtl($room, $tag['c']) >= self::chanTtl($tag['old'], (string)($e['c'] ?? '')))) {
                        $e = self::withChannel($e, $tag['c']);
                    }
                    $e['x'] = (int)($e['t'] ?? $now) + self::chanTtl($room, (string)($e['c'] ?? ''));
                    $line = json_encode($e, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) . "\n";
                }
                if (isset($e['x']) && (int)$e['x'] < $now) continue;
                fwrite($out, $line);
            }
            fclose($in);
            fclose($out);
            rename($src . '.tmp', $src);
            $state['g'] = (int)($state['g'] ?? 0) + 1;   // Byte-Stellen stimmen nicht mehr
            $state['c'] = $now;
            ftruncate($h, 0);
            rewind($h);
            fwrite($h, json_encode($state));
            fflush($h);
        } finally {
            flock($h, LOCK_UN);
            fclose($h);
        }
    }

    /** Eintrag mit Kanal-Kennung c direkt hinter x (wie beim Anhängen). */
    private static function withChannel(array $e, $c)
    {
        $out = [];
        foreach ($e as $key => $v) {
            if ($key === 'c') continue;
            $out[$key] = $v;
            if ($key === 'x') $out['c'] = $c;
        }
        if (!isset($out['c'])) $out['c'] = $c;
        return $out;
    }

    /**
     * An den Verlauf eines Raums anhängen; „Permanent“ (Raum oder ein Kanal):
     * größere Grenze, Älteste fallen weg statt „voll“ – dafür darf jeder
     * Absender ($who: Mitglied bzw. "h:" + Zugang) je Stunde nur
     * memberHourBytes() anhängen. Signale haben eigene, kleine Grenzen und
     * verdrängen nie etwas.
     */
    private static function feedAppend($rid, array $room, array $entry, $who = '')
    {
        $perm  = self::keepsPermanent($room);
        $kind  = (string)($entry['k'] ?? '');
        $limit = [];
        if ($who !== '' && $kind === 'sig') {
            $limit = ['sig' => (string)$who];
        } elseif ($who !== '' && $perm && ($kind === 'msg' || $kind === 'hook')) {
            $limit = ['hour' => (string)$who, 'max' => self::memberHourBytes()];
        }
        return self::append(self::dir('feeds') . '/' . $rid, $entry, $perm ? self::permanentBytes() : self::MAX_FEED,
            $perm && $kind !== 'sig', $limit);
    }

    /**
     * Eigenen Briefkasten aufräumen: Einträge mit diesen Nummern löschen. So
     * verschwinden ältere Nachrichten, wenn eine Unterhaltung kürzer
     * aufbewahrt werden soll – der Server weiß nicht, welche Einträge zu
     * welcher Unterhaltung gehören, das weiß nur der Browser.
     */
    public static function trimInbox(array $me, array $b)
    {
        $want = [];
        foreach (isset($b['s']) && is_array($b['s']) ? array_slice($b['s'], 0, 5000) : [] as $s) {
            if (is_int($s) || (is_string($s) && ctype_digit($s))) $want[(int)$s] = true;
        }
        if (!$want) return ['n' => 0];
        $n = self::rewriteLog(self::dir('inbox') . '/' . $me['id'], function ($e) use ($want) {
            return isset($want[(int)($e['s'] ?? 0)]);
        });
        return ['n' => $n];
    }

    /**
     * Sprachkanal betreten oder verlassen. "ch" wählt den Kanal: "" ist der
     * erste, den jeder Raum hat (und den ältere App-Fassungen kennen), sonst
     * eine Kennung aus den verschlüsselten Raumdaten. Wer einen Kanal
     * betritt, verlässt damit den bisherigen im selben Raum.
     */
    public static function voice(array $me, array $b)
    {
        $rid = self::idOf(self::str($b, 'id'));
        $on  = !empty($b['on']);
        $ch  = self::channelOf(self::str($b, 'ch'));
        $room = self::roomMutate($rid, function (&$room) use ($me, $on, $ch) {
            self::requireMember($room, $me['id']);
            $now = time();
            foreach ($room['vc'] as $id => $seen) {
                if ($now - (int)$seen > self::VOICE_WINDOW || !isset($room['mem'][$id])) {
                    unset($room['vc'][$id], $room['vch'][$id]);
                }
            }
            if ($on && !self::canEnter($room, $me['id'], $ch)) {
                throw new SecureComException('Diesen Sprachkanal darfst du nicht betreten.', 403);
            }
            if ($on) {
                $here = isset($room['vc'][$me['id']]) && (string)($room['vch'][$me['id']] ?? '') === $ch;
                if (!$here && count(self::voiceList($room, $ch)) >= self::MAX_VOICE) {
                    throw new SecureComException('Im Sprachkanal sind schon ' . self::MAX_VOICE . ' Personen.', 409);
                }
                $room['vc'][$me['id']] = $now;
                $room['la'] = $now;
                if ($ch === '') unset($room['vch'][$me['id']]);
                else $room['vch'][$me['id']] = $ch;
            } else {
                unset($room['vc'][$me['id']], $room['vch'][$me['id']]);
            }
            return $room;
        }, true);
        return ['vc' => self::voiceList($room, $ch), 'vcs' => (object)self::voiceMap($room)];
    }

    /* ======================================================================
       Profilbild (nur Konten)
       ====================================================================== */
    /**
     * Profilbild setzen oder entfernen. Es ist öffentlich wie der Name. Die
     * mitgeschickte, signierte Karte trägt seinen SHA-256-Wert: Browser
     * zeigen das Bild nur, wenn beides zusammenpasst – austauschen kann der
     * Server es also nicht.
     */
    public static function setAvatar(array $me, array $b)
    {
        if ($me['k'] !== 'account') throw new SecureComException('Profilbilder gibt es nur für Konten.', 403);
        $card = self::b64(self::str($b, 'card'), self::MAX_CARD, 'Karte');
        $data = self::str($b, 'd');
        $file = self::dir('avatars') . '/' . $me['id'] . '.json';
        if ($data === '') {
            @unlink($file);
        } else {
            $data = self::b64($data, self::MAX_AVATAR, 'Bild');
            if (!self::isImage(base64_decode($data, true))) {
                throw new SecureComException('Das ist kein Bild (JPEG, PNG oder WebP).', 422);
            }
            self::writeJson($file, ['d' => $data, 't' => time()]);
        }
        return self::updateCard($me, ['card' => $card]);
    }

    /** Profilbilder mehrerer Identitäten – nur die, die eins haben. */
    public static function avatars(array $me, array $b)
    {
        $ids = isset($b['ids']) && is_array($b['ids']) ? array_slice($b['ids'], 0, 50) : [];
        $out = [];
        foreach ($ids as $id) {
            if (!is_string($id) || !preg_match('/^[A-Za-z0-9_-]{22}$/', $id)) continue;
            $av = self::readJson(self::dir('avatars') . '/' . $id . '.json', true);
            if ($av && !empty($av['d'])) $out[] = ['id' => $id, 'd' => (string)$av['d']];
        }
        return $out;
    }

    private static function isImage($bytes)
    {
        if (!is_string($bytes) || strlen($bytes) < 12) return false;
        return strncmp($bytes, "\xFF\xD8\xFF", 3) === 0                                   // JPEG
            || strncmp($bytes, "\x89PNG\r\n\x1A\n", 8) === 0                               // PNG
            || (strncmp($bytes, 'RIFF', 4) === 0 && substr($bytes, 8, 4) === 'WEBP');     // WebP
    }

    /* ======================================================================
       Interna: Identitäten
       ====================================================================== */
    private static function createIdentity($id, $kind, $pub, $fp, $card, $username, array $extra = [])
    {
        $file = self::idFile($id);
        $h = @fopen($file, 'x');
        if (!$h) throw new SecureComException('Diese Kennung ist vergeben – bitte erneut versuchen.', 409);
        fclose($h);
        $ident = [
            'id'   => $id,
            'k'    => $kind,
            'pub'  => $pub,
            'fp'   => $fp,
            'card' => $card,
            'cv'   => 1,
            'vis'  => true,
            'c'    => time(),
            'tok'  => [],
        ];
        $ident = $extra + $ident;   // etwa Gast: g = 1, nicht sichtbar
        if ($username !== null) $ident['u'] = $username;
        self::writeJson($file, $ident);

        self::mutate(self::dir() . '/fp.json', function (&$idx) use ($fp, $id) {
            if (!is_array($idx)) $idx = [];
            $list = isset($idx[$fp]) ? (array)$idx[$fp] : [];
            if (!in_array($id, $list, true)) $list[] = $id;
            $idx[$fp] = array_slice($list, -10);
        });
        self::touchPresence($ident, true);
        return $ident;
    }

    private static function identity($id)
    {
        if (!is_string($id) || !preg_match('/^[A-Za-z0-9_-]{22}$/', $id)) return null;
        return self::readJson(self::idFile($id), true);
    }

    private static function publicIdentity(array $ident, $withVis = false)
    {
        $out = [
            'id'   => $ident['id'],
            'k'    => $ident['k'],
            'pub'  => $ident['pub'],
            'fp'   => $ident['fp'],
            'card' => $ident['card'],
            'cv'   => (int)($ident['cv'] ?? 1),
        ];
        if (self::isGuest($ident)) $out['g'] = true;   // Gast eines Meetings: nur dort erreichbar
        if ($withVis) $out['vis'] = self::listed($ident);
        return $out;
    }

    /**
     * Online-Liste und Online-Status gibt es nur für temporäre Sitzungen, die
     * sichtbar sein wollen. Konten zeigen niemandem, ob sie online sind –
     * sonst ließe sich ein dauerhafter Name mit Uhrzeiten verknüpfen. Gäste
     * eines Meetings stehen nie darin.
     */
    private static function listed(array $ident)
    {
        return ($ident['k'] ?? '') === 'temp' && !empty($ident['vis']) && !self::isGuest($ident);
    }

    private static function accountFor(array $me)
    {
        if ($me['k'] !== 'account' || empty($me['u'])) {
            throw new SecureComException('Nur für Konten.', 400);
        }
        $acc = self::readJson(self::accountFile($me['u']), true);
        if (!$acc || $acc['id'] !== $me['id']) throw new SecureComException('Konto nicht gefunden.', 404);
        return $acc;
    }

    /**
     * Neue Sitzung. $dev ist die zufällige Kennung des Geräts (bleibt dort
     * gespeichert) – damit lässt sich ein Gerät aus der Ferne abmelden, ohne
     * dass es sich still wieder anmeldet. "tv" zählt Anmeldungen von Geräten,
     * die das Konto noch nicht kennt ("kd"): Steigt er, melden die anderen
     * Geräte „Neue Anmeldung bei deinem Konto“. Erneutes Anmelden auf einem
     * bekannten Gerät zählt nicht, ein aus der Ferne abgemeldetes ist wieder neu.
     */
    private static function issueToken($id, $dev = '')
    {
        $token = rtrim(strtr(base64_encode(random_bytes(32)), '+/', '-_'), '=');
        $hash  = hash('sha256', $token);
        $now   = time();
        $rec   = ['id' => $id, 'c' => $now, 's' => $now];
        if ($dev !== '') $rec['d'] = $dev;
        self::writeJson(self::dir('tokens') . '/' . $hash . '.json', $rec);

        $drop = [];
        self::mutate(self::idFile($id), function (&$i) use ($hash, $dev, &$drop) {
            if (!$i) return;
            $list = (array)($i['tok'] ?? []);
            $list[] = $hash;
            while (count($list) > self::MAX_TOKENS) $drop[] = array_shift($list);
            $i['tok'] = $list;
            $known = (array)($i['kd'] ?? []);
            if ($dev === '' || !in_array($dev, $known, true)) {
                $i['tv'] = (int)($i['tv'] ?? 0) + 1;
                if ($dev !== '') $i['kd'] = array_slice(array_merge($known, [$dev]), -self::MAX_DEVICES);
            }
        });
        foreach ($drop as $old) @unlink(self::dir('tokens') . '/' . $old . '.json');
        return $token;
    }

    /** Geräte-Kennung aus einer Anfrage (22 Zeichen Base64url) oder ''. */
    private static function devOf(array $b)
    {
        $dev = self::str($b, 'dev');
        return preg_match('/^[A-Za-z0-9_-]{22}$/', $dev) ? $dev : '';
    }

    /* ======================================================================
       Geräte eines Kontos: Liste, Name (verschlüsselt), aus der Ferne abmelden
       ====================================================================== */
    public static function devices(array $me)
    {
        self::accountFor($me);
        $ident = self::identity($me['id']);
        $out = [];
        foreach ((array)($ident['tok'] ?? []) as $hash) {
            $t = self::readJson(self::dir('tokens') . '/' . $hash . '.json');
            if (!$t) continue;
            $out[] = [
                'h'   => substr($hash, 0, 16),
                'c'   => (int)($t['c'] ?? 0),
                's'   => (int)($t['s'] ?? 0),
                'n'   => (string)($t['n'] ?? ''),          // Gerätename, mit dem Kontoschlüssel verschlüsselt
                'cur' => $hash === $me['_th'],
            ];
        }
        usort($out, function ($a, $b) { return $b['s'] <=> $a['s']; });
        return ['list' => $out, 'tv' => (int)($ident['tv'] ?? 0)];
    }

    /** Namen des eigenen Geräts setzen – nur verschlüsselt, der Server kann ihn nicht lesen. */
    public static function deviceLabel(array $me, array $b)
    {
        self::accountFor($me);
        $n = self::b64(self::str($b, 'n'), 512, 'Gerätename');
        self::mutate(self::dir('tokens') . '/' . $me['_th'] . '.json', function (&$t) use ($n) {
            if ($t) $t['n'] = $n;
        });
        return [];
    }

    /** Ein Gerät (oder alle anderen) abmelden; die Geräte-Kennung kommt auf die Sperrliste. */
    public static function revokeDevices(array $me, array $b)
    {
        self::accountFor($me);
        $prefix = self::str($b, 'h');
        $others = !empty($b['others']);
        if (!$others && !preg_match('/^[0-9a-f]{16}$/', $prefix)) throw new SecureComException('Unbekanntes Gerät.', 422);
        $ident = self::identity($me['id']);
        $gone = [];
        $dropped = 0;
        foreach ((array)($ident['tok'] ?? []) as $hash) {
            if ($hash === $me['_th']) continue;
            if (!$others && strpos($hash, $prefix) !== 0) continue;
            $t = self::readJson(self::dir('tokens') . '/' . $hash . '.json');
            if ($t && !empty($t['d'])) $gone[] = (string)$t['d'];
            self::revokeToken($me['id'], $hash);
            $dropped++;
            if (!$others) break;
        }
        if ($gone) {
            self::mutate(self::idFile($me['id']), function (&$i) use ($gone) {
                if (!$i) return;
                $rev = array_values(array_unique(array_merge((array)($i['rev'] ?? []), $gone)));
                $i['rev'] = array_slice($rev, -self::MAX_DEVICES);
                // Meldet es sich wieder an, gilt es als neues Gerät.
                $i['kd']  = array_values(array_diff((array)($i['kd'] ?? []), $gone));
            });
        }
        return ['n' => $dropped] + self::devices($me);
    }

    private static function dropToken($id, $hash)
    {
        @unlink(self::dir('tokens') . '/' . $hash . '.json');
        self::mutate(self::idFile($id), function (&$i) use ($hash) {
            if ($i) $i['tok'] = array_values(array_diff((array)($i['tok'] ?? []), [$hash]));
        });
    }

    /**
     * Wie dropToken, lässt aber einen Grabstein liegen: Das Gerät erfährt beim
     * nächsten Abruf, dass es abgemeldet wurde. Das tägliche Aufräumen löscht
     * ihn nach TOKEN_IDLE (bzw. sobald es das Konto nicht mehr gibt).
     */
    private static function revokeToken($id, $hash)
    {
        self::dropToken($id, $hash);
        self::writeJson(self::dir('tokens') . '/' . $hash . '.json', ['id' => $id, 's' => time(), 'x' => 1]);
    }

    /* ======================================================================
       Dateien: im Browser mit einem eigenen Schlüssel je Datei verschlüsselt
       (AES-256-GCM) und in Stücken hochgeladen. Der Server sieht nur
       Chiffretext, Größe und Ablauf – Name, Typ und Schlüssel stehen nur in
       der Ende-zu-Ende verschlüsselten Nachricht. Ablage:
       files/<id>.json (o Besitzer, c erstellt, x Ablauf, s Größe, t Stücke,
       b verschlüsselte Bytes, next nächstes Stück, done, r Raum – nur bei
       Dateien für einen Raum) und files/<id>/<n>.bin.
       ====================================================================== */
    private static function fileMeta($id) { return self::dir('files') . '/' . $id . '.json'; }
    private static function fileDir($id)  { return self::dir('files') . '/' . $id; }

    public static function filePut(array $me, array $b)
    {
        $id    = self::idOf(self::str($b, 'id'));
        $n     = isset($b['n']) && is_numeric($b['n']) ? (int)$b['n'] : -1;
        $total = isset($b['of']) && is_numeric($b['of']) ? (int)$b['of'] : 0;
        $size  = isset($b['size']) && is_numeric($b['size']) ? (int)$b['size'] : -1;
        $max   = self::fileMaxBytes();
        if ($size < 0 || $size > $max) {
            throw new SecureComException('Die Datei ist zu groß – höchstens ' . round($max / 1048576) . ' MB.', 413);
        }
        $chunks = max(1, (int)ceil($size / self::FILE_CHUNK));
        if ($total !== $chunks || $n < 0 || $n >= $total) throw new SecureComException('Ungültiges Dateistück.', 422);
        $data   = base64_decode(self::b64(self::str($b, 'd'), (int)ceil((self::FILE_CHUNK + 16) / 3) * 4, 'Dateistück'), true);
        $expect = ($n < $total - 1 ? self::FILE_CHUNK : $size - self::FILE_CHUNK * ($total - 1)) + 16;
        if ($data === false || strlen($data) !== $expect) throw new SecureComException('Ungültiges Dateistück.', 422);

        $metaFile = self::fileMeta($id);
        $meta = self::readJson($metaFile);
        if (!$meta && $n === 0) {
            // Neue Datei: Platz prüfen (verschlüsselte Bytes) – je Identität und insgesamt.
            $bytes = $size + 16 * $total;
            [$mine, $all] = self::fileUsage($me['id']);
            if ($mine + $bytes > self::fileQuotaBytes()) {
                throw new SecureComException('Dein Speicher für Dateien ist voll. Ältere Dateien verschwinden mit ihren Nachrichten.', 507);
            }
            if ($all + $bytes > self::filesTotalBytes()) throw new SecureComException('Der Server hat gerade keinen Platz für Dateien.', 507);
            $ttl = isset($b['ttl']) && is_numeric($b['ttl']) ? (int)$b['ttl'] : self::DEFAULT_TTL;
            $ttl = max(60, min(self::retentionDays() * 86400, $ttl));
            $now = time();
            $new = ['o' => $me['id'], 'c' => $now, 'x' => $now + $ttl, 's' => $size, 't' => $total, 'b' => $bytes, 'next' => 0];
            // Datei für einen Raum (r): nur dort darf „Nachrichten verwalten“ sie
            // mit room.del löschen. Nur für Räume, in denen man Mitglied ist.
            $fr = $b['r'] ?? null;
            if (is_string($fr) && preg_match('/^[A-Za-z0-9_-]{22}$/', $fr)) {
                $froom = self::readJson(self::roomFile($fr), true);
                if (!$froom || !isset($froom['mem'][$me['id']])) throw new SecureComException('Kein Mitglied dieses Raums.', 403);
                $new['r'] = $fr;
            }
            self::writeJson($metaFile, $new);
            if (!is_dir(self::fileDir($id))) @mkdir(self::fileDir($id), 0770, true);
        } elseif (!$meta || ($meta['o'] ?? '') !== $me['id']) {
            throw new SecureComException('Unbekannte Datei.', 404);
        }

        $dir = self::fileDir($id);
        $res = self::mutate($metaFile, function (&$m) use ($me, $n, $total, $size, $data, $dir) {
            if (!$m || ($m['o'] ?? '') !== $me['id'] || (int)$m['t'] !== $total || (int)$m['s'] !== $size) return 'unknown';
            $next = (int)$m['next'];
            // Der Reihe nach; das zuletzt gesendete Stück darf noch einmal kommen
            // (Antwort ging verloren) – es ist dasselbe, die Verschlüsselung ist fest.
            if ($n !== $next && $n !== $next - 1) return 'order';
            if (@file_put_contents($dir . '/' . $n . '.bin', $data, LOCK_EX) !== strlen($data)) return 'write';
            if ($n === $next) $m['next'] = $next + 1;
            if ($m['next'] >= $total) $m['done'] = 1;
            return 'ok';
        });
        if ($res === 'order') throw new SecureComException('Dateistücke bitte der Reihe nach senden.', 409);
        if ($res === 'write') throw new RuntimeException('Dateistück nicht gespeichert');
        if ($res !== 'ok') throw new SecureComException('Unbekannte Datei.', 404);
        return ['n' => $n, 'done' => $n === $total - 1];
    }

    public static function fileGet(array $me, array $b)
    {
        $id = self::idOf(self::str($b, 'id'));
        $n  = isset($b['n']) && is_numeric($b['n']) ? (int)$b['n'] : -1;
        $m  = self::readJson(self::fileMeta($id));
        if (!$m || empty($m['done']) || (int)$m['x'] < time()) throw new SecureComException('Die Datei ist nicht mehr da.', 404);
        if ($n < 0 || $n >= (int)$m['t']) throw new SecureComException('Ungültiges Dateistück.', 422);
        $data = @file_get_contents(self::fileDir($id) . '/' . $n . '.bin');
        if (!is_string($data)) throw new SecureComException('Die Datei ist nicht mehr da.', 404);
        return ['d' => base64_encode($data), 'of' => (int)$m['t']];
    }

    /** Eigene Datei löschen (etwa mit ihrer Nachricht). */
    public static function fileDel(array $me, array $b)
    {
        $id = self::idOf(self::str($b, 'id'));
        $m  = self::readJson(self::fileMeta($id));
        if ($m && ($m['o'] ?? '') === $me['id']) self::dropFile($id);
        return [];
    }

    private static function dropFile($id)
    {
        $dir = self::fileDir($id);
        foreach (glob($dir . '/*.bin') ?: [] as $f) @unlink($f);
        @rmdir($dir);
        @unlink(self::fileMeta($id));
    }

    /** [eigene, alle] verschlüsselten Bytes noch gültiger Dateien. */
    private static function fileUsage($owner)
    {
        $mine = 0;
        $all  = 0;
        $now  = time();
        foreach (glob(self::dir('files') . '/*.json') ?: [] as $f) {
            $m = self::readJson($f);
            if (!$m || (int)($m['x'] ?? 0) < $now) continue;
            $all += (int)($m['b'] ?? 0);
            if (($m['o'] ?? '') === $owner) $mine += (int)($m['b'] ?? 0);
        }
        return [$mine, $all];
    }

    /**
     * Stündlich: abgelaufene Dateien, nie fertig hochgeladene (nach einem
     * Tag), Dateien ohne Besitzer und Stückordner ohne Beschreibung löschen.
     * $owner: nur die Dateien dieser Identität (beim Löschen der Identität).
     */
    private static function expireFiles($now, $owner = null)
    {
        foreach (glob(self::dir('files') . '/*.json') ?: [] as $f) {
            $id = basename($f, '.json');
            if (!preg_match('/^[A-Za-z0-9_-]{22}$/', $id)) continue;
            $m = self::readJson($f);
            if ($owner !== null) {
                if ($m && ($m['o'] ?? '') === $owner) self::dropFile($id);
                continue;
            }
            if (!$m || (int)($m['x'] ?? 0) < $now || (empty($m['done']) && $now - (int)($m['c'] ?? 0) > 86400)
                || !is_file(self::idFile((string)($m['o'] ?? '')))) {
                self::dropFile($id);
            }
        }
        if ($owner !== null) return;
        foreach (glob(self::dir('files') . '/*', GLOB_ONLYDIR) ?: [] as $d) {
            if (is_file($d . '.json')) continue;
            foreach (glob($d . '/*.bin') ?: [] as $f) @unlink($f);
            @rmdir($d);
        }
    }

    /** Alles einer Identität löschen: Sitzungen, Briefkasten, Räume, Dateien, Konto. */
    private static function purgeIdentity($id)
    {
        $ident = self::identity($id);
        self::expireFiles(time(), $id);
        foreach (self::roomsOf($id) as $rid) {
            try { self::removeMember($rid, $id, 'leave'); } catch (Throwable $ex) { /* Raum schon weg */ }
        }
        foreach (self::waitingFor($id) as $rid) self::cancelPending($rid, $id);
        if ($ident) {
            foreach ((array)($ident['tok'] ?? []) as $th) @unlink(self::dir('tokens') . '/' . $th . '.json');
            if (!empty($ident['u'])) {
                // Verknüpfung zum Postfach lösen: Danach geht wieder ein neues Konto.
                $acc = self::readJson(self::accountFile($ident['u']));
                if ($acc && preg_match('/^[0-9a-f]{64}$/', (string)($acc['sso'] ?? ''))) @unlink(self::dir('sso') . '/' . $acc['sso'] . '.json');
                @unlink(self::accountFile($ident['u']));
            }
            self::mutate(self::dir() . '/fp.json', function (&$idx) use ($ident, $id) {
                if (!is_array($idx) || !isset($idx[$ident['fp']])) return;
                $idx[$ident['fp']] = array_values(array_diff((array)$idx[$ident['fp']], [$id]));
                if (!$idx[$ident['fp']]) unset($idx[$ident['fp']]);
            });
        }
        foreach (['.jsonl', '.n'] as $ext) @unlink(self::dir('inbox') . '/' . $id . $ext);
        @unlink(self::dir('mem') . '/' . $id . '.json');
        @unlink(self::dir('avatars') . '/' . $id . '.json');
        @unlink(self::idFile($id));
        self::mutate(self::dir() . '/presence.json', function (&$p) use ($id) {
            if (is_array($p)) unset($p[$id]);
        });
        self::mutate(self::dir() . '/temp.json', function (&$t) use ($id) {
            if (is_array($t)) unset($t[$id]);
        });
        if (!$ident || self::isGuest($ident)) {
            self::mutate(self::dir() . '/guests.json', function (&$g) use ($id) {
                if (is_array($g)) unset($g[$id]);
            });
        }
    }

    /* ======================================================================
       Interna: Anwesenheit
       ====================================================================== */
    /** Liefert die aktuelle Anwesenheitsliste; schreibt nur, wenn nötig. */
    private static function touchPresence(array $ident, $force = false)
    {
        $file = self::dir() . '/presence.json';
        $presence = self::readJson($file, true) ?: [];
        $now = time();
        $mine = $presence[$ident['id']] ?? null;
        $cv  = (int)($ident['cv'] ?? 1);
        $vis = self::listed($ident) ? 1 : 0;   // zählt für Liste und Versionsstand
        if (!$force && is_array($mine) && $now - (int)$mine[0] < self::SEEN_EVERY
            && (int)$mine[1] === $cv && (int)$mine[2] === $vis) {
            return $presence;
        }
        self::mutate($file, function (&$p) use ($ident, $now, $cv, $vis, &$presence) {
            if (!is_array($p)) $p = [];
            $p[$ident['id']] = [$now, $cv, $vis];
            $presence = $p;
        });
        return $presence;
    }

    private static function presenceVersion(array $presence, $selfId)
    {
        $now = time();
        $on  = [];
        foreach ($presence as $id => $p) {
            if ($id === $selfId || !is_array($p) || empty($p[2])) continue;
            if ($now - (int)$p[0] <= self::ONLINE_WINDOW) $on[] = $id . ':' . (int)$p[1];
        }
        sort($on);
        return substr(sha1(implode(',', $on)), 0, 12);
    }

    private static function isOnline(array $ident, array $presence)
    {
        if (!self::listed($ident)) return null;      // Konto oder unsichtbar: unbekannt
        $p = $presence[$ident['id']] ?? null;
        return is_array($p) && time() - (int)$p[0] <= self::ONLINE_WINDOW;
    }

    private static function lastSeen($id)
    {
        $presence = self::readJson(self::dir() . '/presence.json', true) ?: [];
        $p = $presence[$id] ?? null;
        return is_array($p) ? (int)$p[0] : time();
    }

    /* ======================================================================
       Interna: Räume
       ====================================================================== */
    private static function publicRoom(array $room, $selfId)
    {
        $members = [];
        foreach ($room['mem'] as $id => $joined) $members[] = ['id' => $id, 'j' => (int)$joined];
        // Offene Einladungen: Solange es welche gibt, wechselt der Besitzer den
        // Raumschlüssel nicht von selbst – das machte die Links ungültig.
        // Nur gültige zählen: Links von Mitgliedern ohne Administrator halten ihn nicht auf.
        $open = 0;
        foreach ((array)($room['inv'] ?? []) as $inv) {
            if (is_array($inv) && self::inviteOpen($room, $inv)) $open++;
        }
        // Eigene Rechte: „Einladen“ (8) nur, wer wirklich einladen darf – so
        // blenden auch ältere Apps (bis 1.9.2) Einladen-Knöpfe sonst aus.
        $perm = self::permsOf($room, $selfId);
        if (empty($room['ot']) && !self::isAdmin($room, $selfId)) $perm &= ~self::P_INVITE;
        return [
            'id'      => $room['id'],
            'owner'   => $room['o'],
            'epoch'   => (int)$room['e'],
            'meta'    => $room['m'],
            'me'      => (int)$room['me'],
            'rev'     => (int)$room['rev'],
            'ttl'     => self::roomTtl($room),              // Aufbewahrung der Nachrichten (Sekunden)
            'ct'      => (object)self::channelTtls($room),  // Textkanäle mit eigener Aufbewahrung: Kanal => Sekunden
            'tmp'     => !empty($room['tmp']),              // verfällt ohne Aktivität
            'ot'      => !empty($room['ot']),               // Einmal-Meeting (Gäste mit Link)
            'ao'      => !empty($room['ao']),               // nur Mitglieder mit Konto treten bei
            'exp'     => !empty($room['tmp']) ? self::lastActive($room) + self::roomIdle($room) : 0,
            'members' => $members,
            'pend'    => $room['o'] === $selfId ? self::pendingList($room) : [],   // Beitrittsanfragen (nur für den Besitzer)
            'iv'      => $open,                             // offene Einladungen
            'vc'      => self::voiceList($room),            // erster Sprachkanal (ältere Apps)
            'vcs'     => (object)self::voiceMap($room),     // alle: Kanal => wer drin ist
            'perm'    => $perm,                             // eigene Rechte (Bits)
        ] + self::publicRoles($room);                       // Ränge, Vergabe, Kanal-Rechte
    }

    /** Offene Beitrittsanfragen: wer (Identität noch da) und bis wann. */
    private static function pendingList(array $room)
    {
        $out = [];
        $now = time();
        foreach ((array)($room['pend'] ?? []) as $id => $p) {
            $id = (string)$id;
            if ((int)$p['x'] < $now || isset($room['mem'][$id]) || !is_file(self::idFile($id))) continue;
            $out[] = ['id' => $id, 't' => (int)$p['t'], 'x' => (int)$p['x']];
        }
        return $out;
    }

    /**
     * Letzte Aktivität eines Raums: Nachricht, Beitritt, Sprachkanal,
     * Einladung oder Änderung am Raum. Verlassen und Entfernen zählen nicht.
     */
    private static function lastActive(array $room)
    {
        return (int)($room['la'] ?? $room['c'] ?? 0);
    }

    /** So lange darf ein verfallender Raum ruhen (Sekunden): Einmal-Meeting 12 Stunden, sonst tempRoomDays(). */
    private static function roomIdle(array $room)
    {
        return !empty($room['ot']) ? self::ONCE_IDLE : self::tempRoomDays() * 86400;
    }

    /** Wer gerade in einem Sprachkanal ist ("" = der erste). */
    private static function voiceList(array $room, $ch = '')
    {
        $now = time();
        $out = [];
        $where = (array)($room['vch'] ?? []);
        foreach ((array)$room['vc'] as $id => $seen) {
            if ($now - (int)$seen > self::VOICE_WINDOW || !isset($room['mem'][$id])) continue;
            if ((string)($where[$id] ?? '') === $ch) $out[] = $id;
        }
        return $out;
    }

    /** Alle besetzten Sprachkanäle eines Raums: Kanal => wer drin ist. */
    private static function voiceMap(array $room)
    {
        $now = time();
        $out = [];
        $where = (array)($room['vch'] ?? []);
        foreach ((array)$room['vc'] as $id => $seen) {
            if ($now - (int)$seen > self::VOICE_WINDOW || !isset($room['mem'][$id])) continue;
            $out[(string)($where[$id] ?? '')][] = $id;
        }
        return $out;
    }

    /** Sprachkanal: "" (der erste) oder eine Kennung wie bei den Textkanälen. */
    private static function channelOf($ch)
    {
        if ($ch === '' || preg_match('/^[A-Za-z0-9_-]{1,22}$/', $ch)) return $ch;
        throw new SecureComException('Ungültiger Kanal.', 422);
    }

    private static function refreshVoice($rid, $id)
    {
        $room = self::readJson(self::roomFile($rid), true);
        if (!$room || !isset($room['vc'][$id]) || time() - (int)$room['vc'][$id] < 8) return $room;
        return self::roomMutate($rid, function (&$r) use ($id) {
            if (isset($r['vc'][$id])) $r['vc'][$id] = $r['la'] = time();   // wer spricht, ist aktiv
            return $r;
        }, true);
    }

    private static function requireMember(array $room, $id)
    {
        if (!isset($room['mem'][$id])) throw new SecureComException('Du bist nicht (mehr) in diesem Raum.', 403);
    }

    private static function requireOwner(array $room, $id)
    {
        if ($room['o'] !== $id) throw new SecureComException('Das darf nur der Besitzer des Raums.', 403);
    }

    /* ---------- Ränge und Rechte -------------------------------------------
       room['rl'][Rang] = {p: Rechte, o: Reihenfolge 1…n, höher = mächtiger}
       room['mr'][Mitglied] = [Ränge]      room['dp'] = Rechte von „@alle“
       room['cw'][Textkanal] = {r: [Ränge], t: seit}   wer schreiben darf
       room['vw'][Sprachkanal] = [Ränge]                wer betreten darf
       Kennungen sind zufällig; Namen und Farben der Ränge stehen nur
       verschlüsselt in den Raumdaten. */

    /** Rechte von „@alle“ (Mitglieder ohne Rang). */
    private static function basePerms(array $room)
    {
        return isset($room['dp']) ? ((int)$room['dp'] & self::P_ALL) : self::P_BASE;
    }

    /** Gültige Ränge eines Mitglieds. */
    private static function rolesOf(array $room, $id)
    {
        $out = [];
        foreach ((array)($room['mr'][$id] ?? []) as $r) {
            if (is_string($r) && isset($room['rl'][$r])) $out[] = $r;
        }
        return $out;
    }

    /** Wirksame Rechte: Besitzer alle, sonst „@alle“ plus die der Ränge (Administrator: alle). */
    private static function permsOf(array $room, $id)
    {
        if ($room['o'] === $id) return self::P_ALL;
        if (!isset($room['mem'][$id])) return 0;
        $p = self::basePerms($room);
        foreach (self::rolesOf($room, $id) as $r) $p |= (int)$room['rl'][$r]['p'];
        return ($p & self::P_ADMIN) ? self::P_ALL : ($p & self::P_ALL);
    }

    /** Höchster Rang (Reihenfolge); Besitzer über allen, ohne Rang 0. */
    private static function topOf(array $room, $id)
    {
        if ($room['o'] === $id) return PHP_INT_MAX;
        $top = 0;
        foreach (self::rolesOf($room, $id) as $r) $top = max($top, (int)$room['rl'][$r]['o']);
        return $top;
    }

    /** Eines der Rechte in $bits (oder Besitzer) – sonst 403. */
    private static function requirePerm(array $room, $id, $bits, $message)
    {
        self::requireMember($room, $id);
        if (!(self::permsOf($room, $id) & $bits)) throw new SecureComException($message, 403);
    }

    /** Hat $id einen der Ränge in $list? */
    private static function hasRoleIn(array $room, $id, $list)
    {
        return (bool)array_intersect(self::rolesOf($room, $id), array_map('strval', (array)$list));
    }

    /** Darf $id schreiben – im Kanal $c ("" = unbekannt bzw. ohne eigene Rechte)? */
    private static function canWrite(array $room, $id, $c)
    {
        $p = self::permsOf($room, $id);
        if ($room['o'] === $id || ($p & self::P_ADMIN)) return true;
        if (!($p & self::P_SEND)) return false;
        return $c === '' || !isset($room['cw'][$c]) || self::hasRoleIn($room, $id, $room['cw'][$c]['r'] ?? []);
    }

    /** Darf $id den Sprachkanal $ch betreten? */
    private static function canEnter(array $room, $id, $ch)
    {
        $p = self::permsOf($room, $id);
        if ($room['o'] === $id || ($p & self::P_ADMIN)) return true;
        if (!($p & self::P_VOICE)) return false;
        return !isset($room['vw'][$ch]) || self::hasRoleIn($room, $id, $room['vw'][$ch]);
    }

    /** Rang-Kennung prüfen (zufällig, 6–22 Zeichen). */
    private static function roleIdOf($v)
    {
        if (!is_string($v) || !preg_match('/^[A-Za-z0-9_-]{6,22}$/', $v)) throw new SecureComException('Ungültiger Rang.', 422);
        return $v;
    }

    /** Liste vorhandener Ränge (für Kanal-Rechte); Unbekanntes fällt weg. */
    private static function roleList(array $room, $list)
    {
        if (!is_array($list)) throw new SecureComException('Ungültige Ränge.', 422);
        $out = [];
        foreach (array_slice($list, 0, self::MAX_ROLES) as $r) {
            if (is_string($r) && isset($room['rl'][$r]) && !in_array($r, $out, true)) $out[] = $r;
        }
        return $out;
    }

    /** Reihenfolge 1…n neu vergeben (nach Anlegen/Löschen), Lücken schließen. */
    private static function renumberRoles(array &$room)
    {
        $rl = (array)($room['rl'] ?? []);
        uasort($rl, function ($a, $b) { return (int)$a['o'] <=> (int)$b['o']; });
        $i = 0;
        foreach (array_keys($rl) as $r) $rl[$r]['o'] = ++$i;
        if ($rl) $room['rl'] = $rl; else unset($room['rl']);
    }

    /** Ränge für die Mitglieder: Kennung => {p, o}, Mitglied => [Ränge], Kanal-Rechte. */
    private static function publicRoles(array $room)
    {
        $rl = [];
        foreach ((array)($room['rl'] ?? []) as $r => $v) $rl[(string)$r] = ['p' => (int)$v['p'], 'o' => (int)$v['o']];
        $mr = [];
        foreach (array_keys((array)$room['mem']) as $id) {
            $list = self::rolesOf($room, (string)$id);
            if ($list) $mr[(string)$id] = $list;
        }
        $cw = [];
        foreach ((array)($room['cw'] ?? []) as $c => $v) {
            $cw[(string)$c] = ['r' => array_values(array_filter((array)($v['r'] ?? []), function ($r) use ($room) { return isset($room['rl'][$r]); })), 't' => (int)($v['t'] ?? 0)];
        }
        $vw = [];
        foreach ((array)($room['vw'] ?? []) as $c => $v) {
            $vw[(string)$c] = array_values(array_filter((array)$v, function ($r) use ($room) { return isset($room['rl'][$r]); }));
        }
        return ['dp' => self::basePerms($room), 'rl' => (object)$rl, 'mr' => (object)$mr, 'cw' => (object)$cw, 'vw' => (object)$vw];
    }

    /**
     * Mitglied entfernen; geht der Besitzer, übernimmt das älteste Mitglied,
     * das kein Gast ist. Sind nur noch Gäste da, endet der Raum (Gäste können
     * weder Schlüssel verteilen noch einladen).
     */
    private static function removeMember($rid, $member, $reason)
    {
        $destroy = false;
        $room = self::roomMutate($rid, function (&$room) use ($member, &$destroy) {
            if (!isset($room['mem'][$member])) return $room;
            unset($room['mem'][$member], $room['vc'][$member], $room['vch'][$member], $room['mr'][$member]);
            if (empty($room['mr'])) unset($room['mr']);
            if (!$room['mem']) { $destroy = true; return $room; }
            if ($room['o'] === $member) {
                asort($room['mem']);
                $next = null;
                foreach (array_keys($room['mem']) as $id) {
                    $ident = self::identity((string)$id);
                    if ($ident && !self::isGuest($ident)) { $next = (string)$id; break; }
                }
                if ($next === null) { $destroy = true; return $room; }
                $room['o'] = $next;
            }
            $room['rev']++;
            return $room;
        }, true);
        self::removeMembership($member, $rid);
        if ($destroy) {
            self::destroyRoom($rid, $room);
            return;
        }
        self::appendSys($rid, $reason, $member);
    }

    private static function destroyRoom($rid, array $room)
    {
        foreach (array_keys((array)$room['mem']) as $id) self::removeMembership($id, $rid);
        @unlink(self::roomFile($rid));
        foreach (['.jsonl', '.n'] as $ext) @unlink(self::dir('feeds') . '/' . $rid . $ext);
    }

    private static function appendSys($rid, $event, $id)
    {
        $room = self::readJson(self::roomFile($rid), true);
        if (!$room) return;
        self::feedAppend($rid, $room, [
            't' => time(), 'k' => 'sys', 'x' => time() + self::retentionDays() * 86400, 'ev' => $event, 'id' => $id,
        ]);
    }

    private static function roomsOf($id)
    {
        $data = self::readJson(self::dir('mem') . '/' . $id . '.json', true);
        return $data ? array_values(array_filter((array)$data['r'], 'is_string')) : [];
    }

    private static function addMembership($id, $rid)
    {
        self::mutate(self::dir('mem') . '/' . $id . '.json', function (&$m) use ($rid) {
            if (!is_array($m)) $m = ['r' => []];
            if (!in_array($rid, $m['r'], true)) $m['r'][] = $rid;
        });
    }

    private static function removeMembership($id, $rid)
    {
        self::mutate(self::dir('mem') . '/' . $id . '.json', function (&$m) use ($rid) {
            if (is_array($m)) $m['r'] = array_values(array_diff((array)$m['r'], [$rid]));
        });
    }

    /** Raum unter Sperre ändern. $returnRoom: den geänderten Raum zurückgeben. */
    private static function roomMutate($rid, callable $fn, $returnRoom = false)
    {
        $file = self::roomFile($rid);
        if (!is_file($file)) throw new SecureComException('Raum nicht gefunden.', 404);
        $result = null;
        $found  = true;
        self::mutate($file, function (&$room) use ($fn, &$result, &$found) {
            if (!is_array($room)) { $found = false; return; }
            $result = $fn($room);
            // Einladungen von Mitgliedern ohne Administrator (mehr) entfernen.
            if (is_array($room)) self::dropForeignInvites($room);
        });
        if (!$found) throw new SecureComException('Raum nicht gefunden.', 404);
        if ($returnRoom) return is_array($result) ? $result : self::readJson($file, true);
        return $result;
    }

    /* ======================================================================
       Interna: Verläufe (JSON Lines mit fortlaufender Nummer)
       ====================================================================== */
    /**
     * Hängt einen Eintrag an. Die Nummer vergibt der Zähler in <base>.n; der
     * steht unter exklusiver Sperre, so kommen sich zwei Schreiber nie in
     * die Quere. Leser nehmen dieselbe Sperre geteilt.
     */
    private static function append($base, array $entry, $maxBytes, $dropOldest = false, array $limit = [])
    {
        $h = fopen($base . '.n', 'c+');
        if (!$h) throw new RuntimeException('Zähler nicht beschreibbar.');
        flock($h, LOCK_EX);
        try {
            $state = json_decode((string)stream_get_contents($h), true);
            if (!is_array($state)) $state = ['n' => 0, 'c' => 0, 'g' => 0];
            if ($limit) self::countVolume($state, $limit, strlen((string)($entry['d'] ?? '')));

            $file = $base . '.jsonl';
            clearstatcache(true, $file);
            $size = is_file($file) ? filesize($file) : 0;
            if ($size > $maxBytes - 131072) {
                self::compact($base, $state);
                clearstatcache(true, $file);
                $size = is_file($file) ? filesize($file) : 0;
                if ($size > $maxBytes - 131072 && $dropOldest) {
                    // Verlauf ohne Ablauf („Permanent“): die ältesten Nachrichten fallen weg.
                    self::dropOldest($base, $state, (int)($maxBytes * 0.75));
                    clearstatcache(true, $file);
                    $size = is_file($file) ? filesize($file) : 0;
                }
                if ($size > $maxBytes - 131072) {
                    throw new SecureComException('Der Briefkasten des Empfängers ist voll.', 507);
                }
            }

            $state['n'] = (int)$state['n'] + 1;
            $line = json_encode(['s' => $state['n']] + $entry, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) . "\n";
            if (file_put_contents($file, $line, FILE_APPEND) === false) {
                throw new RuntimeException('Verlauf nicht beschreibbar.');
            }
            if ($size > 524288 && time() - (int)$state['c'] > 3600) self::compact($base, $state);

            ftruncate($h, 0);
            rewind($h);
            fwrite($h, json_encode($state));
            fflush($h);
            return $state['n'];
        } finally {
            flock($h, LOCK_UN);
            fclose($h);
        }
    }

    /**
     * Mengengrenzen im Zähler des Verlaufs (unter der Sperre von append):
     * Signale je Absender und je Raum im Fenster SIGNAL_TTL ("sg"), in
     * „Permanent“-Verläufen Byte je Absender und Stunde ("vq"). Feste
     * Fenster; gespeichert wird erst zusammen mit dem Eintrag.
     */
    private static function countVolume(array &$state, array $limit, $bytes)
    {
        $now = time();
        if (isset($limit['sig'])) {
            $sg = isset($state['sg']) && is_array($state['sg']) ? $state['sg'] : [];
            if ($now - (int)($sg['w'] ?? 0) >= self::SIGNAL_TTL) $sg = ['w' => $now, 'b' => 0, 'm' => []];
            $mine = (int)($sg['m'][$limit['sig']] ?? 0);
            if ($mine + $bytes > self::SIG_SENDER || (int)$sg['b'] + $bytes > self::SIG_ROOM) {
                throw new SecureComException('Zu viele Signale. Bitte kurz warten.', 429);
            }
            $sg['b'] = (int)$sg['b'] + $bytes;
            $sg['m'][$limit['sig']] = $mine + $bytes;
            $state['sg'] = $sg;
        }
        if (isset($limit['hour'])) {
            $vq = isset($state['vq']) && is_array($state['vq']) ? $state['vq'] : [];
            if ($now - (int)($vq['w'] ?? 0) >= 3600) $vq = ['w' => $now, 'm' => []];
            $mine = (int)($vq['m'][$limit['hour']] ?? 0);
            if ($mine + $bytes > (int)$limit['max']) {
                throw new SecureComException('Zu viel in kurzer Zeit für diesen Verlauf. Bitte später erneut versuchen.', 429);
            }
            $vq['m'][$limit['hour']] = $mine + $bytes;
            $state['vq'] = $vq;
        }
    }

    /**
     * Abgelaufene Einträge entfernen (unter der Sperre von append). Danach
     * stimmen gemerkte Byte-Stellen nicht mehr – die Generation "g" sagt den
     * Lesern, dass sie von vorn (nach Nummer) suchen müssen.
     */
    private static function compact($base, array &$state, $drop = null)
    {
        $src = $base . '.jsonl';
        $now = time();
        $state['c'] = $now;
        if (!is_file($src)) return 0;
        // Abgelaufen, halb geschrieben oder von $drop verworfen?
        $gone = function ($line) use ($now, $drop) {
            if (substr($line, -1) !== "\n") return true;
            if (preg_match('/"x":(\d+)/', $line, $m) && (int)$m[1] < $now) return true;
            if ($drop) {
                $e = json_decode($line, true);
                if (is_array($e) && $drop($e)) return true;
            }
            return false;
        };
        // Erst zählen: Gibt es nichts zu löschen, bleibt die Datei unberührt.
        $count = 0;
        $in = fopen($src, 'r');
        if (!$in) return 0;
        while (($line = fgets($in)) !== false) if ($gone($line)) $count++;
        fclose($in);
        if (!$count) return 0;

        $tmp = $src . '.tmp';
        $in  = fopen($src, 'r');
        $out = fopen($tmp, 'w');
        while (($line = fgets($in)) !== false) if (!$gone($line)) fwrite($out, $line);
        fclose($in);
        fclose($out);
        rename($tmp, $src);
        $state['g'] = (int)($state['g'] ?? 0) + 1;
        return $count;
    }

    /**
     * Platz schaffen, bis der Verlauf höchstens $target Byte hat (unter der
     * Sperre von append): zuerst Anruf-Signale (verfallen ohnehin nach zwei
     * Minuten – so kann eine Signalflut keine Nachrichten verdrängen), dann
     * die ältesten Nachrichten, API-Beiträge und Hinweise (Beitritt,
     * Verlassen). Schlüsselpakete bleiben.
     */
    private static function dropOldest($base, array &$state, $target)
    {
        $src = $base . '.jsonl';
        if (!is_file($src)) return 0;
        $excess = filesize($src) - $target;
        if ($excess <= 0) return 0;
        $sig = '/^\{"s":\d+,"t":\d+,"k":"sig"/';
        $sigBytes = 0;
        $in = fopen($src, 'r');
        while (($line = fgets($in)) !== false) if (preg_match($sig, $line)) $sigBytes += strlen($line);
        fclose($in);
        $sigExcess = min($excess, $sigBytes);
        $excess   -= $sigExcess;
        $tmp = $src . '.tmp';
        $in  = fopen($src, 'r');
        $out = fopen($tmp, 'w');
        $dropped = 0;
        while (($line = fgets($in)) !== false) {
            if ($sigExcess > 0 && preg_match($sig, $line)) {
                $sigExcess -= strlen($line);
                $dropped++;
                continue;
            }
            if ($excess > 0 && preg_match('/^\{"s":\d+,"t":\d+,"k":"(msg|hook|sys)"/', $line)) {
                $excess -= strlen($line);
                $dropped++;
                continue;
            }
            fwrite($out, $line);
        }
        fclose($in);
        fclose($out);
        rename($tmp, $src);
        $state['g'] = (int)($state['g'] ?? 0) + 1;
        $state['c'] = time();
        return $dropped;
    }

    /** Verlauf unter der Sperre von append aufräumen: Abgelaufenes und was $drop sagt. */
    private static function rewriteLog($base, $drop = null)
    {
        if (!is_file($base . '.n')) return 0;
        $h = fopen($base . '.n', 'c+');
        if (!$h) return 0;
        flock($h, LOCK_EX);
        try {
            $state = json_decode((string)stream_get_contents($h), true);
            if (!is_array($state)) $state = ['n' => 0, 'c' => 0, 'g' => 0];
            $n = self::compact($base, $state, $drop);
            ftruncate($h, 0);
            rewind($h);
            fwrite($h, json_encode($state));
            fflush($h);
            return $n;
        } finally {
            flock($h, LOCK_UN);
            fclose($h);
        }
    }

    /**
     * Einträge nach Nummer $since. Der Lesezeiger merkt sich zusätzlich die
     * Byte-Stelle ($offset) und die Generation ($gen) – passt die Generation
     * nicht mehr (nach dem Aufräumen), wird von vorn nach Nummer gesucht.
     * Mit $tail > 0 und $since = 0: nur die jüngsten $tail Einträge.
     */
    private static function readSince($base, $since, $offset, $gen, $tail, $filter)
    {
        $empty = ['e' => [], 's' => $since, 'o' => 0, 'g' => 0, 'more' => false];
        if (!is_file($base . '.n')) return $empty;
        $lock = fopen($base . '.n', 'r');
        if (!$lock) return $empty;
        flock($lock, LOCK_SH);
        try {
            $state = json_decode((string)stream_get_contents($lock), true);
            $curGen = is_array($state) ? (int)($state['g'] ?? 0) : 0;
            $file = $base . '.jsonl';
            $f = is_file($file) ? fopen($file, 'r') : false;
            if (!$f) return ['g' => $curGen] + $empty;

            if ($since === 0 || $gen !== $curGen || $offset < 0 || $offset > filesize($file)) $offset = 0;
            fseek($f, $offset);

            $now   = time();
            $out   = [];
            $sizes = [];
            $bytes = 0;
            $lastS = $since;
            $lastO = $offset;
            $more  = false;
            $tailMode = $tail > 0 && $since === 0;
            while (($line = fgets($f)) !== false) {
                if (substr($line, -1) !== "\n") break;           // halb geschrieben
                $pos = ftell($f);
                if (!preg_match('/^\{"s":(\d+),/', $line, $m)) { $lastO = $pos; continue; }
                $s = (int)$m[1];
                $lastO = $pos;
                if ($s <= $since) continue;
                $lastS = max($lastS, $s);
                $e = json_decode($line, true);
                if (!is_array($e) || (isset($e['x']) && (int)$e['x'] < $now)) continue;
                if ($filter && !$filter($e)) continue;
                unset($e['x']);
                $out[]   = $e;
                $sizes[] = strlen($line);
                $bytes  += strlen($line);
                if ($tailMode) {
                    // Nur die jüngsten behalten – und nie mehr als eine Seite.
                    while (count($out) > $tail || ($bytes > self::PAGE_BYTES && count($out) > 1)) {
                        array_shift($out);
                        $bytes -= array_shift($sizes);
                    }
                    continue;
                }
                if (count($out) >= self::PAGE || $bytes >= self::PAGE_BYTES) { $more = true; break; }
            }
            fclose($f);
            return ['e' => $out, 's' => $lastS, 'o' => $lastO, 'g' => $curGen, 'more' => $more];
        } finally {
            flock($lock, LOCK_UN);
            fclose($lock);
        }
    }

    /* ======================================================================
       Interna: Aufräumen
       ====================================================================== */
    /** Höchstens alle fünf Minuten: abgelaufene temporäre Sitzungen löschen. */
    private static function maybeCollectGarbage()
    {
        $file = self::dir() . '/gc.json';
        $h = @fopen($file, 'c+');
        if (!$h) return;
        if (!flock($h, LOCK_EX | LOCK_NB)) { fclose($h); return; }
        try {
            $state = json_decode((string)stream_get_contents($h), true) ?: [];
            $now = time();
            if ($now - (int)($state['t'] ?? 0) < 300) return;

            // Status-Fächer: nur der jüngste Stand, nach PRES_TTL weg.
            foreach (glob(self::dir('pres') . '/*') ?: [] as $pf) {
                if ($now - (int)@filemtime($pf) > self::PRES_TTL) @unlink($pf);
            }

            // Stündlich: Abgelaufenes wirklich aus Briefkästen und Raumverläufen
            // löschen. Sonst läge es weiter in der Datei (nur nicht mehr
            // ausgeliefert), bis sie groß genug fürs Aufräumen wird.
            if ($now - (int)($state['h'] ?? 0) > 3600) {
                self::expireTempRooms($now);
                self::dropOrphans($now);
                self::expireFiles($now);
                self::expireRateLimits($now);
                $logs = array_merge(glob(self::dir('inbox') . '/*.n') ?: [], glob(self::dir('feeds') . '/*.n') ?: []);
                foreach ($logs as $nf) self::rewriteLog(substr($nf, 0, -2));
                $state['h'] = $now;
            }

            $temp = self::readJson(self::dir() . '/temp.json', true) ?: [];
            $presence = self::readJson(self::dir() . '/presence.json', true) ?: [];
            $idle = self::tempHours() * 3600;
            foreach ($temp as $id => $created) {
                $seen = isset($presence[$id]) ? (int)$presence[$id][0] : (int)$created;
                if ($now - $seen > $idle) self::purgeIdentity($id);
            }

            // Gäste: kürzer. Tab zu (kein Abruf mehr) oder kein Meeting mehr
            // (verlassen, beendet, entfernt) – dann gibt es für sie nichts zu tun.
            $guests = self::readJson(self::dir() . '/guests.json', true) ?: [];
            foreach ($guests as $id => $created) {
                $id = (string)$id;
                $seen = isset($presence[$id]) ? (int)$presence[$id][0] : (int)$created;
                // Wartet noch auf den Gastgeber (Beitrittsanfrage): nicht allein.
                $alone = $now - (int)$created > self::GUEST_GRACE && !self::roomsOf($id) && !self::waitingFor($id);
                if ($now - $seen > self::GUEST_IDLE || $alone || !is_file(self::idFile($id))) self::purgeIdentity($id);
            }

            // Einmal am Tag: vergessene Konto-Sitzungen.
            if ($now - (int)($state['d'] ?? 0) > 86400) {
                foreach (glob(self::dir('tokens') . '/*.json') ?: [] as $tf) {
                    $tok = self::readJson($tf);
                    if (!$tok || $now - (int)($tok['s'] ?? 0) > self::TOKEN_IDLE || !is_file(self::idFile((string)$tok['id']))) {
                        @unlink($tf);
                    }
                }
                self::mutate(self::dir() . '/presence.json', function (&$p) use ($now) {
                    if (!is_array($p)) return;
                    foreach ($p as $id => $v) {
                        if (!is_array($v) || $now - (int)$v[0] > 30 * 86400) unset($p[$id]);
                    }
                });
                $state['d'] = $now;
            }
            $state['t'] = $now;
            ftruncate($h, 0);
            rewind($h);
            fwrite($h, json_encode($state));
        } catch (Throwable $ex) {
            error_log('[securecom] Aufräumen: ' . $ex->getMessage());
        } finally {
            flock($h, LOCK_UN);
            fclose($h);
        }
    }

    /**
     * Räume, die eine temporäre Sitzung angelegt hat, löscht der Server nach
     * tempRoomDays() ohne Aktivität – samt Verlauf, auch wenn noch Konten
     * drin sind. Räume von vor dieser Regel bekommen die Angaben hier
     * einmalig: temporär, wenn der Besitzer den Raum selbst angelegt hat und
     * eine temporäre Sitzung ist. Ihre Frist beginnt dann jetzt.
     * Einmal-Meetings (ot) verfallen schon nach ONCE_IDLE (roomIdle()).
     */
    /**
     * Ratenbegrenzung (rate_limit() in lib/util.php, auf achterberg.dev in
     * app/lib/util.php: beide unter storage_dir()/ratelimit, eine Datei je
     * Eimer): Dateien ohne Treffer seit RATE_KEEP löschen. Das größte Fenster
     * ist ein Tag (Website), die Datei wird bei jedem Treffer neu geschrieben –
     * was älter ist, zählt in keinem Fenster mehr. Ohne das blieben Dateien
     * jeder je benutzten Adresse bzw. jedes Eimers für immer liegen.
     */
    private static function expireRateLimits($now)
    {
        $dir = storage_dir() . '/ratelimit';
        $h = is_dir($dir) ? @opendir($dir) : false;
        if (!$h) return;
        while (($f = readdir($h)) !== false) {
            if (!preg_match('/^[0-9a-f]{64}\.json$/', $f)) continue;
            $path = $dir . '/' . $f;
            $m = @filemtime($path);
            if ($m !== false && $now - $m > self::RATE_KEEP) @unlink($path);
        }
        closedir($h);
    }

    private static function expireTempRooms($now)
    {
        foreach (glob(self::dir('rooms') . '/*.json') ?: [] as $file) {
            $rid  = basename($file, '.json');
            $room = self::readJson($file, true);
            if (!$room || !preg_match('/^[A-Za-z0-9_-]{22}$/', $rid)) continue;
            try {
                if (!isset($room['tmp'], $room['la'])) {
                    $room = self::roomMutate($rid, function (&$r) use ($now) {
                        if (!isset($r['tmp'])) {
                            $o = (string)($r['o'] ?? '');
                            $founder = isset($r['mem'][$o]) && abs((int)$r['mem'][$o] - (int)($r['c'] ?? 0)) <= 5;
                            $ident = $founder ? self::identity($o) : null;
                            $r['tmp'] = $ident && ($ident['k'] ?? '') === 'temp' ? 1 : 0;
                        }
                        if (!isset($r['la'])) $r['la'] = $now;
                        return $r;
                    }, true);
                }
                if (empty($room['tmp']) || $now - self::lastActive($room) <= self::roomIdle($room)) continue;
                // Unter der Sperre nochmal prüfen – vielleicht schreibt gerade jemand.
                $expired = false;
                $room = self::roomMutate($rid, function (&$r) use ($now, &$expired) {
                    $expired = !empty($r['tmp']) && $now - self::lastActive($r) > self::roomIdle($r);
                    return $r;
                }, true);
                if ($expired) self::destroyRoom($rid, $room);
            } catch (SecureComException $ex) {
                // Raum ist inzwischen weg
            }
        }
    }

    /**
     * Reste ohne Bezug: leer zurückgebliebene Raumdateien, Verläufe ohne
     * Raum und Briefkästen ohne Identität. Entstehen, wenn jemand genau
     * beim Löschen noch schreibt – zählen sonst ewig beim Speicher mit.
     */
    private static function dropOrphans($now)
    {
        foreach (glob(self::dir('rooms') . '/*.json') ?: [] as $file) {
            clearstatcache(true, $file);
            if (@filesize($file) === 0 && $now - (int)@filemtime($file) > 3600) @unlink($file);
        }
        foreach (glob(self::dir('feeds') . '/*.n') ?: [] as $nf) {
            $rid = basename($nf, '.n');
            if (is_file(self::roomFile($rid))) continue;
            foreach (['.jsonl', '.n'] as $ext) @unlink(self::dir('feeds') . '/' . $rid . $ext);
        }
        foreach (glob(self::dir('inbox') . '/*.n') ?: [] as $nf) {
            $id = basename($nf, '.n');
            if (is_file(self::idFile($id))) continue;
            foreach (['.jsonl', '.n'] as $ext) @unlink(self::dir('inbox') . '/' . $id . $ext);
        }
    }

    /* ======================================================================
       Speicher (für das Adminpanel der Website)
       ====================================================================== */
    /**
     * Wie viel Platz Clavichat belegt – nach Ordnern der Ablage, dazu ein
     * paar Anzahlen und die Fristen. Nur Größen und Zählungen; die Inhalte
     * sind ohnehin verschlüsselt.
     */
    public static function storageStats()
    {
        $base  = self::dir();
        $parts = [];
        $bytes = 0;
        $files = 0;
        foreach (scandir($base) ?: [] as $name) {
            if ($name === '.' || $name === '..') continue;
            $path = $base . '/' . $name;
            if (is_dir($path)) {
                [$b, $n] = self::dirSize($path);
                $key = $name;
            } else {
                $b = (int)@filesize($path);
                $n = 1;
                $key = '_';          // Verwaltung: Anwesenheit, Index, Aufräumen …
            }
            if (!isset($parts[$key])) $parts[$key] = ['bytes' => 0, 'files' => 0];
            $parts[$key]['bytes'] += $b;
            $parts[$key]['files'] += $n;
            $bytes += $b;
            $files += $n;
        }

        $rooms = 0;
        $tempRooms = 0;
        foreach (glob(self::dir('rooms') . '/*.json') ?: [] as $file) {
            $room = self::readJson($file, true);
            if (!$room) continue;
            $rooms++;
            if (!empty($room['tmp'])) $tempRooms++;
        }
        $accounts = 0;
        foreach (glob(self::dir('accounts') . '/*.json') ?: [] as $file) {
            if (@filesize($file) > 0) $accounts++;
        }
        $temp = self::readJson($base . '/temp.json', true) ?: [];

        return [
            'bytes'  => $bytes,
            'files'  => $files,
            'parts'  => $parts,
            'counts' => [
                'accounts'   => $accounts,
                'temp'       => count($temp),
                'rooms'      => $rooms,
                'temp_rooms' => $tempRooms,
            ],
            'rules'  => [
                'retention_days' => self::retentionDays(),
                'default_ttl'    => min(self::DEFAULT_TTL, self::retentionDays() * 86400),
                'temp_hours'     => self::tempHours(),
                'temp_room_days' => self::tempRoomDays(),
            ],
        ];
    }

    /** Größe und Anzahl der Dateien unter einem Ordner (samt Unterordnern). */
    public static function dirSize($dir)
    {
        $bytes = 0;
        $files = 0;
        if (!is_dir($dir)) return [0, 0];
        try {
            $it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($dir, FilesystemIterator::SKIP_DOTS));
            foreach ($it as $f) {
                if (!$f->isFile()) continue;
                $bytes += $f->getSize();
                $files++;
            }
        } catch (Throwable $ex) {
            // nicht lesbar: zählt nicht mit
        }
        return [$bytes, $files];
    }

    /* ======================================================================
       Interna: Prüfen der Eingaben
       ====================================================================== */
    private static function checkAccess(array $b)
    {
        $code = self::accessCode();
        if ($code === '') return;
        if (!hash_equals($code, self::str($b, 'code'))) {
            throw new SecureComException('Der Zugangscode stimmt nicht.', 403);
        }
    }

    private static function checkCapacity()
    {
        $count = count(glob(self::dir('ids') . '/*.json') ?: []);
        if ($count >= self::maxIdentities()) {
            throw new SecureComException('Clavichat ist gerade voll. Bitte später erneut versuchen.', 503);
        }
    }

    public static function str(array $b, $key)
    {
        return isset($b[$key]) && is_scalar($b[$key]) ? (string)$b[$key] : '';
    }

    private static function idOf($id)
    {
        if (!preg_match('/^[A-Za-z0-9_-]{22}$/', $id)) throw new SecureComException('Ungültige Kennung.', 422);
        return $id;
    }

    private static function hex64($hex)
    {
        if (!preg_match('/^[0-9a-f]{64}$/', $hex)) throw new SecureComException('Ungültiger Anmeldeschlüssel.', 422);
        return $hex;
    }

    private static function fingerprint($fp)
    {
        $fp = strtolower(preg_replace('/[\s:]/', '', $fp));
        if (!preg_match('/^([0-9a-f]{40}|[0-9a-f]{64})$/', $fp)) {
            throw new SecureComException('Das ist kein gültiger Fingerabdruck.', 422);
        }
        return $fp;
    }

    private static function pubKey($pub)
    {
        $pub = str_replace("\r\n", "\n", trim($pub));
        $end = '-----END PGP PUBLIC KEY BLOCK-----';
        if (strlen($pub) > self::MAX_PUB
            || strpos($pub, '-----BEGIN PGP PUBLIC KEY BLOCK-----') !== 0
            || substr($pub, -strlen($end)) !== $end
            || preg_match('/[^\x20-\x7E\n]/', $pub)) {
            throw new SecureComException('Das ist kein öffentlicher PGP-Schlüssel.', 422);
        }
        return $pub;
    }

    private static function b64($value, $max, $what)
    {
        if ($value === '' || strlen($value) > $max) {
            throw new SecureComException($what . ' fehlt oder ist zu groß.', $value === '' ? 422 : 413);
        }
        if (!preg_match('/^[A-Za-z0-9+\/]+={0,2}$/', $value)) {
            throw new SecureComException($what . ': ungültiges Format.', 422);
        }
        return $value;
    }

    private static function randomId()
    {
        return rtrim(strtr(base64_encode(random_bytes(16)), '+/', '-_'), '=');
    }

    /* ======================================================================
       Interna: Dateien
       ====================================================================== */
    private static function dir($sub = '')
    {
        static $made = [];
        $d = storage_dir() . '/securecom' . ($sub !== '' ? '/' . $sub : '');
        if (!isset($made[$d])) {
            if (!is_dir($d)) @mkdir($d, 0770, true);
            $made[$d] = true;
        }
        return $d;
    }

    private static function idFile($id)       { return self::dir('ids') . '/' . $id . '.json'; }
    private static function roomFile($rid)    { return self::dir('rooms') . '/' . $rid . '.json'; }

    private static function accountFile($username)
    {
        return self::dir('accounts') . '/' . hash('sha256', strtolower($username)) . '.json';
    }

    /**
     * JSON lesen – immer unter geteilter Sperre, damit nie eine halb
     * geschriebene Datei gelesen wird. (Der zweite Parameter ist nur noch
     * Lesehilfe an den Aufrufstellen.)
     */
    private static function readJson($file, $locked = true)
    {
        if (!is_file($file)) return null;
        $h = @fopen($file, 'r');
        if (!$h) return null;
        flock($h, LOCK_SH);
        $raw = stream_get_contents($h);
        flock($h, LOCK_UN);
        fclose($h);
        if (!is_string($raw) || $raw === '') return null;
        $data = json_decode($raw, true);
        return is_array($data) ? $data : null;
    }

    private static function writeJson($file, $data)
    {
        $h = fopen($file, 'c');
        if (!$h) throw new RuntimeException('Nicht beschreibbar: ' . basename($file));
        flock($h, LOCK_EX);
        ftruncate($h, 0);
        fwrite($h, json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
        fflush($h);
        flock($h, LOCK_UN);
        fclose($h);
    }

    /**
     * Lesen, ändern, schreiben unter exklusiver Sperre. $fn bekommt die Daten
     * per Referenz (null, wenn die Datei fehlt oder leer ist); ist danach
     * null, bleibt die Datei unverändert. Gibt zurück, was $fn zurückgibt.
     *
     * Eine fehlende Datei entsteht dabei leer und bleibt stehen – sie zu
     * löschen wäre ein Wettlauf mit einem zweiten Aufruf, der gerade auf die
     * Sperre wartet. Leere Dateien gelten überall als "gibt es nicht".
     */
    private static function mutate($file, callable $fn)
    {
        $h = fopen($file, 'c+');
        if (!$h) throw new RuntimeException('Nicht beschreibbar: ' . basename($file));
        flock($h, LOCK_EX);
        try {
            $raw  = stream_get_contents($h);
            $data = $raw === '' || $raw === false ? null : json_decode($raw, true);
            if (!is_array($data)) $data = null;
            $result = $fn($data);
            if ($data !== null) {
                ftruncate($h, 0);
                rewind($h);
                fwrite($h, json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
                fflush($h);
            }
            return $result;
        } finally {
            flock($h, LOCK_UN);
            fclose($h);
        }
    }
}
