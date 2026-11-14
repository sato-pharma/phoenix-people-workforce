# ChatGPT ⇄ Phoenix Inspect — connection readiness

Read on 14 Nov 2026 (Cairo). The question this file answers: **what stands between the tools in this
branch and the owner typing "@Phoenix Inspect, open KPI Reports…" in ChatGPT, and what each step
costs.** The design and the tool list are in [CHATGPT_INTERFACE.md](CHATGPT_INTERFACE.md). The steps are
in [CHATGPT_MCP_DEPLOYMENT_RUNBOOK.md](CHATGPT_MCP_DEPLOYMENT_RUNBOOK.md).

## 1. Verdict

| Layer | State | Proof |
| --- | --- | --- |
| The eight tools, ids-only inputs, masked images, audit log | **ready** | `tests/phoenix-inspect-mcp.test.ts`; `mcp-smoke.mjs` 14/14 over a real stdio client |
| All eight tools marked read-only (`readOnlyHint: true`) | **ready** | `mcp-server.mjs` `toolDefinitions`; ChatGPT treats a tool without it as a write and asks for confirmation every time |
| Capture replies carry their measurements as `structuredContent` beside the text, not only the image | **ready** (added in this branch) | the MCP test's two `structuredContent` assertions, each proved by removing the field and watching it fire |
| A public HTTPS address speaking Streamable HTTP | **not built** | the server is stdio only; ChatGPT cannot reach a local process or a private network |
| OAuth that ChatGPT accepts, admitting only the owner | **designed, in another service** | `infra/phoenix-mcp` has it (below); not yet in front of these tools |
| Somewhere the browser runs, always on | **not decided** | two options in section 4 |
| Connected in ChatGPT | **no** | — |
| Works in ChatGPT Desktop on Windows | **not verified** | the app is installed (`OpenAI.ChatGPT-Desktop 1.2026.190.0`); OpenAI documents adding servers on the web only |

**Nothing is reachable from ChatGPT today, and nothing in this branch deploys or exposes anything.**

## 2. What ChatGPT requires (sources dated)

| Requirement | Detail | Source |
| --- | --- | --- |
| Where to add it | chatgpt.com → **Plugins** → **+** → **Add custom MCP server** → **Create as a plugin**, then call it with "@" | OpenAI developer guide "custom MCP server" (undated, read 14 Nov 2026); mcp.so guide (15 Oct 2026) |
| Plan | OpenAI's pages disagree: the developer docs list Plus, Pro, Business, Enterprise and Edu; a help-centre article quoted by others limits full MCP to Business and Enterprise/Edu. **The owner's own earlier development plugin is the live proof that his account can add one.** On Business and Enterprise an admin must allow it. | coworker.ai (15 Oct 2026); CONNECTION_DIAGNOSTICS.md §1 |
| Transport | Streamable HTTP or SSE over public HTTPS; localhost and private networks are not reachable | OpenAI Apps SDK "connect ChatGPT" (undated) |
| Sign-in | OAuth 2.1 authorization code with **PKCE S256** (the server's metadata must list S256). Client id: a static id the owner types in, else a client-id metadata document, else Dynamic Client Registration (optional). Protected-resource metadata (RFC 9728) and authorization-server metadata (RFC 8414) with an exact `issuer`; ChatGPT sends `resource`, which should become the token's audience. | OpenAI "plugins / auth" (undated; cites the MCP spec of 28 Jul 2026) |
| Redirect | `https://chatgpt.com/connector_platform_oauth_redirect` if the server supports the RFC 9207 `iss` response parameter, else `https://chatgpt.com/connector/oauth/{callback_id}` shown in ChatGPT's form | same |
| Images | **Not guaranteed to reach the model.** OpenAI support (22 Apr 2026): connector output "should not currently be treated as a guaranteed path to model-visible vision input"; Plus users on the web report "Image output is not supported" since 18 Sep 2026 | community.openai.com threads 1375446, 1399319, 1399928 |
| Writes | ChatGPT honours `readOnlyHint`; any other tool is confirmed by the user, once per conversation | OpenAI custom MCP guide |
| Windows desktop | add on the web, then restart the desktop app (third-party guides); not documented by OpenAI | hjarni.com, gradually.ai (2026) |

**Consequence of the image limit:** a capture through ChatGPT will be judged on the text and structured
measurements (overflow, radius, ellipsis, contrast, tap targets, source files) more reliably than on the
picture. The tools already return both. Whether the owner's ChatGPT shows the model the masked image is
the first thing to test once connected (runbook step 7).

## 3. Sign-in: what already exists

`infra/phoenix-mcp` (built 11–12 Oct 2026, never deployed) has the OAuth that ChatGPT needs. It is
the MCP SDK's `mcpAuthRouter`, which serves both well-known metadata documents and advertises S256. It
also has:
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
