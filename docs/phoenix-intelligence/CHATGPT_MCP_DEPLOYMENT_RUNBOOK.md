# ChatGPT ⇄ Phoenix Inspect — deployment runbook

**Nothing here has been run.** Each step that deploys, exposes or spends needs the owner's decision
first ([CHATGPT_MCP_CONNECTION_READINESS.md](CHATGPT_MCP_CONNECTION_READINESS.md) §5). The steps are written so the
session that builds it can follow them in order and prove each one before the next.

Target: **staging only**, always. The production host is refused by the explorer itself.

## Step 0 — Preconditions

- [ ] This branch's PR is merged (the tools, tests and docs are on `main`).
- [ ] The owner chose option A (Railway) or B (spare + named tunnel), and the identity provider.
- [ ] The staging personas exist and are switched on ([INSPECTION_PERSONAS.md](INSPECTION_PERSONAS.md)).
      Their passwords are generated where the browser will run, never in chat or Git.

## Step 1 — Give the tools an HTTP door (code, one PR)

1. Add `scripts/phoenix-inspect/mcp-http.mjs`: the same `createInspector` from `mcp-server.mjs` behind
   the MCP SDK's `StreamableHTTPServerTransport` on `POST /mcp`. Nothing else is served except the
   OAuth routes and `GET /healthz`.
2. Put `requireBearerAuth` (resource-metadata link in the 401) on `/mcp` and serve both metadata
   documents with `mcpAuthRouter`, reusing `infra/phoenix-mcp/src/oauth.mts` and `policy.mts`. Advertise
   `S256`, check `resource` = this server's address, one static client id, one redirect.
3. Keep every tool `readOnlyHint: true`. Keep `structuredContent` beside each image.
4. Tests: a request without a token gets 401 with `WWW-Authenticate: Bearer resource_metadata=…`. A
   token for another `resource` is refused. Every refusal the stdio test proves is also refused over
   HTTP. Prove each by breaking it.

**Proof:** the PR's `validate` and `checks`.

## Step 2A — Railway (if option A)

1. A new service in a **staging** environment, never production, built from a Dockerfile on the
   Playwright image that matches the repo's `playwright` version.
2. Set `RAILWAY_SHM_SIZE_BYTES` (for example 268435456), or launch Chromium with
   `--disable-dev-shm-usage`. One browser, one capture at a time (the server already enforces this).
3. Secrets on the service: the persona passwords file's contents, the OAuth signing key and client id,
   the identity provider's client. **None in Git.**
4. Health: `GET /healthz` 200, and a log line `target: staging only`.

**Proof:** `curl -i https://<service>/mcp` → 401 with the metadata link;
`curl https://<service>/.well-known/oauth-protected-resource` → JSON whose `resource` is the service
address; `.../.well-known/oauth-authorization-server` lists `S256`.

## Step 2B — The spare + a named tunnel (if option B)

1. On the spare: `cloudflared tunnel create phoenix-inspect`, a DNS route to a hostname under
   `satopharma.com`, and a config that sends it only to `http://localhost:<port>`.
2. Run `node scripts/phoenix-inspect/mcp-http.mjs --runner local` on the spare.
3. **No plain Cloudflare Access policy on `/mcp`, `/.well-known/*` or the OAuth routes.** It answers
   ChatGPT's server-to-server calls with a redirect to a login page, so the plugin fails. The sign-in is
   the server's own OAuth.
4. Never a quick tunnel (`trycloudflare.com`): its address changes on every start, it does not support
   SSE, and it is how the old plugin died.

**Proof:** the same three `curl` reads as 2A, against the tunnel hostname.

## Step 3 — Identity provider

Create an OAuth client at the chosen provider, with the server's `/callback` as its redirect. Put its
id, secret and issuer in the service secrets. The policy admits **only** the owner's subject, and the
Phoenix login behind it must still be active.

## Step 4 — Smoke over HTTP

`mcp-smoke.mjs` gains `--url` (Streamable HTTP client with a token from step 3). Expected: 8 tools, all
read-only; a URL, an unknown persona, an extra key and an unknown tool refused; one real capture
returns `structuredContent` and a masked image.

## Step 5 — Optional network allow-list

Allow only OpenAI's published connector ranges (`openai.com/chatgpt-connectors.json`) on `/mcp` and
the OAuth routes. Re-read the list monthly, because it changes.

## Step 6 — Connect ChatGPT (the owner, on the web)

1. chatgpt.com → **Plugins** → **+** → **Add custom MCP server** → **Create as a plugin**.
2. Name: `Phoenix Inspect`. Address: `https://<host>/mcp`. Authentication: **OAuth**.
3. Client id: the static id from step 1. If ChatGPT shows its own callback address, copy it into the
   server's allowed redirect, then save.
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

- Option A: scale the service to zero or delete it. Option B: `cloudflared tunnel delete
  phoenix-inspect` and stop the server.
- Switch the staging personas off ([INSPECTION_PERSONAS.md](INSPECTION_PERSONAS.md), "Switch them off").
- Remove the plugin in ChatGPT.
