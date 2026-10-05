#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

required_files=(
  README.md
  docs/functional-specification.md
  docs/architecture.md
  docs/security-review.md
  docs/deployment-coolify.md
  docs/acceptance-test-plan.md
  docs/operations-runbook.md
  docs/release-checklist.md
  docs/release-model.md
  scripts/verify-container.sh
  scripts/verify-acceptance.sh
  .github/workflows/ci.yml
  .github/workflows/release.yml
)

for file in "${required_files[@]}"; do
  [[ -s "$file" ]] || { echo "release-gate: missing required file: $file" >&2; exit 1; }
done

if grep -RInE '(GITHUB_CLIENT_SECRET|SESSION_SECRET|MCP_TOKEN_SECRET|DATABASE_URL)=[^.<{[:space:]][^[:space:]]+'   --exclude='.env.example' --exclude='release-gate.sh' . >/tmp/browser-screenshot-secret-scan.txt 2>/dev/null; then
  echo "release-gate: potential committed secret/config value detected:" >&2
  cat /tmp/browser-screenshot-secret-scan.txt >&2
  exit 1
fi

: "${RELEASE_EVIDENCE_DIR:=.release-evidence}"
required_evidence=(
  source-verify.pass
  container-smoke.pass
  github-ci.pass
  ghcr-multiarch.pass
  remote-acceptance.pass
  ui-desktop.pass
  ui-mobile.pass
  production-egress-policy.pass
  backup-restore-reviewed.pass
)

missing=0
for evidence in "${required_evidence[@]}"; do
  if [[ ! -s "$RELEASE_EVIDENCE_DIR/$evidence" ]]; then
    echo "release-gate: missing evidence: $RELEASE_EVIDENCE_DIR/$evidence" >&2
    missing=1
  fi
done

candidate_file="$RELEASE_EVIDENCE_DIR/candidate-image.env"
if [[ ! -s "$candidate_file" ]]; then
  echo "release-gate: missing evidence: $candidate_file" >&2
  missing=1
fi

if [[ "$missing" -ne 0 ]]; then
  echo "release-gate: NO-GO — required release evidence is incomplete." >&2
  exit 1
fi

read_unique_value() {
  local key="$1"
  local file="$2"
  local count
  count="$(grep -c "^$key=" "$file" || true)"
  if [[ "$count" -ne 1 ]]; then
    echo "release-gate: candidate-image.env must contain exactly one $key entry" >&2
    exit 1
  fi
  sed -n "s/^$key=//p" "$file"
}

candidate_image="$(read_unique_value IMAGE "$candidate_file")"
candidate_digest="$(read_unique_value DIGEST "$candidate_file")"
candidate_commit="$(read_unique_value COMMIT_SHA "$candidate_file")"

if [[ ! "$candidate_image" =~ ^ghcr\.io/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]]; then
  echo "release-gate: invalid candidate IMAGE in $candidate_file" >&2
  exit 1
fi
if [[ ! "$candidate_digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo "release-gate: invalid candidate DIGEST in $candidate_file" >&2
  exit 1
fi
if [[ ! "$candidate_commit" =~ ^[0-9a-f]{40}$ ]]; then
  echo "release-gate: invalid candidate COMMIT_SHA in $candidate_file" >&2
  exit 1
fi

if [[ -n "${EXPECTED_IMAGE:-}" && "$candidate_image" != "$EXPECTED_IMAGE" ]]; then
  echo "release-gate: candidate image mismatch: expected $EXPECTED_IMAGE, got $candidate_image" >&2
  exit 1
fi
if [[ -n "${RELEASE_COMMIT_SHA:-}" && "$candidate_commit" != "$RELEASE_COMMIT_SHA" ]]; then
  echo "release-gate: candidate commit mismatch: expected $RELEASE_COMMIT_SHA, got $candidate_commit" >&2
  exit 1
fi

echo "release-gate: GO — required release evidence is present and tied to candidate $candidate_image@$candidate_digest at commit $candidate_commit."
