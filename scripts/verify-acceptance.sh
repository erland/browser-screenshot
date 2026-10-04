#!/usr/bin/env bash
set -euo pipefail

: "${BASE_URL:?BASE_URL is required, e.g. https://browser-screenshot.example.com}"
: "${REST_COOKIE:?REST_COOKIE is required, e.g. browser_screenshot_session=...}"
: "${MCP_ACCESS_TOKEN:?MCP_ACCESS_TOKEN is required}"
PUBLIC_URL="${PUBLIC_URL:-https://example.com}"
BASE_URL="${BASE_URL%/}"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

fail() { echo "acceptance: FAIL: $*" >&2; exit 1; }
status() {
  curl --silent --show-error --output "$2" --write-out '%{http_code}' "$1" "${@:3}"
}
assert_code() { [[ "$1" == "$2" ]] || fail "expected HTTP $2, got $1"; }

code="$(status "$BASE_URL/health" "$TMP_DIR/health.json")"; assert_code "$code" 200
code="$(status "$BASE_URL/ready" "$TMP_DIR/ready.json")"; assert_code "$code" 200
if grep -Eqi 'secret|token|password|database_url|authorization' "$TMP_DIR/health.json" "$TMP_DIR/ready.json"; then
  fail 'health/readiness response appears to disclose sensitive configuration'
fi

code="$(status "$BASE_URL/api/me" "$TMP_DIR/unauth.json")"; assert_code "$code" 401
code="$(status "$BASE_URL/api/screenshot-presets" "$TMP_DIR/presets.json" -H "Cookie: $REST_COOKIE")"; assert_code "$code" 200
for preset in desktop tablet mobile; do grep -q "\"$preset\"" "$TMP_DIR/presets.json" || fail "missing preset $preset"; done

code="$(curl --silent --show-error --dump-header "$TMP_DIR/mobile.headers" --output "$TMP_DIR/mobile.png" --write-out '%{http_code}' \
  -H "Cookie: $REST_COOKIE" -H 'content-type: application/json' \
  --data "{\"url\":\"$PUBLIC_URL\",\"preset\":\"mobile\",\"fullPage\":false}" "$BASE_URL/api/screenshots")"
assert_code "$code" 200
[[ "$(od -An -tx1 -N8 "$TMP_DIR/mobile.png" | tr -d ' \n')" == '89504e470d0a1a0a' ]] || fail 'REST result is not PNG'
grep -qi '^x-screenshot-viewport-width: 390' "$TMP_DIR/mobile.headers" || fail 'mobile viewport width metadata mismatch'
grep -qi '^x-screenshot-viewport-height: 844' "$TMP_DIR/mobile.headers" || fail 'mobile viewport height metadata mismatch'

code="$(curl --silent --show-error --dump-header "$TMP_DIR/custom.headers" --output "$TMP_DIR/custom.png" --write-out '%{http_code}' \
  -H "Cookie: $REST_COOKIE" -H 'content-type: application/json' \
  --data "{\"url\":\"$PUBLIC_URL\",\"width\":777,\"height\":555,\"deviceScaleFactor\":1,\"fullPage\":false}" "$BASE_URL/api/screenshots")"
assert_code "$code" 200
grep -qi '^x-screenshot-viewport-width: 777' "$TMP_DIR/custom.headers" || fail 'custom viewport width not honored'
grep -qi '^x-screenshot-viewport-height: 555' "$TMP_DIR/custom.headers" || fail 'custom viewport height not honored'

code="$(curl --silent --show-error --output "$TMP_DIR/invalid.json" --write-out '%{http_code}' \
  -H "Cookie: $REST_COOKIE" -H 'content-type: application/json' \
  --data "{\"url\":\"$PUBLIC_URL\",\"width\":10,\"height\":555}" "$BASE_URL/api/screenshots")"
assert_code "$code" 400
grep -q 'INVALID_REQUEST' "$TMP_DIR/invalid.json" || fail 'invalid viewport did not return INVALID_REQUEST'

code="$(curl --silent --show-error --output "$TMP_DIR/blocked.json" --write-out '%{http_code}' \
  -H "Cookie: $REST_COOKIE" -H 'content-type: application/json' \
  --data '{"url":"http://127.0.0.1/","preset":"desktop"}' "$BASE_URL/api/screenshots")"
assert_code "$code" 403
grep -q 'BLOCKED_DESTINATION' "$TMP_DIR/blocked.json" || fail 'loopback target did not return BLOCKED_DESTINATION'

BASE_URL="$BASE_URL" PUBLIC_URL="$PUBLIC_URL" MCP_ACCESS_TOKEN="$MCP_ACCESS_TOKEN" node scripts/acceptance-mcp.mjs

echo 'remote-acceptance: PASS'
