---
name: browser-interactive-test
description: Verify an authorized public website's user interactions in an isolated Browser Screenshot session using navigation, semantic snapshots, limited click and fill controls, and evidence screenshots.
---

# Browser interactive test

Use this workflow only when the user asks to test browser interactions on a public website.

## Preconditions

Interactive browser tools exist only when the server administrator enabled automation; do not pretend a missing tool worked. Interactions that alter a website additionally require a configured allowed HTTPS test origin. Obtain explicit user authorization before any form submission, purchase, deletion, account change, or other consequential action. Do not log in or enter passwords: those controls are unsupported. Do not visit private hosts, localhost, or internal services.

## Procedure

1. Call `browser_session_create`, save `sessionId`, and always close that session in cleanup.
2. Call `browser_navigate` with the exact public URL requested by the user.
3. Use `browser_snapshot` to read a bounded semantic overview and identify a supported unique `#id` or `[data-testid="..."]` selector.
4. For authorized, non-sensitive test actions only, call `browser_fill` or `browser_click` with the discovered selector. Do not invent selectors or perform unapproved side effects.
5. Call `browser_snapshot` again, verify the expected state changed, and optionally use `browser_session_screenshot` to capture evidence.
6. Always call `browser_session_close`, including after failed assertions.

## Reporting

Report observed behaviors separately from assumptions. Include tested URL, actions, assertions, screenshot evidence when available, failures, blocked steps, and cleanup status. If any required tool is unavailable, report that the test was not performed; do not substitute arbitrary page JavaScript or unsupported selectors.
