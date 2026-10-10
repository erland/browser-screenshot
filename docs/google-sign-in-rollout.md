# Google sign-in rollout (incremental)

Status: design and data migration only; **not yet ready to merge/release**.

## Goal
Extend existing browser GitHub sign-in with optional Google OpenID Connect while preserving GitHub authentication, allowlist, MCP authorization-code + PKCE, signed web cookies and screenshot security boundaries. Match the user-facing account management pattern from erland/pwa-preview PRs #40-#43.

## Existing constraints
- Current `app_user` is GitHub-specific, and signed session claims contain `githubUserId` and `githubLogin`.
- `allowed_user` is email-based; its synchronization is currently authoritative from `BROWSER_SCREENSHOT_GITHUB_ALLOWLIST_EMAILS`.
- MCP authorizations rely on the session authentication path, and must continue to work for GitHub-only deployments.
- Browser Screenshot does not store screenshots or previews, so account merge should not create publication migrations.

## Compatibility-first sequence
1. Add `app_user_identity` and backfill GitHub identities without changing existing user IDs or existing sessions (migration 006).
2. Add optional Google OIDC sign-in: authorization-code + PKCE and state, validate Google issuer/audience/nonce/expiry and verified email on the server. Use immutable `sub` rather than email as identity. Never link on matching email.
3. Evolve signed browser sessions to stable `app_user.id` while accepting existing GitHub sessions during their eight-hour TTL. Revalidate the active provider-specific allowlist on protected requests, including MCP login.
4. Make Google allowlist configuration independent, with `BROWSER_SCREENSHOT_GOOGLE_ALLOWLIST_EMAILS`. Do not reuse current GitHub allowlist synchronization for both providers; preserve database-managed allowlist semantics and fail closed on missing Google allowlist.
5. Support explicit authenticated identity linking/unlinking via same-origin, CSRF-protected mutations, with database locking and protection of the last identity.
6. If linking discovers another account, require fresh authentication and explicit merge confirmation; implement atomic migration of linked identities while invalidating old sessions. Reject accidental automatic merges.
7. Render Google sign-in only when configured, and show linked provider identities. Keep sign-in and screenshot UI responsive.
8. Forward optional Google variables in *both* Compose files. Document Google Cloud redirect `https://browser-screenshot.apphome.one/auth/callback/google` and rollout/rollback.
9. Cover auth state replay/mismatch, callback errors, token claims, disabled/unlisted identities, link/unlink/merge concurrency, GitHub-only upgrade, REST and MCP regressions. Run npm verification and production-container smoke before release.

## Rollback
Do not drop the new table on rollback; retain legacy GitHub columns and routes until final switchover. If Google variables are absent, GitHub-only operation must remain unchanged.

## Reference
- PWA Preview PR #40 Google OIDC and linking
- PWA Preview PR #41 Compose passthrough
- PWA Preview PR #42 account linking and unlinking
- PWA Preview PR #43 explicit account merge

## Current implementation checkpoint (2026-10-10)
- Optional Google web sign-in and standalone Google identities have been wired.
- GitHub web login remains available. Account linking, unlinking and explicit merging are **not** implemented.
- **MCP limitation:** MCP authorization, refresh and bearer verification still check the legacy email-based `allowed_user` list, which is synchronized from the GitHub configuration. Google-only allowlisted users therefore cannot reliably use MCP. Do not attempt to fix this by granting access from the union of both allowlists: tokens currently identify email, not provider or immutable subject, and doing so could cross-authorize identities.
- Required next security migration: bind MCP authorization codes, refresh records and signed access tokens to immutable account + provider identity; recheck active provider-specific authorization on every use, and preserve legacy GitHub tokens through a controlled transition.
- A successful source CI run is not proof of live OAuth or PostgreSQL integration. Keep PR as Draft until provider-scoped MCP checks, linking/merge flows, database-backed tests and manual end-to-end testing are complete.

## MCP temporary isolation gate
MCP authorization now rejects Google web sessions before minting a legacy email-only authorization code, even when the email appears in the GitHub allowlist. Existing GitHub MCP flow is retained. This is a temporary security restriction, **not** complete Google MCP support. Token schema and database records still need provider/subject binding before Google MCP access can be enabled.

## MCP identity schema checkpoint
Migration 008 adds nullable `user_id`, `identity_provider` and `identity_subject` on authorization codes and refresh tokens. Legacy records remain unchanged, and no identities are inferred from email. The application still issues legacy MCP tokens and rejects Google MCP grants until a separate, end-to-end implementation:
1. Resolve the signed-in web identity to the canonical `app_user.id` and `app_user_identity` record.
2. Bind authorization code, refresh token and signed bearer claims to the same immutable identity.
3. Authorize against the specific provider's allowlist and active linked identity during authorization, exchange, refresh, and bearer verification.
4. Design the legacy token transition with explicit expiration and anti-replay tests; never authorize a provider-bound token based on email-only legacy checks.
5. Test PostgreSQL migrations, MCP flows for both providers, unlink/merge revocation, and live GitHub/Google sign-in before enabling Google MCP access.

This additive schema alone does not make Google MCP functional.
