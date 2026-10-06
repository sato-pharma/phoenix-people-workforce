---
name: a-role-sweep-needs-no-dev-server-when-the-gate-is-a-domain-helper
description: "the Production Planner's role sweep was run with NO dev server - its gate is a client-safe domain helper, so calling productionPlanningLevel plus both asserts for each persona tests the real door for a few hundred MB instead of the ~4 GB a next dev costs, which matters because free RAM was 1,761 MB under the 1,800 MB watchdog floor. Confirm each persona's hr_id and app_role against production first, include the SAME ids in lower case (production stores them mixed-case and === matches nobody with no error), fold in the live prodplan_access_grants rows, and prove the sweep is not self-fulfilling by injecting a grant that wrongly admits the other Manager. Then read the ROUTES separately, because policy is not enforcement. That sweep is also what found two Arabic refusals shipping to an English reader: a source guard matching only double-quoted literals cannot see a template literal, so a sentence that INTERPOLATES needs its own half of the bundle"
metadata:
  node_type: memory
  type: project
  originSessionId: 69a46d99-22f3-404a-b5e3-bad631b64e72
  modified: 2026-10-06T06:44:58.319Z
---

Run on 2026-10-06 for the Production Planner, after the language toggle shipped.

**Why there was no dev server.** Free RAM read **1,761 MB** against the 1,800 MB floor
`mem-watchdog.ps1` defends, and a `next dev` wants about 4 GB — that is the no-dump freeze, not a
slow page. The planner's gate is `src/lib/production-planning/access.ts`, which is deliberately
client-safe (no Supabase import) so the page shells, the workspace and the tests all read the same
door. So the sweep called `productionPlanningLevel` with the real role matrix, plus
`assertProductionPlanningRead` and `assertProductionPlanningWrite`, once per persona.

**All 11 rows correct, `SWEEP-FAILURES=0`:** Omar Gawish, Anwar Gaweesh and Dr. Sahar Khalil full;
Ahmed Al Maraghi and Reham Elwiy read with write **denied**; **Samaa Mosaad denied outright** —
she holds the same `Manager` role as Dr. Sahar, which is exactly why the gate is a named list and
not a matrix grant. A Medical Rep and a plain employee denied. `prodplan_access_grants` is empty,
so today the gate is the named lists plus the matrix.

**The four things that make it real rather than circular:**

1. **Confirm the personas against production** — `employees` joined to `app_auth_users` — rather
   than assuming the roles. All six matched.
2. **Include the same ids in LOWER CASE.** Production stores them mixed-case, so an `===`
   comparison matches nobody with no error at all, which presents as the change never shipping.
   `hrIdsMatch` handles it; the three lower-case rows are what prove that.
3. **Break it.** A stored grant admitting Samaa Mosaad made the sweep report
   `WRONG (expected none)`, `SWEEP-FAILURES=1`. It also confirmed the documented under-reporting:
   a stored grant opens the door but does not light the sidebar row.
4. **Read the routes, because policy is not enforcement.** All eleven writes call `assertWrite` as
   their first statement, including `recordRun` and `savePlan`, which also load data — so a
   read-only person cannot reach a write through the read gate. `listAccessGrants` asserts *write*.
   The one ungated loader, `loadProductionPlanningDataForSystem`, takes no access context and is
   reachable only from the two cron sweeps.

**What the sweep found on the way.** Two refusals were still Arabic template literals inside the
service — the closing-balance one and the refusal to commit a plan while a supplier is unsettled —
and the source guard in `tests/production-planning-strings.test.ts` matched only `"…"`, so both
passed every parity assertion while being the exact defect those assertions exist to stop. They are
also the two refusals that matter most: the only two that name what to go and fix. A sentence that
INTERPOLATES cannot live in the flat errors map, so the bundle now carries a `refusals` half that
owns its own list separator (Arabic joins on the Arabic comma, English on a plain one) and takes the
material name in the reader's own language, since every material stores both. The guard reads
backticks now, proven by putting the original Arabic back — lifted out of git, not escaped by hand.

Left deliberately: a committed plan's stored **title** stays Arabic. Both readers see it later in
the same Plans list, so following whoever saved it would mix two languages in one list.

Related: [[the-python-heredoc-trap]] · [[a-python-heredoc-writes-real-control-chars-into-regex-literals]]
