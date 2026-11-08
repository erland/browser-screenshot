---
name: browser-release-verification
description: Produce a traceable post-release browser verification report for a public web or PWA deployment, combining visual screenshots, bounded interaction checks, and PWA offline checks only when enabled.
---

# Browser release verification

Use for a user's request to verify a released public site or Progressive Web App.

## Scope and safety

Confirm the exact deployment URL and requested checks. Never infer that a newly merged version is deployed. Read-only checks are the default; avoid destructive tests and do not submit user data without explicit consent. Private hosts and localhost are forbidden. Do not silently activate feature flags or claim missing tools ran.

## Procedure

1. Confirm the release endpoint is the expected public deployment. Use `screenshot_create` for the explicitly requested viewport(s); capture full-page only when useful.
2. Compare the page with concrete expected behavior or previously supplied evidence. Report visible regressions, broken layout, and unknowns separately.
3. If interactive automation is enabled and requested, follow **browser-interactive-test**. Include before/after snapshots for observed behaviors. Do not replace existing service or CI tests with visual checks.
4. If PWA offline testing is enabled and requested, follow **browser-pwa-offline-test**. Keep the same session and always restore online mode.
5. Record tool errors, skipped controls, tested viewport(s), and whether CI/build/authorization information was actually available.
6. Return an evidence-based recommendation: **pass**, **fail**, or **inconclusive**, with outstanding risks.

## Report

Include deployment URL, release/build identifier if independently known, tested checks, observed results, screenshot references, untested items, restrictions, and a decision with rationale. A successful screenshot is not proof of app function; a passing offline reload is not proof of complete offline feature support. A user deploying code is separate from a user merging code.
