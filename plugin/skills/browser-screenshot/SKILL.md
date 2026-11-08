---
name: browser-screenshot
description: Capture a PNG screenshot of a public HTTP(S) web page at a desktop, tablet, mobile, or custom viewport with exact requested settings and reported metadata.
---

# Browser Screenshot capture

Use `screenshot_create` when the user explicitly needs a screenshot of a public HTTP(S) website. This single-shot capture does not require an interactive browser session.

## Capture

1. Pass the exact public URL requested by the user.
2. Use the requested desktop, tablet, mobile, or custom viewport; default to desktop only when unspecified.
3. Set full-page capture only when requested or necessary to inspect content below the fold.
4. Return the resulting PNG and actual capture metadata. Do not invent dimensions, durations, responsive behavior, or unseen UI.

Do not create multiple viewport screenshots unless requested.

## Other workflows

Browser Screenshot also offers separately gated interactive automation. For authorized multi-step navigation and control inspection, use the **browser-interactive-test** skill. For PWA cache, service-worker, and offline checks, use **browser-pwa-offline-test**. For a structured deployment check, use **browser-release-verification**.

Interactive and PWA operations require administrator-enabled feature flags and authenticated, owner-bound sessions. Screenshot capture does **not** imply that these features are available.

## Safety

Never capture localhost, private IP addresses, or internal resources. Do not invent screenshots, run arbitrary page JavaScript, or treat a screenshot as proof that the app functions correctly. All consequential page modifications require explicit authorization and the service's HTTPS test-origin allowlist.
