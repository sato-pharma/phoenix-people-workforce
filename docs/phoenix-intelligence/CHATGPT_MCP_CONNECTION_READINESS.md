# ChatGPT ⇄ Phoenix Inspect — connection readiness

Read on 14 Nov 2026 (Cairo). The question this file answers: **what stands between the tools in this
branch and the owner typing "@Phoenix Inspect, open KPI Reports…" in ChatGPT, and what each step
costs.** The design and the tool list are in [CHATGPT_INTERFACE.md](CHATGPT_INTERFACE.md). The steps are
in [CHATGPT_MCP_DEPLOYMENT_RUNBOOK.md](CHATGPT_MCP_DEPLOYMENT_RUNBOOK.md).

## 1. Verdict

| Layer | Implemented | Tested locally | Deployed | Available in ChatGPT |
| --- | --- | --- | --- | --- |
| The eight tools: ids-only inputs, masked images, audit log, all `readOnlyHint: true` | yes | yes. `tests/phoenix-inspect-mcp.test.ts`, and `mcp-smoke.mjs` 14 of 14 over a real stdio client | no | no |
| Capture and inspect replies carry their measurements as `structuredContent` beside the text | yes | yes. Assertions in both MCP tests | no | no |
| **Streamable HTTP door** (`scripts/phoenix-inspect/mcp-http.mjs`): `POST /mcp`, stateless, the SDK's `StreamableHTTPServerTransport`, the same eight tools through `buildMcpServer` | yes | yes. `tests/phoenix-inspect-mcp-http.test.ts`, on an ephemeral 127.0.0.1 port with a fake runner and the SDK's own HTTP client. The real CLI was also started on loopback: 401 with no token, 8 tools with an owner token | no | no |
| **OAuth resource server:** RFC 9728 metadata; 401 + `WWW-Authenticate: Bearer … resource_metadata="…"`; JWT checks (signature ES256/RS256, issuer, audience = this server's resource URL, expiry, lifetime ≤ 1 h, scope `phoenix-inspect:read`); 403 for anyone but the owner | yes (`lib/oauth.mjs`) | yes. Each refusal is asserted. The audience, owner, Origin, Host, masked-only, byte-cap and production checks were each broken once to watch the test fail | no | no |
| Owner-only: the admitted subject(s) come from `PHOENIX_INSPECT_MCP_OWNER_SUBJECTS`, never from Git | yes | yes | no | no |
| Staging only: refuses to start when the target is the production host | yes | yes | no | no |
| DNS rebinding: Host (port-agnostic) and Origin (exact) checked on every route | yes | yes | no | no |
| HTTPS: binds 127.0.0.1 by default. A public name needs `--public-url https://…/mcp` and `--trust-proxy`, and must arrive as https through that proxy. Metadata never takes its address from a request header | yes | yes, on loopback only | no | no |
| Masked image blocks: only a shot marked `captured`, only a PNG under `shots/`, at most 4 images and 8 MB per result | yes | yes | no | no |
| Audit: one line per HTTP request, with a keyed hash of the subject. Never a token, header or raw subject | yes | yes | no | no |
| **Authorization server** (issues the tokens ChatGPT presents): built in, loopback-only, Google proves the owner; DCR for ChatGPT's redirects only, PKCE S256, refresh rotation with replay revoke, kill switch | yes (`lib/authorization-server.mjs`, for the Secure MCP Tunnel route) | yes. `tests/phoenix-inspect-authorization-server.test.ts` against a fake Google; three guards broken once each to watch it fail; `tunnel-client doctor` RESULT ok against the running inspector | no | no |
| Somewhere the browser runs: the owner's laptop, reached through OpenAI's Secure MCP Tunnel (`scripts/phoenix-inspect/connect-chatgpt.ps1`), so no hosting and no TLS of our own | yes | the launcher's config check only; the tunnel has not carried a real call yet (it waits for his Google client) | no | no |
| Works in ChatGPT Desktop on Windows | n/a | no | no | **unconfirmed** (section 2) |

**Nothing is reachable from ChatGPT today, and nothing in this branch deploys or exposes anything.**

## 2. What ChatGPT requires (sources dated)

| Requirement | Detail | Source |
| --- | --- | --- |
| Where to add it | chatgpt.com → **Plugins** → **+** → **Add custom MCP server** → **Create as a plugin**, then call it with "@" | OpenAI developer guide "custom MCP server" (undated, read 14 Nov 2026); mcp.so guide (15 Oct 2026) |
| Plan | OpenAI's pages disagree: the developer docs list Plus, Pro, Business, Enterprise and Edu; a help-centre article quoted by others limits full MCP to Business and Enterprise/Edu. **The owner's own earlier development plugin is the live proof that his account can add one.** On Business and Enterprise an admin must allow it. | coworker.ai (15 Oct 2026); CONNECTION_DIAGNOSTICS.md §1 |
| Transport | Streamable HTTP or SSE over public HTTPS; localhost and private networks are not reachable | OpenAI Apps SDK "connect ChatGPT" (undated) |
| Sign-in | OAuth 2.1 authorization code with **PKCE S256** (the server's metadata must list S256). Client id: a static id the owner types in, else a client-id metadata document, else Dynamic Client Registration (optional). Protected-resource metadata (RFC 9728) and authorization-server metadata (RFC 8414) with an exact `issuer`; ChatGPT sends `resource`, which should become the token's audience. | OpenAI "plugins / auth" (undated; cites the MCP spec of 28 Jul 2026) |
| Redirect | `https://chatgpt.com/connector_platform_oauth_redirect` if the server supports the RFC 9207 `iss` response parameter, else `https://chatgpt.com/connector/oauth/{callback_id}` shown in ChatGPT's form | same |
| Images | **Not documented as reaching the model.** The Apps SDK reference says `content` and `structuredContent` are "Surfaced to the model and the component" but never names an image block; its only documented image route is a widget's `imageIds`. An OpenAI_Support reply on the forum (22 Apr 2026) says MCP image output "should not currently be treated as a guaranteed" route to vision and recommends text or `structuredContent` (paraphrased: the post wraps its last words in quotation marks of its own). Whether that reply is marked as the accepted answer was not confirmed. One Plus user on ChatGPT web "Code Mode" reported image output failing from 18 Sep 2026 (posted 20 Sep 2026; OpenAI has not confirmed it). Thread 1399928 (22 Sep 2026) is about what the **user** sees, not the model. | developers.openai.com/apps-sdk/reference and /apps-sdk/plan/components (undated, read 14 Nov 2026); community.openai.com/t/1375446, /1399319, /1399928 |
| Writes | ChatGPT honours `readOnlyHint`; any other tool is confirmed by the user, once per conversation | OpenAI custom MCP guide |
| Windows desktop | **Unconfirmed.** OpenAI's custom-MCP guide says to "Use ChatGPT on the web" and does not mention Windows; its help-centre articles refused an automated read (403). Third parties disagree: one says the desktop app can add a server, one says servers are created on the web and then appear in the desktop app (checked Jul 2026), one says the desktop MCP settings belong to Codex (21 Oct 2026). A forum thread of 11 Nov 2026 shows a connector offering "Open in the desktop app". | developers.openai.com/api/docs/guides/custom-mcp-server (undated, read 14 Nov 2026); crosstrade.io; hjarni.com; tokenrip.com; community.openai.com/t/1415141 |

**Consequence of the image limit:** a capture through ChatGPT will be judged on the text and structured
measurements (overflow, radius, ellipsis, contrast, tap targets, source files) more reliably than on the
picture. The tools already return both. Whether the owner's ChatGPT shows the model the masked image is
the first thing to test once connected (runbook step 7).

## 3. Sign-in: what is built, what was ported, what is missing

**Built in this branch: the resource-server half.** `scripts/phoenix-inspect/mcp-http.mjs` and
`scripts/phoenix-inspect/lib/oauth.mjs` check every token ChatGPT would present. Nothing is imported from
`infra/phoenix-mcp`. These pieces were ported into plain `.mjs`, and each file's header names its source:

| Piece | Ported from |
| --- | --- |
| HTTPS-only URL with no credentials, query or fragment; refusal to start beside a privileged key | `infra/phoenix-mcp/src/config.mts` |
| RFC 9728 metadata address and document; `WWW-Authenticate` challenge with `resource_metadata` | the MCP SDK's `getOAuthProtectedResourceMetadataUrl`, `requireBearerAuth` and `mcpAuthRouter`, as `infra/phoenix-mcp/src/server.mts` wires them; written without express |
| Exact resource match; every token's audience must be this server's resource URL | `infra/phoenix-mcp/src/oauth.mts` (it binds every grant to `resource`) |
| JWT checks: exact issuer and audience, RS256/ES256 only, required `sub`/`exp`/`iat`, the client pin, a bounded token age, a JWKS address on the issuer's own https origin with a 5 s timeout | `infra/phoenix-mcp/src/oauth.mts` `createIdentityProvider`, re-implemented with Node's own `crypto` (no `jose`) |
| Owner only: admit exactly the configured subject(s); a role or name inside the token never widens it | `infra/phoenix-mcp/src/policy.mts` `Authorizer.verify` |
| 120 requests a minute with `Retry-After: 60`, no trust in forwarded addresses, 16 KB body, exact Origin, Host check | `infra/phoenix-mcp/src/server.mts` (Host as the SDK's `hostHeaderValidation`) |

New here: the subject list comes from the environment rather than a database row; the keyed hash of the
subject in the audit line; the masked-image rules; the staging-only start check (`lib/safety.mjs`,
`lib/fence.mjs`).

**Not ported, deliberately:** the authorization-server half of `oauth.mts` (authorize, the upstream OpenID
callback, the consent page, token, refresh rotation, revoke), its SQLite state store (`state.mts`) and the
live Phoenix role and session check (`live-authorization.mts`). The SDK's `mcpAuthRouter` needs express,
which is not a root dependency.

**Still missing before ChatGPT could connect:**
1. **An authorization server ChatGPT accepts:** RFC 8414 metadata listing S256, authorize and token
   endpoints, a client (a static id, a client-id metadata document, or Dynamic Client Registration),
   short-lived JWT access tokens with `aud` equal to this server's `/mcp` URL and scope
   `phoenix-inspect:read`, and a published JWKS. `infra/phoenix-mcp` is the nearest existing design.
2. **An identity provider** for the owner's sign-in, behind that authorization server.
3. **No live Phoenix check at call time.** A token stays good until it expires (at most one hour), even
   if his Phoenix access changes. The admitted subject is a fixed list in a service secret.
4. **Hosting, TLS and a public name** (section 4). The server must run behind an HTTPS proxy with
   `--trust-proxy --public-url https://<name>/mcp`.
5. **The ChatGPT side:** adding the plugin and signing in once (section 5).

`infra/phoenix-mcp` (built 11–12 Oct 2026, never deployed) has the authorization-server half. It is the
MCP SDK's `mcpAuthRouter`, which serves both well-known metadata documents and advertises S256. It also
has:
- one static client id with one registered redirect (`src/oauth.mts`), which fits ChatGPT's "static id
  you enter" path;
- a `resource` check that refuses a token meant for another server;
- `requireBearerAuth` on `/mcp` with the resource-metadata link in the 401;
- an upstream OpenID identity provider, plus a policy that admits only a subject whose Phoenix login, role
  (Super Admin or CEO) and session version still match (`src/policy.mts`, `src/live-authorization.mts`).

Its own suite passed 31/31 on synthetic databases (`infra/phoenix-mcp/VERIFICATION.md`).

Gaps for Phoenix Inspect (to build, not built):
1. It serves five **data** tools; the inspect tools would be a second server, or a second tool set behind the
   same sign-in. Mixing them is not recommended: the data service reads production, and the inspector
   must reach staging only.
2. RFC 9207 `iss` support is not visible in its code, so ChatGPT would use the per-plugin callback
   address. That works; it only means the redirect is copied from ChatGPT's form into the service's
   configuration.
3. Its identity provider is not chosen or configured (`PHOENIX_MCP_OIDC_*` are unset anywhere).

## 4. Where the browser runs — the decision

| | A. Railway service (staging-only) | B. The spare laptop behind a named Cloudflare Tunnel |
| --- | --- | --- |
| What runs | one container with Chromium, the tools and OAuth; the persona passwords as service secrets | the spare runs the server with `--runner local`; a named tunnel gives it a fixed HTTPS name |
| Always on | yes | only while the spare is awake and on the home network (it went dark for an hour on 14 Nov) |
| Cost | Railway charges $10 per GB-month of RAM and $20 per vCPU-month, billed by the minute. One Chromium at low concurrency holding ~0.5–1 GB is about **US$5–12 a month** on the Hobby plan ($5 a month including $5 of usage). This is an estimate: Chromium's memory on Railway is not measured. | **$0** for the tunnel (named-tunnel hostname routing is free on Cloudflare One; it needs a domain on Cloudflare: `satopharma.com`'s name servers are Cloudflare's, read 14 Nov 2026, though the production record itself is deliberately unproxied since 31 Oct) |
| Known traps | `/dev/shm` defaults to 64 MB (`RAILWAY_SHM_SIZE_BYTES`, or Chromium's `--disable-dev-shm-usage`); a host process limit near 1,000 crashed a 40-context pool (Railway forum, 24 Mar 2026); one open report of Chromium failing to start (8 Jul 2026) | a **plain Cloudflare Access policy breaks ChatGPT**: it answers a server-to-server call with a 302 to a login page. Access "Managed OAuth" (beta, 14 Apr 2026) replaces our own OAuth and is not proven with ChatGPT. The home network gets an inbound path. |
| Recommended | **Yes**, if he wants it usable at any hour | Only for a one-evening trial |

Either option reaches **staging only**: the explorer refuses the production host (`lib/safety.mjs`,
`lib/fence.mjs`). Optionally, the endpoint can allow only OpenAI's published connector address ranges
(`openai.com/chatgpt-connectors.json`).

## 5. What the owner does, and only he can

1. **Choose A or B** (and, for A, approve a monthly Railway cost: money is decided on its own screen,
   not in chat).
2. **Choose the identity provider** for the OAuth sign-in (for example his Google account), and create
   its client. This needs his account.
3. **Add the plugin in ChatGPT on the web** (runbook step 6) and approve its first sign-in himself.
4. **Uninstall the old "Phoenix Playwright" plugin** and **reconnect the GitHub connector** with an
   account in the `sato-pharma` organization ([CONNECTION_DIAGNOSTICS.md](CONNECTION_DIAGNOSTICS.md)).
