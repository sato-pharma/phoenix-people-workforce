# Phoenix Intelligence

A read-only visual inspector for Phoenix Workforce. It signs in to **staging** as staging-only logins,
opens a module's pages in every state, takes masked full-page screenshots, measures them against the
house rules, and maps what it sees back to the source files. **KPI Reports** (the KPIs board) is the
first module. Nothing here changes the app, and nothing is connected to ChatGPT yet.

Built on 14 Nov 2026 (Cairo), branch `codex/visual-intelligence`.

## Start here

| If you want to know… | Read |
| --- | --- |
| what works, what is proven and what is not | [PHOENIX_IMPLEMENTATION_VERIFICATION.md](PHOENIX_IMPLEMENTATION_VERIFICATION.md), then [PHOENIX_INTELLIGENCE_VALIDATION_REPORT.md](PHOENIX_INTELLIGENCE_VALIDATION_REPORT.md) |
| why ChatGPT's two connectors failed | [CONNECTION_DIAGNOSTICS.md](CONNECTION_DIAGNOSTICS.md) |
| what the KPIs board looks like now, and what is wrong with it | [KPI_REPORTS_VISUAL_AUDIT.md](KPI_REPORTS_VISUAL_AUDIT.md) |
| what to change, in order, each waiting for the owner | [KPI_REPORTS_PREMIUM_POLISH_PLAN.md](KPI_REPORTS_PREMIUM_POLISH_PLAN.md) |
| the prompt that implements the approved rows | [SECOND_STAGE_PROMPT.md](SECOND_STAGE_PROMPT.md) |
| which file draws which part of the board | [KPI_REPORTS_COMPONENT_MAP.md](KPI_REPORTS_COMPONENT_MAP.md) (files), [KPI_REPORTS_SOURCE_DEPENDENCY_MAP.md](KPI_REPORTS_SOURCE_DEPENDENCY_MAP.md) (each visible element down to its tables) |
| every portal, role and page, read from the navigation code | [route-inventory.json](route-inventory.json) |
| the staging logins the inspector uses, and how to switch them off | [INSPECTION_PERSONAS.md](INSPECTION_PERSONAS.md) |
| what ChatGPT needs, what exists, and the two hosting choices | [CHATGPT_INTERFACE.md](CHATGPT_INTERFACE.md), [CHATGPT_MCP_CONNECTION_READINESS.md](CHATGPT_MCP_CONNECTION_READINESS.md), [CHATGPT_MCP_DEPLOYMENT_RUNBOOK.md](CHATGPT_MCP_DEPLOYMENT_RUNBOOK.md) |
| how this grows to every module, and whether "M2" exists | [PHOENIX_UNIVERSAL_INSPECTION_ROADMAP.md](PHOENIX_UNIVERSAL_INSPECTION_ROADMAP.md) |
| which screenshots exist | [SCREENSHOT_INDEX.md](../../artifacts/phoenix-intelligence-delivery/SCREENSHOT_INDEX.md) (in the delivery folder, not in Git) |

## The code

`scripts/phoenix-inspect/`:

| File | What it does |
| --- | --- |
| `explore.mjs` | the explorer: personas × states × viewports, fenced, masked, measured |
| `modules/kpis.mjs` | the KPIs module spec: personas, states, never-touch controls, source files |
| `lib/fence.mjs` | the network fence: GET only, staging only, never-touch paths |
| `lib/redact.mjs` | masking before every picture, and the leak check after it |
| `lib/measure.mjs` | overflow, computed radius, ellipsis, contrast, tap targets, fonts, colours |
| `lib/capture.mjs` | sign-in, the fenced context, one capture |
| `lib/safety.mjs` | the click classifier, the origin allowlist, input checks |
| `mcp-server.mjs` | the eight tools over stdio, for any MCP client |
| `on-spare.ps1` | runs everything on the spare laptop and copies the results back |
| `self-check.mjs` | proves the machinery on a synthetic page |
| `route-inventory.ts` | regenerates `route-inventory.json` |
| `prune.mjs` | keeps the last 5 runs or 14 days |

The tests are `tests/phoenix-inspect-*.test.ts`, registered in `tests/run-tests.ts`.

## Run it

Every browser run happens on the spare laptop; this laptop starts no browser.

```text
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/phoenix-inspect/on-spare.ps1 self-check
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/phoenix-inspect/on-spare.ps1 explore --module kpi-reports
node scripts/phoenix-inspect/explore.mjs --plan --module kpi-reports
```

Output goes to `artifacts/phoenix-inspection/kpi-reports/<run>/` (not in Git): masked PNGs and a
`manifest.json` with every shot's measurements and source candidates.

## What it never does

It never signs in to production, sends anything but GET after sign-in, clicks Export or any approve,
send, save, delete or submit control, keeps an unmasked picture, or writes a password or cookie to disk
or Git. Each of these is pinned by a test, and the validation report gives the numbers.
