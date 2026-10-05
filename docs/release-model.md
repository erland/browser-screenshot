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

The exact mechanics that enforce this lifecycle are implemented in IP-006. This document defines the policy and target semantics only.

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

## Current transitional state

At the completion of **IP-005**, this model is documented but not yet fully enforced by GitHub Actions.

The current `.github/workflows/release.yml` still publishes when a GitHub Release is created and currently updates `latest` for a stable semantic version.

Until **IP-006** is complete:

- treat prereleases as candidates only;
- do not interpret a stable GitHub Release as production approval unless the release gate has independently passed;
- do not rely on `latest` as proof of release-gate approval;
- production operators must continue to follow `docs/release-checklist.md` and `npm run release:gate`.

This transitional limitation is explicit so documentation does not claim enforcement that the workflow does not yet provide.

## IP-006 target

IP-006 must make the automation match this model.

At minimum it must ensure:

1. candidate/prerelease images can still be produced for acceptance work;
2. production promotion cannot succeed when the release gate is NO-GO;
3. `latest` cannot move as part of an unapproved stable release;
4. the exact commit/image being approved is tied to the evidence;
5. existing multi-arch, SBOM and provenance behavior is preserved.

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
