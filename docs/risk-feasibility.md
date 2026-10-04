# Risk and Feasibility – Browser Screenshot

## Assumptions

- The service will be deployed as a Docker/OCI application, initially on Coolify.
- Chromium/Playwright can execute inside the deployment container with an acceptable sandbox configuration.
- The screenshot service is authenticated and allowlisted; it is not an anonymous public screenshot proxy.
- Target pages are untrusted.
- No general browser automation is needed in v1.

## Risks

### RISK-001 – Browser SSRF/private-network access

**Category:** security / network  
**Probability:** high  
**Impact:** critical  
**Level:** critical  
**Status:** mitigated in application; deployment egress verification pending

**Risk / assumption**

A target page can trigger requests beyond the submitted URL through redirects, scripts, frames, fetch/XHR, WebSockets and subresources. Input URL validation alone is insufficient and could expose localhost, metadata services, private networks, PostgreSQL or other Coolify services.

**Handling**

- Implement destination classification for IPv4/IPv6 and forbidden schemes.
- Revalidate redirects and DNS results.
- Add Playwright/request-level interception as defense in depth.
- Prove a network-level browser egress boundary suitable for Coolify/Docker.
- Test direct, redirect, DNS/rebinding-relevant and subresource cases.

**Related requirements / steps**

- FR-015, FR-016, NFR-001
- DEV-002, DEV-003

### RISK-002 – Chromium container sandbox compatibility

**Category:** security / deployment  
**Probability:** medium  
**Impact:** high  
**Level:** high  
**Status:** application baseline verified; target-container sandbox verification pending

**Risk / assumption**

Some container recipes disable Chromium sandboxing with `--no-sandbox`. That would weaken isolation of hostile page content.

**Handling**

- Test Playwright/Chromium with non-root execution and supported sandbox configuration.
- Avoid `--no-sandbox` unless there is an explicit reviewed compensating architecture.
- Verify container capabilities and Coolify compatibility early.

**Related steps**

- DEV-002

### RISK-003 – Resource exhaustion

**Category:** availability / performance  
**Probability:** high  
**Impact:** medium-high  
**Level:** high  
**Status:** mitigated with bounded concurrency, rate limits, browser recycling and render/output budgets

**Risk / assumption**

Heavy or malicious pages can consume CPU, memory, bandwidth, page height or browser processes and degrade the service.

**Handling**

- Bound concurrency.
- Bound navigation and operation time.
- Bound viewport values and full-page behavior.
- Close contexts in `finally` paths.
- Recycle unhealthy Chromium processes.
- Add authenticated rate limiting.

**Related requirements / steps**

- FR-017, NFR-003, NFR-004
- DEV-004, DEV-009

### RISK-004 – Browser/Playwright version drift

**Category:** delivery  
**Probability:** medium  
**Impact:** medium  
**Level:** medium  
**Status:** open

**Handling**

Pin dependency state and ensure CI browser image/runtime matches the project Playwright version. Browser verification becomes required release evidence.

**Related requirement / steps**

- NFR-008
- DEV-001, DEV-013

### RISK-005 – Target-page privacy and logs

**Category:** privacy / operations  
**Probability:** medium  
**Impact:** medium  
**Level:** medium  
**Status:** open

**Risk / assumption**

URLs can contain sensitive query parameters and screenshots can contain sensitive content.

**Handling**

- Avoid full target URL logging by default.
- Keep screenshot storage ephemeral.
- Apply short TTL and deletion.
- Do not expose screenshots across users.

**Related steps**

- DEV-004, DEV-006, DEV-010

### RISK-006 – OAuth/MCP authorization divergence

**Category:** security / integration  
**Probability:** medium  
**Impact:** high  
**Level:** high  
**Status:** mitigated; REST and MCP recheck the same email allowlist per request

**Handling**

Use one server-side authorization service/policy for protected REST/UI/MCP operations and test unauthorized/allowlist-negative cases.

**Related requirements / steps**

- FR-001, FR-002, FR-010
- DEV-006, DEV-008

## Feasibility questions and spikes

### SPIKE-001 – Secure Chromium execution in Docker/Coolify

**Question**

Can Chromium run with acceptable sandboxing and can its outbound network access be restricted independently enough to block private/internal destinations while the Node application can still reach PostgreSQL and required OAuth endpoints?

**Evidence required**

- Chromium starts in target-like container environment.
- Screenshot of controlled public test page succeeds.
- Attempts by navigation and page subresources to access forbidden address classes fail.
- Application database/network functions required by the control plane remain usable.

**Exit**

A documented enforcement pattern is selected and automated tests cover the chosen boundary. If this cannot be achieved safely in the target deployment model, architecture must be revised before feature work continues.

## Blocking issues

No blocker prevents creation of the project foundation. `SPIKE-001` is architecture-critical and must be resolved before the public screenshot flow is considered secure or before release readiness.

## Accepted risks

None yet.

## Review outcome

The system is feasible enough to proceed. The implementation plan intentionally places browser execution and network-policy proof immediately after project foundation to avoid investing in UI/auth features before the primary security assumptions are demonstrated.

## DEV-002 feasibility evidence

Playwright 1.55 / Chromium 140 was verified in Agent Workspace with Node 22. A controlled HTTP page was rendered and captured as PNG twice using separate browser contexts. Browser launch succeeded without adding `--no-sandbox`.

The intended production model uses the official Playwright Noble image and its non-root `pwuser`. Docker execution itself could not be exercised in the available local tool runtime because no Docker/Podman executable is present; this remains an environment-level verification item for later deployment acceptance, not a reason to disable Chromium sandbox protections.

The most important unresolved security risk remains browser-originated SSRF/private-network access. DEV-003 is dedicated to enforcing the network boundary for top-level navigation, redirects, frames, scripts, fetch/XHR, images and other browser subrequests.


### DEV-003 outcome: SSRF and DNS rebinding
A Playwright route-only design was rejected because validation and Chromium DNS resolution would be separate operations. Browser Screenshot instead uses a validating local forward proxy and connects to the validated address. Direct URL validation and per-request Playwright routing remain additional checks. Deployment acceptance must still verify container egress policy so a browser escape or future protocol bypass cannot reach internal networks.

### Persistence availability and identity drift

Authorization must not depend on mutable GitHub login names. The operator-facing allowlist uses verified GitHub email addresses, matching the administration model used by the surrounding services; GitHub id/login remain identity metadata. Database unavailability prevents readiness and production startup rather than silently bypassing authorization. Screenshot image data is intentionally excluded from PostgreSQL.


## DEV-010 security-hardening outcome

Application-level security hardening is complete and documented in `docs/security-review.md`. Security headers, request/body limits, OAuth/PKCE input bounds, service-worker blocking, screenshot memory/output budgets, stable resource-limit errors, non-root image execution and health signaling are implemented and covered by regression tests.

The remaining critical/high deployment assumptions are explicit rather than hidden: target-like Chromium sandbox execution and container/network egress enforcement are mandatory evidence in DEV-011/DEV-013. Release readiness must fail if either is not demonstrated.
