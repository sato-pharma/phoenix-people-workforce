import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildCrmIdentityMaps } from "../src/lib/crm/identity.ts";
import { planRestampDate, resolvePlanRestamps, type PlanRestampRow } from "../src/lib/crm/plan-sync.ts";
import type { EmployeeDirectoryRow } from "../src/lib/employees/employee-directory.ts";

/** Minimal directory row — only the fields the identity waterfall reads. */
function employee(overrides: Partial<EmployeeDirectoryRow> & { hrId: string }): EmployeeDirectoryRow {
  return {
    crmId: null,
    crmUsername: null,
    hireDate: null,
    lastWorkingDate: null,
    ...overrides,
  } as EmployeeDirectoryRow;
}

function planRow(overrides: Partial<PlanRestampRow> & { crm_plan_entry_id: number }): PlanRestampRow {
  return {
    agent_crm_id: null,
    agent_hr_id: null,
    plan_date: null,
    plan_month: null,
    plan_year: null,
    ...overrides,
  };
}

/** The ids resolvePlanRestamps would stamp, mapped to the hr id it would stamp them with. */
function restampsOf(rows: PlanRestampRow[], maps: ReturnType<typeof buildCrmIdentityMaps>): Map<number, string> {
  return new Map(resolvePlanRestamps(rows, maps).map((restamp) => [restamp.crm_plan_entry_id, restamp.agent_hr_id]));
}

/**
 * PLAN ENTRIES WERE NEVER RE-LINKED TO EMPLOYEES (D8).
 *
 * `ireports360_plan_entries.agent_hr_id` was resolved once, at upsert, and a closed month is never
 * fetched again — so a row written before its rep's identity was known stayed null for good. 40,445
 * of 176,410 production rows on 2026-09-13, and a scoped viewer's plan board filters on
 * `agent_hr_id`, so those plans did not exist for them. On top of that the upsert wrote a SILENT null
 * over an hr id the mirror already held, because the plan sync never called the visits sync's
 * identity-preservation step.
 *
 * The re-stamp must still go through the employment guard: filling a handed-over slot's history with
 * the new holder's hr id is the exact misattribution the guard exists to stop.
 */
export function runCrmPlanEntryRestampTests() {
  // A joiner who inherited slot 1602 on 2026-06-20, and a leaver whose slot 1700 went dark after
  // 2026-05-31. The leaver's label is on the roster, but plan entries carry NO name — so a post-exit
  // row has no label to prove it is his own trailing work, and the guard refuses it.
  const maps = buildCrmIdentityMaps([
    employee({ hrId: "AI-0003", crmId: "1602", crmUsername: "Soad.Atef ( Cairo East 1 / A )", hireDate: "2026-06-20" }),
    employee({
      hrId: "B-300",
      crmId: "1700",
      crmUsername: "Mid.Tenure ( Tanta / F )",
      hireDate: "2026-01-01",
      lastWorkingDate: "2026-05-31",
    }),
  ]);

  // ── (A) planRestampDate: weekly uses its own date, monthly the first of its month ──────────
  assert.equal(planRestampDate({ plan_date: "2026-07-04" }), "2026-07-04", "a weekly row is judged on its own plan date");
  assert.equal(
    planRestampDate({ plan_date: null, plan_month: 6, plan_year: 2026 }),
    "2026-06-01",
    "a monthly row is judged on the FIRST of its month, zero-padded",
  );
  assert.equal(planRestampDate({ plan_date: null, plan_month: null, plan_year: 2026 }), null, "an unplaceable row has no date");

  // ── (B) A pre-hire row stays null ────────────────────────────────────────────────────────
  {
    const stamps = restampsOf(
      [
        planRow({ agent_crm_id: 1602, crm_plan_entry_id: 1, plan_date: "2026-06-19" }),
        planRow({ agent_crm_id: 1602, crm_plan_entry_id: 2, plan_date: "2026-06-20" }),
      ],
      maps,
    );
    assert.equal(stamps.has(1), false, "a plan dated the day before the hire date must never be re-stamped onto the joiner");
    assert.equal(stamps.get(2), "AI-0003", "the hire date itself is hers, so its plan IS re-stamped");
  }

  // ── (C) A post-exit row stays null ───────────────────────────────────────────────────────
  {
    const stamps = restampsOf(
      [
        planRow({ agent_crm_id: 1700, crm_plan_entry_id: 3, plan_date: "2026-06-05" }),
        planRow({ agent_crm_id: 1700, crm_plan_entry_id: 4, plan_date: "2026-05-10" }),
      ],
      maps,
    );
    assert.equal(stamps.has(3), false, "a plan dated after the leaver's last working day must stay null — the slot moved on");
    assert.equal(stamps.get(4), "B-300", "a plan inside the leaver's own employment IS re-stamped");
  }

  // ── (D) A monthly row is judged on the first of its month ─────────────────────────────────
  // June 2026 contains days after the joiner's 06-20 hire, so a rule reading any later day of the
  // month would stamp it. The first of the month is before her hire, so it must stay null.
  {
    const stamps = restampsOf(
      [
        planRow({ agent_crm_id: 1602, crm_plan_entry_id: 5, plan_month: 6, plan_year: 2026 }),
        planRow({ agent_crm_id: 1602, crm_plan_entry_id: 6, plan_month: 7, plan_year: 2026 }),
        planRow({ agent_crm_id: 1700, crm_plan_entry_id: 7, plan_month: 5, plan_year: 2026 }),
        planRow({ agent_crm_id: 1700, crm_plan_entry_id: 8, plan_month: 6, plan_year: 2026 }),
      ],
      maps,
    );
    assert.equal(stamps.has(5), false, "a monthly June plan is judged on 2026-06-01, before the joiner's hire — it stays null");
    assert.equal(stamps.get(6), "AI-0003", "a monthly July plan is judged on 2026-07-01 and is hers");
    assert.equal(stamps.get(7), "B-300", "a monthly May plan is judged on 2026-05-01, inside the leaver's employment");
    assert.equal(stamps.has(8), false, "a monthly June plan is judged on 2026-06-01, after the leaver's exit — it stays null");
  }

  // ── (E) An already-stamped row is never emitted ──────────────────────────────────────────
  {
    const stamps = restampsOf(
      [planRow({ agent_crm_id: 1602, agent_hr_id: "B-OLD", crm_plan_entry_id: 9, plan_date: "2026-07-01" })],
      maps,
    );
    assert.equal(stamps.has(9), false, "a row that already carries an hr id is never re-decided by the re-stamp");
  }

  // ── (F) Nothing is invented for a row nobody can name or date ─────────────────────────────
  {
    const stamps = restampsOf(
      [
        planRow({ agent_crm_id: 9999, crm_plan_entry_id: 10, plan_date: "2026-07-01" }),
        planRow({ agent_crm_id: 1602, crm_plan_entry_id: 11 }),
      ],
      maps,
    );
    assert.equal(stamps.size, 0, "an unknown crm id, or a row with no date to guard against, is left alone");
  }

  // ── (G) The poller runs the re-stamp after every successful deep run, firewalled ───────────
  const pollerSource = readFileSync(new URL("../src/lib/crm/live-poller.ts", import.meta.url), "utf8");
  const scheduledWork = pollerSource.match(/async function runScheduledWork\([\s\S]*?\n\}\n/)?.[0] ?? "";
  assert.ok(scheduledWork, "runScheduledWork must exist");
  const successPath = scheduledWork.slice(0, scheduledWork.indexOf("} catch (error) {"));
  const captureAt = successPath.indexOf("await runProbationDvCapture(");
  const restampAt = successPath.indexOf("await runPlanEntryRestamp();");
  assert.ok(captureAt >= 0, "runScheduledWork's success path must still capture probation DV days");
  assert.ok(
    restampAt > captureAt,
    "runScheduledWork's success path must call runPlanEntryRestamp AFTER runProbationDvCapture",
  );
  const restampFn = pollerSource.match(/async function runPlanEntryRestamp\([\s\S]*?\n\}\n/)?.[0] ?? "";
  assert.match(restampFn, /await restampUnmappedPlanEntries\(\)/, "the poller step must run restampUnmappedPlanEntries");
  assert.match(
    restampFn,
    /\} catch \(error\) \{\s*\n\s*logError\([\s\S]*plan_entry_restamp_failed/,
    "a re-stamp failure must be logged under plan_entry_restamp_failed, never thrown into the visits run",
  );
  assert.doesNotMatch(
    restampFn,
    /pingDeadMansSwitch|notify/,
    "a re-stamp failure must not ping the visits dead-man's switch or notify anyone",
  );

  // ── (H) Both plan upserts preserve a resolved identity before writing ──────────────────────
  const planSource = readFileSync(new URL("../src/lib/crm/plan-sync.ts", import.meta.url), "utf8");
  for (const name of ["syncIReports360WeeklyPlans", "syncIReports360MonthlyPlans"]) {
    const body = planSource.match(new RegExp(`export async function ${name}\\([\\s\\S]*?\\n\\}\\n`))?.[0] ?? "";
    assert.ok(body, `${name} must exist`);
    const preserveAt = body.indexOf("await preserveResolvedIdentities({");
    const upsertAt = body.indexOf(".upsert(batch");
    assert.ok(preserveAt >= 0 && upsertAt > preserveAt, `${name} must call preserveResolvedIdentities before its upsert`);
    const preserveCall = body.slice(preserveAt, upsertAt);
    assert.match(
      preserveCall,
      /resolveEmployeeAttribution\(row\.agent_crm_id, null, maps, planRestampDate\(row\)\)/,
      `${name} must judge the stored identity on the same date the re-stamp uses`,
    );
    assert.match(preserveCall, /keyColumn: "crm_plan_entry_id"/, `${name} must key preservation on crm_plan_entry_id`);
    assert.match(preserveCall, /table: CRM_PLAN_ENTRIES_TABLE/, `${name} must read stored identities from the plan table`);
  }

  // ── (I) The re-stamp only ever writes null rows, in URL-safe chunks ────────────────────────
  const restampBody = planSource.match(/export async function restampUnmappedPlanEntries\([\s\S]*?\n\}\n/)?.[0] ?? "";
  assert.match(
    restampBody,
    /\.update\([\s\S]*?\.in\("crm_plan_entry_id", chunk\)\s*\n\s*\.is\("agent_hr_id", null\)/,
    "the update must repeat the is-null filter, so a row stamped since the read is never overwritten",
  );
  assert.match(planSource, /const RESTAMP_UPDATE_CHUNK = 50;/, "a long .in() list is a silent no-op — updates stay at 50 ids");
}
