# Architecture – Browser Screenshot

## 1. Context

Browser Screenshot is an independent browser-rendering service. It accepts a public URL and capture settings, renders the page in Chromium and returns a screenshot.

It deliberately separates visual capture from:

- **Agent Workspace**, which builds/tests/runs user projects and produces artifacts.
- **PWA Preview**, which hosts already-built static web applications and provides a public URL.

A common composed flow is:

```text
Agent Workspace -> build artifact -> PWA Preview -> public URL -> Browser Screenshot -> PNG
```

Each service remains independently useful and is integrated through ordinary HTTPS/MCP contracts rather than shared internal state.

## 2. Architecture style

Use a modular monolith packaged as one application image.

Planned stack:

- Node.js 22
- TypeScript
- Fastify backend
- React + Vite frontend
- Playwright + Chromium
- PostgreSQL for identity/allowlist state where persistence is required
- Remote MCP using the TypeScript MCP SDK
- Docker/OCI
- GitHub Actions
- Coolify with platform-managed reverse proxy/TLS

This minimizes operational complexity while allowing clean internal module boundaries.

## 3. Logical components

### Web UI

Responsible for login status, URL/capture form, result display and download. It never directly controls Chromium.

### HTTP/API layer

Fastify owns validation, authentication/authorization, rate limiting, error mapping and REST routes.

### MCP layer

Exposes the screenshot capability to authenticated MCP clients and calls the same application service as REST.

### Screenshot application service

Owns the use case:

```text
validate request
-> authorize destination policy
-> acquire browser capacity
-> create isolated context
-> navigate/render
-> capture
-> close context
-> return/store ephemeral result
```

REST, UI and MCP must not implement separate rendering logic.

### Browser manager

Owns Playwright/Chromium lifecycle, process health, browser-context creation, timeouts, recycling and graceful shutdown.

A fresh browser context is created per screenshot request. Chromium process reuse is allowed only while context isolation and resource controls remain reliable.

### Network policy / destination guard

Security-critical component that prevents browser access to disallowed destinations. The design must protect all browser-originated traffic, not only the submitted main URL.

Defense in depth shall combine:

1. strict input scheme/URL parsing,
2. address/DNS checks,
3. redirect revalidation,
4. browser/request interception where useful,
5. container/host egress restrictions where deployment permits,
6. automated tests for bypass classes.

Network-layer enforcement is preferred as the final boundary because page JavaScript and subresources can create network traffic independently of the initial navigation.

### Authentication/authorization

GitHub OAuth identifies users. An allowlist policy authorizes service use. Authorization is enforced server-side for UI/API/MCP protected operations.

### Persistence

PostgreSQL may store allowlist/user identity metadata. Screenshot image data is not durable business data in v1.

### Ephemeral result storage

If direct response streaming is insufficient for UI/MCP behavior, screenshots may be written to a bounded temporary directory with TTL cleanup. It must be safe to lose this data on restart.

## 4. Main data flows

### Human UI

```text
Browser -> OAuth -> Browser Screenshot UI/API
                      -> Screenshot Service
                      -> Chromium
                      -> target public web page
                      -> PNG
Browser <- result ----+
```

### MCP

```text
MCP client -> OAuth/authz -> screenshot_create
                           -> Screenshot Service
                           -> Chromium
                           -> PNG/result metadata
```

### PWA Preview composition

```text
PWA Preview URL -> Browser Screenshot -> Chromium -> PWA Preview -> PNG
```

No direct database or filesystem access is shared between the two services.

## 5. API direction

Initial REST shape is expected to include:

```text
POST /api/screenshots
GET  /api/screenshot-presets
GET  /health
```

Exact download/result routes depend on the selected ephemeral result strategy in an implementation step.

Remote MCP initially exposes only screenshot creation. General-purpose browser automation remains outside the architecture boundary.

## 6. Security architecture

### Threat boundary

The target URL and all page content are untrusted.

Chromium therefore processes attacker-controlled HTML, JavaScript, redirects, frames and subresources.

### Required controls

- non-root container where practical,
- Chromium sandbox retained when compatible with container deployment; never disable it casually,
- fresh browser context per operation,
- bounded concurrency/timeouts,
- no application secrets exposed to page context,
- blocked private/loopback/link-local/reserved/metadata networks,
- redirect and subresource coverage,
- no arbitrary browser automation API,
- rate limits and authenticated access,
- safe error/log handling,
- dependency/browser patching through normal releases.

### Network isolation decision

Browser Screenshot does **not** require Modal because it does not build/run arbitrary uploaded project processes. However, the rendered page executes untrusted browser JavaScript. Chromium and its network path therefore still require strong isolation.

The critical feasibility work is to prove that the chosen Docker/Coolify deployment can enforce the destination policy reliably. This is explicitly planned early.

## 7. Deployment architecture

Target profile: Coolify + external PostgreSQL.

```text
Internet
  |
Coolify / Traefik (TLS)
  |
Browser Screenshot container :8080
  |-- Node/Fastify/React
  |-- managed Chromium
  |-- ephemeral /tmp results
  |
  +---- external PostgreSQL (private service network)
```

The application listens on `0.0.0.0:8080`. TLS is terminated by the platform. Runtime secrets are supplied as environment secrets.

Browser egress controls must prevent access to the private PostgreSQL/service network even though the application itself must be able to reach PostgreSQL. This likely requires separating the browser's network namespace/policy from application-service access or an equivalent enforceable firewall/proxy strategy. That is a key early spike.

## 8. Configuration direction

Expected runtime configuration includes:

- `PORT`
- `PUBLIC_BASE_URL`
- `DATABASE_URL`
- `GITHUB_CLIENT_ID`
- `GITHUB_CLIENT_SECRET`
- OAuth/cookie signing secrets
- screenshot timeout/concurrency settings
- viewport bounds
- ephemeral result TTL
- network-policy configuration

No secrets belong in source or image layers.

## 9. Observability

Initial observability:

- structured application logs to stdout/stderr,
- health endpoint,
- request correlation identifier,
- screenshot outcome/duration and failure category,
- browser process health/restarts,
- rejected destination counters where practical.

URLs may contain sensitive query data, so logging shall avoid or redact full target URLs by default.

## 10. Key decisions and tradeoffs

1. **Standalone service instead of Agent Workspace module.** Enables reuse and reduces Agent Workspace scope.
2. **No Modal by default.** Uploaded arbitrary OS processes are not executed; standard container isolation plus strong browser/network controls is the simpler target.
3. **Playwright/Chromium.** Mature browser automation with viewport/full-page capture and reproducible CI images.
4. **One public screenshot primitive in v1.** Avoids expanding into a general remote-browser platform and keeps the threat model bounded.
5. **Ephemeral screenshots.** Reduces privacy, storage and lifecycle complexity.
6. **Risk-first network-policy spike.** SSRF via browser traffic is the architecture's principal uncertainty and must be proven before feature expansion.

## DEV-002 browser runtime decision

Browser Screenshot uses Playwright 1.55 with Chromium. Each screenshot job receives a fresh browser context and closes that context after capture. The service does not pass `--no-sandbox` or other sandbox-disabling flags.

The production image is based on `mcr.microsoft.com/playwright:v1.55.0-noble` and runs the application as the image's non-root `pwuser`. Browser downloads are skipped during Docker dependency installation because the matching Playwright image already contains Chromium.

For non-container verification environments without a bundled browser, `playwright install chromium` is an explicit test prerequisite. The runtime resolves Chromium from `CHROMIUM_EXECUTABLE_PATH`, Playwright's bundled executable path, or common system locations.

DEV-002 proves browser execution and fresh-context lifecycle only. Network isolation and SSRF protection remain DEV-003 concerns and must not be inferred from this spike.


## Browser network security boundary (DEV-003)
Chromium is forced through a loopback HTTP/CONNECT proxy owned by Browser Screenshot. The proxy resolves each destination, rejects localhost/private/link-local/special-use addresses, and connects to the exact validated IP rather than allowing Chromium to perform a second DNS resolution. Chromium is started with loopback proxy bypass disabled, QUIC disabled, and non-proxied WebRTC UDP disabled. Playwright request routing performs the same URL/DNS validation as defense in depth. This application-layer boundary is complemented by deployment-level egress restrictions during acceptance.


## DEV-004 REST result lifecycle

The first screenshot REST flow streams PNG bytes directly from the isolated browser context to the HTTP response. No screenshot is written to persistent or temporary application storage, and responses use `Cache-Control: no-store`. Canonical presets and limits live server-side and are exposed through a read-only presets endpoint. Authentication is intentionally deferred to DEV-006; DEV-004 is not a production-deployable public boundary on its own.

## Persistence foundation (DEV-005)

The service uses an external PostgreSQL database for authentication identity and allowlist state only. Screenshot bytes remain ephemeral and are not persisted.

The initial schema contains `app_user`, keyed by provider plus the provider's stable subject identifier, and `allowed_user`, keyed operationally by email address. GitHub numeric id/login remain identity metadata, while authorization uses the user's verified GitHub email address.

Startup runs database migrations before the HTTP listener is opened. `/health` is process liveness; `/ready` checks database connectivity and returns 503 when persistence is unavailable. This keeps orchestration from routing traffic to an instance that cannot authorize users.


## Authentication and authorization boundary

Interactive authentication uses GitHub OAuth. OAuth `state` is short-lived and HMAC-signed. After callback, the service discards the GitHub access token and issues its own short-lived signed session cookie. Authorization uses a verified GitHub email address and checks `allowed_user` server-side on every protected request. GitHub login and numeric id are retained only as identity metadata. This makes allowlist revocation effective immediately even when a browser session remains valid.

## Remote MCP and OAuth boundary

Browser Screenshot exposes a stateless Streamable HTTP MCP endpoint at `/mcp`. The MCP server contains one tool, `screenshot_create`, and delegates directly to the same screenshot service used by REST; it does not implement a second browser path.

The MCP resource server publishes RFC 9728 protected-resource metadata and OAuth authorization-server metadata. MCP clients use an authorization-code flow with PKCE S256. Client registrations and one-time authorization codes are persisted in PostgreSQL. Browser Screenshot issues short-lived HMAC-signed bearer tokens containing the authorized verified email, client id, `mcp` scope, resource and expiry. GitHub access tokens are never stored.

The bearer token is not sufficient by itself: the verified email is checked against `allowed_user` for every MCP request. Removing or disabling an email therefore revokes both web and MCP access immediately. OAuth authorization that requires user interaction reuses the existing GitHub sign-in flow and returns the browser to the pending OAuth authorization request.


## Resource control

REST and MCP feed the same in-process screenshot resource controller. The controller enforces a global maximum of three concurrent capture jobs, a per-authenticated-email budget of 20 jobs per rolling one-minute window, and reuses a single Chromium process with isolated contexts. The shared browser is recycled after 100 completed jobs and is closed during application shutdown. MCP propagates the authenticated email through async-local request context so concurrent MCP calls retain the correct rate-limit identity.
