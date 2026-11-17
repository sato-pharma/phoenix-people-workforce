# ChatGPT ⇄ Phoenix Inspect — deployment runbook

**Nothing here has been deployed.** Step 1 is built and tested on loopback only. Step 1b is built for the
Secure MCP Tunnel route (Route C below), the route now in use; Step 4 is not built. Each step that deploys, exposes or spends needs the owner's decision
first ([CHATGPT_MCP_CONNECTION_READINESS.md](CHATGPT_MCP_CONNECTION_READINESS.md) §5). The steps are written so the
session that builds it can follow them in order and prove each one before the next.

Target: **staging only**, always. The production host is refused by the explorer itself.

## Step 0 — Preconditions

- [ ] This branch's PR is merged (the tools, tests and docs are on `main`).
- [ ] The owner chose option A (Railway) or B (spare + named tunnel), and the identity provider.
- [ ] The staging personas exist and are switched on ([INSPECTION_PERSONAS.md](INSPECTION_PERSONAS.md)).
      Their passwords are generated where the browser will run, never in chat or Git.

## Step 1 — Give the tools an HTTP door (code) — BUILT, tested on loopback only

Done in this branch, not deployed:

- `scripts/phoenix-inspect/mcp-http.mjs` runs the same `createInspector` from `mcp-server.mjs`, through
  the new `buildMcpServer`, behind the MCP SDK's `StreamableHTTPServerTransport` on `POST /mcp`. It is
  stateless and replies in JSON. Besides `/mcp` it serves only `GET /healthz` and the RFC 9728 metadata at
  `/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/mcp`.
- `scripts/phoenix-inspect/lib/oauth.mjs` is the token check. It is written on `node:http` and
  `node:crypto`, because `express` and `jose` are not dependencies of the repository root (they belong to
  `infra/phoenix-mcp`'s own lockfile). The SDK's `mcpAuthRouter` is **not** used: that router is an
  authorization server, and this process issues no tokens.
- Every tool stays `readOnlyHint: true`; capture and inspect keep `structuredContent` beside each image.
- `tests/phoenix-inspect-mcp-http.test.ts` covers these refusals:
  - no token: 401 with `WWW-Authenticate: Bearer … resource_metadata=…`;
  - a token for another resource, from another issuer, expired, unsigned or signed with the wrong
    algorithm: 401;
  - no scope, or not the owner: 403;
  - a foreign Host or Origin: 403;
  - a URL in place of a module id, and an extra `url` key, are refused over HTTP and never reach the
    browser (the stdio test covers the rest: unknown persona, unknown tool);
  - one capture at a time and ten tool calls a minute hold across separate HTTP requests;
  - a failed-privacy shot and an over-cap image are never sent;
  - a production target refuses to start.

  The audience, owner, Origin, Host, masked-only, byte-cap and production checks were each broken once
  and the test failed.

**Proof still owed:** the PR's `validate` and `checks`.

## Route C — OpenAI's Secure MCP Tunnel (the route in use) — BUILT, tested on loopback

No hosting, no public address, no paid service. The inspector runs on the owner's laptop on
`127.0.0.1:8797`. OpenAI's `tunnel-client` dials OUT to OpenAI and carries ChatGPT's MCP calls in. The
tunnel's supported shape is the one built here: a **local authorization server on the MCP server's own
loopback origin**. The tunnel forwards protected-resource discovery, registration, the token exchange and
revocation. The browser's sign-in step goes straight to `http://127.0.0.1:8797/authorize` on the same
laptop, and that step is never tunnelled.

- **Sign-in** (`scripts/phoenix-inspect/lib/authorization-server.mjs`, used when
  `PHOENIX_INSPECT_GOOGLE_CLIENT_FILE` is set):
  - Dynamic registration accepts only ChatGPT's redirect addresses, and at most 10 clients.
  - `/authorize` needs PKCE S256 and the scope `phoenix-inspect:read`, then sends the browser to
    Google (`openid email`, its own PKCE, state and nonce).
  - The Google callback checks the id_token: issuer, audience, expiry, nonce, `email_verified`, and
    that the address is the owner's (`PHOENIX_INSPECT_MCP_OWNER_SUBJECTS`). It then answers ChatGPT
    with a one-time code and `iss`.
  - `/token` issues a 1-hour ES256 access token whose audience is the local resource. The refresh token
    rotates on every use, and a replayed refresh token revokes the whole grant.
  - Clients, grants (hashes only) and the signing key live in `%LOCALAPPDATA%\PhoenixInspect\oauth`,
    never in the repository.
- **Tunnel limits:** one page per call, a hard 90-second stop (the browser is closed and the next capture
  waits until it really stopped), one screenshot of at most 6 MB, and the whole result under 9 MB (the
  tunnel's envelope is 10 MiB). Images are dropped, last first, until the result fits.
- **Kill switch:** `connect-chatgpt.ps1 -RevokeAll` (or `node scripts/phoenix-inspect/mcp-http.mjs
  --revoke-all`) stops every token at once, with no restart. The verifier re-reads the state file on
  every call.
- **Launcher:** `scripts/phoenix-inspect/connect-chatgpt.ps1` starts the inspector first, so it never
  inherits the tunnel key. It then decrypts the DPAPI-saved runtime key into the tunnel client's
  environment only, clears it from the shell, and stops both processes together. Port 8787 belongs to
  the Phoenix Attendance Agent and is never used.
- **Proven:** `tests/phoenix-inspect-authorization-server.test.ts` drives the full flow against a fake
  Google, and the owner check, replay revoke and revoked-token check were each broken once to watch it
  fail. `tunnel-client doctor` against the running inspector: `mcp_target` 8797, `mcp_server_reachable`
  PASS, `oauth_metadata` PASS (HTTP 200), RESULT ok.

**What only the owner does:**
1. In Google Cloud, create an OAuth client of type **Desktop app**. Its consent screen stays in
   **Testing**, with his Gmail as the only test user. Download the JSON into `%LOCALAPPDATA%\PhoenixInspect`;
   it never goes in chat or Git.
2. Run `connect-chatgpt.ps1`. On the first run it asks once for the Gmail allowed to sign in.
3. In ChatGPT, add the connector for the tunnel, sign in with Google, and acknowledge ChatGPT's own
   warnings himself.

## Step 1b — The authorization server — BUILT for Route C; an external one is NOT BUILT

For Routes A and B, ChatGPT would need a public server that issues the tokens Step 1 checks:
- RFC 8414 metadata at `/.well-known/oauth-authorization-server` with an exact `issuer` and
  `code_challenge_methods_supported: ["S256"]`;
- authorize and token endpoints;
- a client: a static id, a client-id metadata document, or Dynamic Client Registration;
- the redirect ChatGPT shows;
- short-lived JWT access tokens signed ES256 or RS256, with `aud` equal to `https://<host>/mcp`, scope
  `phoenix-inspect:read`, and `sub` equal to the value in `PHOENIX_INSPECT_MCP_OWNER_SUBJECTS`;
- the public key set, given to the door as `PHOENIX_INSPECT_MCP_JWKS` or `PHOENIX_INSPECT_MCP_JWKS_URL`
  (https, on the issuer's own origin).

`infra/phoenix-mcp/src/oauth.mts` is the nearest existing design. It needs an upstream OpenID provider
(Step 3) and its own state store. Its live Phoenix session check depends on an endpoint that does not
exist. Building it is its own PR and its own decision.

## Step 2A — Railway (if option A)

1. A new service in a **staging** environment, never production, built from a Dockerfile on the
   Playwright image that matches the repo's `playwright` version.
2. Set `RAILWAY_SHM_SIZE_BYTES` (for example 268435456), or launch Chromium with
   `--disable-dev-shm-usage`. One browser, one capture at a time (the server already enforces this).
3. Start command:
   `node scripts/phoenix-inspect/mcp-http.mjs --runner local --host 0.0.0.0 --allow-non-loopback --public-url https://<host>/mcp --trust-proxy --port <PORT>`.
   **The CLI does not read the `PORT` environment variable.** Write the port Railway assigns into
   `--port`, for example through a shell start command. Railway's edge terminates TLS and sends
   `X-Forwarded-Proto: https`, which `--trust-proxy` is there to read.
4. Secrets on the service:
   - `PHOENIX_INSPECT_MCP_OWNER_SUBJECTS` and `PHOENIX_INSPECT_MCP_ISSUER`;
   - `PHOENIX_INSPECT_MCP_JWKS_URL` (or `_JWKS`);
   - `PHOENIX_INSPECT_MCP_CLIENT_ID` and a 32+ character `PHOENIX_INSPECT_MCP_AUDIT_KEY`;
   - the persona passwords file's contents.

   **None in Git** (the repository is public). Never set `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL` or
   the app's auth secret on this service: the door refuses to start beside them.
5. Health: the start line ends `target: staging only`. **Known gap:** the Host and https checks run
   before `/healthz`, so a platform health probe that sends another Host, or plain http, gets 403. Point
   the health check at the public name, or relax `/healthz` in a reviewed change.

**Proof:**
- `curl -i https://<host>/mcp -X POST` → 401 with the `resource_metadata` link;
- `curl https://<host>/.well-known/oauth-protected-resource/mcp` → JSON whose `resource` is
  `https://<host>/mcp`;
- `<issuer>/.well-known/oauth-authorization-server` lists `S256`. That document is served by the
  **authorization server** (Step 1b), not by this door.

## Step 2B — The spare + a named tunnel (if option B)

1. On the spare: `cloudflared tunnel create phoenix-inspect`, a DNS route to a hostname under
   `satopharma.com`, and a config that sends it only to `http://localhost:<port>`.
2. Run on the spare, bound to loopback (the default host), behind the tunnel:
   `node scripts/phoenix-inspect/mcp-http.mjs --runner local --port <port> --public-url https://<hostname>/mcp --trust-proxy`.
   `cloudflared` connects to `localhost`, so no `--allow-non-loopback` is needed. The edge terminates
   TLS; confirm on the first request that `X-Forwarded-Proto` arrives as `https`, or the door answers
   403 `https_required`.
3. **No plain Cloudflare Access policy on `/mcp`, `/.well-known/*` or the OAuth routes.** It answers
   ChatGPT's server-to-server calls with a redirect to a login page, so the plugin fails. The sign-in is
   the server's own OAuth.
4. Never a quick tunnel (`trycloudflare.com`): its address changes on every start, it does not support
   SSE, and it is how the old plugin died.

**Proof:** the same three reads as 2A, against the tunnel hostname.

## Step 3 — Identity provider

Create an OAuth client at the chosen provider, with the **authorization server's** callback (Step 1b) as
its redirect. Put its id, secret and issuer in that server's secrets, not the door's. The policy admits **only** the owner's subject, and the
Phoenix login behind it must still be active.

## Step 4 — Smoke over HTTP — NOT BUILT

`mcp-smoke.mjs` does not yet have `--url`; it speaks stdio only. To build: a Streamable HTTP client with
a token from Steps 1b and 3. Expected:
- 8 tools, all read-only;
- a URL, an unknown persona, an extra key and an unknown tool refused;
- one real capture returns `structuredContent` and a masked image.

Until then, the loopback test (`tests/phoenix-inspect-mcp-http.test.ts`) is the only HTTP proof.

## Step 5 — Optional network allow-list

Allow only OpenAI's published connector ranges (`openai.com/chatgpt-connectors.json`) on `/mcp` and
the OAuth routes. Re-read the list monthly, because it changes.

## Step 6 — Connect ChatGPT (the owner, on the web)

1. chatgpt.com → **Plugins** → **+** → **Add custom MCP server** → **Create as a plugin**.
2. Name: `Phoenix Inspect`. Address: `https://<host>/mcp`. Authentication: **OAuth**.
3. Client id: the static id from Step 1b. If ChatGPT shows its own callback address, copy it into the
   authorization server's allowed redirect, then save.
4. Sign in when ChatGPT opens the identity provider. Only the owner's account is admitted.
5. Uninstall the old **Phoenix Playwright** plugin.

## Step 7 — Prove it in ChatGPT

1. In a new chat: `@Phoenix Inspect list the modules`. This should name KPI Reports and seven personas.
2. `@Phoenix Inspect capture the KPI Reports summary for the CEO on desktop`. This should give one
   shot, its measurements, and its source files.
3. **Image test:** ask what colour the tab strip's active tab is. If the model cannot say, images do not
   reach it on this plan. The text and structured measurements remain the evidence (readiness §2).
4. Ask it to capture a production address. It must refuse.
5. Restart ChatGPT Desktop on Windows and repeat 1. Record whether the plugin appears there.

Record each answer, with the time in Cairo, in a dated section at the end of this file.

## Step 8 — Switching it off

- Route C: `connect-chatgpt.ps1 -RevokeAll` stops every token at once; Ctrl+C in the launcher stops the
  inspector and the tunnel client. Disable the tunnel at platform.openai.com/settings/organization/tunnels.

- Option A: scale the service to zero or delete it. Option B: `cloudflared tunnel delete
  phoenix-inspect` and stop the server.
- Switch the staging personas off ([INSPECTION_PERSONAS.md](INSPECTION_PERSONAS.md), "Switch them off").
- Remove the plugin in ChatGPT.
