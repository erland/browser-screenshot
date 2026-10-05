#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

required=(
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

candidate_image="ghcr.io/erland/browser-screenshot"
candidate_digest="sha256:$(printf 'a%.0s' {1..64})"
candidate_commit="$(printf 'b%.0s' {1..40})"

make_complete_evidence() {
  local dir="$1"
  mkdir -p "$dir"
  for file in "${required[@]}"; do
    printf 'PASS\n' > "$dir/$file"
  done
  cat > "$dir/candidate-image.env" <<EOF
IMAGE=$candidate_image
DIGEST=$candidate_digest
COMMIT_SHA=$candidate_commit
EOF
}

expect_fail() {
  local name="$1"
  shift
  if "$@" >"$tmp/$name.out" 2>"$tmp/$name.err"; then
    echo "FAIL: $name unexpectedly succeeded" >&2
    cat "$tmp/$name.out" >&2 || true
    cat "$tmp/$name.err" >&2 || true
    exit 1
  fi
  echo "PASS: $name rejected"
}

expect_pass() {
  local name="$1"
  shift
  if ! "$@" >"$tmp/$name.out" 2>"$tmp/$name.err"; then
    echo "FAIL: $name unexpectedly failed" >&2
    cat "$tmp/$name.out" >&2 || true
    cat "$tmp/$name.err" >&2 || true
    exit 1
  fi
  echo "PASS: $name accepted"
}

run_gate() {
  local evidence_dir="$1"
  shift
  RELEASE_EVIDENCE_DIR="$evidence_dir" "$@" ./scripts/release-gate.sh
}

echo "== release-gate regression tests =="

empty="$tmp/empty"
mkdir -p "$empty"
expect_fail missing_evidence run_gate "$empty" env EXPECTED_IMAGE="$candidate_image" RELEASE_COMMIT_SHA="$candidate_commit"

partial="$tmp/partial"
make_complete_evidence "$partial"
rm "$partial/ui-mobile.pass"
expect_fail partial_evidence run_gate "$partial" env EXPECTED_IMAGE="$candidate_image" RELEASE_COMMIT_SHA="$candidate_commit"

complete="$tmp/complete"
make_complete_evidence "$complete"
expect_pass complete_evidence run_gate "$complete" env EXPECTED_IMAGE="$candidate_image" RELEASE_COMMIT_SHA="$candidate_commit"

wrong_image="$tmp/wrong-image"
make_complete_evidence "$wrong_image"
sed -i 's#^IMAGE=.*#IMAGE=ghcr.io/example/other#' "$wrong_image/candidate-image.env"
expect_fail image_mismatch run_gate "$wrong_image" env EXPECTED_IMAGE="$candidate_image" RELEASE_COMMIT_SHA="$candidate_commit"

wrong_commit="$tmp/wrong-commit"
make_complete_evidence "$wrong_commit"
sed -i "s/^COMMIT_SHA=.*/COMMIT_SHA=$(printf 'c%.0s' {1..40})/" "$wrong_commit/candidate-image.env"
expect_fail commit_mismatch run_gate "$wrong_commit" env EXPECTED_IMAGE="$candidate_image" RELEASE_COMMIT_SHA="$candidate_commit"

invalid_digest="$tmp/invalid-digest"
make_complete_evidence "$invalid_digest"
sed -i 's/^DIGEST=.*/DIGEST=sha256:not-a-valid-digest/' "$invalid_digest/candidate-image.env"
expect_fail invalid_digest run_gate "$invalid_digest" env EXPECTED_IMAGE="$candidate_image" RELEASE_COMMIT_SHA="$candidate_commit"

duplicate_key="$tmp/duplicate-key"
make_complete_evidence "$duplicate_key"
printf 'IMAGE=%s\n' "$candidate_image" >> "$duplicate_key/candidate-image.env"
expect_fail duplicate_candidate_key run_gate "$duplicate_key" env EXPECTED_IMAGE="$candidate_image" RELEASE_COMMIT_SHA="$candidate_commit"

echo
echo "== release workflow structural regression tests =="
workflow=".github/workflows/release.yml"

grep -Fq "if: steps.version.outputs.stable != 'true'" "$workflow" || { echo "FAIL: prerelease conditional missing" >&2; exit 1; }
grep -Fq "Build and push prerelease candidate" "$workflow" || { echo "FAIL: prerelease candidate build missing" >&2; exit 1; }
grep -Fq "Enforce stable production release gate" "$workflow" || { echo "FAIL: stable release gate step missing" >&2; exit 1; }
grep -Fq "Promote approved candidate digest" "$workflow" || { echo "FAIL: stable promotion step missing" >&2; exit 1; }
grep -Fq -- '--tag "$IMAGE:latest"' "$workflow" || { echo "FAIL: latest promotion tag missing" >&2; exit 1; }

gate_line="$(grep -n "Enforce stable production release gate" "$workflow" | head -n1 | cut -d: -f1)"
promote_line="$(grep -n "Promote approved candidate digest" "$workflow" | head -n1 | cut -d: -f1)"
if [[ -z "$gate_line" || -z "$promote_line" || "$gate_line" -ge "$promote_line" ]]; then
  echo "FAIL: stable promotion is not structurally ordered after the release gate" >&2
  exit 1
fi

meta_block="$(awk '/Generate prerelease image metadata/{flag=1} flag{print} /Build and push prerelease candidate/{exit}' "$workflow")"
if grep -Fq 'value=latest' <<<"$meta_block"; then
  echo "FAIL: prerelease metadata must not create latest" >&2
  exit 1
fi

echo "PASS: prerelease path does not declare latest"
echo "PASS: stable gate is ordered before stable promotion"
echo
echo "release-gate regression tests: PASS"
