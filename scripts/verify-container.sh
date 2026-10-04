#!/usr/bin/env bash
set -euo pipefail

IMAGE="${IMAGE:-browser-screenshot:dev011}"
PROJECT="browser-screenshot-dev011-$$"
cleanup() {
  docker compose -p "$PROJECT" down -v --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker build --pull -t "$IMAGE" .

docker run --rm --init --shm-size=1g "$IMAGE" node apps/server/dist/container-smoke.js

docker compose -p "$PROJECT" up -d --build
for _ in $(seq 1 30); do
  if curl --fail --silent http://127.0.0.1:8080/ready >/dev/null; then
    echo "container-health: PASS"
    exit 0
  fi
  sleep 2
done

docker compose -p "$PROJECT" logs app postgres >&2
exit 1
