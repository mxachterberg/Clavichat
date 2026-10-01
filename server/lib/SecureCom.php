<?php
/**
 * ============================================================================
 *  SecureCom — Ende-zu-Ende verschlüsselte Nachrichten, Anrufe und Räume.
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
 *                            Sprachkanal ist (Namen der Kanäle: verschlüsselt)
 *    feeds/<rid>.jsonl|.n    Verlauf eines Raums
 *    avatars/<id>.json       Profilbild eines Kontos (öffentlich wie der Name)
 *    mem/<id>.json           Räume einer Identität
 *    presence.json           zuletzt gesehen, Kartenversion, sichtbar
 *    temp.json               temporäre Identitäten (für das Aufräumen)
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

    const MAX_ENTRY     = 98304;     // verschlüsselter Eintrag (Base64)
    const MAX_SIGNAL    = 49152;
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
    const PAGE          = 250;       // Einträge je Abruf
    const PAGE_BYTES    = 1500000;

    /** bcrypt-Kosten wie bei den Budgetmaxxer-Konten. */
    const HASH_OPTS = ['cost' => 12];

    const RESERVED = ['admin', 'administrator', 'root', 'system', 'securecom',
                      'support', 'moderator', 'mod', 'server', 'hetzner'];

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

    public static function accessCode()
    {
        return trim((string)cfg('securecom_access_code', ''));
    }

    public static function maxIdentities()
    {
        return max(10, (int)cfg('securecom_max_identities', 2000));
    }

    /** Öffentliche Angaben für den Browser: Verbindungsserver und Grenzen. */
    public static function config()
    {
        $ice   = self::iceServers();
        $relay = false;
        foreach ($ice as $server) {
            foreach ((array)$server['urls'] as $url) {
                if (stripos($url, 'turn') === 0) $relay = true;
            }
        }
        return [
            'ice'            => $ice,
            'relay'          => $relay,
            'retention_days' => self::retentionDays(),
            'temp_hours'     => self::tempHours(),
            'access'         => self::accessCode() !== '' ? 'code' : 'open',
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
    public static function iceServers()
    {
        $list = [];
        $stun = cfg('securecom_stun', ['stun:stun.cloudflare.com:3478']);
        if (is_string($stun)) $stun = [$stun];
        $stun = array_values(array_filter((array)$stun, 'is_string'));
        if ($stun) $list[] = ['urls' => $stun];

        foreach ((array)cfg('securecom_turn', []) as $turn) {
            if (!is_array($turn) || empty($turn['urls'])) continue;
            $entry = ['urls' => $turn['urls']];
            if (isset($turn['username']))   $entry['username']   = (string)$turn['username'];
            if (isset($turn['credential'])) $entry['credential'] = (string)$turn['credential'];
            $list[] = $entry;
        }

        $cf = cfg('securecom_cf_turn', null);
        if (is_array($cf) && !empty($cf['key_id']) && !empty($cf['api_token'])) {
            $server = self::cloudflareTurn((string)$cf['key_id'], (string)$cf['api_token']);
            if ($server) $list[] = $server;
        }
        return $list;
    }

    /** Kurzlebige TURN-Zugangsdaten bei Cloudflare holen und 12 h merken. */
    private static function cloudflareTurn($keyId, $token)
    {
        $cache = self::dir() . '/turn-cache.json';
        $data  = self::readJson($cache);
        if ($data && ($data['x'] ?? 0) > time() && isset($data['server'])) return $data['server'];
        if (!function_exists('curl_init')) return null;

        $ch = curl_init('https://rtc.live.cloudflare.com/v1/turn/keys/' . rawurlencode($keyId) . '/credentials/generate');
        curl_setopt_array($ch, [
            CURLOPT_POST           => true,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT        => 5,
            CURLOPT_HTTPHEADER     => ['Authorization: Bearer ' . $token, 'Content-Type: application/json'],
            CURLOPT_POSTFIELDS     => json_encode(['ttl' => 86400]),
        ]);
        $raw  = curl_exec($ch);
        $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);
        $json = is_string($raw) ? json_decode($raw, true) : null;
        if ($code < 200 || $code >= 300 || !is_array($json) || empty($json['iceServers'])) {
            error_log('[securecom] Cloudflare TURN: HTTP ' . $code);
            return null;
        }
        $server = $json['iceServers'];
        if (isset($server['urls'])) {
            // Nur die TURN-Adressen – STUN steht schon in der Liste.
            $server['urls'] = array_values(array_filter((array)$server['urls'], function ($u) {
                return stripos($u, 'turn') === 0;
            }));
        }
        self::writeJson($cache, ['x' => time() + 43200, 'server' => $server]);
        return $server;
    }

    /* ======================================================================
       Konten und Sitzungen
       ====================================================================== */
    public static function register(array $b)
    {
        self::checkAccess($b);
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

        $file = self::accountFile($username);
        $h = @fopen($file, 'x');
        if (!$h) throw new SecureComException('Dieser Name ist schon vergeben.', 409);
        fclose($h);

        try {
            self::createIdentity($id, 'account', $pub, $fp, $card, $username);
        } catch (Throwable $ex) {
            @unlink($file);
            throw $ex;
        }
        self::writeJson($file, [
            'u'     => $username,
            'id'    => $id,
            'auth'  => password_hash($auth, PASSWORD_DEFAULT, self::HASH_OPTS),
            'w'     => $wrap,
            'vault' => $vault,
            'vv'    => 1,
            'c'     => time(),
        ]);
        $token = self::issueToken($id);
        return ['token' => $token, 'id' => $id, 'kind' => 'account', 'username' => $username, 'vv' => 1];
    }

    public static function login(array $b)
    {
        $username = trim(self::str($b, 'username'));
        $auth     = self::str($b, 'auth');
        $acc      = self::readJson(self::accountFile($username));
        // Gleiche Antwort für "gibt es nicht" und "falsches Passwort".
        if (!$acc || !preg_match('/^[0-9a-f]{64}$/', $auth) || !password_verify($auth, (string)$acc['auth'])) {
            throw new SecureComException('Name oder Passwort stimmen nicht.', 401);
        }
        $ident = self::identity($acc['id']);
        if (!$ident) throw new SecureComException('Das Konto ist beschädigt.', 500);

        if (password_needs_rehash($acc['auth'], PASSWORD_DEFAULT, self::HASH_OPTS)) {
            self::mutate(self::accountFile($username), function (&$a) use ($auth) {
                if ($a) $a['auth'] = password_hash($auth, PASSWORD_DEFAULT, self::HASH_OPTS);
            });
        }
        $token = self::issueToken($acc['id']);
        return [
            'token'    => $token,
            'id'       => $acc['id'],
            'kind'     => 'account',
            'username' => $acc['u'],
            'wrapped'  => $acc['w'],
            'vault'    => (string)($acc['vault'] ?? ''),
            'vv'       => (int)($acc['vv'] ?? 1),
            'pub'      => $ident['pub'],
            'card'     => $ident['card'],
            'vis'      => !empty($ident['vis']),
        ];
    }

    public static function startTemp(array $b)
    {
        self::checkAccess($b);
        $id   = self::idOf(self::str($b, 'id'));
        $pub  = self::pubKey(self::str($b, 'pub'));
        $fp   = self::fingerprint(self::str($b, 'fp'));
        $card = self::b64(self::str($b, 'card'), self::MAX_CARD, 'Karte');
        self::checkCapacity();

        self::createIdentity($id, 'temp', $pub, $fp, $card, null);
        self::mutate(self::dir() . '/temp.json', function (&$t) use ($id) {
            if (!is_array($t)) $t = [];
            $t[$id] = time();
        });
        $token = self::issueToken($id);
        return ['token' => $token, 'id' => $id, 'kind' => 'temp', 'exp' => time() + self::tempHours() * 3600];
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
        if ($me['k'] === 'temp') $out['exp'] = self::lastSeen($me['id']) + self::tempHours() * 3600;
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
            throw new SecureComException('Das Passwort stimmt nicht.', 403);
        }
        self::purgeIdentity($me['id']);
    }

    public static function changePassword(array $me, array $b)
    {
        $acc = self::accountFor($me);
        if (!password_verify(self::str($b, 'old_auth'), (string)$acc['auth'])) {
            throw new SecureComException('Das bisherige Passwort stimmt nicht.', 403);
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

    /** Karte (Name/Alias, signiert) und Sichtbarkeit ändern. */
    public static function updateCard(array $me, array $b)
    {
        $card = self::str($b, 'card');
        $vis  = array_key_exists('vis', $b) ? !empty($b['vis']) : null;
        if ($card !== '') $card = self::b64($card, self::MAX_CARD, 'Karte');
        $out = null;
        self::mutate(self::idFile($me['id']), function (&$i) use ($card, $vis, &$out) {
            if (!$i) return;
            if ($card !== '') { $i['card'] = $card; $i['cv'] = (int)($i['cv'] ?? 1) + 1; }
            if ($vis !== null) $i['vis'] = $vis;
            $out = $i;
        });
        if (!$out) throw new SecureComException('Identität nicht gefunden.', 404);
        self::touchPresence($out, true);
        return ['cv' => (int)$out['cv'], 'vis' => !empty($out['vis'])];
    }

    /* ======================================================================
       Wer ist da? Wer ist wer?
       ====================================================================== */
    public static function online(array $me)
    {
        $presence = self::readJson(self::dir() . '/presence.json', true) ?: [];
        $now  = time();
        $list = [];
        arsort($presence);
        foreach ($presence as $id => $p) {
            if ($id === $me['id'] || count($list) >= 200) continue;
            if (!is_array($p) || $now - (int)$p[0] > self::ONLINE_WINDOW || empty($p[2])) continue;
            $ident = self::identity($id);
            if ($ident && !empty($ident['vis'])) $list[] = self::publicIdentity($ident) + ['on' => true];
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
        $fp = self::fingerprint(self::str($b, 'fp'));
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
       Briefkasten: Direktnachrichten und Signale
       ====================================================================== */
    public static function send(array $me, array $b)
    {
        $to   = self::idOf(self::str($b, 'to'));
        $kind = self::str($b, 'k');
        if (!in_array($kind, ['dm', 'sig'], true)) throw new SecureComException('Unbekannte Art.', 422);
        $max  = $kind === 'sig' ? self::MAX_SIGNAL : self::MAX_ENTRY;
        $data = self::b64(self::str($b, 'd'), $max, 'Nachricht');
        if (!self::identity($to)) throw new SecureComException('Diese Identität gibt es nicht (mehr).', 404);

        $ttl = $kind === 'sig' ? self::SIGNAL_TTL : self::retentionDays() * 86400;
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
        return [
            'now'   => $now,
            'i'     => $inbox,
            'r'     => (object)$feeds,
            'rooms' => (object)$rooms,
            'pv'    => self::presenceVersion($presence, $me['id']),
        ];
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
        ];
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
            self::requireOwner($room, $me['id']);
            if ($epoch !== (int)$room['e']) throw new SecureComException('Veralteter Raumschlüssel.', 409);
            $room['m']  = $meta;
            $room['me'] = $epoch;
            $room['rev']++;
            return self::publicRoom($room, $me['id']);
        });
    }

    public static function createInvite(array $me, array $b)
    {
        $rid  = self::idOf(self::str($b, 'id'));
        $days = max(1, min(30, (int)($b['days'] ?? 7)));
        $max  = max(1, min(100, (int)($b['max'] ?? 25)));
        return self::roomMutate($rid, function (&$room) use ($me, $days, $max) {
            self::requireMember($room, $me['id']);
            $now = time();
            foreach ($room['inv'] as $code => $inv) {
                if ((int)$inv['x'] < $now || (int)$inv['n'] >= (int)$inv['max']) unset($room['inv'][$code]);
            }
            if (count($room['inv']) >= 50) throw new SecureComException('Zu viele offene Einladungen.', 409);
            $code = self::randomId();
            $room['inv'][$code] = ['b' => $me['id'], 'c' => $now, 'x' => $now + $days * 86400, 'n' => 0, 'max' => $max];
            return ['code' => $code, 'epoch' => (int)$room['e'], 'x' => $now + $days * 86400];
        });
    }

    public static function joinRoom(array $me, array $b)
    {
        $rid  = self::idOf(self::str($b, 'id'));
        $code = self::str($b, 'code');
        if (count(self::roomsOf($me['id'])) >= self::MAX_ROOMS) {
            throw new SecureComException('Du bist schon in ' . self::MAX_ROOMS . ' Räumen.', 409);
        }
        $room = self::roomMutate($rid, function (&$room) use ($me, $code) {
            if (isset($room['mem'][$me['id']])) return $room;
            $inv = $room['inv'][$code] ?? null;
            if (!$inv || !is_string($code) || (int)$inv['x'] < time() || (int)$inv['n'] >= (int)$inv['max']) {
                throw new SecureComException('Die Einladung ist ungültig oder abgelaufen.', 403);
            }
            if (count($room['mem']) >= self::MAX_MEMBERS) {
                throw new SecureComException('Der Raum ist voll.', 409);
            }
            $room['inv'][$code]['n']++;
            $room['mem'][$me['id']] = time();
            $room['rev']++;
            return $room;
        }, true);
        self::addMembership($me['id'], $rid);
        self::appendSys($rid, 'join', $me['id']);
        return self::publicRoom($room, $me['id']);
    }

    public static function leaveRoom(array $me, array $b)
    {
        $rid = self::idOf(self::str($b, 'id'));
        self::removeMember($rid, $me['id'], 'leave');
    }

    public static function kick(array $me, array $b)
    {
        $rid    = self::idOf(self::str($b, 'id'));
        $member = self::idOf(self::str($b, 'member'));
        $room = self::readJson(self::roomFile($rid), true);
        if (!$room) throw new SecureComException('Raum nicht gefunden.', 404);
        self::requireOwner($room, $me['id']);
        if ($member === $me['id']) throw new SecureComException('Dich selbst entfernst du über „Raum verlassen“.', 422);
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
            $room['rev']++;
            return $room;
        }, true);
        self::append(self::dir('feeds') . '/' . $rid, [
            't' => time(), 'k' => 'key', 'x' => time() + self::retentionDays() * 86400, 'e' => $epoch, 'd' => $env,
        ], self::MAX_FEED);
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

        $entry = ['t' => time(), 'k' => $kind];
        if ($kind === 'sig') {
            $to = self::idOf(self::str($b, 'to'));
            if (!isset($room['mem'][$to])) throw new SecureComException('Kein Mitglied dieses Raums.', 404);
            $entry['x']  = time() + self::SIGNAL_TTL;
            $entry['to'] = $to;
        } else {
            $entry['x'] = time() + self::retentionDays() * 86400;
        }
        $entry['d'] = $data;
        return ['s' => self::append(self::dir('feeds') . '/' . $rid, $entry, self::MAX_FEED)];
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
            if ($on) {
                $here = isset($room['vc'][$me['id']]) && (string)($room['vch'][$me['id']] ?? '') === $ch;
                if (!$here && count(self::voiceList($room, $ch)) >= self::MAX_VOICE) {
                    throw new SecureComException('Im Sprachkanal sind schon ' . self::MAX_VOICE . ' Personen.', 409);
                }
                $room['vc'][$me['id']] = $now;
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
    private static function createIdentity($id, $kind, $pub, $fp, $card, $username)
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
        if ($withVis) $out['vis'] = !empty($ident['vis']);
        return $out;
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

    private static function issueToken($id)
    {
        $token = rtrim(strtr(base64_encode(random_bytes(32)), '+/', '-_'), '=');
        $hash  = hash('sha256', $token);
        $now   = time();
        self::writeJson(self::dir('tokens') . '/' . $hash . '.json', ['id' => $id, 'c' => $now, 's' => $now]);

        $drop = [];
        self::mutate(self::idFile($id), function (&$i) use ($hash, &$drop) {
            if (!$i) return;
            $list = (array)($i['tok'] ?? []);
            $list[] = $hash;
            while (count($list) > self::MAX_TOKENS) $drop[] = array_shift($list);
            $i['tok'] = $list;
        });
        foreach ($drop as $old) @unlink(self::dir('tokens') . '/' . $old . '.json');
        return $token;
    }

    private static function dropToken($id, $hash)
    {
        @unlink(self::dir('tokens') . '/' . $hash . '.json');
        self::mutate(self::idFile($id), function (&$i) use ($hash) {
            if ($i) $i['tok'] = array_values(array_diff((array)($i['tok'] ?? []), [$hash]));
        });
    }

    /** Alles einer Identität löschen: Sitzungen, Briefkasten, Räume, Konto. */
    private static function purgeIdentity($id)
    {
        $ident = self::identity($id);
        foreach (self::roomsOf($id) as $rid) {
            try { self::removeMember($rid, $id, 'leave'); } catch (Throwable $ex) { /* Raum schon weg */ }
        }
        if ($ident) {
            foreach ((array)($ident['tok'] ?? []) as $th) @unlink(self::dir('tokens') . '/' . $th . '.json');
            if (!empty($ident['u'])) @unlink(self::accountFile($ident['u']));
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
        $vis = !empty($ident['vis']) ? 1 : 0;
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
        if (empty($ident['vis'])) return null;       // unsichtbar: unbekannt
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
        return [
            'id'      => $room['id'],
            'owner'   => $room['o'],
            'epoch'   => (int)$room['e'],
            'meta'    => $room['m'],
            'me'      => (int)$room['me'],
            'rev'     => (int)$room['rev'],
            'members' => $members,
            'vc'      => self::voiceList($room),            // erster Sprachkanal (ältere Apps)
            'vcs'     => (object)self::voiceMap($room),     // alle: Kanal => wer drin ist
        ];
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
            if (isset($r['vc'][$id])) $r['vc'][$id] = time();
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

    /** Mitglied entfernen; geht der Besitzer, übernimmt das älteste Mitglied. */
    private static function removeMember($rid, $member, $reason)
    {
        $destroy = false;
        $room = self::roomMutate($rid, function (&$room) use ($member, &$destroy) {
            if (!isset($room['mem'][$member])) return $room;
            unset($room['mem'][$member], $room['vc'][$member], $room['vch'][$member]);
            if (!$room['mem']) { $destroy = true; return $room; }
            if ($room['o'] === $member) {
                asort($room['mem']);
                $room['o'] = (string)array_key_first($room['mem']);
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
        if (!is_file(self::roomFile($rid))) return;
        self::append(self::dir('feeds') . '/' . $rid, [
            't' => time(), 'k' => 'sys', 'x' => time() + self::retentionDays() * 86400, 'ev' => $event, 'id' => $id,
        ], self::MAX_FEED);
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
    private static function append($base, array $entry, $maxBytes)
    {
        $h = fopen($base . '.n', 'c+');
        if (!$h) throw new RuntimeException('Zähler nicht beschreibbar.');
        flock($h, LOCK_EX);
        try {
            $state = json_decode((string)stream_get_contents($h), true);
            if (!is_array($state)) $state = ['n' => 0, 'c' => 0, 'g' => 0];

            $file = $base . '.jsonl';
            clearstatcache(true, $file);
            $size = is_file($file) ? filesize($file) : 0;
            if ($size > $maxBytes - 131072) {
                self::compact($base, $state);
                clearstatcache(true, $file);
                $size = is_file($file) ? filesize($file) : 0;
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
     * Abgelaufene Einträge entfernen (unter der Sperre von append). Danach
     * stimmen gemerkte Byte-Stellen nicht mehr – die Generation "g" sagt den
     * Lesern, dass sie von vorn (nach Nummer) suchen müssen.
     */
    private static function compact($base, array &$state)
    {
        $src = $base . '.jsonl';
        if (!is_file($src)) return;
        $tmp = $src . '.tmp';
        $in  = fopen($src, 'r');
        $out = fopen($tmp, 'w');
        $now = time();
        while (($line = fgets($in)) !== false) {
            if (substr($line, -1) !== "\n") continue;
            if (preg_match('/"x":(\d+)/', $line, $m) && (int)$m[1] < $now) continue;
            fwrite($out, $line);
        }
        fclose($in);
        fclose($out);
        rename($tmp, $src);
        $state['c'] = $now;
        $state['g'] = (int)($state['g'] ?? 0) + 1;
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

            $temp = self::readJson(self::dir() . '/temp.json', true) ?: [];
            $presence = self::readJson(self::dir() . '/presence.json', true) ?: [];
            $idle = self::tempHours() * 3600;
            foreach ($temp as $id => $created) {
                $seen = isset($presence[$id]) ? (int)$presence[$id][0] : (int)$created;
                if ($now - $seen > $idle) self::purgeIdentity($id);
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
            throw new SecureComException('SecureCom ist gerade voll. Bitte später erneut versuchen.', 503);
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
