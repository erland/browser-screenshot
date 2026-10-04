# Functional Specification – Browser Screenshot

## 1. Purpose and goals

Browser Screenshot shall provide a small, reusable service for capturing screenshots of web pages without coupling screenshot functionality to Agent Workspace or PWA Preview.

The primary goals are:

1. A human user can submit a URL, choose a device preset or viewport, and receive a screenshot.
2. An AI client can perform the same operation through remote MCP.
3. The browser execution is constrained so that the service cannot be used as a path into the service host or private/internal networks.
4. The service can be deployed independently and reused by Agent Workspace, PWA Preview workflows, CI, and other clients.

## 2. Actors

- **End user** – authenticated person using the web UI.
- **MCP client** – authenticated AI/tool client invoking screenshot capability.
- **Operator** – configures deployment, OAuth, allowlist, limits and observability.
- **Target website** – public HTTP(S) page rendered by Chromium.

## 3. Scope and priorities

### Must

- GitHub OAuth login.
- Server-side allowlist authorization.
- Responsive web UI.
- REST API for screenshot creation.
- Remote MCP exposing screenshot creation.
- URL input using HTTP/HTTPS policy defined by configuration, with HTTPS preferred for production.
- Device presets for desktop, tablet and mobile.
- Custom viewport width and height.
- Optional full-page capture.
- PNG output.
- Configurable navigation timeout and concurrency limits.
- Isolation between screenshot jobs using fresh browser contexts.
- Protection against SSRF/private-network access for main navigation, redirects and subresources.
- Health endpoint.
- Container packaging suitable for Coolify.
- CI for lint/typecheck/tests/build and later browser/security verification.

### Should

- Device scale factor.
- Stable metadata with screenshot dimensions, content type and timing.
- Bounded temporary screenshot retention or direct streaming with automatic cleanup.
- Rate limiting per authenticated identity.
- Useful failure categories for timeout, blocked destination, invalid URL and browser failure.

### Could

- Web UI history.
- Additional image formats.
- Screenshot comparison/diff.
- Named custom device profiles.

### Out of scope for v1

- General browser automation such as click, type, execute JavaScript or arbitrary navigation commands.
- Persistent long-term screenshot archive.
- Running/building source projects.
- Private-network browsing.
- Authentication into arbitrary target websites.
- Scheduled screenshots.

## 4. Functional requirements

### FR-001 – Authenticate users

The service shall authenticate interactive users through GitHub OAuth and remote MCP clients through the service's supported OAuth flow.

### FR-002 – Authorize through allowlist

The service shall deny UI/API/MCP access unless the authenticated identity is enabled by the configured email allowlist policy.

### FR-003 – Create screenshot

An authorized client shall be able to request a screenshot for a URL.

Input shall support:

- URL,
- preset or custom width/height,
- optional device scale factor,
- optional full-page mode.

### FR-004 – Device presets

The service shall provide at least `desktop`, `tablet` and `mobile` presets. Preset values shall be defined in one canonical server-side configuration/module and exposed to UI clients.

### FR-005 – Custom viewport

An authorized client shall be able to specify viewport width and height within configured minimum and maximum bounds.

### FR-006 – Render in Chromium

The service shall render the target page in Chromium through Playwright and create an isolated browser context for each screenshot request.

### FR-007 – Return screenshot

A successful request shall return or expose a PNG screenshot plus basic metadata including width, height and content type.

### FR-008 – Full-page screenshot

A client shall be able to request either viewport-only or full-page capture.

### FR-009 – REST API

The service shall expose an authenticated REST API for screenshot creation with validation and stable error responses.

### FR-010 – Remote MCP

The service shall expose a remote MCP tool named `screenshot_create` or equivalent with the same screenshot semantics as the REST API.

### FR-011 – Responsive web UI

The web UI shall allow an authorized user to enter a URL, choose a preset or custom viewport, choose full-page mode, create a screenshot, inspect it and download the result.

### FR-012 – Health

The service shall expose an unauthenticated health endpoint suitable for container/platform health checks and shall not expose secrets in the response.

### FR-013 – Temporary result lifecycle

If screenshots are written to local storage, the service shall treat them as ephemeral, enforce bounded retention and remove them automatically. Persistent screenshot storage is not required in v1.

### FR-014 – Failure reporting

The service shall distinguish at least invalid request, unauthorized/forbidden, blocked destination, navigation timeout, target/browser failure and internal failure without leaking sensitive network details.

## 5. Security and business rules

### FR-015 – URL scheme restrictions

Only configured web schemes shall be accepted. `file:`, `data:`, `javascript:` and other non-web schemes shall be rejected.

### FR-016 – Private destination blocking

The browser shall not be able to reach loopback, link-local, private, reserved or infrastructure metadata destinations. Protection shall cover:

- initial URL,
- DNS resolution,
- redirects,
- browser subresources,
- JavaScript-initiated requests,
- IPv4 and IPv6.

DNS rebinding and TOCTOU behavior shall be considered in the implementation strategy.

### FR-017 – Bounded execution

Each screenshot operation shall have configured bounds for navigation duration, total operation duration, viewport dimensions, output size where practical, and concurrent browser work.

### FR-018 – No general browser control

The public API/MCP contract shall not expose arbitrary click, typing, script execution or generic browser-control primitives in v1.

## 6. Information needs

Persistent data is limited to what authentication/allowlisting requires. Screenshots are ephemeral unless a later accepted requirement changes this.

Likely persistent entities:

- authorized GitHub identity / allowlist entry,
- minimal user identity metadata if needed for OAuth/audit/rate limiting.

## 7. Non-functional requirements

### NFR-001 – Security isolation

A malicious target page must not gain useful network access to the application host, container infrastructure, database, metadata services or private networks through the screenshot browser.

### NFR-002 – Least privilege

The application container shall run with least practical privileges, secrets shall be supplied at runtime, and application/database access shall use least privilege.

### NFR-003 – Performance

The service should reuse a managed Chromium process when safe while using a fresh isolated browser context per job. Concurrency shall be bounded to prevent resource exhaustion.

### NFR-004 – Reliability

A failed or hung screenshot request shall be terminated without leaving browser contexts/jobs indefinitely active.

### NFR-005 – Operability

The service shall log to stdout/stderr, expose health, support graceful shutdown and document required environment configuration.

### NFR-006 – Portability

The service shall be packaged as a Docker/OCI image and shall not require Modal or another external sandbox provider for normal screenshot execution.

### NFR-007 – Responsive UI

The management UI shall remain usable on desktop, tablet and phone-sized screens.

### NFR-008 – Reproducible delivery

Node, package-manager state, browser/Playwright compatibility and CI commands shall be pinned/locked sufficiently to make builds and browser verification reproducible.

## 8. Acceptance criteria

- **AC-001 (FR-003):** Given an authorized user and a permitted public URL, a screenshot request returns a valid PNG.
- **AC-002 (FR-004):** Desktop, tablet and mobile presets each produce screenshots with their documented viewport settings.
- **AC-003 (FR-005):** Valid custom width/height values are honored and values outside configured bounds are rejected.
- **AC-004 (FR-008):** Viewport and full-page capture can be selected and produce the expected capture area.
- **AC-005 (FR-002):** A valid GitHub login not present/enabled in the allowlist cannot use protected UI/API/MCP functions.
- **AC-006 (FR-016/NFR-001):** Direct, redirected and subresource requests to blocked address classes are prevented by automated security tests.
- **AC-007 (FR-017):** A non-responsive page does not hold a screenshot worker beyond configured operation limits.
- **AC-008 (FR-011):** The complete screenshot flow is usable at representative desktop and mobile viewport sizes.
- **AC-009 (FR-010):** An authorized MCP client can create a screenshot with semantics equivalent to REST.
- **AC-010 (FR-012):** Container health can be checked without authentication and without disclosure of secrets.

## 9. Open questions

No question currently blocks implementation. Exact production hostname, GitHub OAuth application values and final allowlist contents are deployment configuration and do not need to block development.
