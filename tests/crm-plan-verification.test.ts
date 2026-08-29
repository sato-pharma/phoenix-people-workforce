import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  PLAN_DOCTORS_ANCHOR_ID,
  PLAN_STATUS_AREA_MANAGER_VERIFIED,
  PLAN_STATUS_NEW,
  PLAN_STATUS_SUPERVISOR_VERIFIED,
  decidePlanVerification,
  isPlanVerified,
  planStatusLabel,
} from "../src/lib/crm/plan-verification.ts";
import { PLAN_STRADDLE_MARGIN_DAYS, monthBounds, summarisePlans } from "../src/lib/crm/plan-board.ts";
import { resolveTeamScope, scopeAllowsAgent } from "../src/lib/crm/manager-scope.ts";
import {
  PLAN_VERIFICATION_ROLES,
  canAccessPlanVerification,
  planVerificationBasisForRole,
} from "../src/lib/crm/plan-verification-access.ts";
import { canAccessDoctorList, doctorListBasisForRole } from "../src/lib/crm/doctor-list-access.ts";
import { assertPlanMonth, rowFromMonthlyPlanEntry } from "../src/lib/crm/plan-sync.ts";
import { NEW_PLAN_ANNOUNCE_LIMIT, planPeriodLabel } from "../src/lib/crm/plan-notifications.ts";
import { permissionResources } from "../src/lib/auth/permissions.ts";

/**
 * Plan Verification — tab two of the District Manager page, and the ONLY thing Phoenix writes back
 * into the customer's CRM.
 *
 * ## What each block here is actually defending
 *
 * 1. NO DOWNGRADE. The vendor has three statuses — 0 New, 1 Supervisor Verified, 2 Area Manager
 *    Verified — and the vendor does NOT range-check the value it is sent (proven live against a
 *    phantom plan id, 2026-08-28). So the only thing standing between a district manager's click and
 *    an area manager's signature being erased is `decidePlanVerification`. It is pure for exactly
 *    that reason.
 *
 * 2. THE MONTH-STRADDLE RULE. 265 of production's 2,388 weekly plans (11%) cross a month boundary.
 *    Filtering entries on `plan_date BETWEEN month start AND end` splits such a plan in two and shows
 *    a manager half of it, twice, with a doctor count that is wrong in both halves. A plan belongs to
 *    the month its FIRST day falls in, whole.
 *
 * 3. AN EMPTY SCOPE IS NOT AN EMPTY BOARD. PostgREST reads `.in("agent_hr_id", [])` as "no rows", and
 *    an empty plans board is indistinguishable from "my reps have filed nothing" — a sentence a
 *    manager would believe and act on. A seat with no reports must resolve to `none` carrying a
 *    reason, and it must not be constructible any other way.
 *
 * 4. THE PERMISSION IS REAL AT RUNTIME. `crm_plans` is a NEW resource. Two failure modes are checked
 *    here rather than trusted to the compiler: a resource missing from the runtime
 *    `permissionResources` array makes the sidebar's lookup FAIL OPEN (the documented trap on
 *    `early_birds`), and a role map is a partial Record, so a missing grant is not a type error — it
 *    is a district manager who cannot use the feature built for him, discovered in production.
 */

// ── Fixtures ─────────────────────────────────────────────────────────────────────────────────────

type RawRow = Parameters<typeof summarisePlans>[0][number];

function row(overrides: Partial<RawRow> & { crm_plan_id: number | null }): RawRow {
  return {
    agent_crm_id: 500,
    agent_hr_id: "SA-0001",
    contact_crm_id: 1,
    plan_date: "2026-08-10",
    plan_month: null,
    plan_status: PLAN_STATUS_NEW,
    plan_year: null,
    synced_at: "2026-08-28T06:00:00.000Z",
    ...overrides,
  } as RawRow;
}

type ScopeEmployee = Parameters<typeof resolveTeamScope>[0]["employees"][number];

function employee(hrId: string, managerHrId: string | null, employmentStatus = "Active"): ScopeEmployee {
  return { employmentStatus, hrId, managerHrId, pendingManagerReplacementForHrId: null };
}

export function runCrmPlanVerificationTests() {
  // ── 1. The status vocabulary, and the refusal to lower one ────────────────────────────────────
  assert.equal(planStatusLabel(PLAN_STATUS_NEW), "Pending");
  assert.equal(planStatusLabel(PLAN_STATUS_SUPERVISOR_VERIFIED), "Verified");
  assert.equal(planStatusLabel(PLAN_STATUS_AREA_MANAGER_VERIFIED), "Verified by area manager");
  assert.equal(planStatusLabel(null), "Unknown", "a plan with no status must not read as pending");
  assert.equal(isPlanVerified(PLAN_STATUS_NEW), false);
  assert.equal(isPlanVerified(PLAN_STATUS_AREA_MANAGER_VERIFIED), true);

  const pending = decidePlanVerification({ currentStatus: PLAN_STATUS_NEW });
  assert.equal(pending.allowed, true);
  assert.equal(
    pending.allowed && pending.nextStatus,
    PLAN_STATUS_SUPERVISOR_VERIFIED,
    "verifying moves a plan from New to Supervisor Verified — never straight to Area Manager Verified",
  );

  // THE ONE THAT MATTERS. The vendor accepts any integer, so this refusal is the whole guard: a
  // district manager clicking Verify on a plan an area manager already signed must not lower it.
  const signed = decidePlanVerification({ currentStatus: PLAN_STATUS_AREA_MANAGER_VERIFIED });
  assert.equal(signed.allowed, false, "an area-manager-verified plan can NEVER be moved back down a level");
  assert.match(
    signed.allowed ? "" : signed.reason,
    /area manager/i,
    "the refusal has to say WHO already signed it, or the manager retries and reads a bug",
  );

  assert.equal(decidePlanVerification({ currentStatus: PLAN_STATUS_SUPERVISOR_VERIFIED }).allowed, false);
  assert.equal(decidePlanVerification({ currentStatus: null }).allowed, false);
  // An unrecognised status is refused, not defaulted. A new vendor status must not be silently
  // overwritten by ours.
  const unknown = decidePlanVerification({ currentStatus: 7 });
  assert.equal(unknown.allowed, false);
  assert.match(unknown.allowed ? "" : unknown.reason, /7/, "the refusal names the status it did not recognise");

  // ── 2. Grouping entries into plans, and the month-straddle rule ────────────────────────────────
  const bounds = monthBounds(8, 2026);
  assert.deepEqual(bounds, { end: "2026-08-31", start: "2026-08-01" });
  assert.deepEqual(monthBounds(2, 2026), { end: "2026-02-28", start: "2026-02-01" }, "February must not overrun");
  assert.deepEqual(monthBounds(12, 2026), { end: "2026-12-31", start: "2026-12-01" }, "December must roll the year");

  const grouped = summarisePlans(
    [
      row({ contact_crm_id: 11, crm_plan_id: 900, plan_date: "2026-08-10" }),
      // Same doctor, second day of the same plan — one CONTACT, two ENTRIES.
      row({ contact_crm_id: 11, crm_plan_id: 900, plan_date: "2026-08-11" }),
      row({ contact_crm_id: 12, crm_plan_id: 900, plan_date: "2026-08-12" }),
      // No plan id: belongs to no plan, so there is nothing a manager could verify.
      row({ contact_crm_id: 13, crm_plan_id: null }),
    ],
    { kind: "weekly", keepMonth: { month: 8, year: 2026 } },
  );
  assert.equal(grouped.length, 1, "a row carrying no crm_plan_id must be dropped, not given a synthetic group");
  assert.equal(grouped[0].entries, 3, "entries counts planned CALLS");
  assert.equal(grouped[0].contacts, 2, "contacts counts DISTINCT doctors — a doctor planned twice is one doctor");
  assert.equal(grouped[0].firstDate, "2026-08-10");
  assert.equal(grouped[0].lastDate, "2026-08-12");

  // The straddle rule, both directions. A week running 30 Aug → 5 Sep is AUGUST's, whole, and must
  // NOT also appear in September — the shape that showed a manager half a plan, twice.
  const straddleRows = [
    row({ contact_crm_id: 21, crm_plan_id: 901, plan_date: "2026-08-30" }),
    row({ contact_crm_id: 22, crm_plan_id: 901, plan_date: "2026-09-02" }),
    row({ contact_crm_id: 23, crm_plan_id: 901, plan_date: "2026-09-05" }),
  ];
  const august = summarisePlans(straddleRows, { kind: "weekly", keepMonth: { month: 8, year: 2026 } });
  assert.equal(august.length, 1, "a week that STARTS in August belongs to August");
  assert.equal(august[0].contacts, 3, "and it is shown WHOLE — all three doctors, including September's two");
  assert.equal(august[0].lastDate, "2026-09-05", "the plan keeps its real span; it is not clipped to the month");

  const september = summarisePlans(straddleRows, { kind: "weekly", keepMonth: { month: 9, year: 2026 } });
  assert.equal(september.length, 0, "the same plan must NOT also be listed under September, or it is counted twice");

  // The fetch window has to be wider than the month for the above to be possible at all.
  assert.ok(
    PLAN_STRADDLE_MARGIN_DAYS >= 7,
    "no weekly plan in production spans more than 7 days; a margin below that clips a plan silently",
  );

  // Pending sorts first — the board exists to clear a backlog.
  const sorted = summarisePlans(
    [
      row({ crm_plan_id: 910, plan_date: "2026-08-20", plan_status: PLAN_STATUS_SUPERVISOR_VERIFIED }),
      row({ crm_plan_id: 911, plan_date: "2026-08-03", plan_status: PLAN_STATUS_NEW }),
    ],
    { kind: "weekly", keepMonth: { month: 8, year: 2026 } },
  );
  assert.deepEqual(
    sorted.map((plan) => plan.crmPlanId),
    [911, 910],
    "pending first, even though the verified plan is the newer one",
  );

  // A monthly plan has NO dates. `keepMonth` is not applied to it, or every monthly plan would be
  // dropped for having no first date at all.
  const monthly = summarisePlans(
    [
      row({ contact_crm_id: 31, crm_plan_id: 920, plan_date: null, plan_month: 8, plan_year: 2026 }),
      row({ contact_crm_id: 32, crm_plan_id: 920, plan_date: null, plan_month: 8, plan_year: 2026 }),
    ],
    { kind: "monthly" },
  );
  assert.equal(monthly.length, 1, "a monthly plan carries no plan_date and must survive grouping");
  assert.equal(monthly[0].contacts, 2);
  assert.equal(monthly[0].month, 8);
  assert.equal(monthly[0].year, 2026);

  // ── 3. Scope: an empty reach is a sentence, never an empty board ───────────────────────────────
  const directory = [
    employee("DM-0001", "RM-0001"),
    employee("REP-0001", "DM-0001"),
    employee("REP-0002", "DM-0001"),
    // Resigned: still in the MAP so the tree stays walkable, but never in the RESULT.
    employee("REP-0003", "DM-0001", "Resigned"),
    // Another district entirely.
    employee("DM-0002", "RM-0001"),
    employee("REP-0004", "DM-0002"),
  ];

  const dmScope = resolveTeamScope({ employees: directory, label: "District Manager · own team", viewerHrId: "DM-0001" });
  assert.equal(dmScope.kind, "agents");
  const dmAgents = dmScope.kind === "agents" ? [...dmScope.agentHrIds].sort() : [];
  assert.ok(dmAgents.includes("REP-0001") && dmAgents.includes("REP-0002"), "his own reps resolve");
  assert.ok(!dmAgents.includes("REP-0003"), "a resigned rep is filtered out of the RESULT");
  assert.ok(
    !dmAgents.includes("REP-0004"),
    "another district's rep must never resolve — this is the fault the owner caught on Doctor Coverage",
  );

  // A seat with nobody under it. THE case an empty `.in()` would render as a quiet CRM.
  const barren = resolveTeamScope({ employees: directory, label: "District Manager · own team", viewerHrId: "REP-0001" });
  assert.equal(barren.kind, "none", "a seat with no reports must resolve to `none`, never to an empty allow-list");
  assert.match(barren.kind === "none" ? barren.reason : "", /org tree/i, "and it must say WHY in words");

  const unlinked = resolveTeamScope({ employees: directory, label: "x", viewerHrId: null });
  assert.equal(unlinked.kind, "none", "an account with no employee record cannot resolve a team");

  // `scopeAllowsAgent` is the single answer both the board loader and the verify route ask.
  assert.equal(scopeAllowsAgent(dmScope, "REP-0001"), true);
  assert.equal(scopeAllowsAgent(dmScope, "REP-0004"), false);
  assert.equal(
    scopeAllowsAgent(dmScope, null),
    false,
    "a plan whose rep could not be identified must NOT fall into a manager's lap",
  );
  assert.equal(
    scopeAllowsAgent({ kind: "company", label: "all" }, null),
    true,
    "but a company-scoped viewer DOES see it — an unattributed plan is a finding, not a row to hide",
  );
  assert.equal(scopeAllowsAgent({ kind: "none", reason: "x" }, "REP-0001"), false);

  // ── 4. Role policy: the write list is SHORTER than the read list ───────────────────────────────
  assert.equal(planVerificationBasisForRole("District Manager"), "team", "the seat this feature was built for");
  assert.equal(planVerificationBasisForRole("Regional Manager"), "team");
  assert.equal(planVerificationBasisForRole("Super Admin"), "company");
  assert.equal(
    planVerificationBasisForRole("Medical Rep"),
    null,
    "a rep must not reach the board that signs off his own plan",
  );
  assert.equal(
    planVerificationBasisForRole("SFE Manager"),
    null,
    "SFE reads coverage company-wide but supervises no named rep — reading a rep's numbers and signing " +
      "his plan into the CRM are not the same authority",
  );
  assert.ok(PLAN_VERIFICATION_ROLES.includes("District Manager"));
  assert.equal(canAccessPlanVerification({ role: "District Manager", scope: "company" }), true);
  assert.equal(canAccessPlanVerification({ role: "Medical Rep", scope: "self" }), false);

  // The doctor list (tab one) is deliberately WIDER, and the two lists live in two files precisely
  // so that widening one cannot silently widen the other.
  assert.equal(doctorListBasisForRole("SFE Manager"), "company", "tab one is a read, so SFE is admitted there");
  assert.equal(doctorListBasisForRole("District Manager"), "team");
  assert.equal(canAccessDoctorList({ role: "Medical Rep", scope: "self" }), false);
  assert.equal(
    planVerificationBasisForRole("National Sales Manager"),
    null,
    "NSM reaches a product LINE, not a management subtree — a line is not supervision over a named rep",
  );
  assert.equal(doctorListBasisForRole("National Sales Manager"), "company");

  // ── 5. `crm_plans` is real at RUNTIME, not merely in the type union ────────────────────────────
  // The documented fail-open trap: the sidebar's permission lookup SUCCEEDS on a key it has never
  // seen, so a resource missing from this runtime array offers the page to every role in the company.
  assert.ok(
    permissionResources.includes("crm_plans"),
    "crm_plans MUST be in the runtime permissionResources array — the sidebar lookup fails OPEN on an " +
      "unseen key, which would offer a CRM-writing button to every role",
  );

  // ── 6. Monthly plans are a different shape, and the guard that keeps them one ──────────────────
  assert.doesNotThrow(() => assertPlanMonth(8, 2026));
  assert.throws(() => assertPlanMonth(0, 2026), /month/i, "month 0 is not a month");
  assert.throws(() => assertPlanMonth(13, 2026), /month/i);
  assert.throws(() => assertPlanMonth(8, 1999), /year/i);

  const emptyMaps = {
    crmUsernameByHrId: new Map<string, string>(),
    hireDateByHrId: new Map<string, string>(),
    hrIdByCrmId: new Map<string, string>(),
    hrIdByCrmUsername: new Map<string, string>(),
    hrIdByManualOverride: new Map(),
    lastWorkingDateByHrId: new Map<string, string>(),
  } as Parameters<typeof rowFromMonthlyPlanEntry>[1];

  const monthlyRow = rowFromMonthlyPlanEntry(
    {
      agentID: 500,
      contactID: 77,
      contactName: "Doctor A",
      frequency: 4,
      id: 4242,
      month: 8,
      planID: 920,
      planStatus: PLAN_STATUS_NEW,
      year: 2026,
    } as Parameters<typeof rowFromMonthlyPlanEntry>[0],
    emptyMaps,
  );
  assert.equal(monthlyRow.plan_kind, "monthly");
  assert.equal(monthlyRow.plan_frequency, 4, "a monthly plan carries a frequency instead of repeating the row");
  // EXPLICIT nulls, not omitted keys. A plan that changes kind must not keep a stale date on the
  // mirrored row — an omitted column in an upsert leaves the old value in place.
  assert.equal(monthlyRow.plan_date, null, "a monthly plan has no date, and the column must be actively cleared");
  assert.equal(monthlyRow.start_am, null);
  assert.equal(monthlyRow.start_pm, null);

  // ── 7. The bulk-email guard ───────────────────────────────────────────────────────────────────
  // Production holds 204 pending weekly plans going back to January. A naive "announce everything
  // pending" first run would have emailed all of them at once — a bulk-mail incident, against the
  // owner's standing rule that bulk or test email is never fired.
  assert.ok(
    NEW_PLAN_ANNOUNCE_LIMIT > 0 && NEW_PLAN_ANNOUNCE_LIMIT <= 50,
    "the announce limit exists to stop a first sync emailing a historical backlog; it must be a real ceiling",
  );

  // A period a human can read — never a bare plan id, which is what the rep would otherwise be
  // emailed about. A straddling week names BOTH months, which is the whole point of the label.
  assert.equal(
    planPeriodLabel({ firstDate: "2026-08-30", kind: "weekly", lastDate: "2026-09-05" }),
    "2026-08-30 to 2026-09-05",
  );
  assert.equal(
    planPeriodLabel({ firstDate: "2026-08-30", kind: "weekly", lastDate: "2026-08-30" }),
    "2026-08-30",
    "a single-day plan reads as one date, not as a range from a day to itself",
  );
  assert.equal(planPeriodLabel({ kind: "monthly", month: 8, year: 2026 }), "August 2026");
  // Never an empty string or a bare id: a plan with nothing to place it still has to produce a
  // sentence the rep can read.
  assert.equal(planPeriodLabel({ kind: "weekly" }), "an unrecorded week");
  assert.equal(planPeriodLabel({ kind: "monthly" }), "an unrecorded month");

  // ── 8. Opening a plan has to be VISIBLE ───────────────────────────────────────────────────────
  // The owner's whole report was "I press on the rep name nothing happens". Nothing was broken: the
  // click pushed the URL, the server re-rendered, and the doctors appeared in a section BELOW the
  // entire plans table — off the bottom of the screen, with the only cue at the click site being a
  // bg-orange-50 row, which is #fff7ed and reads as white. A working feature that gives the user no
  // evidence it worked is indistinguishable from a dead button, and he had every reason to call it
  // dead. These pins defend the three things that make the click legible.
  const repoRoot = fileURLToPath(new URL("../", import.meta.url));
  const boardSource = readFileSync(`${repoRoot}src/components/crm/plan-verification-board.tsx`, "utf8");
  const tablesSource = readFileSync(`${repoRoot}src/components/crm/plan-verification-tables.tsx`, "utf8");

  // (a) The two halves of the page agree on where to land, through the shared constant rather than
  // two string literals that only a manual click could ever prove equal. The server half renders the
  // anchor; the client half, which cannot see it at build time, looks it up.
  assert.ok(
    boardSource.includes(`id={PLAN_DOCTORS_ANCHOR_ID}`),
    "the server half must render the scroll anchor, or opening a plan has nothing to scroll to",
  );
  assert.ok(
    tablesSource.includes(`getElementById(PLAN_DOCTORS_ANCHOR_ID)`),
    "the client half must look the anchor up by the shared constant",
  );
  for (const [name, source] of [
    ["board", boardSource],
    ["tables", tablesSource],
  ] as const) {
    assert.ok(
      !source.includes(`"${PLAN_DOCTORS_ANCHOR_ID}"`),
      `the ${name} half must use PLAN_DOCTORS_ANCHOR_ID, never a copy of the literal — two literals drift silently`,
    );
  }

  // (b) The scroll is INSTANT. Chrome abandons a programmatic smooth scroll over a long distance,
  // measured in this repo on 2026-08-21 against a panel 15,489px down: the smooth call moved nothing
  // in 1.8s while the identical instant call landed. A manager with forty reps has exactly that much
  // table above the doctors, so "improving" this to smooth restores the original bug on precisely
  // the boards that suffer from it worst — and it would look fine on any small test board.
  assert.ok(
    tablesSource.includes(`behavior: "auto"`),
    "the landing scroll must be instant",
  );
  // Pinned as the exact option, not the bare word: the comment above the effect explains the smooth
  // trap in prose, and a test that forbade the word would forbid its own explanation.
  assert.ok(
    !tablesSource.includes(`behavior: "smooth"`),
    "a smooth scroll is abandoned by Chrome over a long distance, which is this board's normal case",
  );

  // (c) Desktop has its own way in. The mobile card has always carried a "Show doctors" button; the
  // desktop table had none, so the only route was to guess that the rep's name — plain, unadorned,
  // un-underlined text — was pressable. Both renderings must offer the action.
  const showDoctors = tablesSource.match(/Show doctors/g) ?? [];
  assert.ok(
    showDoctors.length >= 2,
    `the desktop table and the mobile card must BOTH offer "Show doctors" — found ${showDoctors.length} occurrence(s)`,
  );
  assert.ok(
    tablesSource.includes("underline decoration-slate-300"),
    "the rep name is the primary way into a plan and must look pressable, not like plain text",
  );
}
