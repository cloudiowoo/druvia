#!/bin/sh
set -eu

PRIMARY_DOMAIN="${CERTBOT_PRIMARY_DOMAIN:?CERTBOT_PRIMARY_DOMAIN is required}"
CERTBOT_EMAIL="${CERTBOT_EMAIL:?CERTBOT_EMAIL is required}"
WILDCARD_DOMAIN="${CERTBOT_WILDCARD_DOMAIN:-}"
CREDENTIALS_FILE="${CERTBOT_DNSPOD_CREDENTIALS:-/secrets/dnspod.ini}"
OUTPUT_DIR="${CERTBOT_OUTPUT_DIR:-/output}"
LIVE_DIR="/etc/letsencrypt/live/${PRIMARY_DOMAIN}"

sync_live_certificate() {
  if [ ! -f "${LIVE_DIR}/fullchain.pem" ] || [ ! -f "${LIVE_DIR}/privkey.pem" ]; then
    echo "Certificate files not found under ${LIVE_DIR}" >&2
    return 1
  fi

  mkdir -p "${OUTPUT_DIR}"
  cp "${LIVE_DIR}/fullchain.pem" "${OUTPUT_DIR}/fullchain.pem"
  cp "${LIVE_DIR}/privkey.pem" "${OUTPUT_DIR}/privkey.pem"
  chmod 644 "${OUTPUT_DIR}/fullchain.pem"
  chmod 600 "${OUTPUT_DIR}/privkey.pem"
}

issue_certificate() {
  if [ ! -f "${CREDENTIALS_FILE}" ]; then
    echo "DNSPod credentials file not found: ${CREDENTIALS_FILE}" >&2
    exit 1
  fi

  set -- certonly \
    --dns-dnspod \
    --dns-dnspod-credentials "${CREDENTIALS_FILE}" \
    -d "${PRIMARY_DOMAIN}"

  if [ -n "${WILDCARD_DOMAIN}" ]; then
    set -- "$@" -d "${WILDCARD_DOMAIN}"
  fi

  set -- "$@" \
    --non-interactive \
    --agree-tos \
    -m "${CERTBOT_EMAIL}" \
    --keep-until-expiring

  certbot "$@"
  sync_live_certificate
}

renew_certificate() {
  certbot renew --quiet "$@"
  sync_live_certificate
}

COMMAND="${1:-issue}"
if [ "$#" -gt 0 ]; then
  shift
fi

case "${COMMAND}" in
  issue)
    issue_certificate "$@"
    ;;
  renew)
    renew_certificate "$@"
    ;;
  sync)
    sync_live_certificate
    ;;
  *)
    exec "${COMMAND}" "$@"
    ;;
esac
