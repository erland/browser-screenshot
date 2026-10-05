# Coolify deployment – Browser Screenshot

## Recommended deployment model

Use `docker-compose.coolify.yml` for production in Coolify. It contains **only the Browser Screenshot application**; it does not start PostgreSQL. This allows one shared PostgreSQL instance to host a dedicated `browser_screenshot` database.

The existing `docker-compose.yml` remains the representative local/development profile and includes its own PostgreSQL container.

The Coolify profile:

- pulls the pre-built release image from `ghcr.io/erland/browser-screenshot` instead of building on the Coolify host;
- selects the image tag through `BROWSER_SCREENSHOT_VERSION` (default `latest`);
- exposes the application only inside Docker on port `8080`;
- does not publish `8080` on the host;
- joins the existing external Docker network `coolify`;
- sets `traefik.docker.network=coolify` explicitly so Traefik does not select a generated project network;
- keeps `traefik.enable=true`;
- applies the repository Playwright seccomp profile;
- uses an external/shared PostgreSQL database.

Configure the application domain in Coolify. Coolify may generate the host/router/service labels for that domain; the compose file intentionally does not hard-code generated router names.

Set `PUBLIC_BASE_URL` to the exact public HTTPS origin, for example `https://browser-screenshot.example.com`. GitHub OAuth callback is `${PUBLIC_BASE_URL}/auth/callback` and the MCP endpoint is `${PUBLIC_BASE_URL}/mcp`.

## PostgreSQL configuration

For production, prefer separate database settings instead of embedding credentials in `DATABASE_URL`:

- `DB_HOST` – PostgreSQL hostname reachable from the Browser Screenshot container.
- `DB_PORT` – PostgreSQL port; defaults to `5432`.
- `DB_NAME` – dedicated database name; defaults to `browser_screenshot`.
- `DB_USER` – database user.
- `DB_PASSWORD` – database password.

The service safely builds the PostgreSQL connection string internally and URL-encodes user/password/database-name values.

For local/dev compatibility, `DATABASE_URL` is still supported. If `DATABASE_URL` is non-empty it takes precedence over the split `DB_*` settings.

A shared PostgreSQL instance is therefore sufficient; create one database and least-privilege database user for Browser Screenshot rather than deploying another PostgreSQL container.

The database host must be reachable from the `coolify` network (or otherwise routable from the container). If the shared PostgreSQL service itself runs in Docker, attach it to an appropriate shared network before relying on a Docker service/container hostname.

## Required environment variables

Recommended Coolify variables:

- `BROWSER_SCREENSHOT_VERSION` – release image tag to deploy; prefer an immutable version such as `1.2.3` rather than `latest`
- `PUBLIC_BASE_URL`
- `DB_HOST`
- `DB_PORT` (optional, default `5432`)
- `DB_NAME` (optional, default `browser_screenshot`)
- `DB_USER`
- `DB_PASSWORD`
- `GITHUB_CLIENT_ID`
- `GITHUB_CLIENT_SECRET`
- `BROWSER_SCREENSHOT_GITHUB_ALLOWLIST_EMAILS` – optional comma-separated authoritative allowlist
- `SESSION_SECRET` – random secret of at least 32 characters.
- `MCP_TOKEN_SECRET` – independent random secret of at least 32 characters.

`PORT=8080` and `HOST=0.0.0.0` are set by the Coolify compose profile.

Do not bake secrets into the image or repository.

## Coolify setup

1. Create the dedicated database, for example `browser_screenshot`, in the shared PostgreSQL instance.
2. Create/use a least-privilege PostgreSQL user with access to that database.
3. Publish a GitHub Release so GitHub Actions builds and pushes the multi-arch image to GHCR.
4. Create the Coolify application from this repository.
5. Select `docker-compose.coolify.yml` as the Compose file.
6. Set `BROWSER_SCREENSHOT_VERSION` to the release version to deploy, for example `1.2.3`.
7. Set the remaining environment variables listed above.
8. Configure the public HTTPS domain in Coolify.
9. Confirm the application is attached to the external `coolify` network.
10. Confirm the shared PostgreSQL hostname is reachable from that network.
11. Use `/health` for liveness and `/ready` for database-aware readiness.

## Health and startup

The OCI image exposes port `8080` and has a Docker liveness healthcheck against `/health`. Configure Coolify readiness/startup checking against `/ready`, because `/ready` also verifies PostgreSQL. The application runs migrations before it starts listening and therefore fails fast when the database is unavailable or migrations fail.

## Browser runtime

The runtime is pinned to `mcr.microsoft.com/playwright:v1.55.0-noble`, matching the npm Playwright version. The service runs as the non-root `pwuser` and requires Chromium sandboxing.

The repository contains Playwright's seccomp profile in `seccomp_profile.json`. `docker-compose.coolify.yml` applies it with `security_opt`. Do not replace this with `--no-sandbox`, privileged mode or `SYS_ADMIN` in production.

Allocate approximately 1 GiB shared memory when the platform allows it; both compose profiles use `shm_size: 1gb`.

## Production egress discovery

Before changing Docker networking or host firewall rules, run the IP-001 discovery in the actual Coolify environment. See [egress-discovery.md](egress-discovery.md) and use `scripts/inspect-egress.sh` from inside the deployed container. The discovery is intentionally read-only and only probes internal targets that the operator explicitly names.

Do not mark the production egress requirement as satisfied from repository inspection alone; host firewall and Coolify-generated networking are outside the repository boundary.

## Network security requirement

Application-level protection is mandatory and implemented by the validating HTTP/CONNECT proxy plus Playwright routing. Production should additionally prevent the Browser Screenshot workload from reaching unrelated private/internal networks directly while still allowing the explicitly required PostgreSQL destination and public Internet access.

The external `coolify` network and `traefik.docker.network=coolify` solve reverse-proxy network selection; they are not a replacement for production egress filtering.

Do not add `NET_ADMIN` or privileged mode to Browser Screenshot to implement egress filtering inside the application container.

## Allowlist configuration

For Coolify, the recommended setup is to manage the allowlist with:

`BROWSER_SCREENSHOT_GITHUB_ALLOWLIST_EMAILS=user@example.com,second@example.com`

When the variable is set and non-empty, it is authoritative at startup: addresses are normalized to lowercase, duplicates are removed, listed addresses are enabled, and previously enabled addresses not present in the variable are disabled. The sync runs after migrations and is transactional.

When the variable is missing or empty, startup does not modify `allowed_user`; SQL/manual database administration remains available.

Invalid e-mail values fail startup rather than silently changing authorization.

Only verified GitHub e-mail addresses matching an enabled allowlist entry can authenticate.

## Pre-deployment container verification

On a Docker-capable Linux host run:

```bash
./scripts/verify-container.sh
```

The script builds the exact production Dockerfile, launches the packaged non-root runtime with the repository seccomp profile, captures a public PNG, proves loopback navigation is blocked, starts the local representative application with PostgreSQL, and waits for `/ready`.

## GHCR release delivery

The release workflow publishes the production image to GHCR when a GitHub Release is published from a semantic-version tag. Images are built for both `linux/amd64` and `linux/arm64`.

`docker-compose.coolify.yml` does not contain `build: .`; Coolify pulls `ghcr.io/erland/browser-screenshot:${BROWSER_SCREENSHOT_VERSION:-latest}` instead. This keeps image compilation and the heavy Playwright build workload on GitHub Actions rather than the Coolify server.

For production, set `BROWSER_SCREENSHOT_VERSION` to an immutable release version such as `1.2.3`. Use `latest` only when intentionally tracking the newest stable release.

If the GHCR package is private, configure Coolify with GitHub Container Registry credentials that can pull the package.

## Operations and release gate

Use `docs/operations-runbook.md` for health/readiness handling, backup/restore, rollback, secret rotation and troubleshooting. See `docs/release-checklist.md` for the human release decision.
