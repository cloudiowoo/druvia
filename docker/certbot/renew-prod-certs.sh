#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
DOCKER_DIR=$(CDPATH= cd -- "${SCRIPT_DIR}/.." && pwd)
BASE_ENV_FILE="${BASE_ENV_FILE:-${ENV_FILE:-${DOCKER_DIR}/.env.prod}}"
RELEASE_ENV_FILE="${RELEASE_ENV_FILE:-${DOCKER_DIR}/.env.release}"
export DRUVIA_DEPLOY_DIR="${DRUVIA_DEPLOY_DIR:-${DOCKER_DIR}}"

if [ -z "${COMPOSE_FILE:-}" ]; then
  if [ -f "${RELEASE_ENV_FILE}" ]; then
    COMPOSE_FILE="${DOCKER_DIR}/docker-compose.release.yml"
  else
    COMPOSE_FILE="${DOCKER_DIR}/docker-compose.prod.yml"
  fi
fi

set -- --env-file "${BASE_ENV_FILE}"
if [ -f "${RELEASE_ENV_FILE}" ]; then
  set -- "$@" --env-file "${RELEASE_ENV_FILE}"
fi

docker compose "$@" -f "${COMPOSE_FILE}" --profile with-nginx run --rm certbot renew
docker compose "$@" -f "${COMPOSE_FILE}" --profile with-nginx exec -T nginx nginx -s reload
