<?php
/**
 * SecureCom — Einstellungen
 *
 * Als config.php neben api.php speichern. Alles ist optional; ohne Datei
 * gelten die Standardwerte unten.
 */
return [
    // Datenverzeichnis. Am besten AUSSERHALB des Webroots, z. B.
    // '/home/nutzer/securecom-data'. Ohne Angabe: storage/ neben api.php
    // (dann sperrt eine automatisch angelegte .htaccess den Zugriff).
    'storage_dir' => null,

    // Öffentliche Adresse der Seite – Einladungslinks zeigen hierher.
    // Ohne Angabe wird sie aus der Anfrage ermittelt.
    'public_url' => '',

    // Gesetzt: Konto anlegen und temporäre Sitzungen nur mit diesem Code.
    'securecom_access_code' => '',

    // So lange bleiben verschlüsselte Nachrichten liegen (Tage).
    'securecom_retention_days' => 30,

    // Leerlauf, nach dem temporäre Sitzungen samt Daten verschwinden (Stunden).
    'securecom_temp_hours' => 24,

    // Obergrenze aller Identitäten (Konten + temporäre Sitzungen).
    'securecom_max_identities' => 2000,

    // STUN: damit Geräte ihre öffentliche Adresse herausfinden.
    'securecom_stun' => ['stun:stun.cloudflare.com:3478'],

    // TURN (Relay) für Netze, in denen keine direkte Verbindung klappt, z. B.
    // [['urls' => 'turn:turn.example.com:3478', 'username' => '…', 'credential' => '…']]
    'securecom_turn' => [],

    // Oder Cloudflare Realtime TURN: kurzlebige Zugangsdaten holt SecureCom selbst.
    // ['key_id' => '…', 'api_token' => '…']
    'securecom_cf_turn' => null,
];
