# Owner identity and OAuth registrations — review only

Read-only verification on 11 October 2026 (Africa/Cairo): the owner's supplied login `b-10`
resolved uniquely to **B-10**, active **Super Admin**, not a test persona. Its `auth_user_id`
already joins an existing `auth.users` row; no active ban was returned. No email, UUID, password,
token or secret is committed. Reverify the mapping before configuration; never assign a new role.

Supported upstream provider: **Supabase Auth OAuth 2.1 / OIDC server** for the existing Phoenix
Auth project. Its subject is the existing Auth UUID, which must equal B-10's `auth_user_id`.
Phoenix's custom login session is not itself an OIDC proof. Existing account mapping is verified;
the actual upstream sign-in, hosted OAuth enablement and consent UI remain unverified.
Repository OAuth-server configuration was disabled at baseline. No hosted setting was changed.

Official provider instructions:
[Getting started](https://supabase.com/docs/guides/auth/oauth-server/getting-started),
[OIDC authorization code flow](https://supabase.com/docs/guides/auth/oauth-server/oauth-flows).
The adapter uses exact issuer/audience, S256, signed RS256/ES256 ID tokens, nonce, expiry/issued-at,
authorized party and same-origin HTTPS discovery endpoints; upstream tokens are discarded.

## Registration A: Phoenix MCP as confidential upstream client

- Enable OAuth server only after separate approval; configure the provider's authorization/consent
  page on an approved Phoenix source host. That page must use the existing linked Supabase account.
  No email-based automatic account linking, password forwarding through MCP or new employee access.
- Issuer: the Phoenix Auth origin followed by `/auth/v1`.
- Discovery: issuer followed by `/.well-known/openid-configuration`.
- Grant: authorization code; PKCE S256; scope `openid`; token auth `client_secret_post`.
- Redirect: exact approved MCP HTTPS origin plus `/oauth/callback`; no wildcard or alternate host.
- Keep client secret only in the separate MCP service. Pin owner subject/login/role to the verified
  mapping via private deployment configuration, never from client input or JWT role claims.
- Verify provider issuer, signing algorithm, endpoint origins, login/MFA behavior, consent handling
  and prompt=login in non-production. Synthetic signature tests cannot prove provider UX compatibility.

## Registration B: ChatGPT as public downstream client

- Static pre-registered client only; no dynamic registration or account auto-enrollment.
- Exact redirect copied from the owner's ChatGPT custom-MCP configuration; no guessed callback.
- Authorization code + S256, refresh rotation, scope `phoenix:read`, resource exact HTTPS `/mcp` URL.
- Public-client token authentication `none`; never enter the upstream secret in ChatGPT.
- MCP authorization server: `/authorize`, `/token`, `/revoke`; resource discovery is advertised by
  the bearer challenge. Upstream and downstream callbacks are distinct.
- If ChatGPT requires confidential-client authentication in the owner's available UI, leave the
  connection unconfigured and prepare a compatibility change; do not weaken PKCE or enable DCR.

Use RUNBOOK.md's private ChatGPT procedure only after the source and non-production gates pass.
No production OAuth registration, environment value or connection was created by this work.
