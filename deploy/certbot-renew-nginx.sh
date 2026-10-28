#!/bin/sh
# Install as /etc/letsencrypt/renewal-hooks/deploy/three-chess-nginx-reload.
# Certbot runs deploy hooks only after successful issuance or renewal.
set -eu
case "${RENEWED_LINEAGE:-}" in
    /etc/letsencrypt/live/47.95.251.153) ;;
    *) exit 0 ;;
esac
/usr/sbin/nginx -t
/bin/systemctl reload nginx
