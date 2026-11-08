# MCP Skills Extension — Browser Screenshot

## Scope

Browser Screenshot serves the official MCP Skills extension
(`io.modelcontextprotocol/skills`, SEP-2640), keeping the **same**
`plugin/skills/*/SKILL.md` files in both the Marketplace plugin and the
remote MCP server. Skills provide *instructions*, not additional privileges.
The existing authenticated screenshot and automation tools are unchanged.

The four skills are:

| Skill | Intended workflow | Tools |
| --- | --- | --- |
| `browser-screenshot` | One-shot screenshot of a public URL | `screenshot_create` |
| `browser-interactive-test` | Authorized navigation/snapshot/control test | `browser_session_*`, `browser_navigate`, `browser_snapshot`, `browser_fill`, `browser_click` |
| `browser-pwa-offline-test` | Service worker, cache, offline reload, recovery | `browser_pwa_status`, `browser_cache_inspect`, `browser_set_offline`, `browser_reload` |
| `browser-release-verification` | Combine visual, interaction and PWA evidence | Available subset of the above |

## Wire contract

- `server/discover` advertises `capabilities.extensions["io.modelcontextprotocol/skills"]`, plus the regular resources capability.
- `skills/list` returns four entries with `uri`, verbatim `frontmatter`,
  and `resources` containing a byte size and `sha256:<hex>` digest.
- `skills/get` returns one entry by its complete `skill://.../SKILL.md` URI.
- `resources/read` returns the exact Markdown bytes for that entry.
- No directory listing capability is advertised: each skill currently contains
  only one `SKILL.md` file. Build/startup fails if unlisted files are added.
- The index is loaded when the MCP module starts, not reloaded in the middle
  of an active connection. Restart the service to publish changed instructions.

The code uses the low-level extension handler API supported by the **existing
pinned MCP TypeScript SDK**, avoiding a dependency or lockfile update. When
the project's SDK is upgraded, the official `SkillsExtension` helper can
replace this small adapter after protocol-regression tests.

## Deployment and risk

Deploying these skills does **not** enable `BROWSER_AUTOMATION_ENABLED` or
`BROWSER_PWA_TEST_ENABLED`. Both remain disabled by default. Interactive
write actions still require a specifically allowed HTTPS test origin,
authenticated owner-bound sessions, and user approval for consequential changes.

The `Dockerfile` copies `plugin/skills` into the runtime image. The
container smoke verifies all four entries are served and readable over MCP.
GitHub Actions checks that the Marketplace plugin contains all four skills,
and unit tests verify exact content digest/size, listing, lookup and
invalid-request handling. OAuth protection of the MCP endpoint is unchanged.

**Important:** The Skills extension does not guarantee that a connected
ChatGPT client will dynamically import changes from a server after a plugin
has been installed. Distribute updated skills with each plugin release and
reinstall/reload through supported client workflows when needed. Do not
interpret `resources/read` as automatic skill activation.

## Acceptance before enabling PWA

1. Merge and release the plugin/server together with matching skills.
2. Deploy new code with automation and PWA flags OFF.
3. Verify remote authenticated `skills/list`, `skills/get` and `resources/read`
   and confirm available skill discovery in the actual ChatGPT client.
4. Separately complete the deployed OAuth/egress PWA acceptance before enabling
   experimental PWA automation.


## BS-SKILL-003: deployed-server and ChatGPT installation verification

**Two separate acceptances are required.** A successful server-side Skills
extension does not demonstrate that the ChatGPT host imported the skill bundle.

### A. Authenticated deployed MCP server

Use a *real OAuth access token* issued to a trusted operator for this service.
Do not paste tokens into chats, logs, GitHub issues, CI output, or shell history.
From the matching Git tag or checked-out release source, run:

```sh
# Provide BROWSER_SCREENSHOT_MCP_TOKEN securely in your shell environment.
# Optional: override BROWSER_SCREENSHOT_MCP_URL for staging.
node scripts/verify-remote-skills.mjs
```

The script validates `initialize`, `server/discover` (skills and resources
capabilities), `skills/list`, all four `skills/get` calls, and all four
`resources/read` calls. It compares remote bytes to both manifest SHA-256
and the **matching local release source**. A 401 or unavailable OAuth token
is **not tested**, not a pass. It is deliberately not wired into unauthenticated
CI, because that would require injecting an operator credential into builds.

The script proves the deployed MCP protocol only. It does not imply ChatGPT
has granted approval or loaded any skills.

### B. ChatGPT plugin bundle

1. Confirm the **GitHub Release asset**
   `browser-screenshot-plugin-<version>.zip` was produced from the correct tag.
   The release workflow now fails if any of the four `SKILL.md` files are absent.
2. Confirm this *updated plugin artifact*, not just the server container,
   was installed/published/synchronized using the actual supported ChatGPT
   plugin distribution workflow.
3. Start a **new ChatGPT conversation** after installing/updating the plugin,
   because installed bundled skills are resolved at session startup.
4. Check whether the four skill names are in the loaded skill list:
   `browser-screenshot`, `browser-interactive-test`,
   `browser-pwa-offline-test`, `browser-release-verification`.
5. Invoke an appropriate explicit workflow (for example, screenshot then
   release verification) and distinguish observed instruction-guided use
   from mere availability of MCP tools.

**Important limitation:** the MCP tool bridge exposed in ChatGPT may expose
only `tools/call` and no raw `skills/list` method. Failure to see remote
skills in a particular chat therefore does **not** by itself prove an MCP
protocol bug. Conversely, working tools do **not** prove that ChatGPT installed
the updated plugin ZIP.

If all four skills are present and usable in the new ChatGPT session, mark
BS-SKILL-003 complete. Otherwise collect: installed plugin package version,
release ZIP version, the local-versus-remote acceptance result, skill names
visible in a fresh session, and host support/approval status. Do not add an
unauthenticated MCP endpoint or a privileged tools-based skill loader as a
shortcut.

### Release artifact parity

A Docker image release and a Marketplace plugin ZIP are separate artifacts.
Publishing a newer Docker container does not update an already installed
plugin ZIP. For BS-SKILL-003, deploy/publish both from the same tag. Keep
interactive and PWA test features under their existing independent flags.
