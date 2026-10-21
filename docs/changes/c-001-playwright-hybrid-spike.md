# C-001 – Playwright MCP hybrid integration spike

Status: **design established; runtime integration NOT VERIFIED**  
Tracking: [issue #24](https://github.com/erland/browser-screenshot/issues/24)

## Objective

Allow an authenticated ChatGPT MCP client to test an HTTPS PWA Preview deployment interactively without weakening Browser Screenshot's existing security model or screenshot functionality.

The existing public MCP endpoint (`/mcp`) and OAuth identity/allowlist enforcement remain authoritative. No second public unauthenticated Playwright server may be exposed.

## Verified repository baseline

- `apps/server/src/mcp.ts` uses `createMcpHandler`, `McpServer`, `toNodeHandler`, bearer validation and per-request `AsyncLocalStorage` for actor identity.
- `apps/server/src/browser.ts` starts sandboxed Chromium with the secure HTTP/CONNECT proxy and `--disable-quic` / WebRTC UDP restrictions.
- `captureWithFreshContext` uses `acceptDownloads: false`, `serviceWorkers: 'block'`, and `context.route('**/*', enforceRequestPolicy)`.
- Screenshot work has its own concurrency, queueing and Chromium recycle policy.
- Production-like container smoke and external ingress/egress evidence are marked deferred in `.system-builder/work-status.yaml`.

**Critical:** request-scoped AsyncLocalStorage alone is not sufficient for multi-request browser sessions. Session records must persist owner identity across calls and be checked on every operation.

## Architecture decision under test

Use an application-owned `BrowserAutomationService` with a stable MCP contract. A driver adapter can use either:

1. **Embedded Microsoft Playwright MCP**, only if it can be made to use the existing or equivalent hardened browser lifecycle and network boundary without opening a second unauthenticated endpoint.
2. **Direct Playwright API**, if ownership, routing or safety of the embedded MCP approach cannot be proven.

Do not run both drivers against the same mutable browser session. Driver selection is server-side and feature-flagged, not requested by callers.

## Candidate public MCP interface

- `browser_session_create({url?, preset?}) -> {sessionId, expiresAt}`
- `browser_navigate({sessionId, url}) -> {url, snapshot}`
- `browser_snapshot({sessionId}) -> {url, snapshot}`
- `browser_click({sessionId, role, name}) -> {snapshot}`
- `browser_fill({sessionId, role, name, value}) -> {snapshot}`
- `browser_session_close({sessionId}) -> {closed}`

Initial scope: role/name-based selection, no arbitrary browser JavaScript evaluation, no file uploads/downloads, no raw CDP and no caller-controlled launch flags. Bound snapshot/result size; do not return cookies, localStorage, credentials or authentication headers. Use unpredictable session IDs but never treat their secrecy as authorization.

Proposed feature flag: `BROWSER_AUTOMATION_ENABLED=false` by default.

## Session ownership and execution boundary

- Authenticated actor ID from the established MCP access token binds each session at creation; every subsequent operation must verify exact owner match.
- Use isolated `BrowserContext` per session; close on explicit request, idle timeout, absolute lifetime, owner revocation, shutdown and error.
- Proposed initial limits (to validate, not yet implemented): maximum 2 automation sessions across instance, maximum 1 per actor, 5-minute idle, 15-minute absolute lifetime, 10-second default action timeout.
- Browser sessions must share or explicitly reserve capacity relative to screenshot work; never bypass the existing screenshot queue by uncontrolled browser creation.
- Synchronize mutating actions per session (no simultaneous click/navigate against the same page).
- Deny connections to private/loopback/metadata hosts on primary URL, redirects, frames, subresources, WebSockets and other browser network paths. Require the same validated proxy/egress boundary used by screenshots.
- Service workers remain blocked for the first phase. Offline/cache-specific PWA testing is a **separate security/design decision**.
- Page content and snapshots are untrusted input to the calling assistant. Avoid logging targets, form values, cookies or secrets.

## PoC experiments (must be executed before engine selection)

| ID | Test | PASS criteria |
|---|---|---|
| C001-01 | Embedded Microsoft MCP feasibility | Can serve actions behind existing `/mcp` OAuth route; no extra unauthenticated listener |
| C001-02 | Direct Playwright fallback | Same externally visible action semantics through application-owned service |
| C001-03 | User isolation | Actor B cannot access actor A's session; revoked actor loses access |
| C001-04 | Network confinement | Every browser-originated request, redirects and bypass attempts fail closed for disallowed destinations |
| C001-05 | Session cleanup | Errors, client disconnect, idle expiry, shutdown close context and release capacity |
| C001-06 | Resource budget | Interactive work coexists with three allowed screenshots without unbounded memory/queue growth |
| C001-07 | PWA Preview end-to-end | Real OAuth-authorized MCP client navigates, fills and asserts a DOM change against a safe published fixture |
| C001-08 | Regression | `npm run verify`, `scripts/verify-container.sh`, and `scripts/verify-acceptance.sh` pass in their appropriate environments |

Capture actual command, commit SHA, results and timing for each run. Do not substitute mocks for real OAuth, Chromium, deployment egress or MCP end-to-end evidence.

## Decision gate

Choose embedded Microsoft MCP **only if** C001-01, C001-03, C001-04, C001-05 and C001-06 pass. Otherwise use direct Playwright under the identical application-owned contract, provided its security/operational checks pass. Keep the feature flag disabled while any authorization or network-isolation check is incomplete or failing.

## Out of scope for C-001

General-purpose scripting, arbitrary expression execution, file transfer, unrestricted Internet browsing, offline/service-worker bypasses, persistent cross-user browser profiles and production activation.

## Planned follow-up

C-002 implements the chosen engine/session tools and unit/integration tests. C-003 adds declarative `browser_test_run`, assertions, console/network diagnostics and PWA Preview test reports. Update governing architecture and functional specification as part of the implementation work; the present document is a proposed change, not an assertion of implemented capability.
