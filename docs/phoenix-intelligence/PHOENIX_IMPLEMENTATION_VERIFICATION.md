# Phoenix Intelligence — what exists, and what is proven

Read on 14 Nov 2026 (Cairo). A capability is called working only when it was run and its output is
quoted here or in [PHOENIX_INTELLIGENCE_VALIDATION_REPORT.md](PHOENIX_INTELLIGENCE_VALIDATION_REPORT.md).
Source code alone counts as "implemented, not tested".

## 1. Versions: which code, which app, which screenshots

Three revision ids appear across these documents. They are three moments on the same day, not a
conflict:

| Where | Revision | When (Cairo) | Why that one |
| --- | --- | --- | --- |
| `CONNECTION_DIAGNOSTICS.md` | `fb27d6a8c` | early evening, 14 Nov | what staging and production both served when the diagnostics were read |
| `KPI_REPORTS_COMPONENT_MAP.md`, this branch's base | `950851277` | 18:26 | `origin/main` when the branch was cut; staging served it during the first runs |
| staging at 19:34 | `6df640b10` | 19:25 merge | `/api/healthz` on staging, read at 19:34 |

Commits between the first and the last: `44e226ab4`, `950851277`, `c33e93bb8`, `6df640b10`. Two
change the payroll screens, one Phoenix CRM's building check, one a payroll picker. **None touches a
file the KPIs board is built from:**

```text
git diff --name-only fb27d6a8c 6df640b10 -- 'src/components/crm/kpi*' 'src/components/crm/kpis*' \
  src/components/crm/portal-kpi-report-page.tsx src/components/crm/rep-visits-page.tsx 'src/lib/crm/' \
  'app/(admin)/admin/kpis' app/employee-portals/kpis src/components/ui/table-row-detail.tsx \
  src/components/layout/app-shell.tsx src/components/employee-portal/ src/config/system-navigation.ts \
  src/styles/ app/globals.css
-> (empty)
```

So the component map, the dependency map and every screenshot describe the same KPIs code whichever
of the three revisions served the page. **Every run now records both ids itself:** the manifest's
`revision` is staging's `/api/healthz` answer at the start of the run, and `sourceCommit` is the git
commit the packed source files came from, marked `+dirty` if any of them differs from it (added in
this branch; `on-spare.ps1` passes it). [SCREENSHOT_MANIFEST.json](../../artifacts/phoenix-intelligence-delivery/SCREENSHOT_MANIFEST.json)
carries both on every entry.

## 2. Capability ledger

| Capability | Where | Implemented | Tested | Against staging | Deployed | From ChatGPT | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Route inventory from the navigation code | `scripts/phoenix-inspect/route-inventory.ts` → `route-inventory.json` | yes | yes (unit test) | n/a (source only) | n/a | as a file | `tests/phoenix-inspect-route-inventory.test.ts` |
| GET-only network fence | `lib/fence.mjs` | yes | yes (unit + browser) | yes | — | — | fence test; self-check "the server received no request other than GET" (0); smoke run `writesStopped: 2` |
| Masking + leak check | `lib/redact.mjs` | yes | yes (unit + browser) | yes | — | — | redaction test; self-check masking and leak-deletion checks; smoke run 0 privacy deletions |
| Click classifier, origin allowlist, bounds, ids-only input | `lib/safety.mjs` | yes | yes (unit) | — | — | — | `tests/phoenix-inspect-safety.test.ts` |
| Full-page + scroller screenshots, measurements | `lib/capture.mjs`, `lib/measure.mjs` | yes | yes (browser, fixture) | yes | — | — | self-check 31/31 on the spare (run `20261114-190625`); smoke run captured the CEO summary |
| Staging sign-in per persona | `lib/capture.mjs` `signIn` | yes | yes | yes | — | — | smoke run: `sign-in ceo: ok`, `sign-in emp: ok` |
| Denied path (Employee) | `explore.mjs` + `modules/kpis.mjs` | yes | yes | yes | — | — | smoke run: `002-emp-summary-desktop: denied-as-expected` |
| KPIs state matrix (122 pages) | `modules/kpis.mjs`, `buildPlan` | yes | plan yes; full run see [the audit](KPI_REPORTS_VISUAL_AUDIT.md) | see the audit | — | — | `explore.mjs --plan`: 122 jobs |
| Runs on the spare, output copied back | `on-spare.ps1` | yes | yes | yes | — | — | smoke run; copy-back retry and `fetch` added after a dropped copy (section 3) |
| Local MCP server, 8 tools | `mcp-server.mjs` (stdio) | yes | yes (unit + real stdio client) | capture tool through the spare | no | **no** | `tests/phoenix-inspect-mcp.test.ts`; `mcp-smoke.mjs` 14/14 |
| Remote MCP endpoint for ChatGPT | — | **no** | — | — | no | no | [CHATGPT_MCP_CONNECTION_READINESS.md](CHATGPT_MCP_CONNECTION_READINESS.md) |
| `infra/phoenix-mcp` (data tools, OAuth) | `infra/phoenix-mcp/` | yes (5 data tools, no browser) | its own suite: 31/31 on 11 Oct 2026 (`VERIFICATION.md`), synthetic databases only | no | **no** (no service in `.railway/railway.ts`) | no | `infra/phoenix-mcp/README.md`: "NOT production ready or connected" |
| Repo Playwright suite | `playwright.config.ts`, `tests/e2e/` | yes | in CI (login smoke on `main`) | no | — | — | unrelated to the explorer; the explorer uses Playwright's library directly |
| Old "Phoenix Playwright" ChatGPT plugin | owner's ChatGPT | was a stock Playwright MCP behind a quick tunnel | — | — | **dead** | **fails** | [CONNECTION_DIAGNOSTICS.md](CONNECTION_DIAGNOSTICS.md) §1 |
| ChatGPT GitHub connector | owner's ChatGPT | — | — | — | — | **403** | [CONNECTION_DIAGNOSTICS.md](CONNECTION_DIAGNOSTICS.md) §2 |
| ChatGPT Desktop on this laptop | Windows | installed: `OpenAI.ChatGPT-Desktop 1.2026.190.0` | — | — | — | not verified | `Get-AppxPackage -Name '*ChatGPT*'` |

## 3. Defects found while verifying, and fixed in this branch

| Defect | Proof | Fix |
| --- | --- | --- |
| A dropped copy-back said "the run wrote no output" and exited 0 while the run had succeeded on the spare | smoke run 14 Nov 19:13: totals printed, then `scp.exe: Connection closed`, `exit 0` | `Copy-Back`: three tries, the spare's address found again before each, exit 4 and the folder named when nothing arrives; `on-spare.ps1 fetch <stamp>` brings it later |
| Manifests did not say which source commit their kept text and source mapping came from | manifest fields | `--source-commit`, passed by `on-spare.ps1`, `+dirty` aware |
| The self-check's results lived only on screen | — | it writes `report.json` beside its shots |
| `mcp-server.mjs` assigned a variable named `module` (Next.js lint error) | `check-contracts`: `58:3 error … no-assign-module-variable` | renamed; lint exit 0 |
| The masking tests and the self-check fixture used a realistic name, an HR-id-shaped code and a staff address at the company's own domain as their made-up data. The repository is public, so a match with a real person would have published it | the delivery's privacy scan flagged the address | replaced with values that cannot be anyone (`Sammy Example`, `Z-9043`, `sammy.e@example.com`, `hr@example.com`); same lengths, so every masked shape is unchanged and the five suites pass 5 of 5 |
| The explorer's comment and the personas file said a test account's server-side dry run stops every write. It skips GET, HEAD and OPTIONS (`src/lib/auth/test-dry-run-rules.ts`, `READ_METHODS`), so a page that writes while it renders writes for real | the universal roadmap's reuse audit | both texts corrected: for GET, the explorer's own path list is the only guard. The KPIs board has no such page (no write in its pages or domain files; staging's audit log shows only the two sign-ins) |

## 4. Not working, or not reachable today

- **The spare laptop stopped accepting SSH sessions at about 19:15 Cairo**: authentication succeeds,
  then the session is reset (`Authenticated … using "publickey"` → `Connection reset by peer`). Port
  22 answers and the host key matches. Every browser run depends on it. See the validation report for
  what ran before and after.
- **Nothing is reachable from ChatGPT.** The local server needs a process on this machine; the
  remote endpoint is designed and priced, not built.
- **Super Admin's own view** is not inspected: its sign-in needs an authenticator code, and the
  explorer does not bypass account security.
