# VA-01 – Navigation readiness evidence

## Purpose

Browser Screenshot currently waits for Playwright `networkidle` before capture. DR-006 identified this as a possible reliability hotspot, but not yet a verified design problem.

VA-01 collects production-like evidence before changing readiness semantics.

## Enable evidence

Set:

```text
BROWSER_SCREENSHOT_NAVIGATION_EVIDENCE=1
```

and restart/redeploy the application.

The capture behavior is unchanged. Successful, timed-out and failed navigations emit one structured stdout line:

```text
navigation-evidence {"host":"example.com","waitUntil":"networkidle","timeoutMs":10000,"durationMs":642,"outcome":"success"}
```

Only the hostname is recorded. URL paths, query strings and fragments are not logged.

## Representative run

Use the normal REST/MCP capture flow against a representative sample rather than synthetic-only pages. Include:

- ordinary static/public pages,
- modern SPA/client-rendered pages,
- pages with analytics/long polling or continuous background requests,
- known slower public sites,
- desktop and mobile presets where relevant.

Collect enough requests to see whether a pattern exists. Do not change resource limits or navigation timeouts while collecting the baseline.

## Evidence to summarize

For each host/category, record:

- number of captures,
- success count,
- navigation timeout count,
- other target failures,
- typical successful navigation duration,
- whether timeout durations cluster near the configured timeout,
- whether a timed-out page appears visually ready in a normal browser materially earlier.

## Decision criteria

Treat DR-006 as a verified problem only if representative evidence shows a meaningful pattern such as:

1. repeated `NAVIGATION_TIMEOUT` for otherwise healthy public pages,
2. failures disproportionately affecting sites with continuous/background requests,
3. timeouts consistently occurring near the configured timeout while useful content is already rendered,
4. retries succeeding without a target-site availability change.

If evidence does not show such a pattern, keep `networkidle` and close DR-006 as not currently justified.

If the evidence supports a change, use IP-017 to compare a narrower strategy such as `domcontentloaded` plus an explicit bounded stabilization/wait policy. Do not silently replace readiness semantics without acceptance evidence.

## Disable evidence

Remove or set:

```text
BROWSER_SCREENSHOT_NAVIGATION_EVIDENCE=0
```

and restart/redeploy.

The evidence mode is intended for bounded diagnostic windows, not permanent verbose logging.


## Current decision

The representative production-like VA-01 run is intentionally deferred.

Until that evidence is collected:

- keep `waitUntil: 'networkidle'` unchanged,
- do not start IP-017,
- treat DR-006 as deferred rather than verified,
- retain the opt-in evidence instrumentation so validation can be resumed later without another implementation change.

This is a deliberate no-change decision, not evidence that `networkidle` is optimal.
