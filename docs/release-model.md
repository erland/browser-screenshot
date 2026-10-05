# Release and production-promotion model

This document defines the release semantics for Browser Screenshot from **DR-002 → RS-02 → IP-005**.

The goal is to separate artifact publication from production approval so that a built image is not automatically interpreted as proof that every production requirement has passed.

## Terminology

### Candidate image

A **candidate image** is an OCI image built from a specific commit/tag and published to GHCR for verification.

A candidate image:

- is immutable by version/digest;
- may be used for container smoke, remote acceptance and representative deployment testing;
- is not, by itself, proof that production release requirements are satisfied.

### Prerelease / release candidate

A semantic prerelease tag such as:

```text
v1.2.3-rc.1
```

represents a candidate intended for acceptance and production-like verification.

Prereleases:

- may publish multi-architecture GHCR images;
- must never update `latest`;
- may be deployed to a representative environment to gather release evidence;
- are not production-approved releases.

### Production-approved stable release

A stable semantic version such as:

```text
v1.2.3
```

represents a production-approved release only when the release gate is **GO** for the exact release commit/image.

Production approval therefore means more than "GitHub Release exists" or "GHCR image exists".

Required evidence is defined by:

- `docs/release-checklist.md`;
- `scripts/release-gate.sh`.

A stable production-approved release may update `latest`.

## Intended lifecycle

The intended lifecycle is:

```text
main / selected commit
        |
        v
candidate/prerelease image
        |
        v
container + representative deployment verification
        |
        v
release evidence complete
        |
        v
release gate = GO
        |
        v
production-approved stable release
        |
        v
Coolify deploys immutable version/digest
```

GitHub Actions enforces this lifecycle: prereleases build candidate images, while stable releases promote an already-verified candidate digest only after the fail-closed release gate returns GO.

## Image publication versus production approval

The project deliberately distinguishes:

```text
image exists
```

from:

```text
image is approved for production
```

This distinction is necessary because some required evidence can only be collected after an image exists, for example:

- representative remote acceptance;
- real deployment/network egress evidence;
- desktop/mobile UI acceptance;
- production-specific operational checks.

Therefore image publication must be possible before final production approval.

## Tag semantics

### Prerelease tags

Examples:

```text
v1.2.3-rc.1
v1.2.3-beta.1
```

Expected semantics:

- publish immutable version tags;
- do not update `latest`;
- usable for evidence gathering;
- not production-approved.

### Stable tags

Example:

```text
v1.2.3
```

Target semantics:

- release gate must be GO before production promotion is considered successful;
- publish/retain immutable version tags;
- update `latest` only as part of a successful production-approved stable release;
- record exact image digest used for production.

## Coolify deployment policy

Production Coolify deployments should use an immutable version tag or digest, for example:

```text
BROWSER_SCREENSHOT_VERSION=1.2.3
```

Do not use `latest` as the authoritative production pin.

`latest` is only a convenience pointer to the newest production-approved stable release after IP-006 enforcement is in place.

For representative acceptance, Coolify or another target-like environment may deploy an RC/prerelease tag.

## Release evidence

The production gate remains fail-closed.

Current required evidence includes:

- canonical source verification;
- production-container smoke;
- GitHub CI;
- GHCR multi-architecture publication;
- remote acceptance;
- desktop UI acceptance;
- mobile UI acceptance;
- production egress policy verification;
- backup/restore review.

If required evidence is missing, failed or unknown:

```text
production decision = NO-GO
```

The existence of an image or GitHub Release does not override this decision.

## Enforced stable-promotion flow

For a stable release, prepare a **draft GitHub Release** for the stable tag and attach a file named:

```text
release-evidence.tar.gz
```

The archive must contain the release-evidence files at its root, including:

```text
source-verify.pass
container-smoke.pass
github-ci.pass
ghcr-multiarch.pass
remote-acceptance.pass
ui-desktop.pass
ui-mobile.pass
production-egress-policy.pass
backup-restore-reviewed.pass
candidate-image.env
```

`candidate-image.env` must contain exactly:

```text
IMAGE=ghcr.io/erland/browser-screenshot
DIGEST=sha256:<64 lowercase hex characters>
COMMIT_SHA=<40 character commit SHA>
```

The candidate commit must be the same commit referenced by the stable release tag. The digest must be the exact prerelease/RC digest that was used to gather acceptance evidence.

A typical package can be created from a local `.release-evidence/` directory with:

```bash
tar -czf release-evidence.tar.gz -C .release-evidence .
```

Attach the archive to the draft stable release **before publishing it**.

When the stable release is published, GitHub Actions:

1. checks out the stable tag and resolves its exact commit;
2. downloads `release-evidence.tar.gz`;
3. runs the fail-closed `npm run release:gate`;
4. verifies that candidate image repository and commit match the stable release;
5. verifies that the candidate digest contains both `linux/amd64` and `linux/arm64`;
6. promotes that exact candidate digest to the stable version tag, Git tag and `latest`.

If any step fails, the stable image tags are not moved by the workflow.

### Why stable releases promote instead of rebuild

Representative acceptance is performed against the candidate image. Rebuilding on the stable release would create a second artifact that had not been the exact object under acceptance.

Promoting the already-tested digest preserves the relationship:

```text
tested candidate digest
        =
production-approved digest
```

The OCI metadata inside the promoted image remains the metadata of the candidate build. This is intentional: the promoted stable tags identify the approved artifact without changing its bytes.

## Operational note

The GitHub Release object itself becomes public/published before the workflow completes because the workflow is triggered by the release `published` event. A failed gate therefore means:

- the GitHub Release exists,
- but stable GHCR tags/`latest` are not promoted,
- and the release is **not production-approved**.

Production approval is represented by successful completion of the release workflow and the resulting promoted digest, not merely by the existence of the GitHub Release.

## Non-goals

This model does not require:

- a new artifact registry;
- a separate deployment service;
- changing Coolify;
- building images on the Coolify host;
- a new versioning scheme;
- making prereleases production-approved;
- removing immutable semantic-version tags.

## Decision summary

Browser Screenshot uses a two-stage conceptual release model:

1. **Artifact/candidate publication** creates an immutable image that can be verified.
2. **Production promotion** declares a specific verified image production-approved only after the fail-closed release gate is GO.

A GitHub/GHCR artifact is therefore necessary for production but is not sufficient evidence of production readiness.
