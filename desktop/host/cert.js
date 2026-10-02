/* ==========================================================================
   Clavichat Server — selbst signiertes Zertifikat (ohne fremde Pakete)
   --------------------------------------------------------------------------
   Browser geben Verschlüsselung (WebCrypto) und Mikrofon nur über HTTPS
   frei. Für den Betrieb im eigenen Netz entsteht hier beim ersten Start ein
   eigenes Zertifikat: Schlüssel EC P-256, X.509 v3, signiert mit
   ECDSA/SHA-256. Node kann Schlüssel erzeugen und signieren, aber kein
   Zertifikat zusammensetzen – das übernimmt die kleine DER-Kodierung unten.

   Gültig 800 Tage: iPhones lehnen Server-Zertifikate mit mehr als 825 Tagen
   Laufzeit ab, auch wenn man ihnen sonst vertraut.
   ========================================================================== */
'use strict';

const crypto = require('node:crypto');
const net = require('node:net');

/* ---- DER, nur was ein Zertifikat braucht ---------------------------------- */
function len(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  while (n > 0) { bytes.unshift(n & 0xff); n = Math.floor(n / 256); }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag, content) => Buffer.concat([Buffer.from([tag]), len(content.length), content]);
const seq = (...parts) => tlv(0x30, Buffer.concat(parts));
const set = (...parts) => tlv(0x31, Buffer.concat(parts));
const octets = (buf) => tlv(0x04, buf);
const bits = (buf) => tlv(0x03, Buffer.concat([Buffer.from([0]), buf]));
const utf8 = (text) => tlv(0x0c, Buffer.from(text, 'utf8'));
const bool = (value) => tlv(0x01, Buffer.from([value ? 0xff : 0]));
const explicit = (n, content) => tlv(0xa0 | n, content);

function integer(buf) {
  let b = Buffer.from(buf);
  while (b.length > 1 && b[0] === 0 && !(b[1] & 0x80)) b = b.subarray(1);
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return tlv(0x02, b);
}

function oid(dotted) {
  const arcs = dotted.split('.').map(Number);
  const out = [40 * arcs[0] + arcs[1]];
  for (const arc of arcs.slice(2)) {
    const chunk = [arc & 0x7f];
    let rest = Math.floor(arc / 128);
    while (rest > 0) { chunk.unshift(0x80 | (rest & 0x7f)); rest = Math.floor(rest / 128); }
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
}

/** UTCTime bis 2049, danach GeneralizedTime (RFC 5280). */
function time(date) {
  const iso = date.toISOString().replace(/[-:T]/g, '').slice(0, 14) + 'Z';
  return date.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(iso.slice(2))) : tlv(0x18, Buffer.from(iso));
}

const OID = {
  ecdsaSha256: '1.2.840.10045.4.3.2',
  commonName: '2.5.4.3',
  organization: '2.5.4.10',
  basicConstraints: '2.5.29.19',
  keyUsage: '2.5.29.15',
  extKeyUsage: '2.5.29.37',
  subjectAltName: '2.5.29.17',
  subjectKeyId: '2.5.29.14',
  serverAuth: '1.3.6.1.5.5.7.3.1'
};

function extension(id, critical, value) {
  return critical ? seq(oid(id), bool(true), octets(value)) : seq(oid(id), octets(value));
}

/** Alternative Namen: DNS-Namen und IP-Adressen (v4 und v6). */
function altNames(hosts) {
  const names = [];
  for (const h of hosts) {
    if (net.isIPv4(h)) names.push(tlv(0x87, Buffer.from(h.split('.').map(Number))));
    else if (net.isIPv6(h)) names.push(tlv(0x87, ipv6Bytes(h)));
    else names.push(tlv(0x82, Buffer.from(h, 'ascii')));
  }
  return seq(...names);
}

function ipv6Bytes(ip) {
  const [head, tail] = ip.split('::');
  const a = head ? head.split(':') : [];
  const b = tail !== undefined && tail ? tail.split(':') : [];
  const fill = tail !== undefined ? new Array(8 - a.length - b.length).fill('0') : [];
  const out = Buffer.alloc(16);
  [...a, ...fill, ...b].forEach((part, i) => out.writeUInt16BE(parseInt(part || '0', 16), i * 2));
  return out;
}

/**
 * Neues Zertifikat. hosts: Namen und Adressen, unter denen der Server
 * erreichbar ist. Ergebnis: { cert, key } als PEM und der Fingerabdruck.
 */
function makeCertificate(hosts, commonName) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const now = Date.now();
  const name = seq(
    set(seq(oid(OID.commonName), utf8(commonName || 'Clavichat Server'))),
    set(seq(oid(OID.organization), utf8('Clavichat'))));
  const tbs = seq(
    explicit(0, integer(Buffer.from([2]))),                       // Version 3
    integer(crypto.randomBytes(16)),                              // Seriennummer
    seq(oid(OID.ecdsaSha256)),
    name,
    seq(time(new Date(now - 86400000)), time(new Date(now + 800 * 86400000))),
    name,
    spki,
    explicit(3, seq(
      extension(OID.basicConstraints, true, seq()),               // kein CA-Zertifikat
      extension(OID.keyUsage, true, tlv(0x03, Buffer.from([0x07, 0x80]))),   // digitalSignature
      extension(OID.extKeyUsage, false, seq(oid(OID.serverAuth))),
      extension(OID.subjectKeyId, false, octets(crypto.createHash('sha1').update(spki).digest())),
      extension(OID.subjectAltName, false, altNames([...new Set(hosts)])))));
  const signature = crypto.sign('sha256', tbs, privateKey);       // DER-kodiertes ECDSA
  const der = seq(tbs, seq(oid(OID.ecdsaSha256)), bits(signature));
  const pem = '-----BEGIN CERTIFICATE-----\n' + der.toString('base64').match(/.{1,64}/g).join('\n') + '\n-----END CERTIFICATE-----\n';
  return {
    cert: pem,
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    fingerprint: fingerprintOf(der)
  };
}

/** SHA-256 über das DER-Zertifikat, wie Browser ihn zeigen (AB:CD:…). */
function fingerprintOf(der) {
  return crypto.createHash('sha256').update(der).digest('hex').toUpperCase().match(/.{2}/g).join(':');
}

module.exports = { makeCertificate, fingerprintOf };
