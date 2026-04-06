#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
DOCKER_DIR=$(CDPATH= cd -- "${SCRIPT_DIR}/.." && pwd)
ENV_FILE="${ENV_FILE:-${DOCKER_DIR}/.env.prod}"
COMPOSE_FILE="${DOCKER_DIR}/docker-compose.prod.yml"

docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" --profile with-nginx run --rm certbot renew
docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" --profile with-nginx exec -T nginx nginx -s reload
