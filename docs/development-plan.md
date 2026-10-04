# Development Plan – Browser Screenshot

## Goal and delivery scope

Deliver an independently deployable, authenticated browser screenshot service with web UI, REST and remote MCP. The service renders permitted public URLs in Chromium at selected viewport/device settings while preventing browser access to private/internal networks.

## Planning assumptions

- Repository name will be `browser-screenshot`.
- Node.js 22 + TypeScript + Fastify + React/Vite is the intended stack.
- Playwright/Chromium is the browser engine.
- Coolify is the first production deployment target.
- GitHub OAuth + allowlist is the user access model.
- PostgreSQL is external to the app container.
- No Modal dependency is planned.
- Screenshots are ephemeral in v1.

## Step overview

| Step | Title | Primary outcome |
|---|---|---|
| DEV-001 | Project foundation | Runnable/testable backend+frontend baseline with CI-ready commands and health |
| DEV-002 | Chromium feasibility spike | Prove secure, container-compatible Playwright/Chromium baseline |
| DEV-003 | Browser network security boundary | Prove and implement SSRF/private-network protection for all browser traffic |
| DEV-004 | Core screenshot REST flow | Validated screenshot API, presets, custom viewport, full-page, ephemeral result lifecycle |
| DEV-005 | Persistence foundation | PostgreSQL schema/migrations for identity/allowlist state |
| DEV-006 | GitHub OAuth and allowlist | Authenticated and server-authorized UI/API access |
| DEV-007 | Responsive web UI | Complete end-user screenshot workflow |
| DEV-008 | Remote MCP | OAuth-protected `screenshot_create` capability using core service |
| DEV-009 | Resource and abuse controls | Concurrency, rate limits, timeouts, browser recycling and limits |
| DEV-010 | Security hardening | Regression coverage and container/application security baseline |
| DEV-011 | Coolify packaging | Production Docker image and deployment configuration/docs |
| DEV-012 | GitHub CI and release workflow | Required CI plus tag-derived GHCR release images |
| DEV-013 | End-to-end acceptance | Browser/UI/API/MCP/security acceptance evidence |
| DEV-014 | Release readiness and operations | Reconcile docs, operations/install guidance and release gate |

## DEV-001 – Project foundation

### Mål

Create the smallest useful project baseline from which browser/security work can proceed safely.

### Scope

**Ingår**
- Node 22/TypeScript workspace and locked dependency state.
- Fastify backend with `/health`.
- React/Vite frontend shell served/developed with clear backend integration direction.
- Lint, typecheck, unit-test and production-build commands.
- Docker baseline suitable for later Playwright integration.
- `.env.example`, `.gitignore`, `.dockerignore` and baseline README updates.
- CI workflow or CI-ready canonical verify script if appropriate in this step.

**Ingår inte**
- Playwright/Chromium.
- screenshot endpoint.
- authentication/database/MCP.

### Förutsättningar

- Planning handoff accepted as current project state.

### Implementation

Create project/package structure and a health-tested backend/frontend baseline without introducing browser dependencies prematurely.

### Verifiering

- locked dependency install,
- lint,
- typecheck,
- unit tests,
- production build,
- application startup and `/health` response,
- Docker image build/start/health when container tooling is available.

### Klart-kriterier

- [ ] Canonical verify commands pass.
- [ ] `/health` returns success.
- [ ] Frontend production build succeeds.
- [ ] Container baseline builds/starts when environment supports Docker.
- [ ] Work status and documentation are updated.

### Beroenden

- None beyond planning handoff.

## DEV-002 – Chromium feasibility spike

### Mål

Prove that Playwright/Chromium can render a controlled public page in the intended container model without casually disabling Chromium sandbox protections.

### Scope

Add Playwright/Chromium only far enough to establish lifecycle, isolated context, controlled screenshot and target-like container execution.

### Verifiering

- Controlled page screenshot PASS.
- Fresh context per job demonstrated.
- Container runtime behavior documented.
- Chromium sandbox/non-root behavior reviewed.

### Klart-kriterier

- [ ] Browser execution works in target-like container environment.
- [ ] No unresolved high-risk sandbox configuration is hidden.
- [ ] Architecture updated if target constraints require changes.

### Beroenden

- DEV-001

## DEV-003 – Browser network security boundary

### Mål

Implement and prove the destination/network boundary that prevents SSRF and private/internal network access from Chromium.

### Scope

Cover URL schemes, address classification, DNS/redirect handling, subresources/JS traffic and enforceable egress controls. Prefer network-layer enforcement with Playwright interception as defense in depth.

### Verifiering

Automated tests for direct and indirect attempts to reach loopback, private IPv4/IPv6, link-local, reserved/metadata endpoints and disallowed schemes while permitted public destinations continue to work.

### Klart-kriterier

- [ ] AC-006 has automated evidence.
- [ ] RISK-001 enforcement pattern is documented and materially reduced.
- [ ] Any deployment-specific limitation is explicit before feature work continues.

### Beroenden

- DEV-002

## DEV-004 – Core screenshot REST flow

### Mål

Deliver the first vertical screenshot capability through REST.

### Scope

Presets, custom viewport, device scale factor as appropriate, full-page, validation, PNG result, metadata, ephemeral result handling and stable error model.

### Verifiering

Unit/API/browser integration tests for successful capture, preset/custom dimensions, full-page, invalid input, timeout and cleanup.

### Klart-kriterier

- [ ] AC-001, AC-002, AC-003, AC-004 and AC-007 pass at API level.
- [ ] Results cannot be retained indefinitely by accident.

### Beroenden

- DEV-003

## DEV-005 – Persistence foundation

### Mål

Establish external PostgreSQL persistence and migrations required for identity/allowlist state.

### Scope

Database access layer, migrations, development/test database configuration and health/readiness implications.

### Verifiering

Migration on clean PostgreSQL, persistence integration tests and startup behavior when DB is unavailable.

### Klart-kriterier

- [ ] Schema is reproducible from migrations.
- [ ] No screenshot binary data is unintentionally persisted.

### Beroenden

- DEV-001

## DEV-006 – GitHub OAuth and allowlist

### Mål

Protect human REST/UI access using GitHub identity and server-side allowlisting.

### Scope

OAuth login/callback/session/logout, email allowlist model/admin configuration pattern and authorization middleware/service.

### Verifiering

Integration tests for anonymous, authenticated-but-not-allowed and allowed users; cookie/session security checks.

### Klart-kriterier

- [ ] AC-005 passes.
- [ ] Protected screenshot API is inaccessible without allowlist authorization.

### Beroenden

- DEV-005

## DEV-007 – Responsive web UI

### Mål

Deliver the complete end-user screenshot workflow.

### Scope

URL form, presets/custom viewport, full-page toggle, submit/progress/errors, image result and download, responsive layout.

### Verifiering

Frontend tests/build plus browser acceptance at desktop and mobile viewport sizes.

### Klart-kriterier

- [ ] AC-008 passes.
- [ ] UI uses protected REST behavior and does not bypass server authorization.

### Beroenden

- DEV-004, DEV-006

## DEV-008 – Remote MCP

### Mål

Expose the same screenshot use case to authenticated MCP clients.

### Scope

Remote MCP transport/auth, one screenshot tool, schema validation, result semantics and shared authorization/application service.

### Verifiering

MCP integration tests for allowed/denied clients and successful screenshot creation.

### Klart-kriterier

- [ ] AC-009 passes.
- [ ] MCP does not expose general browser automation.

### Beroenden

- DEV-004, DEV-006

## DEV-009 – Resource and abuse controls

### Mål

Make screenshot execution operationally bounded under expensive or malicious pages.

### Scope

Concurrency limiter/queue policy, authenticated rate limiting, timeouts, browser recycling, viewport/output bounds and cancellation/cleanup.

### Verifiering

Load/concurrency-focused tests and failure-path cleanup tests.

### Klart-kriterier

- [ ] Jobs cannot exceed configured concurrency indefinitely.
- [ ] Hung/error requests release contexts/resources.

### Beroenden

- DEV-004, DEV-006

## DEV-010 – Security hardening

### Mål

Close security gaps before deployment packaging is considered complete.

### Scope

Headers, CSRF/session review where relevant, input/error/log review, secrets handling, dependency posture, container privileges and security regression suite.

### Verifiering

Security regression tests and documented review against project security requirements.

### Klart-kriterier

- [ ] NFR-001 and NFR-002 have explicit verification evidence.
- [ ] Critical/high security risks have no unresolved hidden assumptions.

### Beroenden

- DEV-003, DEV-006, DEV-009

## DEV-011 – Coolify packaging

### Mål

Produce target deployment packaging and configuration for Coolify.

### Scope

Production Dockerfile, non-root execution where practical, Playwright browser dependencies, port/health, external PostgreSQL, runtime config and Coolify deployment notes.

### Verifiering

Image build/start/health and target-like browser screenshot smoke test.

### Klart-kriterier

- [ ] AC-010 passes in container.
- [ ] Browser security boundary still works in packaged runtime.

### Beroenden

- DEV-010

## DEV-012 – GitHub CI and release workflow

### Mål

Automate required verification and release image publishing.

### Scope

PR/default-branch CI and release-tag workflow that publishes versioned GHCR images; Playwright environment must match project version.

### Verifiering

Workflow syntax/permissions review and real GitHub Actions PASS once repository is available.

### Klart-kriterier

- [ ] Required CI covers canonical verification.
- [ ] Release version derives from tag.
- [ ] GHCR image tags are deterministic/versioned.

### Beroenden

- DEV-011 and GitHub repository availability

## DEV-013 – End-to-end acceptance

### Mål

Verify the complete human, REST, MCP and security flows in a representative environment.

### Scope

Acceptance/e2e suite covering functional acceptance criteria and critical security negative cases.

### Verifiering

Browser/e2e/API/MCP/security suite PASS with reproducible evidence.

### Klart-kriterier

- [ ] All Must acceptance criteria have PASS evidence.
- [ ] No release-blocking deferred browser/security check remains.

### Beroenden

- DEV-007, DEV-008, DEV-012

## DEV-014 – Release readiness and operations

### Mål

Reconcile implemented system with governing specification/architecture and prepare an operationally releasable project.

### Scope

Documentation reconciliation, installation/configuration/operations, backup implications, troubleshooting, release checklist and final hygiene.

### Verifiering

Final full canonical verification, docs/state consistency and release-readiness review.

### Klart-kriterier

- [ ] Functional/architecture mismatches are resolved/classified.
- [ ] Operations/install guidance is complete enough for deployment.
- [ ] Release-readiness gate passes.

### Beroenden

- DEV-013

## Cross-cutting verification

- Security-sensitive behavior receives negative tests, not only happy paths.
- Browser tests that actually run and fail are blocking failures.
- Missing local browser binaries may be deferred only when environment-limited; release requires actual browser PASS evidence.
- CI should use the same canonical verification commands as local development.
- No step is marked complete until required verification passes.

## Plan-change rules

The plan may be split/reordered when actual evidence requires it, especially around Chromium sandboxing or network isolation. Completed step IDs are not repurposed. Any accepted change to product intent updates the functional specification/architecture before dependent implementation continues.
