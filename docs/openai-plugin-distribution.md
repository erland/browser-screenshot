# OpenAI plugin distribution

Browser Screenshot publishes one complete portable Agent Plugins package that is also the author-supplied ZIP for Marketplace/public submission.

## Package layout

`browser-screenshot-plugin-<version>.zip` contains:

```text
browser-screenshot/
├── plugin.json
├── mcp.json
├── assets/
│   ├── logo.png
│   └── composer-icon.png
└── skills/
    └── browser-screenshot/
        └── SKILL.md
```

The public upload contains no `.app.json`, no non-null `apps` declaration and no `.codex-plugin/` update overlay. The Developer Portal can create the ChatGPT App binding from the remote MCP configuration during submission.

## MCP integration

`mcp.json` points at `https://browser-screenshot.apphome.one/mcp`. The remote service uses OAuth and exposes one screenshot tool, `screenshot_create`.

## Marketplace metadata

`plugin.json` includes public website/support/privacy/terms URLs, Marketplace icons, five positive and three negative review cases, `commerce: false`, and country targeting limited to Sweden (`SE`).

## Build

```bash
BROWSER_SCREENSHOT_MCP_URL=https://browser-screenshot.apphome.one/mcp \
  npm run plugin:build -- --version 1.0.0 --target marketplace
```

The generated directory is `build/plugin-marketplace/browser-screenshot/`. The `desktop` target remains available for direct-MCP use and produces the same complete structure.

## Release

A GitHub Release publishes the application image and `browser-screenshot-plugin-<version>.zip`.

No OAuth credential, browser session secret, database credential, bearer token, private URL or other secret may be embedded in the package.

## Public submission

Portal-only work remains separate: verified publisher identity, MCP→ChatGPT App conversion, reviewer access for the OAuth/allowlist-protected flow, demo recording, final review-case execution, legal/policy attestations and submit-for-review.
