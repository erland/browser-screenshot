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
  scripts/verify-container.sh
  scripts/verify-acceptance.sh
  .github/workflows/ci.yml
  .github/workflows/release.yml
)

for file in "${required_files[@]}"; do
  [[ -s "$file" ]] || { echo "release-gate: missing required file: $file" >&2; exit 1; }
done

if grep -RInE '(GITHUB_CLIENT_SECRET|SESSION_SECRET|MCP_TOKEN_SECRET|DATABASE_URL)=[^.<{[:space:]][^[:space:]]+' \
  --exclude='.env.example' --exclude='release-gate.sh' . >/tmp/browser-screenshot-secret-scan.txt 2>/dev/null; then
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

if [[ "$missing" -ne 0 ]]; then
  echo "release-gate: NO-GO — required release evidence is incomplete." >&2
  exit 1
fi

echo "release-gate: GO — required release evidence is present. Review docs/release-checklist.md before publishing/deploying."
