# syntax=docker/dockerfile:1
# ============================================================================
#  SecureCom – Server als Container (Apache + PHP 8.3, ohne Datenbank)
# ============================================================================
#  Bauen:   docker build -t securecom .
#  Starten: docker compose up -d   (siehe compose.yaml – mit HTTPS über Caddy)
#
#  Der Container spricht nur HTTP auf Port 80. Browser geben Verschlüsselung
#  und Mikrofon nur über HTTPS frei – davor gehört also ein Reverse-Proxy
#  mit Zertifikat (Caddy, Traefik, nginx …). Daten liegen im Volume /data.
#  Einstellungen kommen aus Umgebungsvariablen (docker/config.php).
# ----------------------------------------------------------------------------
FROM php:8.3-apache

# Produktions-Einstellungen von PHP; Datenordner außerhalb des Webroots,
# nur für den Webserver-Nutzer beschreibbar.
RUN set -eux; \
    mv "$PHP_INI_DIR/php.ini-production" "$PHP_INI_DIR/php.ini"; \
    mkdir -p /data; \
    chown www-data:www-data /data; \
    chmod 0750 /data

COPY docker/apache.conf /etc/apache2/conf-enabled/securecom.conf
COPY docker/php.ini "$PHP_INI_DIR/conf.d/securecom.ini"
COPY server/ /var/www/html/
COPY docker/config.php /var/www/html/config.php

ENV SECURECOM_STORAGE=/data
VOLUME ["/data"]
EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -fsS -o /dev/null -X POST -H 'Content-Type: application/json' -d '{"a":"config"}' http://127.0.0.1/api.php || exit 1

LABEL org.opencontainers.image.title="SecureCom" \
      org.opencontainers.image.description="Ende-zu-Ende verschlüsselt schreiben, telefonieren und den Bildschirm teilen" \
      org.opencontainers.image.source="https://github.com/mxachterberg/securecom" \
      org.opencontainers.image.licenses="MIT"
