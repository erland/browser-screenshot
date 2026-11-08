#!/usr/bin/env bash
set -euo pipefail

IMAGE="${IMAGE:-browser-screenshot:dev011}"
PROJECT="browser-screenshot-dev011-$$"
SECCOMP_PROFILE="${SECCOMP_PROFILE:-$PWD/seccomp_profile.json}"

if [[ ! -f "$SECCOMP_PROFILE" ]]; then
  echo "Missing Chromium seccomp profile: $SECCOMP_PROFILE" >&2
  exit 1
fi

cleanup() {
  docker compose -p "$PROJECT" down -v --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker build --pull -t "$IMAGE" .

docker run --rm --init --shm-size=1g   --security-opt "seccomp=$SECCOMP_PROFILE"   "$IMAGE" node apps/server/dist/container-smoke.js

# Real Chromium test: install SW/cache on a deterministic isolated HTTPS fixture,
# reload offline, and recover online. This does not claim to prove egress isolation.
docker run --rm --init --shm-size=1g \
  --security-opt "seccomp=$SECCOMP_PROFILE" \
  "$IMAGE" node apps/server/dist/pwa-offline-smoke.js

# Re-run existing sandbox/SSRF checks while automation contexts allow service
# workers. The per-context interceptor can be bypassed by SW-originated fetches:
# the mandatory hardened browser proxy must remain the security boundary.
docker run --rm --init --shm-size=1g \
  --security-opt "seccomp=$SECCOMP_PROFILE" \
  -e BROWSER_PWA_TEST_ENABLED=true \
  "$IMAGE" node apps/server/dist/container-smoke.js

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
