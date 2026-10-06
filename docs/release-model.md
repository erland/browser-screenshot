# Release model

Browser Screenshot uses a deliberately simple image publication flow.

## GitHub Release → GHCR image

Publishing a GitHub Release with a semantic-version tag triggers `.github/workflows/release.yml`.

Examples:

```text
v1.2.3
v1.2.3-rc.1
```

For every release GitHub Actions:

1. checks out the release tag;
2. builds the production Dockerfile;
3. publishes a multi-architecture image for `linux/amd64` and `linux/arm64`;
4. publishes OCI provenance and an SBOM;
5. tags the image with both the normalized version and the Git tag.

Stable releases also update `latest`. Prereleases never update `latest`.

A stable release therefore produces, for example:

```text
ghcr.io/erland/browser-screenshot:1.2.3
ghcr.io/erland/browser-screenshot:v1.2.3
ghcr.io/erland/browser-screenshot:latest
```

A prerelease such as `v1.2.3-rc.1` produces the version/tag variants but leaves `latest` unchanged.

## Production readiness is separate from image publication

Publishing an image is intentionally not blocked by a manually assembled evidence archive.

The project still has a conservative production-readiness checklist in `docs/release-checklist.md` and the optional fail-closed helper:

```bash
npm run release:gate
```

That gate can be used when a formal production GO/NO-GO decision is wanted, but it is not part of the GitHub Release image-build workflow.

This keeps two concerns separate:

- **artifact publication** — automatic and repeatable from a GitHub Release;
- **production readiness** — an operational decision based on CI, acceptance, security and deployment evidence.

## Coolify

Coolify should normally pin an immutable release version:

```text
BROWSER_SCREENSHOT_VERSION=1.2.3
```

Using an immutable version makes rollback explicit and avoids an unrelated future release changing a running deployment. `latest` remains available as a convenience pointer to the newest stable release.

## Why the workflow builds stable releases directly

The previous workflow required a prerelease candidate plus an attached `release-evidence.tar.gz` before a stable release could publish its GHCR tags. That made a normal release fail when the evidence asset was absent.

The current model removes that coupling. A normal stable GitHub Release is sufficient to build and publish the corresponding image, while production-readiness evidence remains available as a separate operational control.
