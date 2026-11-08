---
name: browser-pwa-offline-test
description: Test a public HTTPS Progressive Web App's service-worker and cache state, offline reload, and online recovery using a persistent Browser Screenshot automation session.
---

# PWA offline and recovery test

Use this workflow when the user asks for offline, service-worker, caching, or PWA release verification.

## Preconditions

The server must expose interactive tools and the independent PWA flag (`BROWSER_AUTOMATION_ENABLED=true`, `BROWSER_PWA_TEST_ENABLED=true`). Both are disabled by default. Do not instruct the user to enable experimental PWA mode on an unreviewed deployment. Test only an authorized, public HTTPS origin. Browser Screenshot prohibits private network targets. Keep one session open across online/offline transitions.

## Procedure

1. Create a session with `browser_session_create`, navigate with `browser_navigate`.
2. Capture online evidence using `browser_snapshot`, `browser_pwa_status`, and `browser_cache_inspect`. Registration and cache existence do **not** prove complete offline behavior.
3. If needed, allow time for normal service-worker activation, then inspect again. Do not assume installation is immediate.
4. Call `browser_set_offline` with `offline:true`.
5. Call `browser_reload` in the same session. Record its actual `loaded` value.
6. If reloaded successfully, use `browser_snapshot` and optionally `browser_session_screenshot`; verify expected offline content and an explicitly scoped navigation or read-only feature if the tools support it.
7. Call `browser_pwa_status` and `browser_cache_inspect` again to inspect the offline state.
8. Restore `browser_set_offline` with `offline:false` in cleanup; call `browser_reload` and verify online recovery.
9. Always `browser_session_close`, even on errors.

## Reporting

Separate (a) SW registration, (b) resource caching, (c) offline app-shell reload, (d) genuinely tested offline function, and (e) online recovery. Mark missing assertions as **not tested**, not passed. Failed offline navigations are legitimate test outcomes; never infer success from a cache list alone.
