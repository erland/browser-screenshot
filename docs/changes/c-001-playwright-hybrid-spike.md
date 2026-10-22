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

## Security review – 2026-10-22 (commit e3aad28)

Decision: **PARTIAL / keep draft, feature flag OFF in production**.

CI #408 passed all four jobs: Verify source, Verify PostgreSQL identities,
Validate Marketplace plugin package and Verify production container.
The production-container smoke exercised MCP JSON-RPC tools against real,
sandboxed Chromium, but did not exercise OAuth on the same transport.

| Criterion | Evidence | Assessment |
| --- | --- | --- |
| C001-01 Embedded Microsoft MCP | Not integrated or tested; implementation uses direct Playwright | NOT APPLICABLE to selected direct adapter |
| C001-02 Direct Playwright | Browser session, navigate, snapshot, fill, click, close and production container smoke | PASS (PoC) |
| C001-03 Ownership | Session owner checked in manager; MCP actor from OAuth; cross-owner and OAuth tests separate | PARTIAL (revoke mid-session E2E unverified) |
| C001-04 Network boundary | Validated initial navigations, route interception and proxy, loopback-denial smoke | PARTIAL (redirect/frame/WebSocket/bypass matrix not exhaustively executed) |
| C001-05 Cleanup | Explicit close, idle/absolute checks, shutdown tests | PARTIAL (disconnect/error and failure injection incomplete) |
| C001-06 Resource budget | Shared leased screenshot resource controller and caps implemented | PARTIAL (mixed concurrent load/queue measurements missing) |
| C001-07 Preview OAuth E2E | OAuth HTTP and real Chromium MCP tested separately | NOT VERIFIED on published PWA Preview fixture |
| C001-08 Regression | GitHub Actions CI #408 successful | PASS for configured checks; separate acceptance script not independently evidenced |

### Review findings requiring resolution

1. **HIGH: Concurrent actions in a single session are not serialized.**
   `AutomationSessionManager.get()` returns a mutable page; navigation, click,
   fill and snapshot execute without a per-session action lock. This violates the
   original session-execution requirement and can lead to cross-action races.
   Introduce a per-session FIFO or mutex, including close/shutdown coordination.
2. **HIGH: Complete URL/network-bypass test matrix is missing.**
   The production proxy and route handler are reused, but no current exhaustive
   evidence for WebSockets, redirects, iframes, DNS changes and browser egress.
3. **MEDIUM: Snapshot and control selectors are not aligned.**
   Snapshot enumerates indices while click/fill accept only `#id` and
   `[data-testid="..."]`. Pages without these attributes cannot be
   interacted with reliably. Choose a stable locator scheme.
4. **MEDIUM: Side effects on arbitrary external sites are possible.**
   `browser_click` can activate destructive actions on external pages.
   Add explicit operation policy, request-side scoping and review of confirmation.
5. **MEDIUM: No real OAuth-to-published-PWA end-to-end acceptance run.**
   Existing independent OAuth and Chromium tests are not a substitute.

Do not call C-001 release-ready or switch `BROWSER_AUTOMATION_ENABLED` on
until blocking issues are resolved, verified and documented.

## Acceptance checkpoint – 2026-10-22, CI #426 (commit e1f16d8)

CI #426 passed all configured jobs, including production container smoke.
This supersedes the *test status*, not the historical security findings above.

| Criterion | Updated assessment | Remaining evidence |
| --- | --- | --- |
| C001-01 | Not applicable: direct Playwright chosen | Record formal driver decision |
| C001-02 | PASS (PoC) | Public contract implemented and tested |
| C001-03 | PARTIAL | Revocation while session is live, end-to-end |
| C001-04 | PARTIAL, stronger coverage | Real Chromium redirect, iframe and live internal-server WebSocket/HTTP denial plus proxy DNS-rebinding unit tests pass; exhaustive egress and DNS-rebinding end-to-end still outstanding |
| C001-05 | PARTIAL | Explicit close, lifecycle and concurrency tests pass; disconnect, failures and time-based cleanup still need end-to-end evidence |
| C001-06 | PARTIAL | Deterministic queue/lease tests plus two automation sessions and three concurrent Chromium screenshots pass; mixed workloads through *the same resource controller* and sustained stress/memory measurement remain |
| C001-07 | NOT VERIFIED | OAuth-authorized end-to-end against published PWA Preview fixture |
| C001-08 | PARTIAL | CI source/container suites pass; `scripts/verify-acceptance.sh` not independently evidenced |

Closed finding: per-session FIFO action serialization and close synchronization implemented and covered by CI.
Open findings: selector/snapshot discoverability; click side effects and operation scoping;
revocation; true cross-service PWA fixture acceptance; resource-controller integrated stress.

**Release gate remains PARTIAL. Keep PR draft and the automation flag off.**

## Acceptance checkpoint – 2026-10-22, CI #443 (commit 625578a)

All four configured CI jobs passed: source, PostgreSQL identity verification,
Marketplace package validation, and the real-Chromium production container.

| Criterion | Current status | Evidence / missing proof |
| --- | --- | --- |
| C001-01 | NOT PURSUED | The PoC implements direct Playwright rather than embedded Microsoft MCP; formal architecture decision remains |
| C001-02 | PASS (PoC) | Direct adapter, session operations, authenticated MCP HTTP with a test bearer validator and real container Chromium |
| C001-03 | PARTIAL | Owner isolation; real OAuth issue/revoke tested with MCP; active session bearer rejection tested, but live deployed revocation-to-context-cleanup not proved |
| C001-04 | PARTIAL | Real Chromium blocked redirects, private iframe/WebSocket/HTTP, proxy DNS-rebinding unit; exact HTTPS-origin allowlist for both click and fill with cross-origin regression tests; complete deployed egress evaluation outstanding |
| C001-05 | PARTIAL | FIFO, close synchronization, periodic expiry reap, idle/absolute expiration tests; client disconnect and failure-injection evidence outstanding |
| C001-06 | PARTIAL | Same resource controller exercised by real Chromium sessions and screenshot jobs; sustained memory/queue/failure stress metrics outstanding |
| C001-07 | NOT VERIFIED | No actual authorized MCP client to a published PWA Preview fixture using deployed service |
| C001-08 | PARTIAL | CI #443 green; independent acceptance script run not evidenced |

Additional controls implemented since #426: snapshot emits valid unique ID/test-ID
selectors; `browser_click` advertises `destructiveHint: true`;
`BROWSER_AUTOMATION_WRITE_ORIGINS` requires explicit HTTPS origin permission for
both click and fill; unconfigured writes are denied by default. These are
defense-in-depth, **not** complete safeguards against consequential actions on
an allowed origin.

**Decision remains PARTIAL. Do not merge or enable the feature in production.**
The next practical acceptance milestone is a controlled, deployed, OAuth-authorized
PWA Preview test with an explicitly allowlisted disposable test origin and a
documented cleanup/revocation check.

## Release-scope decision – 2026-10-22

**Engine decision:** use the application-owned direct Playwright adapter behind the
existing authenticated MCP endpoint. Do not embed an additional Microsoft
Playwright MCP server. This keeps the existing OAuth identity boundary,
restricted browser launcher/proxy and screenshot resource controller in
one application ownership model. The alternative was not benchmarked in this
PoC; no performance superiority is asserted.

**Acceptance-plan change (user decision):** C001-07 (deployed OAuth-authorized
PWA Preview end-to-end) is explicitly **deferred to manual testing after
release**. It is no longer a prerequisite for *merging code with the feature
disabled*. It remains a prerequisite to considering the automation feature
operationally validated and enabling it for ordinary users. Earlier checklist
language saying the PR can never merge without C001-07 is superseded for this
feature-off release scope.

**Current release-readiness assessment:** code CI #443 passed. The remote
`scripts/verify-acceptance.sh` was inspected: it needs `BASE_URL`,
`REST_COOKIE`, and `MCP_ACCESS_TOKEN` against a live service. It has not
been run in this review, and must not be marked PASS. See README for the
manual test and rollback procedure.

**Residual risks, accepted only for dormant/disabled code shipment:**
- A failed Chromium context close may intentionally retain a resource slot;
  forced recovery of a stuck context may require a process restart.
- Sustained concurrent session/screenshot resource metrics and complete
  end-to-end network bypass checks remain outstanding.
- Approving an HTTPS write origin permits potentially consequential clicks
  there; MCP `destructiveHint` is advisory, not an enforcement mechanism.

**Gate distinction:** review/merge of disabled, tested code may proceed
subject to normal repository review; **feature activation remains blocked**
pending manual deployed acceptance and residual security evaluation.
