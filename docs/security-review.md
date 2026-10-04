# Security Review – DEV-010

## Scope

DEV-010 hardens the application before deployment packaging. The review covers HTTP behavior, OAuth/session handling, MCP bearer authentication, browser isolation, resource exhaustion, secrets/logging and container baseline assumptions.

## Implemented controls

### HTTP and application boundary

- Fastify request bodies are limited to 32 KiB.
- Requests have a 45 second server timeout, while screenshot navigation remains bounded to 30 seconds.
- Prototype/constructor poisoning is rejected by the JSON parser.
- Security response headers are applied globally: CSP, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, `X-Frame-Options`, COOP and CORP.
- HSTS is enabled only when `PUBLIC_BASE_URL` is HTTPS.
- API, authentication, OAuth, MCP and discovery responses default to `Cache-Control: no-store` unless a route explicitly supplies another policy.

### Authentication and OAuth

- Browser sessions remain HMAC-signed, short-lived, `HttpOnly`, `Secure` and `SameSite=Lax`.
- GitHub OAuth state remains signed and validated against a separate state cookie.
- Only verified GitHub email addresses can become authenticated identities.
- The email allowlist is rechecked on every protected REST and MCP request.
- MCP authorization uses authorization-code + PKCE S256 and short-lived signed bearer tokens.
- DCR redirect URIs are limited in count/length and must be HTTPS except for loopback HTTP callbacks.
- PKCE challenges/verifiers and bearer/token input lengths are explicitly bounded.
- GitHub access tokens are never persisted.

### Browser and network isolation

- Browser traffic remains forced through the validating HTTP/CONNECT proxy from DEV-003, which resolves and connects to the validated public IP address.
- Playwright routing remains defense in depth for every browser request.
- Chromium service workers are disabled so they cannot bypass Playwright routing semantics.
- Downloads are disabled.
- Chromium continues to launch without `--no-sandbox` and the runtime image uses `pwuser`.
- QUIC and non-proxied WebRTC UDP remain disabled.

### Resource-exhaustion controls

- Global concurrency is bounded to three screenshot jobs.
- Each authenticated email is limited to 20 screenshot jobs per minute.
- The shared Chromium process is recycled after 100 jobs.
- Viewport inputs are bounded and combinations above 50,000,000 rendered pixels are rejected.
- Full-page output is rejected above 16,384 CSS pixels in either dimension or above the rendered-pixel budget.
- PNG results above 20 MiB are rejected.
- Browser/context cleanup remains in `finally`/shutdown paths.

### Secrets, logging and dependency posture

- Runtime secrets are environment variables only; `.env`/`.env.*` are gitignored except `.env.example`.
- Session and MCP signing secrets require at least 32 characters.
- Application logging does not intentionally log request bodies, cookies, Authorization headers, GitHub tokens or screenshot target URLs. Fastify's default request logging is used without custom header/body serializers.
- `package-lock.json` is retained and production installs use `npm ci --omit=dev`.
- Playwright is exact-version pinned to the runtime image version.
- ESLint was moved from unsupported major 9 to supported major 10 during this step; typescript-eslint explicitly supports ESLint 10.

## Verification evidence

Automated verification covers HTTP security headers/body limits, OAuth/PKCE validation, browser/network policy, direct private navigation rejection, resource controls, REST, MCP and authentication regressions.

DEV-010 Agent Workspace verification passed with:

- `npm install --no-audit --no-fund` while regenerating the lock file after the lint-toolchain update;
- lint and TypeScript checks;
- 60 backend tests;
- 4 frontend tests;
- production build.

The regenerated lock file passed canonical `npm ci`, all 60 backend tests, all 4 frontend tests and the production build in Agent Workspace.

## Explicitly deferred deployment evidence

The following are not hidden assumptions and remain required later:

1. DEV-011/DEV-013 must run the production OCI image in a target-like Docker/Coolify environment and prove Chromium sandbox compatibility as `pwuser`.
2. The deployment must add a container/network egress boundary that blocks private/internal networks even if Chromium or application-level proxy controls are bypassed.
3. Coolify runtime secrets and PostgreSQL credentials must be provisioned with least privilege and must not be baked into the image.
4. A release/CI dependency advisory scan should be automated in DEV-012; current runtime dependency verification here is lockfile/build/test based rather than a registry-backed vulnerability audit.

These deployment-specific items prevent release readiness if they are not demonstrated, but they do not block completion of the application-level DEV-010 hardening step.


## DEV-011 security correction

Chromium launch now sets `chromiumSandbox: true` explicitly. IPv4-mapped IPv6 addresses are normalized before policy classification so hexadecimal forms such as `::ffff:7f00:1` cannot bypass IPv4 private/loopback checks.


## DEV-011 follow-up hardening

The packaging/security follow-up adds bounded screenshot queueing (maximum 20 queued jobs, 15 second queue timeout), a stable `CAPACITY_EXCEEDED` 503 error, anonymous dynamic-client-registration throttling (10 registrations per source address per 10 minutes with `Retry-After`), opportunistic cleanup of expired/used OAuth authorization codes, and tolerant cookie parsing that treats malformed percent-encoding as an invalid cookie rather than a server error.

Canonical source verification passed in Agent Workspace with `npm ci`, lint, typecheck, 67 backend tests passed, 2 root-only Chromium sandbox runtime tests skipped, 4 frontend tests passed, and production build passed. The skipped tests require a non-root sandbox-capable runtime and remain covered by the mandatory DEV-011 container smoke test.
