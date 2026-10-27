<?php
/**
 * ============================================================================
 *  Clavichat — Schnittstelle für den Browser.
 * ============================================================================
 *  Alle Aufrufe: POST an genau diese Adresse, JSON {"a": "<aktion>", …}.
 *  Die Aktion steht bewusst nicht in der Adresse: In den Zugriffsprotokollen
 *  des Servers steht so nur, DASS Clavichat benutzt wird – nicht was.
 *
 *  Angemeldet wird mit dem Kopf "X-SC-Token" statt mit einem Cookie. Ein
 *  Kopf wird nie von selbst mitgeschickt, fremde Seiten können also keine
 *  Aufrufe unterschieben (kein CSRF).
 *
 *  Was hier ankommt, ist bereits im Browser verschlüsselt – siehe
 *  lib/SecureCom.php. Einstellungen: config.php (Vorlage config.sample.php).
 * ----------------------------------------------------------------------------
 */

if (function_exists('mb_internal_encoding')) {
    mb_internal_encoding('UTF-8');
}
ini_set('display_errors', '0');
error_reporting(E_ALL);

require_once __DIR__ . '/lib/util.php';
require_once __DIR__ . '/lib/SecureCom.php';

header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: no-referrer');
header('X-Frame-Options: DENY');

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    json_fail('Nur POST.', 405);
}

$raw = (string)file_get_contents('php://input', false, null, 0, 1200001);
if (strlen($raw) > 1200000) json_fail('Anfrage zu groß.', 413);
$body = json_decode($raw, true);
if (!is_array($body)) json_fail('Ungültige Anfrage.', 400);
$action = SecureCom::str($body, 'a');

/**
 * Begrenzt Aufrufe je Eimer. Adressen gehen nur als HMAC mit dem geheimen
 * Server-Schlüssel ein – in der Ablage steht so keine IP-Adresse.
 */
function sc_limit($bucket, $max, $window)
{
    if (!rate_limit('sc:' . $bucket, $max, $window)) {
        json_fail('Zu viele Anfragen. Bitte kurz warten.', 429);
    }
}

$ipTag = hash_hmac('sha256', client_ip(), app_key());

try {
    /* ---- Ohne Anmeldung ------------------------------------------------ */
    switch ($action) {
        case 'config':
            json_out(['ok' => true] + SecureCom::config());

        case 'register':
            sc_limit('reg:' . $ipTag, 5, 3600);
            json_out(['ok' => true] + SecureCom::register($body));

        case 'login': {
            $user = hash('sha256', strtolower(trim(SecureCom::str($body, 'username'))));
            sc_limit('login:' . $ipTag, 30, 900);
            sc_limit('login-u:' . $user, 10, 900);
            $result = SecureCom::login($body);
            rate_limit_clear('sc:login-u:' . $user);
            json_out(['ok' => true] + $result);
        }

        case 'temp':
            sc_limit('temp:' . $ipTag, 20, 3600);
            json_out(['ok' => true] + SecureCom::startTemp($body));

        case 'invite.info':
            // Vor dem Beitritt: Lässt der Raum nur Konten zu? (Nur mit gültiger Einladung.)
            sc_limit('invi:' . $ipTag, 60, 3600);
            json_out(['ok' => true] + SecureCom::inviteInfo($body));

        case 'hook.post':
            // API-Zugang (nur posten, ohne Anmeldung): je Adresse und je Zugang begrenzt.
            sc_limit('hookip:' . $ipTag, 60, 60);
            $hookTag = hash('sha256', SecureCom::str($body, 'r') . '/' . SecureCom::str($body, 'h'));
            sc_limit('hook:' . $hookTag, 20, 60);
            sc_limit('hookh:' . $hookTag, 300, 3600);
            json_out(['ok' => true] + SecureCom::hookPost($body));

        case 'sso.who':
            // Nur mit Ticket des Dashboards (gibt es auf eigenständigen Servern nicht).
            sc_limit('sso:' . $ipTag, 30, 600);
            json_out(['ok' => true] + SecureCom::ssoWho($body));
    }

    /* ---- Mit Anmeldung ------------------------------------------------- */
    $me = SecureCom::authenticate((string)($_SERVER['HTTP_X_SC_TOKEN'] ?? ''));

    switch ($action) {
        case 'me':
            json_out(['ok' => true] + SecureCom::me($me));

        case 'logout':
            SecureCom::logout($me);
            json_out(['ok' => true]);

        case 'end':
            SecureCom::endTemp($me);
            json_out(['ok' => true]);

        case 'delete':
            sc_limit('del:' . $me['id'], 5, 3600);
            SecureCom::deleteAccount($me, $body);
            json_out(['ok' => true]);

        case 'password':
            sc_limit('pw:' . $me['id'], 10, 3600);
            json_out(['ok' => true] + SecureCom::changePassword($me, $body));

        case 'devices':
            sc_limit('dev:' . $me['id'], 120, 3600);
            json_out(['ok' => true] + SecureCom::devices($me));

        case 'device.label':
            sc_limit('devl:' . $me['id'], 30, 3600);
            json_out(['ok' => true] + SecureCom::deviceLabel($me, $body));

        case 'device.revoke':
            sc_limit('devr:' . $me['id'], 30, 3600);
            json_out(['ok' => true] + SecureCom::revokeDevices($me, $body));

        case 'key.lease':
            // Forward Secrecy: wer wechselt gerade den Unterschlüssel?
            sc_limit('klease:' . $me['id'], 60, 3600);
            json_out(['ok' => true] + SecureCom::keyLease($me));

        case 'key.pub':
            sc_limit('kpub:' . $me['id'], 30, 3600);
            json_out(['ok' => true] + SecureCom::updateKey($me, $body));

        case 'key.wrap':
            sc_limit('kwrap:' . $me['id'], 20, 3600);
            json_out(['ok' => true] + SecureCom::rewrapKey($me, $body));

        case 'vault':
            sc_limit('vault:' . $me['id'], 240, 3600);
            json_out(['ok' => true] + SecureCom::saveVault($me, $body));

        case 'vault.get':
            json_out(['ok' => true] + SecureCom::loadVault($me));

        case 'card':
            sc_limit('card:' . $me['id'], 30, 3600);
            json_out(['ok' => true] + SecureCom::updateCard($me, $body));

        case 'avatar':
            sc_limit('avatar:' . $me['id'], 20, 3600);
            json_out(['ok' => true] + SecureCom::setAvatar($me, $body));

        case 'ice':
            // Relay-Zugangsdaten nur für Angemeldete (siehe SecureCom::config).
            sc_limit('ice:' . $me['id'], 60, 3600);
            json_out(['ok' => true, 'ice' => SecureCom::iceServers(true), 'relay' => SecureCom::hasRelay()]);

        case 'avatars':
            json_out(['ok' => true, 'list' => SecureCom::avatars($me, $body)]);

        case 'online':
            json_out(['ok' => true, 'list' => SecureCom::online($me)]);

        case 'ids':
            json_out(['ok' => true, 'list' => SecureCom::identities($me, $body)]);

        case 'find':
            sc_limit('find:' . $me['id'], 60, 600);
            json_out(['ok' => true, 'list' => SecureCom::find($me, $body)]);

        case 'send':
            sc_limit('send:' . $me['id'], 120, 60);
            json_out(['ok' => true] + SecureCom::send($me, $body));

        case 'poll':
            json_out(['ok' => true] + SecureCom::poll($me, $body));

        case 'pres':
            // Freunde: etwa alle 20 Sekunden lesen, jede Minute schreiben.
            sc_limit('pres:' . $me['id'], 600, 3600);
            json_out(['ok' => true] + SecureCom::presence($me, $body));

        case 'inbox.trim':
            // Aufbewahrung verkürzt: eigene ältere Einträge löschen.
            sc_limit('trim:' . $me['id'], 120, 3600);
            json_out(['ok' => true] + SecureCom::trimInbox($me, $body));

        case 'rooms':
            json_out(['ok' => true, 'rooms' => SecureCom::rooms($me)]);

        case 'room.create':
            sc_limit('room:' . $me['id'], 20, 3600);
            json_out(['ok' => true, 'room' => SecureCom::createRoom($me, $body)]);

        case 'room.meta':
            json_out(['ok' => true, 'room' => SecureCom::updateMeta($me, $body)]);

        case 'room.ttl':
            json_out(['ok' => true, 'room' => SecureCom::setRoomTtl($me, $body)]);

        case 'room.cttl':
            // Aufbewahrung eines Textkanals (nur der Besitzer; ttl 0 = wie der Raum).
            sc_limit('cttl:' . $me['id'], 120, 3600);
            json_out(['ok' => true, 'room' => SecureCom::setChannelTtl($me, $body)]);

        case 'room.ao':
            // Nur Mitglieder mit Konto: an/aus (nur der Besitzer).
            json_out(['ok' => true, 'room' => SecureCom::setRoomAccounts($me, $body)]);

        case 'room.invite':
            sc_limit('inv:' . $me['id'], 60, 3600);
            json_out(['ok' => true] + SecureCom::createInvite($me, $body));

        case 'room.join':
            sc_limit('join:' . $ipTag, 30, 3600);
            json_out(['ok' => true, 'room' => SecureCom::joinRoom($me, $body)]);

        case 'room.leave':
            SecureCom::leaveRoom($me, $body);
            json_out(['ok' => true]);

        case 'room.kick':
            SecureCom::kick($me, $body);
            json_out(['ok' => true]);

        case 'room.rotate':
            json_out(['ok' => true, 'room' => SecureCom::rotate($me, $body)]);

        case 'room.delete':
            SecureCom::deleteRoom($me, $body);
            json_out(['ok' => true]);

        case 'room.post':
            sc_limit('post:' . $me['id'], 240, 60);
            json_out(['ok' => true] + SecureCom::post($me, $body));

        case 'room.del':
            // Besitzer entfernt Nachrichten/API-Beiträge aus dem Verlauf.
            sc_limit('rdel:' . $me['id'], 300, 3600);
            json_out(['ok' => true] + SecureCom::deleteEntries($me, $body));

        case 'hook.create':
            // API-Zugang anlegen (nur Besitzer, nur Konten, nur bleibende Räume).
            sc_limit('hookc:' . $me['id'], 20, 3600);
            json_out(['ok' => true] + SecureCom::hookCreate($me, $body));

        case 'hook.list':
            json_out(['ok' => true, 'list' => SecureCom::hookList($me, $body)]);

        case 'hook.del':
            json_out(['ok' => true] + SecureCom::hookDel($me, $body));

        case 'room.voice':
            json_out(['ok' => true] + SecureCom::voice($me, $body));

        case 'file.put':
            // Dateistücke (512 KB): 600 je Stunde = ein Dutzend Dateien zu 25 MB.
            sc_limit('fput:' . $me['id'], 600, 3600);
            json_out(['ok' => true] + SecureCom::filePut($me, $body));

        case 'file.get':
            sc_limit('fget:' . $me['id'], 3000, 3600);
            json_out(['ok' => true] + SecureCom::fileGet($me, $body));

        case 'file.del':
            sc_limit('fdel:' . $me['id'], 120, 3600);
            json_out(['ok' => true] + SecureCom::fileDel($me, $body));

        default:
            json_fail('Unbekannte Aktion.', 404);
    }
} catch (SecureComException $ex) {
    json_out(['ok' => false, 'error' => $ex->getMessage()] + $ex->extra, $ex->status);
} catch (Throwable $ex) {
    error_log('[securecom] [' . $action . '] ' . get_class($ex) . ': ' . $ex->getMessage()
            . ' @ ' . $ex->getFile() . ':' . $ex->getLine());
    // Wie in api.php: "undefined" heißt fast immer, dass nur ein Teil der
    // geänderten Dateien hochgeladen wurde.
    if ($ex instanceof Error && stripos($ex->getMessage(), 'undefined') !== false) {
        json_fail('Die Serverdateien passen nicht zusammen – vermutlich wurde nur ein Teil '
            . 'der geänderten Dateien hochgeladen. Bitte alle erneut übertragen.', 500);
    }
    json_fail('Unerwarteter Serverfehler.', 500);
}
