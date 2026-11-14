# Phoenix Inspect — the interface for ChatGPT (and any MCP client)

What the owner asked for: tell ChatGPT "open KPI Reports in Phoenix, visit every page and state, take
full-page screenshots, understand every component and its code, then prepare an exact premium-polish
plan". This file says what exists, what is safe about it, what is still missing for ChatGPT itself, and
what each missing piece would cost.

## 1. Readiness

| Piece | Implemented | Tested here | Deployed | Usable from ChatGPT |
| --- | --- | --- | --- | --- |
| Visual explorer (`scripts/phoenix-inspect/explore.mjs`) | yes | yes — on the spare laptop against staging (see `KPI_REPORTS_VISUAL_AUDIT.md`) | runs on the spare, on demand | no |
| Browser self-check (`self-check.mjs`) | yes | yes — 31 of 31 checks on the spare | — | — |
| Local MCP server (`mcp-server.mjs`, stdio) | yes — capture and inspect also return `structuredContent` (plain JSON) beside the text, which ChatGPT's apps read | yes — unit test with a fake runner (`tests/phoenix-inspect-mcp.test.ts`, including the `structuredContent` shape) and a real stdio client (`mcp-smoke.mjs`, 14/14) | no (a local process) | **no — ChatGPT cannot start a local process** |
| Streamable HTTP door with token checks (`mcp-http.mjs`, `lib/oauth.mjs`; section 4) | yes — the resource-server half only: it checks tokens, it does not issue them | yes — `tests/phoenix-inspect-mcp-http.test.ts` on an ephemeral 127.0.0.1 port with a fake runner and the SDK's own HTTP client; the real CLI started once on loopback (401 with no token, 8 tools for the owner) | no | no |
| Authorization server that issues the tokens ChatGPT presents | **no** | no | no | no |
| Component map, audit, polish plan, second-stage prompt | yes (`docs/phoenix-intelligence/`) | read by the tools | in Git | through the tools, once remote |

**Nothing here is connected to ChatGPT yet.** ChatGPT's custom MCP plugins take an HTTPS address. This
branch ships the local server and the HTTP door that checks every token, tested on this laptop only. The
authorization server, the hosting and the public HTTPS name are not built, and come back to the owner as a
decision. What ChatGPT requires, what already exists, and the two hosting choices are in
[CHATGPT_MCP_CONNECTION_READINESS.md](CHATGPT_MCP_CONNECTION_READINESS.md); the steps once he chooses are
in [CHATGPT_MCP_DEPLOYMENT_RUNBOOK.md](CHATGPT_MCP_DEPLOYMENT_RUNBOOK.md).

## 2. The tools

Eight tools. Every input is an id from the module spec (`scripts/phoenix-inspect/modules/kpis.mjs`); the
schemas say `additionalProperties: false`, and `validateToolInput` refuses anything else again on the
server side.

| Tool | Inputs | Returns |
| --- | --- | --- |
| `phoenix_list_portals_and_modules` | none | the portals (admin, HR, employee portal) with pages and roles from `route-inventory.json`; the modules the explorer can capture |
| `phoenix_list_module_pages` | `module` | every state (tab, report, filter, sort, period, drill-down, click, keyboard, mocked loading/error) with its address per board, the personas, and the controls never touched |
| `phoenix_open_module` | `module`, `persona` | the landing page at desktop: masked screenshot, measurements |
| `phoenix_capture_page` | `module`, `persona`, `states[]`, `viewports[]` | a run of up to 40 shots: per-shot outcome, measurements, source candidates; up to 4 masked images inline |
| `phoenix_inspect_ui_state` | `module`, `persona`, `state`, `viewport` | one shot in depth: every measurement, the masked accessibility snapshot, the source files its visible text comes from, stopped writes, console errors, the image |
| `phoenix_get_component_map` | `module` | `KPI_REPORTS_COMPONENT_MAP.md` |
| `phoenix_get_visual_audit` | `module`, `runId?` | `KPI_REPORTS_VISUAL_AUDIT.md`, and a run's totals and measurements |
| `phoenix_get_implementation_plan` | `module` | `KPI_REPORTS_PREMIUM_POLISH_PLAN.md` and `SECOND_STAGE_PROMPT.md` |

Personas: `ceo`, `sfe`, `hrr`, `nsm`, `dm`, `rep`, `emp` ([INSPECTION_PERSONAS.md](INSPECTION_PERSONAS.md)).
Viewports: `desktop` 1440×900, `tablet` 768×1024, `mobile` 390×844.

## 3. Why it is safe to hand to a model

The kickoff's line: "Never expose an unrestricted browser/JavaScript/SQL execution endpoint to ChatGPT.
Never expose secrets or unredacted screenshots."

- **No free input.** There is no URL, selector, script, SQL or text field anywhere. A model can only
  pick among states a human reviewed. (`tests/phoenix-inspect-mcp.test.ts`, `-safety.test.ts`)
- **Staging only.** The production host is refused as a target and refused by the fence by any method.
- **Read-only browsing.** The browser contexts send GET and HEAD to staging and nothing else: no POST,
  no Server Action, no beacon, no form post, no other origin, never the export, sign-out, cron or a
  webhook, even as a GET. A stopped write is answered as if it succeeded, so the page carries on; the
  run lists every stopped write. The one non-GET is each persona's sign-in, from a separate context.
  (`lib/fence.mjs`; self-check: "the server received no request other than GET")
- **No click that changes anything.** Controls are refused by name (approve, send, save, delete,
  export, download, submit, …), by type (submit buttons, typing fields), by target (downloads, other
  origins, API addresses) and by the module's never-touch list.
- **Masked pictures only.** Every visible string is masked character for character before the
  screenshot, except text that appears verbatim in the module's reviewed source files; pictures are
  hidden; a second, independent pass checks the page and the accessibility snapshot (including link
  addresses) and deletes the shot on any finding. (`lib/redact.mjs`)
- **Bounded.** One capture at a time, 10 calls a minute, 40 pages and 10 minutes per call, 160 pages and
  45 minutes per run, a fresh browser per call.
- **Audited.** `artifacts/phoenix-inspection/mcp-audit.jsonl`: time (Cairo), tool, the validated ids,
  outcome, duration. A refused call's input is never written.
- **Passwords never travel.** The personas' passwords exist only on the machine that runs the browser.

What the fence cannot stop: a write the SERVER makes while answering a GET (a "last seen" stamp, an
audit row of a page view). That is why the target is staging with staging-only logins.

## 4. The remote endpoint ChatGPT needs (the door is built; the authorization server, hosting and TLS are not)

ChatGPT's custom MCP plugins speak Streamable HTTP over HTTPS, with OAuth.

1. **Transport — built, not deployed.** `scripts/phoenix-inspect/mcp-http.mjs` serves the same eight
   tools on `POST /mcp` through the MCP SDK's `StreamableHTTPServerTransport` (stateless, JSON replies),
   over one shared inspector, so one capture at a time and 10 calls a minute still hold.
2. **Token checks — built, not deployed.** `lib/oauth.mjs` is the resource-server half of the MCP
   authorization spec:
   - RFC 9728 metadata at `/.well-known/oauth-protected-resource/mcp`;
   - 401 with `WWW-Authenticate: Bearer … resource_metadata="…"`;
   - a JWT check: ES256/RS256 public keys only, exact issuer, audience equal to this server's `/mcp`
     address, expiry and at most one hour of life, scope `phoenix-inspect:read`;
   - 403 for any subject but the owner's, which comes from an environment variable and never from Git.

   It refuses to start against the production host, checks Host and Origin on every request, binds
   127.0.0.1 unless told otherwise, and writes `artifacts/phoenix-inspection/mcp-http-audit.jsonl` with a
   keyed hash of the subject and never a token. Not "Authorization: None": that is what made the old
   "Phoenix Playwright" plugin dangerous (CONNECTION_DIAGNOSTICS.md §1).
3. **Sign-in that issues the tokens — not built.** ChatGPT needs an authorization server: S256 PKCE,
   RFC 8414 metadata, authorize and token endpoints, a client id, and a published key set.
   `infra/phoenix-mcp`'s owner-only OAuth (`src/oauth.mts`, `src/policy.mts`) is the nearest design. Its
   live Phoenix role and session check is not part of the door. Details:
   [CHATGPT_MCP_CONNECTION_READINESS.md](CHATGPT_MCP_CONNECTION_READINESS.md) §3.
4. **Where the browser runs** — two options:

| | A. A staging-only Railway service | B. The spare laptop behind a named Cloudflare Tunnel |
| --- | --- | --- |
| What runs | a container with Chromium (Playwright image), the tools and OAuth; persona passwords as service secrets | the spare runs the server; a named tunnel (not a quick tunnel) gives it a fixed HTTPS name; OAuth in front |
| Reaches | staging only | staging only |
| Up when | always | only while the spare is on and on the home network |
| Cost | about **US$5–12 a month** (estimate: Chromium needs ~1 GB while capturing and ~0.2 GB idle; Railway lists $10/GB-month RAM, $20/vCPU-month, $0.15/GB-month volume) | **$0** extra (Cloudflare's free tunnel) |
| Risk | a new production-grade service to keep patched | the home network gets an inbound path; the spare also runs the dev server and tests |

5. **Connecting it** (RUNBOOK.md, "Exact ChatGPT connection procedure"): in ChatGPT on the web, **Plugins
   → + → Add custom MCP server**, a name, the HTTPS address, OAuth with the registered callback; then
   check it appears in ChatGPT Desktop on Windows before calling it "available in ChatGPT".

Building, deploying and connecting are each a separate step with a price, and come back to the owner as
one decision.

## 5. Using it locally today

Any MCP client that can start a local process (Claude Desktop, Claude Code, Codex) can use it now. From
the repository root of a checkout on this laptop:

```json
{
  "mcpServers": {
    "phoenix-inspect": {
      "command": "node",
      "args": ["scripts/phoenix-inspect/mcp-server.mjs", "--runner", "spare"]
    }
  }
}
```

`--runner spare` sends every capture to the spare laptop (`on-spare.ps1`), so this laptop starts no
browser; `--runner local` runs the browser where the server runs (the spare itself). To check it end to
end: `node scripts/phoenix-inspect/mcp-smoke.mjs` (lists the tools, reads the module pages, and proves
a URL and an unknown persona are refused; `--capture` adds one real capture through the spare).

**The HTTP door, on loopback only.** It needs an issuer and its public keys; until the authorization server
exists, a test can use a throwaway key pair and made-up values. In PowerShell:

```powershell
$env:PHOENIX_INSPECT_MCP_OWNER_SUBJECTS = 'owner-subject-0001'
$env:PHOENIX_INSPECT_MCP_ISSUER = 'https://auth.example.test'
$env:PHOENIX_INSPECT_MCP_JWKS = '{"keys":[ ...the PUBLIC key only... ]}'
node scripts/phoenix-inspect/mcp-http.mjs --runner spare --port 8787
```

It answers on `http://127.0.0.1:8787/mcp` and nowhere else. A bare start with no owner subject exits 1;
an unknown flag exits 2. `tests/phoenix-inspect-mcp-http.test.ts` is the end-to-end check.

## 6. Clean-up the owner should do in ChatGPT

- **Uninstall the "Phoenix Playwright" plugin.** Its tunnel is gone, it had no sign-in, and it offered a
  tool that runs any JavaScript in a browser (CONNECTION_DIAGNOSTICS.md §1).
- **Reconnect the GitHub connector** with an account that GitHub serves and that belongs to the
  `sato-pharma` organization (CONNECTION_DIAGNOSTICS.md §2).
