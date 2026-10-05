# Operations runbook – Browser Screenshot

## Purpose

This runbook covers production operation of Browser Screenshot after deployment to Coolify or an equivalent Docker platform. The service is stateless for screenshots; PostgreSQL stores identity, allowlist and MCP OAuth registration/code state.

## Service dependencies

- Public HTTPS ingress/reverse proxy.
- PostgreSQL 17-compatible database.
- Outbound HTTPS/DNS to public target sites and GitHub OAuth endpoints.
- Host/platform egress policy that blocks private/internal destinations while permitting the explicitly required PostgreSQL path.

## Required secrets

- `GITHUB_CLIENT_ID`
- `GITHUB_CLIENT_SECRET`
- `SESSION_SECRET` (>= 32 random characters)
- `MCP_TOKEN_SECRET` (>= 32 random characters and different from `SESSION_SECRET`)
- `DATABASE_URL`

Secrets must be supplied by the deployment platform and must never be committed to the repository or baked into the image.

## Health model

- `GET /health`: unauthenticated liveness. It must return success without disclosing secrets.
- `GET /ready`: readiness. It checks PostgreSQL connectivity and is the preferred startup/readiness probe.

If `/health` fails, restart/rollback the application. If `/health` succeeds but `/ready` fails, investigate PostgreSQL connectivity, credentials, migration status and network policy before restarting repeatedly.

## Logs and observability

The application logs to stdout/stderr. Production log collection should retain at least:

- application start/stop and migration failures,
- request failures and stable error codes,
- OAuth/MCP authorization failures without tokens/cookies,
- screenshot timeout/resource/capacity failures,
- readiness failures,
- container restart count and health state.

Never log `Authorization`, cookies, OAuth codes, GitHub access tokens, session secrets, MCP token secrets or database passwords. Alerting should at minimum cover repeated restart loops, sustained readiness failure, elevated 5xx responses and sustained `CAPACITY_EXCEEDED`/rate-limit events.

## Backup and restore

Screenshots do not need backup. Back up PostgreSQL because it contains allowlist and OAuth client state.

Recommended policy:

1. Use the PostgreSQL provider/Coolify backup mechanism with encrypted storage.
2. Retain multiple restore points according to the surrounding platform policy.
3. Test restore periodically to a separate database instance.
4. After restore, run `/ready`, verify an allowlisted login, and verify MCP authorization before directing production traffic to the restored instance.

A logical fallback backup can be produced with `pg_dump` using the least-privilege backup account approved for the environment. Do not store plaintext dumps in the repository.

## Secret rotation

### GitHub OAuth secret

1. Create/rotate the secret in GitHub OAuth configuration.
2. Update `GITHUB_CLIENT_SECRET` in the deployment platform.
3. Redeploy/restart the service.
4. Verify new login and callback flow.

### Session secret

Changing `SESSION_SECRET` intentionally invalidates all existing browser sessions. Rotate during a maintenance window when possible, update the platform secret and restart the service.

### MCP token secret

Changing `MCP_TOKEN_SECRET` invalidates all existing MCP bearer tokens. Rotate, restart and require MCP clients to authorize again.

### Database credentials

Create the replacement credential first, update `DATABASE_URL`, verify `/ready`, then revoke the old credential. Avoid a rotation sequence that removes the currently active credential before the application has switched.

## Release model

Image publication and production approval are intentionally separate. See `docs/release-model.md`. Prerelease/RC images may be used for representative acceptance before the final production gate is complete. A stable production deployment must use an immutable version tag/digest and must have a `GO` release decision for that exact image.

GitHub Actions enforces the distinction: prereleases publish candidate images, while stable releases require an attached `release-evidence.tar.gz` and promote the exact approved candidate digest only after the fail-closed release gate returns `GO`.

## Deployment and rollback

Production should deploy an immutable GHCR version tag such as `1.2.3`, not `latest`.

Before deployment:

1. Confirm the candidate image/tag being evaluated and record its immutable version/digest.
2. Complete `docs/release-checklist.md` for that exact candidate.
3. Run `npm run release:gate` with all required evidence present.
4. Confirm a recent PostgreSQL backup exists.
5. Create the stable GitHub Release as a draft and attach `release-evidence.tar.gz` containing the required `.release-evidence` files plus `candidate-image.env` for the exact accepted candidate digest and commit.
6. Publish the stable release and require the release workflow to succeed before treating it as production-approved.
7. Record the currently deployed image tag/digest for rollback.

After deployment:

1. Wait for `/ready` to pass.
2. Run the remote acceptance harness with production-safe credentials.
3. Perform the desktop/mobile UI spot-check.
4. Monitor logs/restarts/error rate during the rollout window.

Rollback by redeploying the previously known-good immutable image tag. Database migrations in v1 are additive; if a future migration becomes destructive or incompatible, that release must provide an explicit database rollback/forward-fix procedure before release.

## Troubleshooting

### `/ready` fails

Check PostgreSQL availability, `DATABASE_URL`, DNS/network reachability and migration logs. `/health` may remain healthy while the database is unavailable.

### GitHub login succeeds but user is denied

Confirm GitHub returns a verified e-mail and that `allowed_user` contains the same normalized e-mail with `enabled=true`.

### MCP client cannot authorize

Check protected-resource and authorization-server metadata endpoints, registered redirect URI, PKCE S256, exact resource URL, allowlist status and `MCP_TOKEN_SECRET` consistency across replicas/restarts.

### Screenshots time out or capacity errors rise

Inspect target responsiveness, resource-controller metrics/logs, queue pressure and host CPU/memory. Do not solve pressure by removing screenshot/resource limits. Scale the service only after confirming shared-state/rate-limit implications for the chosen topology.

### Public site works in a normal browser but screenshot is blocked

Review destination DNS/IP classification and redirects. Do not add a broad private-network exception. If a specific public service resolves into a special-use range, treat it as blocked unless the security model is deliberately changed and reviewed.

### Chromium sandbox failure

The production image must run as non-root `pwuser` with `chromiumSandbox: true`. Do not add `--no-sandbox` as a workaround. Verify the Docker runtime/seccomp setup and run `./scripts/verify-container.sh` on the target-like host.

## Incident response

For suspected SSRF/sandbox/auth bypass:

1. Disable public access or stop the deployment.
2. Preserve relevant platform/application logs.
3. Rotate affected credentials/secrets.
4. Verify PostgreSQL and surrounding infrastructure for unauthorized access.
5. Fix the issue and rerun container plus end-to-end acceptance before restoring service.
