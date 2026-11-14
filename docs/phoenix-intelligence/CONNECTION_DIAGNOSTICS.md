# Phoenix Visual Intelligence — connection diagnostics

Read on 14 Nov 2026 (Cairo). Every finding below has its command and the answer it gave, so it can be
re-run. Nothing was changed in ChatGPT, GitHub, Railway or either database while reading these.

## Summary

| Connection | State | Cause | Remedy |
| --- | --- | --- | --- |
| ChatGPT plugin "Phoenix Playwright" | **Dead** | It points at a Cloudflare *quick tunnel* whose name no longer exists (DNS: non-existent domain). Quick-tunnel names live only as long as the process that opened them. | **Do not revive it.** It was an unauthenticated, public, unrestricted browser (see below). Uninstall it in ChatGPT and replace it with the focused, read-only tools in [CHATGPT_INTERFACE.md](CHATGPT_INTERFACE.md). |
| ChatGPT GitHub connector | **403 "account suspended"** | The connector is linked to a GitHub account that GitHub no longer serves. `it-gawish-hr` answers 404 on GitHub's public API (a suspended or removed account). The repository moved to the `sato-pharma` organisation. | In ChatGPT, disconnect GitHub and connect it again signed in as the account that administers `sato-pharma` (this laptop's `gh` is signed in as it). Then grant the ChatGPT GitHub app access to `sato-pharma/phoenix-people-workforce`. Never work around the suspension. |
| `infra/phoenix-mcp` (PR #5748) | **Built, never deployed** | No `phoenix-mcp` service exists in `.railway/railway.ts`. Its README says "NOT production ready or connected", and its release gates are in `SECURITY.md` and `RUNBOOK.md`. | Unchanged by this work. It is a data reader with no browser tools. Its owner-only OAuth layer is the model for the visual tools' remote form. |
| Staging app | **Up, on the live version** | `/api/healthz` revision `fb27d6a8c` on both staging and production. | Used for the KPIs explorer (the owner's choice, 14 Nov 2026). |

## 1. "Phoenix Playwright" in ChatGPT

Read from ChatGPT → Plugins → Phoenix Playwright → Settings (read only):

| Field | Value |
| --- | --- |
| Connected on | 19 Jul 2026 |
| URL | `https://wheel-record-pacific-bestsellers.trycloudflare.com/mcp` |
| Authorization supported / used | **None / None** |
| Safety scan | **Warning** |
| Review status | DEVELOPMENT (a personal plugin) |
| Tools | 24: 17 "write" (including `browser_evaluate`, "Run a Playwright code snippet. Unsafe: executes arbitrary JavaScript", `browser_file_upload`, `browser_fill_form`) and 7 "read" |

The tool list is the stock Playwright MCP server's. Nothing in this repository serves it: `.mcp.json`
names only the two Supabase servers, and no `playwright-mcp` package or code exists in the repo or
under `~/.claude`.

Probes:

```text
nslookup wheel-record-pacific-bestsellers.trycloudflare.com          -> Non-existent domain
nslookup wheel-record-pacific-bestsellers.trycloudflare.com 1.1.1.1  -> Non-existent domain
curl -X POST https://wheel-record-pacific-bestsellers.trycloudflare.com/mcp (MCP initialize)
                                                                     -> HTTP 000, curl exit 6 (could not resolve host)
```

The laptop's only Cloudflare process is the `cloudflared-mesh` Windows service. It runs neither
`--url` (a quick tunnel) nor this hostname.

**Classification.** It is not TLS, OAuth or authorization: the name does not resolve, so no connection
is ever attempted. The cause is deployment: the tunnel process that served the name stopped, and a
quick tunnel cannot be brought back under the same name.

**Why it must not be revived as it was.** Anyone who learned the address could drive a browser with no
sign-in. With a Phoenix session in that browser, they could run arbitrary JavaScript as that user and
upload files. The kickoff's own rule ("never expose an unrestricted browser/JavaScript endpoint") forbids
it. The replacement is a short list of named tools with ids-only inputs, a write fence, masked
screenshots and an audit log (Phase E).

**Remedy, in order.**
1. Owner: in ChatGPT → Plugins → Phoenix Playwright → Settings, choose **Uninstall**. The plugin points at
   a released random name, so leaving it installed keeps a stale address on the account.
2. Use the replacement tools locally now (`scripts/phoenix-inspect/mcp-server.mjs`, stdio).
3. Connect ChatGPT to them only through the remote design in [CHATGPT_INTERFACE.md](CHATGPT_INTERFACE.md):
   OAuth, a fixed hostname and owner-only access. That is a separate approval with a price.

## 2. GitHub connector (HTTP 403, "account suspended")

```text
gh repo view sato-pharma/phoenix-people-workforce --json viewerPermission  -> ADMIN (repository is PUBLIC)
gh api users/it-gawish-hr                                                   -> 404 Not Found
gh auth status                                                              -> active login is the sato-pharma admin; the it-gawish-hr login fails
```

The repository history explains it: the code moved from the `it-gawish-hr` account to a new account on
4 Nov 2026 and then into the `sato-pharma` organisation (PR numbers restarted, which is why PR #5748
belongs to the old numbering). A connector still linked to the old account is answered 403 by GitHub.
That is the account's state, not a fault in Phoenix.

Remedy (owner, in ChatGPT): **Settings → Plugins → GitHub → disconnect**, then connect again and sign in
to GitHub as the `sato-pharma` administrator account. When GitHub asks which repositories the ChatGPT
app may read, grant `sato-pharma/phoenix-people-workforce`. Note: the `sato-pharma` enterprise refuses
fine-grained personal tokens that last more than 366 days. That applies to tokens only, not to the
connector's own app sign-in.

Until then, the local working tree and `gh` on this laptop are the source of truth for source mappings.
None of this work depended on the connector.

## 3. Staging access for the explorer

| Path | Works on staging? | Evidence |
| --- | --- | --- |
| Dev-auth role headers / `/api/dev-auth` | **No** | Both need `NODE_ENV=development` and a loopback host (`src/lib/auth/server.ts` `isLocalDevHeaderRequest`, `src/lib/auth/dev-preview.ts` `isLocalDevelopmentRequest`). `docs/deployment.md` records `/api/dev-auth` answering 404 on staging. |
| Staging test sign-in key | Only if `PHOENIX_STAGING_TEST_SIGNIN_KEY` is set | `src/lib/auth/staging-test-sign-in.ts`. Staging had **0** test accounts on 14 Nov 2026. Not needed: a test account with its own password signs in first. |
| Ordinary sign-in with a staging-only login | **Yes** | `app_auth_users` (bcrypt, primary key `login_id`, `hr_id` not unique). See [INSPECTION_PERSONAS.md](INSPECTION_PERSONAS.md). |
| Super Admin sign-in | Needs the second step | PR #364 (13 Nov 2026): Super Admin password sign-ins ask for an authenticator code. The explorer does not sign in as Super Admin. The CEO's view has the same whole-company reach on the KPIs board. |

Staging data on 14 Nov 2026: `crm_visits_unified` holds 126,330 visits, 15–21k a month March–August
2026, and none since October. August therefore shows a full KPIs board and November the real empty
state. The rows are copies of real people, so every screenshot is masked (see the explorer's masking).

## 4. ChatGPT plan and the connection mechanism

- The owner's ChatGPT account is on **Plus**. It already holds a personal ("DEVELOPMENT") custom MCP
  plugin, so custom MCP servers can be added from **Plugins** on this account. That is the live
  evidence. OpenAI's help article still describes full MCP as Business/Enterprise/Edu, and a
  staff post in the OpenAI community (Oct 2026) says Developer Mode is no longer required. The
  account's own Plugins page outranks both.
- ChatGPT supports OAuth for these plugins. The replacement must use it ("Authorization: None" is
  what this diagnosis condemns).
- **Desktop app:** not verified. Plugins belong to the account, and whether ChatGPT Desktop on Windows
  offers the same personal plugin is checked once the remote endpoint exists, before anything is
  called "available in ChatGPT".

Sources: [Connecting custom MCP servers in ChatGPT](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt),
[MCP server tools now in ChatGPT — developer mode](https://community.openai.com/t/mcp-server-tools-now-in-chatgpt-developer-mode/1357233).

## Re-running these checks

```powershell
nslookup <plugin-host>
curl.exe -s -o NUL -w "%{http_code}" -X POST https://<plugin-host>/mcp
gh api users/<linked-github-login>
curl.exe -s https://phoenix-people-workforce-staging.up.railway.app/api/healthz
curl.exe -s https://phoenix-hr.satopharma.com/api/healthz
```
