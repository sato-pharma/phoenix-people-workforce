# Phoenix universal inspection roadmap

How the read-only inspector in `scripts/phoenix-inspect/` grows from one module (KPIs) to every web module
of Phoenix Workforce. Everything here was read from the source on 14 Nov 2026 (Cairo). Anything not read
says **not verified**.

> **Update, 14 Nov 2026 evening — B3 and B4 are DONE** (branch `codex/visual-intelligence`). The fence's deny
> list is now built from source: `scripts/phoenix-inspect/side-effect-routes.ts` scans `app/**` and the access
> registry and writes `generated/side-effect-routes.json` — 275 API routes whose GET writes (35), serves a file
> (114) or spends the Maps quota (1), plus registry entries classed export, mutation or audit-required
> access-read — and the 2 pages whose server render writes. `lib/fence.mjs` refuses all of them as a
> navigation, an RSC fetch and a prefetch, and refuses every `/api` GET if the list cannot be read.
> `tests/phoenix-inspect-route-fence.test.ts` fails a stale list, fails any scanned address the fence lets
> through, and fails any registered module whose plan opens one. Every route marked **unfenced** below is
> now refused; the tables keep the word as the record of what the survey found.

**Ground rules**

- The target is always **staging**. Production is refused, and that refusal is pinned by `lib/fence.mjs:30`
  and `lib/safety.mjs` (`assertTargetOrigin`).
- Inspection reads screens. It decides no money matter and changes no record. A finding on a money screen is
  reported; the decision is made on that module's own screen.
- This repository is public, so this file names no person, no HR id and no data value.

Contents: 1 Reuse audit · 2 Coverage inventory · 3 Per-module safety profile · 4 M2 · 5 What must be built ·
6 Expansion order.

---

## 1. Reuse audit

**Generic** means a second module can use the file unchanged. **KPIs-bound** means the file hardcodes
something from the KPIs board.

| File | Verdict | KPIs-bound points (file:line) | Change needed |
| --- | --- | --- | --- |
| `explore.mjs` | KPIs-bound | Imports `KPIS_MODULE`, `addressFor`, `statesFor` and `viewportsFor` from `modules/kpis.mjs` (:35). The `MODULES` registry holds one entry (:38). `buildPlan` (:69) calls the KPIs helpers at :76, :78 and :80, so a second module would walk the **KPIs** states, not its own. The default module is `kpi-reports` (:239). | Call `spec.statesFor`, `spec.viewportsFor` and `spec.addressFor`. Import the registry from one shared file. Require `--module`. |
| `lib/capture.mjs` | Mostly generic | The loading mock waits on `a[href*="/kpis/frequency"]` (:268). The error mock waits on `tab=am-pm` and `/kpis/coverage` (:279). `probeDenied` (:388) checks the KPIs tab strip and the KPIs rail entry (:400-405). | Move the mocks and the denial probe into the module spec, as `spec.mocks` and `spec.deniedProbe`. `settle` (:102) and `acceptDownloads: false` (:92) stay as they are. |
| `lib/fence.mjs` | Generic, with gaps | `NEVER_TOUCH_PATHS` (:43). Line :44 covers the KPIs export only. The generic patterns (:45 onwards) miss `-export`, `-download`, `/pdf`, `/print`, `/pack`, `bank-file`, templates, `/cv`, attachments, `/file`, photos, the case-map basemap and contact numbers (§3). | Widen the patterns and add a deny list generated from the access registry (§5, B3). |
| `lib/fence.mjs` comment :24-26, `INSPECTION_PERSONAS.md:23-26` | Inaccurate | Both say test personas carry a server-side dry-run fence that makes every write a no-op. The server fence skips GET: `src/lib/auth/test-dry-run-rules.ts:30` (`READ_METHODS` holds GET, HEAD and OPTIONS) and :50. A GET that writes therefore writes for real, even for a test account. | Correct both texts. Treat the browser fence as the **only** guard against writes on GET. |
| `lib/safety.mjs` | Generic | The phone viewport is 390×844 (:12). AGENTS.md §7 asks for 375. `RUN_BOUNDS` (:16), `REFUSED_CONTROL_WORDS` (:46-47), `classifyControl` (:55) and `validateToolInput` (:121) are module-free. | Add a 375 px viewport. Add refused words for capture, photo, camera, location, check-in and share (absent from :47). |
| `lib/redact.mjs` | Generic | `buildKeepIndex` (imported at `explore.mjs:33`) keeps literals found in the module's `SOURCE_FILES`. The kept-literal check catches emails, phone numbers, national ids, HR-id shapes and long numbers. It does **not** catch a person's name hardcoded in a source file. | Review `SOURCE_FILES` for each module before its first run (§5, B5). |
| `lib/measure.mjs`, `prune.mjs` | Generic | None. | None. |
| `mcp-server.mjs` (431 lines) | KPIs-bound | Imports `addressFor` from kpis (:34) and uses it at :266. `MODULE_DOCS` is keyed `kpi-reports` only (:49-50). The docs handlers index `MODULE_DOCS[module]` at :304, :308 and :321-322; they throw for any other module. The persona enum is a union across modules (:68), so a persona id must mean the same login everywhere. `open_module` takes one landing state (:277). | Read the helpers from the spec. Add a docs map per module with an honest "no doc yet" answer. Add a landing state per shell. Use a shared persona registry. |
| `modules/kpis.mjs` | The template | `PERSONAS` :20-28, `basePathFor` :35, `STATES` :48-87, `NEVER_TOUCH` :90, `SOURCE_FILES` :97, the module object :127-135, and the helpers `statesFor` :138, `viewportsFor` :147 and `addressFor` :156. | Becomes the first implementation of the module contract (§5, B1). |
| `make-persona-secrets.mjs` | KPIs-bound | Imports kpis (:23). It keeps its own `MODULES` (:35) and defaults to `kpi-reports` (:37). | Use the shared registry. Generate secrets per persona, not per module. |
| `on-spare.ps1` | KPIs-bound | Reads `SOURCE_FILES` from `kpis.mjs` only (:98). | Take the module id and read that module's sources. |
| `lib/route-inventory.ts`, `route-inventory.ts` | KPIs-bound | `KPI_TABS` is imported at :41. `MODULE_TABS` (:90-97) declares KPIs only. The summary at `route-inventory.ts:43-46` prints KPIs. | Add the tabs that can be derived from source: `/admin/field-crm`, `/admin/deductions` and `/admin/outstation/expense-command`. |
| `self-check.mjs`, `mcp-smoke.mjs` | KPIs-bound | The self-check fixture uses the KPIs export (:71, :84, :91, :106). The smoke hardcodes `kpi-reports` (:86-111). | Run both once per registered module. |
| `tests/phoenix-inspect-*.test.ts` | KPIs-bound | Mentions of KPIs per file: fence 17, mcp 12, redaction 3, route-inventory 25, safety 31. | Run each test over every registered module. |

**Helpers outside the inspector:**

- `tests/every-offered-link-opens.test.ts` and `tests/support/page-gate-reader.ts` hold the page-gate logic.
- The `run-phoenix-workforce` skill's `driver.mjs` signs in through dev-auth. It is useful locally, never on
  staging logins.
- The 83 `.claude/rules/*.md` files are a ready list of each module's locked rules, to brief a reviewer.

---

## 2. Coverage inventory

Source: `docs/phoenix-intelligence/route-inventory.json` (18 roles, 1,064 rows, 0 unevaluated).

### 2.1 Portals

| Portal | Roles | Rows | Distinct routes | Sections | Sidebar entries |
| --- | --- | --- | --- | --- | --- |
| Admin | 5 | 442 | 242 (237 page paths) | 63: 62 named, plus the SFE Manager's flat rail with no headings (`src/config/system-navigation.ts:204`) | 333 |
| HR | 3 | 101 | 64 | 12 | 73 |
| Employee portal | 10 | 521 | 85 | 16 | 85 |

### 2.2 Pages

| Kind | Count |
| --- | --- |
| Page routes under `app/` | 521 |
| Reached from a sidebar entry | 323 page paths (322 files) |
| Reached only from inside another page | 175 |
| In neither: public, auth, `/print` ×3, `/share` token pages ×3, `/dev` | 25 |
| Sidebar pages a current persona role reaches | 221 of 323 |
| Portal and route pairs a current persona role reaches | 242 of 391 |
| Sidebar pages no persona role reaches | 102, of which 79 are Super Admin only |

Tabs can be derived from source for five pages only: `/admin/kpis`, `/employee-portals/kpis`,
`/admin/field-crm`, `/admin/deductions` and `/admin/outstation/expense-command`. On every other page, tab
and filter state is held in the browser, so its states must be listed by hand (not verified per page).

### 2.3 Roles and personas

The seven personas today are `ceo`, `sfe`, `hrr`, `nsm`, `dm`, `rep` and `emp`. A test account can only
mirror a portal role (`INSPECTION_PERSONAS.md:27-28`). Admin and HR logins have no dry-run fence of their
own.

| Role | Rows | Persona | New sidebar pages a persona would open |
| --- | --- | --- | --- |
| Super Admin | 237 | **none** | 79 (pages only this role reaches) |
| SFE Manager | 87 | `sfe` | n/a |
| CEO | 85 | `ceo` | n/a |
| National Sales Manager | 71 | `nsm` | n/a |
| District Manager | 63 | `dm` | n/a |
| Regional Manager | 63 | **none** | 0 |
| Group Product Manager | 63 | **none** | 2 |
| Product Manager | 62 | **none** | 2 |
| Marketing Manager | 59 | **none** | 4 |
| Medical Rep | 44 | `rep` | n/a |
| Training Manager | 40 | **none** | 5 |
| HR Operations | 40 | **none** | 10 |
| HR Resourcing | 39 | `hrr` | n/a |
| Manager | 31 | **none** | 1 |
| Employee | 25 | `emp` | n/a |
| HR Administration | 22 | **none** | 5 |
| Finance Manager | 21 | **none** | 3 |
| Financial Advisor | 12 | **none** | 0 |

### 2.4 Owner decisions: the 11 roles with no persona

No login is created by this roadmap. Each row below is the owner's call.

| Role | What deciding "yes" buys | Note |
| --- | --- | --- |
| HR Operations | 10 pages, mostly attendance and employee records | An HR login has no dry-run fence. The browser fence would be its only guard. |
| Training Manager | 5 pages, coaching and training | Portal role; a test account can mirror it. |
| HR Administration | 5 pages | HR login, no dry-run fence. |
| Marketing Manager | 4 pages | Portal role. |
| Finance Manager | 3 pages, including finance screens | Money module; comes last (§6). |
| Product Manager | 2 pages | Portal role. |
| Group Product Manager | 2 pages | Portal role. |
| Manager | 1 page | Portal role. |
| Regional Manager | 0 new pages; it sees the same pages at a different scope | Worth it only to check what a regional scope shows. |
| Financial Advisor | 0 new pages | Lowest value. |
| Super Admin | 79 pages, including all of email and platform administration | Sign-in asks for the second step. That step is **never bypassed**, so this can only be the owner's own decision on how such a login would work. |

---

## 3. Per-module safety profile

The 323 sidebar pages fall into **42 modules**, with none left unassigned.

**Coverage** is the number of portal and route pairs a current persona reaches, out of all pairs in the
module.

**Sensitivity** has four levels:

- *Medium*: named people's work or sales figures.
- *High*: personal data, locations, health or absence.
- *Money*: pay, deductions, incentive, expenses, bank files or company spend requests.
- *Low*: none of the above. No module was rated Low.

**A GET that writes** means the route runs a write when it is only read. The browser fence
`NEVER_TOUCH_PATHS` must cover every such route, and the ones marked **unfenced** are not covered today.

Every one of the 35 GET-only routes that writes is listed below. Those not marked "unfenced" are already
covered by the path fence.

| Module | Pages | Coverage | Roles with no persona | Sensitivity | A GET that writes (file:line) | Other write or read risks |
| --- | --- | --- | --- | --- | --- | --- |
| kpi-reports | 5 | 6/6 | RM, PM, GPM, TM, MM, SA | Medium | `api/crm/kpis-export` (fenced, `fence.mjs:44`) | None found |
| ranks-early-birds | 4 | 6/6 | RM, PM, GPM, TM, MM, SA | Medium | None found | `api/rep-ranks/certificate` serves a file on GET and is **unfenced**. Rendered on the server (early birds has 1 client file, rep ranks none). |
| reps-list | 2 | 2/2 | RM, PM, GPM, TM, MM, SA | Medium | None found | Shares KPIs code (`src/lib/crm/reps-list-board.ts:54`). |
| team-performance | 3 | 3/3 | RM | Medium | None found | Portal only. |
| business-review | 2 | 2/2 | RM, PM, GPM, MM, SA | Medium | `api/business-review/pack/route.ts:334` (**unfenced**); `api/business-review/export` (fenced) | 9 client files. Shares KPIs code (`src/lib/business-review/sources/crm-kpis.ts:22`, `pack/kpi-sections.ts`). |
| command-centers | 7 | 4/7 | RM, PM, GPM, MM, FinM, HRO, HRA, Mgr, SA | High | None found | 175 pages reached from inside these. The finance command center links `cib-download` and `fab-download` (money, **unfenced**). `src/lib/employee-portal/home-snapshot.ts` shares KPIs code. |
| organogram-360 | 4 | 6/6 | RM, PM, GPM, TM, MM, FinM, FinA, HRO, HRA, Mgr, SA | High | `api/reports/organogram/contact-numbers/route.ts:112` (required audit row, **unfenced**) | `api/reports/organogram/employee/[hrId]/pdf` is **unfenced**. |
| phoenix-crm-workspace | 6 | 6/7 | RM, PM, GPM, TM, MM, Mgr, SA | Medium | `api/admin/crm/master-export/route.ts:85` and `api/employee-portals/crm/master-export/route.ts:98` (both **unfenced**) | GPS: capture-location, live-photo-capture, use-silent-fix, my-map-canvas. A test account's Phoenix CRM writes are **not** dry-run (`test-dry-run-rules.ts:45-46`); they land in its test world. 20 inventory rows are approximate. |
| visits-maps-activity | 7 | 7/7 | RM, PM, GPM, TM, MM, Mgr, SA | High | `api/phoenix-crm/visit-report/export`, `api/phoenix-crm/reports/export` (fenced) | `api/admin/field-activity/pdf` is **unfenced** and calls Maps Static on the server. Google Maps JS is off-origin, so maps render blank. `/admin/field-activity` reads no `searchParams`. |
| double-visits | 6 | 6/6 | RM, PM, GPM, TM, MM, Mgr, SA | Medium | None found | `api/admin/double-visit-analytics/audit-export` serves a file and is **unfenced**. The request pages carry approve controls. 10 inventory rows are approximate. |
| crm-data-quality | 17 | 15/17 | RM, PM, GPM, TM, MM, Mgr, SA | High | `api/phoenix-crm/list/template/route.ts:37` (**unfenced**); fenced: `api/admin/phoenix-crm/integrity/export`, `api/crm/team-visits/export`, `api/crm/weekly-sheet/export`, `api/crm/district-manager-plans/export`, `api/phoenix-crm/manager-plans/export` | `api/admin/phoenix-crm/case-map-basemap` is **unfenced**; it calls Maps Static on GET and spends the daily cap (whether staging shares the key: not verified). The team visits, weekly sheet and district manager plans boards share KPIs code (`src/components/crm/regional/team-visits-view.tsx:3,5`). |
| plans | 4 | 4/5 | RM, PM, GPM, TM, MM, FinM, HRO, HRA, Mgr, SA | Medium | `api/weekly-plans/calendar/export` (fenced) | None found |
| field-absence-compliance | 4 | 4/4 | SA | High | `api/admin/field-workforce-compliance/live-snapshots/[monthKey]/route.ts:61` (**unfenced**) | None found |
| sales-dashboards | 9 | 8/9 | RM, PM, GPM, MM, FinM, SA | Medium | None found | `src/components/sales` has 87 client files, 679 `useState` calls and 181 `fetch` calls. `/sales/monthly-dashboard` reads no `searchParams`, so its state lives in the browser (not verified). |
| monthly-closing | 6 | 4/6 | RM, PM, GPM, MM, FinM, SA | Medium | None found | `api/sales/monthly-closing/premium-export/pdf` is **unfenced**. |
| weekly-sales | 8 | 6/8 | RM, PM, GPM, MM, SA | Medium | None found | `api/sales/weekly/summary-export`, `api/sales/weekly/nsm-dsm-export` and `api/employee-portals/weekly-sales/nsm-dsm-export` are **unfenced**. `/sales/weekly/dashboard` reads no `searchParams`. |
| targets-make-it-happen | 4 | 4/4 | RM, PM, GPM, MM, SA | Medium | None found | `api/sales/targets/template` is **unfenced**. Whether the Make It Happen Excel route is fenced: not verified. |
| sales-imports-mapping | 10 | 4/10 | RM, SA | Medium | `api/sales/normalizer/phoenix-template/route.ts:43`, `api/sales/source-of-sales/raw-template/route.ts:29` (both **unfenced**) | Six mapping templates are **unfenced**. Upload screens. |
| direct-orders | 14 | 12/15 | RM, PM, GPM, FinM, SA | Medium | `api/share/direct-orders/[token]/file/route.ts:100` updates `file_access_count` (**unfenced**; a token page outside the sidebar) | GPS in the direct-orders validation screen. |
| customers-master-data | 9 | 6/9 | FinM, SA | Medium | None found | `api/admin/crm/customer-mapping/template` and `region-mapping/template` are **unfenced**. |
| marketing-roi | 7 | 6/7 | RM, PM, GPM, MM, FinA, SA | Medium (spend totals) | None found | `/admin/marketing-roi-tracker` reads no `searchParams`. |
| market-awareness-functions | 10 | 8/10 | PM, GPM, MM, SA | Medium | `api/marketing-functions/export` (fenced) | `api/visual-aids/[id]/file` is **unfenced**. |
| marketing-requests | 16 | 12/16 | RM, PM, GPM, MM, FinM, FinA, SA | Money | `api/share/marketing-requests/[token]/file/route.ts:136` (**unfenced**); fenced: `api/marketing-requests/finance-ageing/export`, `api/marketing-requests/list-check/export` | **Writes when the page renders:** `app/employee-portals/marketing-requests/decision/[requestId]/page.tsx:49` writes an audit row. GPS in marketing validation. |
| approvals-hub | 10 | 8/10 | RM, PM, GPM, MM, FinM, FinA, Mgr, SA | Money | None found | Its screens exist to approve, so every control is refused by `REFUSED_CONTROL_WORDS`. |
| leave-excuses | 10 | 10/15 | RM, PM, GPM, TM, MM, FinM, FinA, HRO, HRA, Mgr, SA | High | `api/vacation/company-report/export` (fenced) | Inline server action at `app/(admin)/leave-management/vacation-decision/[id]/page.tsx:28`; it is a POST, so the browser fence stops it. The vacation attachment routes are **unfenced**. |
| attendance | 14 | 4/22 | RM, PM, GPM, TM, MM, FinM, HRO, HRA, Mgr, SA | High | `api/company-activity-report/export` (fenced) | `api/attendance/employee-fingerprint-export` and `device-user-mappings/template` are **unfenced**. |
| calendars | 5 | 6/9 | RM, PM, GPM, TM, MM, HRO, HRA, Mgr, SA | Medium | None found | None found |
| payroll | 8 | 4/10 | RM, PM, GPM, TM, MM, FinM, FinA, HRO, Mgr, SA | Money | `api/payroll/[id]/bank-file/route.ts:67` (**unfenced**) | **Unfenced:** `cib-download`, `fab-download`, `api/payroll/[id]/payslips/image` and `api/payroll/template`. `/admin/automated-payroll/finance` and the portal payslips page read no `searchParams`. |
| deductions-disputes | 4 | 5/6 | RM, PM, GPM, TM, MM, HRO, Mgr, SA | Money | `api/admin/deductions/export`, `api/admin/deductions/export/master` (fenced) | The deduction-comment and dispute attachment routes are **unfenced**. |
| incentive | 1 | 1/1 | RM, PM, GPM, Mgr | Money | None found | **Writes when the page renders:** `app/employee-portals/incentive/page.tsx:48` calls `recordShownIncentive`, which upserts `incentive_shown_figures` (`src/lib/incentives/shown-figures-store.ts:26,46`). Opening the page writes, even for a test account. |
| expenses | 8 | 4/10 | RM, PM, GPM, TM, MM, Mgr, SA | Money | `api/admin/outstation/expense-command/export`, `api/admin/outstation/expenses/export` (fenced) | **Unfenced:** `api/admin/outstation/[id]/pdf` (calls Maps Static), attachments and photo routes. GPS ×3. The expense-calculation preview is a read sent as POST, so it shows blank. |
| employee-records | 11 | 6/18 | FinM, HRO, HRA, SA | High | None found | `api/employees/[hrId]/cv`, `photo` and `template` are **unfenced**. |
| probation | 6 | 7/9 | RM, PM, GPM, TM, MM, HRO, Mgr, SA | High | None found | None found |
| coaching-training | 9 | 4/11 | RM, TM, HRO, SA | Medium | None found | None found |
| recruitment | 24 | 23/39 | RM, PM, GPM, MM, HRO, HRA, Mgr, SA | High | `api/phoenix-crm/day-interviews/cv/route.ts:26` (**unfenced**; the module it belongs to is not verified) | **Unfenced:** four CV routes, the CV database template, `api/offers/[id]/pdf`, offer templates and WhatsApp templates. The offer preview is a read sent as POST, so it shows blank. |
| hiring-documents-cards | 6 | 4/10 | RM, PM, GPM, TM, MM, HRO, HRA, Mgr, SA | High | `api/hiring-documents/export` (fenced) | **Unfenced:** `api/hiring-pack/[hrId]/print`, `bank-account-letter`, `signature`, `paper-register` and their siblings. |
| spotlight-milestones | 5 | 6/7 | SA | Medium | None found | None found |
| pharmacovigilance | 3 | 3/4 | RM, PM, GPM, TM, MM, FinM, FinA, HRO, HRA, Mgr, SA | High (health) | None found | Report forms; every control is refused. |
| workspace-support | 3 | 4/5 | RM, PM, GPM, TM, MM, FinM, FinA, HRO, Mgr, SA | Medium | None found | 19 pages reached from inside these. |
| production-planner | 1 | 1/1 | FinM, SA | Medium | None found | None found |
| email-notifications | 14 | 0/14 | SA | High | None found | Super Admin only. **Unfenced** template routes. The email-template and composer previews are reads sent as POST, so they show blank. |
| platform-admin | 17 | 1/18 | SA | High | `api/admin/activity/timeline/route.ts:35` (**unfenced**); fenced: `api/admin/activity/export`, `api/admin/system-audit/export` | Super Admin only, apart from one page. Destructive screens: data backup, system cleanup and test accounts. |

### 3.1 Risks that cut across modules

- **Writes the browser cannot stop.** Server renders that write (incentive, marketing-request decision)
  happen before any request the fence sees. The only guard is not to open those addresses. They must sit in
  a never-open page list per module.
- **Unfenced file routes.** 137 GET routes serve files; the path fence covers 59 and misses 78.
  `src/lib/security/access-registry.ts` (1,025 `sessionApi` entries) already classes GET-capable routes:
  99 export, 101 access-read (92 of them audit-required) and 45 mutation. Seen at :502, :506, :680, :899,
  :1082 and :2437. It is the machine-readable source for a deny list.
- **Blank panes that are not "empty".** A read sent as POST is stopped by the fence and answers 204, so its
  pane shows blank. Affected: the email-template, offer, expense-calculation and composer previews, and the
  `resolve-*` routes. A blank pane must be recorded as *write-stopped*, never as an empty state.
- **Maps.** Google Maps JS is off-origin, so every live map renders blank. Maps Static is called on the
  server, on GET, by `case-map-basemap`, `field-activity/pdf` and `outstation/[id]/pdf`. Each such call
  spends the daily Static cap.
- **Device APIs.**
  - `navigator.geolocation` is used in Phoenix CRM (×4), outstation (×3), direct-orders validation and
    marketing validation.
  - 15 files open the camera, 75 have file inputs and 7 hold WhatsApp links. Which module owns each camera
    file: not verified.
  - `lib/capture.mjs` sets no browser permissions (grep finds none). Denial must be made explicit.
- **Heartbeat and activity tracking** are POST, so the fence stops them. `/api/auth/pulse` GET is
  read-only.

---

## 4. M2

The kickoff named "M2". **No portal, role, route, sidebar section, module or permission by that name
exists in the source.**

In `src/` and `app/`, the only whole-word match is SVG path data.

| Where | File:line | What the string is there |
| --- | --- | --- |
| Weekly-sales migration | `supabase/migrations/20261018141640_weekly_is_three_depots_and_tebofortin_op_alias.sql:6,19,30,32,58` | A distributor depot code |
| Weekly-sales module rules | `.claude/rules/weekly-sales.md:35` | The same depot code |
| Archived migration | `supabase/_migrations_archive/pre-baseline-2026-07-11/20260605093724_20260606090500_offer_approval_steps.sql:1` | The label "Recruitment Offer Pipeline (M2)", one of the milestones M1 to M4 |
| Schema dump | `supabase/schema/production.sql:56976-56977` | A SQL table alias (`m2`) |
| Image code | `src/lib/milestones/portrait.ts:110-111` | A sharpen parameter (`m2`) |
| Leave code | `src/lib/vacation/calculations.ts:192` | A month variable in a comment (`m2`) |
| Award cheque | `src/lib/spotlight/award-cheque.ts:248,252,253` | SVG path data (`M2 …`) |
| Test fixtures | `tests/kpi-coverage-premium.test.ts:160-161`, `tests/sos-analytics.test.ts:139`, `tests/weekly-sales-depot-detail.test.ts:306`, `tests/recruitment-whatsapp-intake.test.ts:228` | Made-up fixture values |
| The inspector itself | `scripts/phoenix-inspect/lib/route-inventory.ts:435`, `tests/phoenix-inspect-route-inventory.test.ts:96` | The inventory's own note, and a test asserting no role is named M2 |

**Not searched:** git history, the issue tracker and the owner's own documents.

**Nearest names, with nothing linking them to M2:** the page `/admin/m-payroll` ("CEO Payroll View",
`src/config/system-navigation.ts:3731`) and the role "Manager". Which one M2 meant, if either, is the
owner's call.

---

## 5. What must be built

Ordered. B1 to B9 come before any second module runs.

| # | What | Where | Done when |
| --- | --- | --- | --- |
| B1 | **A module contract.** Each `modules/<id>.mjs` exports `id`, `personas` (ids only), `states`, `basePathFor`, `statesFor`, `viewportsFor`, `addressFor`, `neverTouch`, `neverOpenPages`, `sourceFiles`, `docs`, and optionally `mocks`, `deniedProbe` and `tabs`. | `scripts/phoenix-inspect/modules/` | `kpis.mjs` passes the contract test unchanged in behaviour. |
| B2 | **One registry for modules and personas.** Persona ids are defined once, and a module lists only which of them it uses and their matrix. | A new `modules/index.mjs` and `personas.mjs`. Read by `explore.mjs:38`, `make-persona-secrets.mjs:35`, `mcp-server.mjs:34,49` and `on-spare.ps1:98`. | No file outside `modules/` imports `kpis.mjs`. |
| B3 | ✅ **Done 14 Nov 2026.** **A fence deny list built from source**, not from a hand-kept list. Generate it from `access-registry.ts` (export, mutation and audit-required access-read entries), plus every GET-only route whose handler writes. Widen the patterns for `-export`, `-download`, `/pdf`, `/print`, `/pack`, `bank-file`, `template`, `/cv`, `attachment`, `/file`, `photo`, `/share/` and `contact-numbers`, and name `case-map-basemap`. | `lib/fence.mjs` | A test walks `app/api`, finds every GET route that writes or serves a file, and fails on any one the fence lets through. Today that test would list the 13 unfenced writers marked in §3 and the 78 unfenced file routes counted in §3.1. |
| B4 | ✅ **Done 14 Nov 2026** (built from source with B3, refused for every module, not per module). **A never-open page list** for renders that write: the portal incentive page and the marketing-request decision page. | Module spec plus `explore.mjs` | The plan refuses those addresses before a browser opens. |
| B5 | **A review of the source literals** for each module before its first run. No person's name may sit in `SOURCE_FILES`, because `redact.mjs` would keep it. | Module spec | A written pass per module, plus a test that fails on a capitalised two-word literal outside an allow-list. |
| B6 | **A 375 px viewport**, kept beside 390, to match AGENTS.md §7. | `lib/safety.mjs:12` | Plans list both widths. |
| B7 | **Mocks and the denial probe moved into the spec.** | `lib/capture.mjs:268,279,388-405` | Running capture.mjs on a module with no mocks skips those states and says so. |
| B8 | **A landing state per shell, and a docs map per module** with an honest "no doc yet". | `mcp-server.mjs:49,277,304,308,321-322` | Asking for docs of a module with none answers instead of throwing. |
| B9 | **Device denial and honest blanks.** Deny geolocation, camera and notifications explicitly in the browser context. Never act on a file input. Add the words capture, photo, camera, location, check-in and share to the refused controls. Record a 204 from a fenced POST-read as *write-stopped*, and a blank Maps canvas as *map not loaded*. | `lib/capture.mjs`, `lib/safety.mjs:47`, `lib/measure.mjs` | The safety test covers each case. |
| B10 | **Correct the dry-run text.** The server fence ignores GET. | `lib/fence.mjs:24-26`, `INSPECTION_PERSONAS.md:23-26` | Both texts say that GET-time writes are real. |
| B11 | **Tests and smoke checks parametrised by module.** | `self-check.mjs`, `mcp-smoke.mjs`, `tests/phoenix-inspect-*.test.ts` | Each one runs once per registered module. |
| B12 | **Tab declarations** for the three other derivable pages. | `lib/route-inventory.ts:90-97` | The inventory lists their tabs. |
| B13 | **Masking proof for money modules** (needed only for §6, wave F). | `lib/redact.mjs`, module spec | Four proofs: (a) a redaction test built from that module's own figure fields fails when one figure leaks; (b) every money file route is fenced (B3); (c) render-time writers are refused (B4); (d) the first run's artifacts are reviewed before they are kept. |

**Owner decisions this roadmap does not take:**

- Personas for the 11 roles in §2.4. No login is created.
- Super Admin inspection, which needs the second sign-in step and is never bypassed.
- Whether staging's Maps key is the production key.
- Whether test accounts should get a server-side GET dry run. That is a product change, not an inspector
  change.

---

## 6. Expansion order

Order rule: modules that are read-only or share KPIs code go first. Personal-data modules come later.
Super-Admin-only modules wait on the owner. Money comes **last**, and only with B13's masking proof.

- **Write-risk** sums up §3 for each module:
  - *Low*: no GET writer, no device API.
  - *Medium*: an unfenced GET writer or file route that B3 fixes, or blank panes.
  - *High*: a write on render, GPS or camera, or money files.
- **Reuse** shows how much existing KPIs code or inspector state carries over.

| Order | Module | Portal | Routes (pairs) | Personas available | Sensitivity | Write-risk | Reuse | Effort | Prerequisites |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | Platform work B1 to B12 | n/a | n/a | n/a | n/a | n/a | Converts the KPIs module | L | None |
| 1 | reps-list | Admin, portal | 2 | dm, nsm, sfe, ceo | Medium | Low | Shares KPIs code (`reps-list-board.ts:54`) | S | B1, B2 |
| 2 | ranks-early-birds | Admin, HR, portal | 6 | rep, dm, nsm, sfe, hrr, ceo | Medium | Low | Rendered on the server; few client states | S | B3 (the rep-ranks certificate) |
| 3 | business-review | Admin, portal | 2 | rep, dm, nsm, sfe, ceo | Medium | Medium | Shares KPIs code (`crm-kpis.ts:22`, `kpi-sections.ts`) | M | B3 (`business-review/pack:334`) |
| 4 | team-performance | Portal | 3 | dm, nsm | Medium | Low | Portal shell already driven | S | B1 |
| 5 | double-visits (analytics and report pages only) | Admin, portal | 6 | All field personas | Medium | Medium | Field personas already exist | M | B3 (`audit-export`); request pages deferred to wave F |
| 6 | Field CRM manager boards: team visits, weekly sheet, district manager plans (part of crm-data-quality) | Admin, portal | 3 admin pairs; the portal twins open from inside the portal field CRM page | dm, nsm, sfe, ceo (per page: not verified) | Medium | Low (exports already fenced) | Shares KPIs code (`team-visits-view.tsx:3,5`) | M | B1, B7 |
| 7 | organogram-360 | Admin, HR, portal | 6 | All seven | High | Medium | Generic | M | B3 (`contact-numbers:112`, organogram PDF), B5 |
| 8 | targets-make-it-happen | Admin, portal | 4 | rep, dm, nsm, sfe, ceo | Medium | Medium | Generic | S | B3 (targets template, Make It Happen Excel route) |
| 9 | sales-dashboards | Admin, portal | 9 | rep, dm, nsm, sfe, ceo | Medium | Low | Heavy client state | L | B1; states listed by hand |
| 10 | weekly-sales | Admin, portal | 8 | rep, dm, nsm, sfe, ceo | Medium | Medium | Generic | M | B3 (three weekly exports) |
| 11 | monthly-closing | Admin, portal | 6 | rep, dm, nsm, sfe, ceo | Medium | Medium | Generic | M | B3 (premium PDF) |
| 12 | marketing-roi | Admin, portal | 7 | rep, dm, nsm, sfe, ceo | Medium | Low | Generic | M | B1 |
| 13 | plans | Admin, HR, portal | 5 | dm, nsm, sfe, hrr, ceo | Medium | Low | Generic | S | B1 |
| 14 | field-absence-compliance | Admin, portal | 4 | nsm, sfe, ceo | High | Medium | Generic | S | B3 (`live-snapshots:61`) |
| 15 | command-centers (finance command center excluded until wave F) | Admin, HR, portal | 7 | All seven | High | Medium | `home-snapshot.ts` shares KPIs code | L | B3 (`cib-download` and `fab-download` fenced), B8 |
| 16 | visits-maps-activity | Admin, portal | 7 | All field personas, ceo | High | High | Generic | M | B3 (`field-activity/pdf`), B9 |
| 17 | phoenix-crm-workspace | Admin, portal | 7 | All field personas, ceo | Medium | High | Generic | L | B3 (both `master-export`), B9 |
| 18 | crm-data-quality (the rest) | Admin, portal | 14 | emp, rep, dm, nsm, sfe, ceo | High | High | Generic | L | B3 (`list/template:37`, `case-map-basemap`), B9 |
| 19 | market-awareness-functions | Admin, portal | 10 | nsm, sfe, ceo | Medium | Medium | Generic | M | B3 (visual-aid file) |
| 20 | direct-orders | Admin, portal | 15 | rep, dm, nsm, sfe, ceo | Medium | High | Generic | L | B3 (`share/direct-orders/…/file:100`), B9 |
| 21 | customers-master-data | Admin | 9 | sfe, ceo | Medium | Medium | Generic | M | B3 (mapping templates) |
| 22 | sales-imports-mapping | Admin, portal | 10 | dm, nsm, sfe, ceo | Medium | Medium | Generic | M | B3 (`phoenix-template:43`, `raw-template:29`), B9 (uploads) |
| 23 | calendars | Admin, HR, portal | 9 | emp, rep, dm, nsm, hrr, ceo | Medium | Low | Generic | S | B1 |
| 24 | spotlight-milestones | Admin, HR, portal | 7 | rep, dm, hrr, ceo | Medium | Low | Generic | S | B5 |
| 25 | workspace-support | Admin, HR, portal | 5 | All but ceo | Medium | Low | Generic | S | B1 |
| 26 | production-planner | Admin | 1 | ceo | Medium | Low | Generic | S | B1 |
| 27 | pharmacovigilance | Admin, HR, portal | 4 | All seven | High (health) | Medium | Generic | M | B5, B9 |
| 28 | probation | Admin, HR, portal | 9 | dm, nsm, sfe, hrr, ceo | High | Low | Generic | M | B5 |
| 29 | coaching-training | Admin, HR, portal | 11 | dm, nsm, sfe, ceo | Medium | Low | Generic | M | Training Manager persona (owner decision) for full coverage |
| 30 | leave-excuses | Admin, HR, portal | 15 | All seven | High | Medium | Generic | M | B3 (vacation attachments), B5 |
| 31 | attendance | Admin, HR, portal | 22 | Covers 4 of 22 | High | Medium | Generic | L | HR Operations persona (owner decision); B3 (fingerprint export) |
| 32 | employee-records | Admin, HR | 18 | ceo (6 of 18) | High | Medium | Generic | L | HR Operations and HR Administration personas (owner decision); B3 (CV, photo) |
| 33 | recruitment | Admin, HR, portal | 39 | emp, rep, dm, nsm, hrr, ceo | High | Medium | Generic | L | B3 (four CV routes, `day-interviews/cv:26`, offer PDF), B9 |
| 34 | hiring-documents-cards | Admin, HR, portal | 10 | emp, rep, dm, nsm, hrr | High | Medium | Generic | M | B3 (`hiring-pack/*`, `bank-account-letter`) |
| 35 | email-notifications | Admin | 14 | None | High | Medium | Generic | L | Super Admin login (owner decision; second step never bypassed); B9 (blank previews) |
| 36 | platform-admin | Admin, HR | 18 | hrr (1 of 18) | High | High | Generic | L | Super Admin login (owner decision); B3 (`activity/timeline:35`) |
| 37 | approvals-hub | Admin, portal | 10 | dm, nsm, sfe, ceo | Money | Medium | Generic | M | B13 |
| 38 | marketing-requests | Admin, portal | 16 | rep, dm, nsm, sfe, ceo | Money | High | Generic | L | B4 (the decision page), B3 (`share/marketing-requests/…/file:136`), B13 |
| 39 | expenses | Admin, portal | 10 | emp, rep, dm, nsm, ceo | Money | High | Generic | L | B3 (outstation PDF, attachments, photos), B9, B13 |
| 40 | deductions-disputes | Admin, HR, portal | 6 | emp, rep, dm, nsm, ceo | Money | Medium | Generic | M | B3 (attachments), B13 |
| 41 | incentive | Portal | 1 | emp, rep, dm, nsm | Money | High | Generic | S | B4 (the page write at `incentive/page.tsx:48`); B13. Until a capture is possible without rendering the page, it stays **not inspected**. |
| 42 | payroll, plus the finance command center | Admin, HR, portal | 10 | emp, rep, dm, nsm, ceo | Money | High | Generic | L | B3 (`bank-file:67`, `cib-download`, `fab-download`, payslip image), B13, and a Finance Manager persona (owner decision) for full coverage |
