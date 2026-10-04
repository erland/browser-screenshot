# End-to-end acceptance – Browser Screenshot

## Purpose

This is the release-facing acceptance plan for DEV-013. It combines previously verified automated evidence with a repeatable remote acceptance smoke against a representative deployed environment. No acceptance result is considered PASS merely because a scenario is skipped.

## Preconditions

- A representative HTTPS deployment is running with PostgreSQL, GitHub OAuth and the production container image.
- One test GitHub identity is enabled in `allowed_user` and one test identity is disabled/not present.
- A public target URL is available (default `https://example.com`).
- A valid interactive session cookie is available as `REST_COOKIE`.
- A valid MCP OAuth bearer token for the same allowed identity is available as `MCP_ACCESS_TOKEN`.
- The deployment has the intended host/platform private-egress policy.

## Automated remote acceptance

Run from a checked-out source tree after `npm ci`:

```bash
BASE_URL=https://browser-screenshot.example.com \
REST_COOKIE='browser_screenshot_session=…' \
MCP_ACCESS_TOKEN='…' \
PUBLIC_URL=https://example.com \
./scripts/verify-acceptance.sh
```

The harness verifies unauthenticated health/readiness, absence of obvious secret disclosure, anonymous protected-route rejection, preset discovery, REST PNG creation, mobile metadata, custom viewport semantics, invalid viewport rejection, direct loopback blocking, MCP tool discovery, absence of general browser-control tools, MCP PNG creation and mobile semantics.

## Manual UI acceptance

Using the allowlisted GitHub identity, perform the following at desktop (~1440 px wide) and mobile (~390 px wide):

1. Sign in through GitHub and confirm the account identity is shown.
2. Enter the public target URL and capture Desktop, Tablet and Mobile presets.
3. Select custom viewport and capture 777×555 at scale 1.
4. Toggle full-page capture and confirm the result visibly contains more page content than viewport capture when the target page is tall enough.
5. Confirm the result preview is visible and “Hämta PNG” downloads a valid image.
6. Confirm no horizontal page overflow at either representative viewport.
7. Sign out and confirm protected screenshot functions are no longer usable.
8. Sign in with the non-allowlisted identity and confirm screenshot UI/API access is denied.

Record PASS/FAIL, deployment URL, image digest/version, browser/device and date in the release evidence.

## Acceptance matrix

| Criterion | Expected evidence |
| --- | --- |
| AC-001 | REST PNG magic + successful public target; existing TEST-004 |
| AC-002 | Preset discovery plus Desktop/Tablet/Mobile UI captures; existing TEST-004 |
| AC-003 | Remote custom 777×555 PASS and out-of-range 400; existing TEST-004 |
| AC-004 | Manual viewport/full-page comparison; existing TEST-004 |
| AC-005 | Non-allowlisted UI/API denial and existing auth integration evidence |
| AC-006 | Existing network/security suite plus remote `127.0.0.1` rejection and container smoke |
| AC-007 | Existing timeout/resource tests plus target-like run evidence |
| AC-008 | Desktop/mobile manual UI flow; existing DEV-007 browser evidence |
| AC-009 | `scripts/acceptance-mcp.mjs` `screenshot_create` PNG/metadata PASS |
| AC-010 | Unauthenticated `/health` and `/ready`, container smoke, no secret disclosure |

## Release blockers

DEV-013 cannot be marked fully accepted until all Must acceptance criteria have representative-environment PASS evidence. In particular, the production container sandbox/private-egress proof from DEV-011 and actual GitHub Actions/GHCR proof from DEV-012 remain release blockers until executed.
