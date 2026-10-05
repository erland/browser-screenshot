# Release checklist – Browser Screenshot

Release semantics and the distinction between candidate image publication and production approval are defined in `docs/release-model.md`.

A production release is **NO-GO** until every required item below has evidence.

## Source and documentation

- [ ] Canonical source verification passed for the release commit (`npm ci`, lint, typecheck, unit tests, build).
- [ ] `docs/functional-specification.md`, `docs/architecture.md`, `docs/security-review.md` and deployment docs match the release implementation.
- [ ] `.system-builder/work-status.yaml` and `.system-builder/traceability.yaml` contain no unclassified drift.
- [ ] No secrets, tokens, cookies, database credentials or private keys are committed.

## Container and deployment

- [ ] `./scripts/verify-container.sh` passed on Docker-capable Linux using the exact production Dockerfile.
- [ ] Chromium starts as non-root with sandbox required; no `--no-sandbox` fallback is used.
- [ ] `/health` and PostgreSQL-backed `/ready` pass in the production image.
- [ ] Host/platform egress policy blocks private/internal/metadata networks and permits required public traffic plus the explicit PostgreSQL path.
- [ ] Coolify uses an immutable GHCR version tag and the required runtime secrets.

## CI and release artifacts

- [ ] GitHub CI passed for the release commit.
- [ ] The candidate/release image for the exact release commit produced both `linux/amd64` and `linux/arm64` GHCR manifests.
- [ ] Image provenance/SBOM generation completed.
- [ ] The exact image digest selected for production is recorded in `candidate-image.env` together with the candidate commit SHA.
- [ ] The stable draft GitHub Release contains `release-evidence.tar.gz` before publication.

## Acceptance

- [ ] `./scripts/verify-acceptance.sh` passed against a representative HTTPS deployment with real REST/MCP credentials.
- [ ] Desktop UI acceptance checklist passed.
- [ ] Mobile UI acceptance checklist passed.
- [ ] Anonymous/unauthorized access is denied.
- [ ] Loopback/private destination negative cases are blocked.

## Operations

- [ ] PostgreSQL backup exists and restore procedure is understood.
- [ ] Rollback image/tag is recorded.
- [ ] Log collection/retention and basic alerts are configured.
- [ ] Secret owners and rotation process are known.
- [ ] `docs/operations-runbook.md` is available to the operator.

## Release semantics

- A candidate/prerelease image may exist before all production evidence is complete.
- A stable version is production-approved only when this checklist and `npm run release:gate` are `GO` for the exact release commit/image.
- Stable GHCR tags and `latest` are promoted only after GitHub Actions has run the fail-closed release gate against the attached evidence package.

## Release decision

- **GO** only when all required checks above have evidence.
- **NO-GO** if any security, sandbox, private-egress, auth, container, CI or acceptance item is missing/failed.
- Deferred verification during development is not release evidence.
