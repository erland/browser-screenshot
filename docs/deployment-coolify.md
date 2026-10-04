# Coolify deployment – Browser Screenshot

## Deployment model

Deploy the repository Dockerfile as one public application on port `8080`. PostgreSQL is external to the application container (a Coolify PostgreSQL resource or another PostgreSQL 17-compatible service). The application is stateless; screenshots are returned directly and are not persisted.

Coolify terminates TLS. Set the application domain first, then set `PUBLIC_BASE_URL` to the exact public HTTPS origin, for example `https://browser-screenshot.example.com`. GitHub OAuth callback is `${PUBLIC_BASE_URL}/auth/callback` and the MCP endpoint is `${PUBLIC_BASE_URL}/mcp`.

## Required environment variables

- `PUBLIC_BASE_URL` – exact public HTTPS origin.
- `DATABASE_URL` – least-privilege PostgreSQL connection string.
- `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` – GitHub OAuth application credentials.
- `SESSION_SECRET` – random secret of at least 32 characters.
- `MCP_TOKEN_SECRET` – independent random secret of at least 32 characters.
- `PORT=8080` and `HOST=0.0.0.0` may normally use image defaults.

Do not bake secrets into the image or repository.

## Health and startup

The OCI image exposes port `8080` and has a Docker liveness healthcheck against `/health`. Configure Coolify readiness/startup checking against `/ready`, because `/ready` also verifies PostgreSQL. The application runs migrations before it starts listening and therefore fails fast when the database is unavailable or migrations fail.

## Browser runtime

The runtime is pinned to `mcr.microsoft.com/playwright:v1.55.0-noble`, matching the npm Playwright version. The service runs as the non-root `pwuser` and requires Chromium sandboxing.

The repository contains Playwright's seccomp profile in `seccomp_profile.json`. When the application is deployed through Docker Compose, the `app` service applies it with `security_opt`. If Coolify is configured to run the Dockerfile directly instead of the repository Compose file, configure the equivalent runtime security option so the container uses this seccomp profile. Do not replace this with `--no-sandbox`, privileged mode or `SYS_ADMIN` in production.

Allocate approximately 1 GiB shared memory when the platform allows it; the representative compose profile uses `shm_size: 1gb`.

## Network security requirement

Application-level protection is already mandatory and implemented by the validating HTTP/CONNECT proxy plus Playwright routing. Production must additionally prevent the Browser Screenshot container from reaching private/internal networks directly. This host/platform egress rule is defense in depth for a browser/proxy bypass and must block at least loopback-equivalent host paths, RFC1918, link-local/cloud metadata, CGNAT and private IPv6 destinations while still allowing public Internet access and the explicitly required PostgreSQL destination.

This cannot be expressed safely inside the non-root application image itself without granting networking capabilities to the workload. Configure it at the Docker host/firewall, Coolify host, or upstream network-policy layer. Do not add `NET_ADMIN` or privileged mode to Browser Screenshot to implement this rule inside the container.

## Allowlist bootstrap

After migrations, add enabled e-mail addresses to `allowed_user`. Example SQL:

```sql
INSERT INTO allowed_user (email, enabled)
VALUES ('user@example.com', true)
ON CONFLICT ((lower(email))) DO UPDATE SET enabled = EXCLUDED.enabled;
```

Only verified GitHub e-mail addresses matching an enabled allowlist entry can authenticate.

## Pre-deployment container verification

On a Docker-capable Linux host run:

```bash
./scripts/verify-container.sh
```

The script builds the exact production Dockerfile, launches the packaged non-root runtime with the repository seccomp profile, captures a public PNG, proves loopback navigation is blocked, starts the application with PostgreSQL, and waits for `/ready`.

## GHCR release delivery

The release workflow publishes the same production `Dockerfile` to GHCR when a GitHub Release is published from a semantic-version tag. Images are built for both `linux/amd64` and `linux/arm64`. Coolify should consume an immutable version tag (for example `1.2.3`) for production rather than tracking `latest`; `latest` is provided only for stable releases and convenience.

## Operations and release gate

Use `docs/operations-runbook.md` for health/readiness handling, backup/restore, rollback, secret rotation and troubleshooting. Before production deployment run `npm run release:gate`; it is fail-closed and requires explicit evidence for container, CI, multi-arch image, acceptance, egress policy and operational readiness. See `docs/release-checklist.md` for the human release decision.
