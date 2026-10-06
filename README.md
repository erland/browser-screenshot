# Browser Screenshot

Browser Screenshot is a standalone service for capturing screenshots of permitted public web pages at selected viewport sizes. It is designed to be usable from a web UI, REST API and remote MCP while keeping browser rendering and network access behind a controlled service boundary.

This repository is being built incrementally from the System Builder planning handoff. **DEV-001** establishes only the application foundation; Playwright/Chromium, screenshot capture, authentication, persistence and MCP are intentionally deferred to later development steps.

## Current foundation

- Node.js 22 + TypeScript npm workspace.
- Fastify backend with `GET /health`.
- React 19 + Vite frontend shell.
- Production build where Fastify serves the built frontend.
- Canonical lint, typecheck, test and build commands.
- Docker baseline running as the non-root `node` user.
- GitHub Actions CI baseline.

## Development

Requirements: Node.js 22 and npm.

```bash
npm ci
npm run dev:server
```

In another terminal:

```bash
npm run dev:web
```

The Vite development server proxies `/health` and `/api` to the backend on port 8080.

## Verification

Run the canonical verification suite:

```bash
npm run verify
```

It executes linting, TypeScript checks, unit tests and both production builds.

After a production build:

```bash
npm start
curl http://localhost:8080/health
```

Expected health response:

```json
{"status":"ok","service":"browser-screenshot"}
```

## Docker

```bash
docker build -t browser-screenshot .
docker run --rm -p 8080:8080 browser-screenshot
```

The production target is Coolify behind its reverse proxy/TLS handling. Browser-specific container hardening is intentionally deferred until DEV-002/DEV-003, where Chromium feasibility and the browser network security boundary are proven.

## Planning documentation

The functional specification, architecture, risk assessment, development plan and System Builder state are kept under `docs/` and `.system-builder/`.

### Browser runtime baseline

DEV-002 established Playwright 1.55 + Chromium with a fresh browser context per capture. Production is intended to run from the matching official Playwright image as non-root `pwuser`; sandbox-disabling Chromium flags are not used. Browser network restrictions are intentionally deferred to DEV-003.

## Screenshot REST API (DEV-004)

`POST /api/screenshots` accepts a public web URL plus either a `desktop`, `tablet` or `mobile` preset, or custom `width`/`height`. Optional `deviceScaleFactor`, `fullPage` and bounded `timeoutMs` are supported. Successful calls stream `image/png` directly with `Cache-Control: no-store`; screenshot metadata is returned in `X-Screenshot-*` headers, so no screenshot file is retained by the service.

`GET /api/screenshot-presets` exposes the canonical preset and validation limits used by clients.

Authentication is deliberately added in DEV-006. Until then, deployment of this intermediate step outside an isolated development environment is not supported.

## PostgreSQL

PostgreSQL may be configured with `DATABASE_URL`, or with separate `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER` and `DB_PASSWORD` settings. `DATABASE_URL` takes precedence when present; the split settings are recommended for Coolify so the password does not have to be embedded in a URL. `DB_PORT` defaults to `5432` and `DB_NAME` to `browser_screenshot`. The service applies its schema migration before listening. `/health` is liveness and `/ready` verifies database connectivity. PostgreSQL stores identity/allowlist state only; screenshots are never persisted.


## Authentication (DEV-006)

Production startup requires GitHub OAuth/session configuration plus either `DATABASE_URL` or the split `DB_*` database settings:

```text
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
SESSION_SECRET=<at least 32 random characters>
PUBLIC_BASE_URL=https://browser-screenshot.example.com
```

GitHub OAuth establishes identity. Authorization is separate: the verified GitHub email address must exist as an enabled row in `allowed_user`. For deployment, `BROWSER_SCREENSHOT_GITHUB_ALLOWLIST_EMAILS` may contain a comma-separated authoritative allowlist; when it is set the database allowlist is synchronized at startup, while a missing/empty value leaves database-managed entries untouched. The service rechecks the allowlist on every protected request. GitHub access tokens are used only during the callback and are never stored. Browser sessions use an 8-hour HMAC-signed `HttpOnly; Secure; SameSite=Lax` cookie.

The screenshot API and preset endpoint are protected in production; `/health`, `/ready`, `/auth/login` and `/auth/callback` remain available as required for operation and login.


## Webbgränssnitt

När användaren har loggat in med GitHub och den verifierade e-postadressen finns i allowlisten visar webbgränssnittet hela screenshot-flödet: URL, desktop/tablet/mobile eller egen viewport, full-page, progress/fel, PNG-förhandsvisning och nedladdning. Layouten växlar från två paneler på desktop till staplad mobilvy utan horisontell overflow.

UI:t använder de skyddade `/api/me`, `/api/screenshot-presets` och `/api/screenshots`-endpoints som servern tillhandahåller; klienten innehåller ingen separat authorization-bypass.

### Remote MCP

The same capture capability is available at `/mcp` as the single MCP tool `screenshot_create`. Remote MCP uses OAuth authorization code + PKCE and the same email allowlist as the web application. Discovery endpoints are published under `/.well-known/`, and `MCP_TOKEN_SECRET` must be configured separately from `SESSION_SECRET`.

## Resource controls

Screenshot work is protected by a shared resource controller: at most 3 captures run concurrently, each authenticated email is limited to 20 requests per minute, and the shared Chromium process is recycled after 100 jobs. REST and MCP use the same controller.

## Security baseline

Application-level hardening and explicitly deferred deployment controls are documented in `docs/security-review.md`.

## Coolify deployment

Production packaging is documented in `docs/deployment-coolify.md`. Use `docker-compose.coolify.yml` in Coolify: it pulls the pre-built GHCR release image selected by `BROWSER_SCREENSHOT_VERSION`, contains only the application, joins the external `coolify` network, pins Traefik to that network with `traefik.docker.network=coolify`, and expects a shared/external PostgreSQL database via `DB_*` settings. The local `docker-compose.yml` continues to include PostgreSQL for representative local testing. The image listens on port 8080, runs as Playwright's non-root `pwuser`, uses `/health` for liveness and `/ready` for database-aware readiness.

## DEV-011 security correction checkpoint

This checkpoint explicitly enables Chromium sandboxing with `chromiumSandbox: true` and normalizes IPv4-mapped IPv6 addresses before SSRF classification, including hexadecimal forms such as `::ffff:7f00:1`. Source-level regression verification is complete. The remaining deferred evidence is the Docker/Coolify container smoke that proves sandboxed Chromium startup as non-root `pwuser` in the production image.

## CI and release images

GitHub Actions runs the canonical source verification on pushes and pull requests, then runs `./scripts/verify-container.sh` on an Ubuntu runner to verify the production image, sandbox-required Chromium startup, screenshot smoke flow, private/loopback blocking and PostgreSQL-backed readiness.

Publishing a GitHub Release with a semantic-version tag such as `v1.2.3` builds and pushes a multi-architecture image for `linux/amd64` and `linux/arm64` to `ghcr.io/<owner>/<repository>`. The release produces deterministic tags for both the normalized version (`1.2.3`) and the Git tag (`v1.2.3`); stable releases also update `latest`. Pre-release versions such as `v1.2.3-rc.1` never update `latest`.

### Release publication and production readiness

Release semantics are defined in `docs/release-model.md`. Publishing either a stable release or prerelease builds the corresponding multi-architecture GHCR image directly from the release tag with SBOM and provenance. Stable releases also update `latest`; prereleases do not.

Production-readiness checks remain separate from artifact publication. `docs/release-checklist.md` and the optional `npm run release:gate` helper can still be used for a stricter operational GO/NO-GO decision, but no `release-evidence.tar.gz` asset is required for GitHub Actions to publish a release image.

## End-to-end acceptance

DEV-013 provides a deployment-facing acceptance harness in `scripts/verify-acceptance.sh` plus `docs/acceptance-test-plan.md`. The harness requires a real authenticated REST session and MCP bearer token and checks health, authorization boundaries, PNG output, preset/custom viewport semantics, blocked loopback access and MCP parity. UI acceptance remains an explicit desktop/mobile checklist. Runtime execution is intentionally deferred until a representative deployment is available.

## Release readiness and operations

Operational guidance is in `docs/operations-runbook.md` and production-readiness checks are in `docs/release-checklist.md`. For environments that require a formal evidence-based decision, the existing fail-closed helper remains available:

```bash
npm run release:gate
```

The helper is now independent of image publication: a GitHub Release builds and publishes its GHCR image directly, while the operator can apply the stricter GO/NO-GO gate when appropriate.
