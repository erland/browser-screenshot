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

## CI and MCP lookup checkpoint
The CI workflow now verifies pushes to `main` and pull requests; feature-branch pushes with an open PR no longer produce a second push-triggered run. The MCP store can resolve an immutable `(provider, subject, verified email)` identity to its internal account ID, and GitHub sign-ins maintain the mapping. OAuth grants/tokens are **not yet bound** to that result, so the existing Google MCP denial remains in force. Complete grant/token binding and revocation checks before removing it.

## Google MCP authorization enabled in code (pending final verification)
The provider-bound Google MCP authorization path is now implemented. An authenticated Google session must resolve to an existing Google identity by immutable subject, verified email and account ID; the resolved identity must pass provider-specific authorization before any grant is issued. The grant, refresh credential and bearer token carry that identity and revalidate it on use. GitHub authorization is unchanged, including its legacy email-only compatibility path.

Earlier sections describing the temporary Google MCP block document historical rollout checkpoints rather than the current implementation. Do not merge until CI and database-backed tests pass, and account linking / merging / revocation behavior is reviewed.

## Linked identity listing (read-only)
An authenticated endpoint, `GET /api/account/identities`, now lists provider names and verified emails linked to the *same* internal user ID. It resolves the requesting session by provider and immutable subject; it does not use matching email as a linkage rule. Provider subject identifiers are deliberately omitted from the browser response.

**Not implemented:** mutation routes for linking, unlinking or merging accounts. Before adding these, require fresh OAuth verification, same-origin protection for mutations, atomic account ownership checks and reliable invalidation of browser sessions and MCP credentials after changes. Do not present the read-only endpoint as complete account linking.

## Explicit account merge assessment
The database now provides `assessIdentityLink(source, target)` using immutable provider subjects. It reports missing identities, already-linked identities, or `merge_required` when the two verified identities belong to different internal accounts. It **does not** link, merge, migrate data or revoke sessions. Linking must later require fresh verification of both identities, explicit merge consent, and transactional record/token handling. Email equality never approves a merge.

## Fresh Google verification before linking
`GET /auth/link/google` now requires an authorized GitHub browser session and starts a new Google OIDC code flow with PKCE, nonce and a signed state containing the GitHub provider subject. On the callback, the original session and immutable GitHub subject are checked again. Even after successful Google verification the endpoint returns `LINK_CONFIRMATION_REQUIRED` and makes **no account mutation**. This is an intentional safe intermediate stage; complete transactional conflict handling, confirmation and account migration before exposing a working link button.

## Atomic unclaimed-identity linking primitive
`linkUnclaimedGoogleIdentity` now uses one INSERT ... SELECT with ON CONFLICT DO NOTHING to attach a never-before-claimed Google subject to a verified GitHub account. It never reassigns an existing Google identity. A conflict returns `merge_required` (or an applicable existing/missing status), and the caller must implement explicit consent and fresh OIDC before invoking it. **This primitive is not yet wired to the OAuth callback or confirmation endpoint.** End-to-end account linking remains unavailable until the confirmation workflow and revocation controls are completed.

## Explicit Google account-link confirmation (current checkpoint)
After a fresh Google verification, `/auth/callback/google` now sets a short-lived, signed, HttpOnly confirmation cookie bound to the current GitHub subject and redirects to `/auth/link/confirm`. The user must explicitly click to send a same-origin POST to `/api/account/link/google/confirm`. The server rechecks the browser session, signed confirmation, configured Google allowlist, and invokes the insert-only link operation. Any previously owned Google identity causes a conflict, not automatic merging. The link confirmation does not implement account merges or unlinking, and requires end-to-end browser and PostgreSQL testing before deployment.

## Google unlinking checkpoint
`POST /api/account/unlink/google` now requires a live GitHub session and same-origin request. It removes only the Google provider identity from that same account, leaving GitHub available for login. Existing identity-bound Google MCP bearer and refresh credentials are rejected at provider-identity validation after the unlink. This does **not** implement explicit account merging or browser-UI unlink confirmation. Review the lifecycle of standalone Google records and run real PostgreSQL integration tests before merging.

## Linked Google sign-in regression check
An ordinary Google sign-in now updates the existing `app_user_identity` record first. If the Google subject is already linked to a GitHub account, it retains the original `user_id` and does not create a duplicate standalone `app_user`. CI checks this on real PostgreSQL. This is account-lifecycle hardening, **not** permission to merge two already-existing accounts: the latter still requires explicit dual-account proof, transactional migration and token/session revocation.
