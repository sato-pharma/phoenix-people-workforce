import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  PLAN_DOCTORS_ANCHOR_ID,
  PLAN_STATUS_AREA_MANAGER_VERIFIED,
  PLAN_STATUS_NEW,
  PLAN_STATUS_SUPERVISOR_VERIFIED,
  decidePlanVerification,
  isPlanVerificationAction,
  isPlanVerified,
  planActionPastTense,
  planStatusLabel,
} from "../src/lib/crm/plan-verification.ts";
import {
  PLAN_STRADDLE_MARGIN_DAYS,
  monthBounds,
  phoenixPlanBoardId,
  repsWithNoPlan,
  summarisePlans,
  type PlanMissingRep,
} from "../src/lib/crm/plan-board.ts";
import { resolveTeamScope, scopeAllowsAgent } from "../src/lib/crm/manager-scope.ts";
import {
  PLAN_VERIFICATION_ROLES,
  canAccessPlanVerification,
  planVerificationBasisForRole,
} from "../src/lib/crm/plan-verification-access.ts";
import { canAccessDoctorList, doctorListBasisForRole } from "../src/lib/crm/doctor-list-access.ts";
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
 *
 * 5. A PHOENIX PLAN IS FOUND BY THE VIEW'S OWN NUMBER. iReports360 was retired on 6 November 2026; a
 *    plan filed in Phoenix CRM is approved through Phoenix CRM's own route, and the board finds its row
 *    by recomputing the negative id the unified view gave it. One helper, pinned to the view's answer.
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
  assert.equal(
    pending.allowed,
    true,
    "no action means VERIFY — every caller written before unverify existed omits it, so a flipped default would turn each of them into an undo",
  );
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

  // ── 1b. UNVERIFY — the owner's 2026-09-01 ask, and the one asymmetry in it ─────────────────────
  //
  // "I want to be able to verify and unverify from Phoenix." The interesting half is what unverify
  // still REFUSES: it is not the mirror image of verify, and every assertion below is a refusal
  // that would be trivially easy to lose by making it one.

  const undo = decidePlanVerification({ action: "unverify", currentStatus: PLAN_STATUS_SUPERVISOR_VERIFIED });
  assert.equal(undo.allowed, true, "a manager must be able to take back the signature this feature wrote");
  assert.equal(
    undo.allowed ? undo.nextStatus : -1,
    PLAN_STATUS_NEW,
    "unverifying returns the plan to Pending — the state it was in before anybody signed it",
  );

  const undoSigned = decidePlanVerification({ action: "unverify", currentStatus: PLAN_STATUS_AREA_MANAGER_VERIFIED });
  assert.equal(
    undoSigned.allowed,
    false,
    "an AREA MANAGER's signature is not Phoenix's to clear: Phoenix never writes status 2, so unverifying it would erase a decision made a level above the person clicking, with nothing left on any screen to say it had happened",
  );
  assert.match(
    undoSigned.allowed ? "" : undoSigned.reason,
    /area manager/i,
    "and the refusal has to name who signed it, or it reads as a bug",
  );

  const undoPending = decidePlanVerification({ action: "unverify", currentStatus: PLAN_STATUS_NEW });
  assert.equal(undoPending.allowed, false, "there is nothing to take back off a plan nobody has signed");
  assert.doesNotMatch(
    undoPending.allowed ? "" : undoPending.reason,
    /already verified/i,
    'a pending plan must NOT be refused with the verify side\'s words: "already verified" and "nothing to take back" are different facts and the manager is entitled to know which one he hit',
  );

  assert.equal(
    decidePlanVerification({ action: "unverify", currentStatus: null }).allowed,
    false,
    "a plan with no status is not a plan to act on in either direction",
  );
  assert.equal(decidePlanVerification({ action: "unverify", currentStatus: 7 }).allowed, false);

  // THE DEFAULT IS VERIFY, and it must stay that way. Every caller written before unverify existed
  // omits the action; if the default ever flipped, or an absent action fell through to whatever the
  // status suggests, a lost field on the wire would silently LOWER a status instead of raising one.
  const defaulted = decidePlanVerification({ currentStatus: PLAN_STATUS_NEW });
  assert.equal(defaulted.allowed && defaulted.nextStatus, PLAN_STATUS_SUPERVISOR_VERIFIED, "no action means VERIFY");
  assert.equal(
    decidePlanVerification({ currentStatus: PLAN_STATUS_SUPERVISOR_VERIFIED }).allowed,
    false,
    "and specifically NOT unverify: an omitted action on a verified plan is refused, never treated as an undo",
  );

  // The route validates through this rather than falling back, so a typo cannot become a CRM write.
  assert.equal(isPlanVerificationAction("verify"), true);
  assert.equal(isPlanVerificationAction("unverify"), true);
  assert.equal(isPlanVerificationAction("Verify"), false, "the check is exact — no case folding, no trimming");
  assert.equal(isPlanVerificationAction(undefined), false);
  assert.equal(isPlanVerificationAction("reject"), false, "reject is not a thing this system can do");

  assert.equal(planActionPastTense("verify"), "verified");
  assert.equal(planActionPastTense("unverify"), "unverified");

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
    // Never started, or not working: the directory does not count them active, and neither does KPIs.
    employee("REP-0005", "DM-0001", "declined_offer"),
    employee("REP-0006", "DM-0001", "inactive"),
    // On leave IS active in the directory, so a rep on leave stays on his manager's board.
    employee("REP-0007", "DM-0001", "on_leave"),
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
    !dmAgents.includes("REP-0005"),
    "a declined-offer person is not on the team — Reps List showed one that KPIs dropped (owner, 2026-09-20)",
  );
  assert.ok(!dmAgents.includes("REP-0006"), "an inactive person is not on the team");
  assert.ok(dmAgents.includes("REP-0007"), "a rep on leave is still active and stays on the team");
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
  assert.equal(
    doctorListBasisForRole("National Sales Manager"),
    "line",
    "an NSM sees his own line's reps on Reps List, as on KPIs and Reps Plans (owner, 2026-09-20)",
  );

  // ── 5. `crm_plans` is real at RUNTIME, not merely in the type union ────────────────────────────
  // The documented fail-open trap: the sidebar's permission lookup SUCCEEDS on a key it has never
  // seen, so a resource missing from this runtime array offers the page to every role in the company.
  assert.ok(
    permissionResources.includes("crm_plans"),
    "crm_plans MUST be in the runtime permissionResources array — the sidebar lookup fails OPEN on an " +
      "unseen key, which would offer a CRM-writing button to every role",
  );

  // ── 6. Opening a plan has to be VISIBLE ───────────────────────────────────────────────────────
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

  // ── 7. A rep who filed NOTHING must still be on the board ─────────────────────────────────────
  //
  // The board is built from plans that exist, so a rep who filed none is not "shown as zero" — he is
  // absent entirely, and "Reps with a plan: 12" reads as complete whether the true roster is 12 or
  // 30. That is the one question this screen could not answer.

  function missing(agentCrmId: number, name: string, hrId: string | null = `SA-${agentCrmId}`): PlanMissingRep {
    return { agentCrmId, hrId, name, pmCount: 100 };
  }

  // (a) The match is on the numeric CRM agent id, never on hr_id. Hr ids are MIXED CASE in this
  // database, so a case-sensitive comparison under-matches — and every under-match here falls in the
  // worst possible direction: it reports a rep who DID file as having filed nothing, which is an
  // accusation rather than a gap. This fixture is the exact shape that trap takes.
  assert.deepEqual(
    repsWithNoPlan({
      plans: [{ agentCrmId: 500 }],
      roster: [missing(500, "Filed", "sa-0500"), missing(501, "Did not file", "SA-0501")],
    }).map((rep) => rep.name),
    ["Did not file"],
    "a rep whose plan exists must never be listed as missing, whatever case his hr id carries",
  );

  // (b) An empty roster yields an empty list — the arithmetic is sound — which is precisely why the
  // board must NOT read that as an all-clear. The mirror is scraped from the CRM's web app and can
  // come back empty for reasons that have nothing to do with planning, so `rosterKnown` carries that
  // distinction and the board renders an "unavailable" message instead of a green zero.
  assert.deepEqual(repsWithNoPlan({ plans: [{ agentCrmId: 1 }], roster: [] }), []);
  assert.ok(
    boardSource.includes("rosterKnown"),
    "the board must distinguish an empty roster from a complete one — a false all-clear is the one wrong answer here",
  );
  assert.ok(
    tablesSource.includes("could not be read"),
    "an unreadable roster must say so in words, not render as zero reps missing",
  );

  // (c) A LEAVER IS NOT A DEFAULTER. The CRM admin deactivates a resigned rep's account rather than
  // deleting it, so his row can outlive him in the mirror; naming him under "Filed nothing" is an
  // accusation the data does not support. Pinned on the shared helper rather than a local status
  // list, because that helper treats an UNKNOWN status as non-terminal — which is what keeps an
  // unresolvable CRM account visible and labelled instead of silently dropped.
  const planBoardSource = readFileSync(`${repoRoot}src/lib/crm/plan-board.ts`, "utf8");
  assert.ok(
    planBoardSource.includes("isTerminalEmploymentStatus"),
    "a rep who has left the company must not be listed as having failed to file",
  );
  // (c2) WHERE EACH PLANNED DOCTOR IS COMES FROM PHOENIX CRM FIRST (owner, 2026-10-31). A Phoenix plan
  // row carries no CRM region, so every started team's plan read a blank locality; the Reps List's own
  // placement answers first and the iReports360 values stay as the fallback.
  const planEntriesBody = planBoardSource.slice(
    planBoardSource.indexOf("export async function getPlanEntries("),
    planBoardSource.indexOf("export type AgentPlanEntryRow"),
  );
  assert.match(planEntriesBody, /await loadContactPlacements\(/, "the plan's doctors are placed by the Reps List's own door");
  assert.match(
    planEntriesBody,
    /address: placement\.address \?\? row\.address, region: placement\.label/,
    "Phoenix CRM's address and brick come first, the iReports360 ones only when Phoenix has none",
  );

  // (d) Sorted by name. The list is read top-down by a manager deciding who to chase, and an
  // arbitrary order makes the same list look different on every refresh.
  assert.deepEqual(
    repsWithNoPlan({ plans: [], roster: [missing(3, "Zaki"), missing(1, "Adel"), missing(2, "Mostafa")] }).map(
      (rep) => rep.name,
    ),
    ["Adel", "Mostafa", "Zaki"],
  );

  // ── 8. A Phoenix plan's board number is the view's ─────────────────────────────────────────────
  //
  // iReports360 was retired on 6 November 2026 (owner: "phx crm replaced the old crm so any module was
  // wired with old crm must wire with phx crm"). The board's Approve posts the plan's own uuid and
  // version, so the board finds each Phoenix plan's row by the number `crm_plan_entries_unified` gave
  // it: `-1 - ('x' || substr(md5(plan_id::text), 1, 8))::bit(30)::integer`. -844718716 is what the view
  // computed on staging for this uuid (tests/phoenix-crm-visits-everywhere.test.ts, STAGING_IDS). A hash
  // that drifted from the view would match no plan, and every Phoenix week would show no button.
  assert.equal(
    phoenixPlanBoardId("00000000-0000-0000-0000-000000000001"),
    -844718716,
    "the board number of a Phoenix plan is the one the unified plan view computes",
  );
  assert.equal(phoenixPlanBoardId("ffffffff-ffff-ffff-ffff-ffffffffffff"), -760078620, "the top thirty bits, never all thirty-two");
  const attachBody = planBoardSource.slice(
    planBoardSource.indexOf("async function attachPhoenixPlanState("),
    planBoardSource.indexOf("export async function getPlanEntries("),
  );
  assert.match(attachBody, /\.from\("phoenix_crm_plans"\)[\s\S]*\.eq\("is_test", false\)/, "real plans only: a test plan never reaches the view");
  assert.match(attachBody, /byBoardId\.set\(phoenixPlanBoardId\(id\)/, "each row is keyed by the one helper");
  assert.equal(
    (planBoardSource.match(/await attachPhoenixPlanState\(|return attachPhoenixPlanState\(/g) ?? []).length,
    2,
    "both plan boards carry it: the month board and the Reps Weekly Plans week, which mount the same button",
  );
}
