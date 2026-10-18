import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildPlanAdherenceHistory,
  countsAsKept,
  isCheckableActivity,
  isScoredInAdherenceHistory,
  isScoredVerdict,
  PLAN_ADHERENCE_HISTORY_EXCLUDED_STATUSES,
  planAdherenceTone,
  planAdherenceVerdictLabel,
  scorePlanAdherence,
  type PlanAdherenceEvidence,
  type PlanAdherenceHistoryEntry,
  type PlanItemForAdherence,
} from "../src/lib/weekly-planning/plan-adherence.ts";

/** The manager whose week is being scored, and the reps he plans to go out with. */
const OWNER = "dsm-201";
const REP_A = "rep-701";
const REP_B = "rep-702";

/** A fixed "today" so a finished week and a running one can both be scored deterministically. */
const TODAY = "2026-08-28";

function item(overrides: Partial<PlanItemForAdherence> = {}): PlanItemForAdherence {
  return {
    activityDate: "2026-08-24",
    activityTitle: "Double visit with the rep",
    activityType: "Double Visit",
    id: "item-1",
    partnerHrId: REP_A,
    partnerName: "Ahmed Samir",
    ...overrides,
  };
}

function evidence(overrides: Partial<PlanAdherenceEvidence> = {}): PlanAdherenceEvidence {
  return {
    nameByHrId: new Map([
      [REP_A, "Ahmed Samir"],
      [REP_B, "Mona Fouad"],
      [OWNER, "Khaled Abdel Aziz"],
    ]),
    ownerActiveDates: new Set<string>(),
    ownerPartnersByDate: new Map<string, Set<string>>(),
    personActiveDayKeys: new Set<string>(),
    ...overrides,
  };
}

export function runPlanAdherenceTests(): void {
  // ── The verdicts ───────────────────────────────────────────────────────────

  {
    // He said he would go out with Ahmed on Monday, and the CRM says he did.
    const score = scorePlanAdherence([item()], evidence({
      ownerActiveDates: new Set(["2026-08-24"]),
      ownerPartnersByDate: new Map([["2026-08-24", new Set([REP_A])]]),
    }), { today: TODAY });

    assert.equal(score.items[0]?.verdict, "kept", "the planned rep is exactly who he was out with");
    assert.equal(score.scorePct, 100);
    assert.equal(score.items[0]?.advice, null, "a kept item has nothing to advise");
  }

  {
    // He WAS in the field — with somebody else.
    //
    // OWNER RULE, 2026-08-28: this COUNTS AS KEPT. He was asked in plain words whether a partner
    // swap agreed on the day should score as kept and answered yes. The day was worked; which
    // colleague ended up beside him is a detail the CRM cannot tell apart from a verbal agreement.
    // The verdict stays distinct so the swap is still visible — it is simply not deducted.
    const score = scorePlanAdherence([item()], evidence({
      ownerActiveDates: new Set(["2026-08-24"]),
      ownerPartnersByDate: new Map([["2026-08-24", new Set([REP_B])]]),
    }), { today: TODAY });

    const row = score.items[0];
    assert.equal(row?.verdict, "wrong_partner", "the swap is still reported as its own verdict, not folded into kept");
    assert.deepEqual(
      row?.actualPartnerNames,
      ["Mona Fouad"],
      "who he actually went with is reported BY NAME — the owner's standing rule is never a raw id",
    );
    assert.ok(row?.advice?.includes("Mona Fouad"), "the advice names the person, so it can be acted on");
    assert.ok(row?.advice?.includes("Ahmed Samir"), "and names who was planned, so the gap is visible");

    assert.equal(score.scorePct, 100, "a partner swap SCORES AS KEPT — owner's rule, 2026-08-28");
    assert.equal(score.kept, 1, "and it lands in the numerator, not merely outside the denominator");
    assert.equal(score.checkable, 1, "the day is still a day the CRM answered for");
    assert.ok(countsAsKept("wrong_partner"), "the rule lives in KEPT_VERDICTS, where one place decides it");
    assert.ok(isScoredVerdict("wrong_partner"), "and it is still measured — credited is not the same as ignored");

    // The wording has to agree with the arithmetic. A row labelled like a fault beside a score that
    // does not deduct for it is how a manager stops believing the number.
    assert.match(
      row?.advice ?? "",
      /[Cc]ounted as kept/,
      "the advice says it counted, rather than telling him to fix a day he is not marked down for",
    );
    assert.match(
      planAdherenceVerdictLabel("wrong_partner"),
      /^Kept/,
      "and the label leads with Kept, so the screen never contradicts the score",
    );
  }

  {
    // A swap and a real miss in the same week, so the two sides of the fraction are proven apart
    // rather than each on its own. Before the owner's 2026-08-28 rule this week scored 33%.
    const score = scorePlanAdherence(
      [
        item({ activityDate: "2026-08-24", id: "kept-as-planned" }),
        item({ activityDate: "2026-08-25", id: "swapped" }),
        item({ activityDate: "2026-08-26", id: "never-happened" }),
      ],
      evidence({
        ownerActiveDates: new Set(["2026-08-24", "2026-08-25"]),
        ownerPartnersByDate: new Map([
          ["2026-08-24", new Set([REP_A])],
          ["2026-08-25", new Set([REP_B])],
        ]),
      }),
      { today: TODAY },
    );

    assert.deepEqual(
      score.items.map((i) => i.verdict),
      ["kept", "wrong_partner", "no_trace"],
      "the three days are still told apart",
    );
    assert.equal(score.kept, 2, "the swap is credited alongside the day that went exactly to plan");
    assert.equal(score.checkable, 3);
    assert.equal(score.scorePct, 67, "2 of 3 — a swap credits, a day nobody worked still does not");
  }

  {
    // Ahmed worked that day. The manager was not with him.
    const score = scorePlanAdherence([item()], evidence({
      personActiveDayKeys: new Set([`2026-08-24|${REP_A}`]),
    }), { today: TODAY });

    assert.equal(score.items[0]?.verdict, "partner_alone");
    assert.ok(
      score.items[0]?.advice?.includes("without you"),
      "partner_alone must not read like the rep did something wrong — he worked; the manager did not join",
    );
  }

  {
    // Neither of them logged anything. The day did not happen as written.
    const score = scorePlanAdherence([item()], evidence(), { today: TODAY });
    assert.equal(score.items[0]?.verdict, "no_trace");
    assert.ok(score.items[0]?.advice?.includes("revise the plan"), "the fix for a moved day is to revise it");
  }

  // ── The two rules that stop the score from lying ────────────────────────────

  {
    // A plan approved on Friday for next week must NOT open at 0%. Production carries plan
    // items dated through 2026-09-03, so this is the ordinary case, not an edge case.
    const score = scorePlanAdherence(
      [item({ activityDate: "2026-09-02", id: "future" })],
      evidence(),
      { today: TODAY },
    );

    assert.equal(score.items[0]?.verdict, "not_yet_due");
    assert.equal(score.notYetDue, 1);
    assert.equal(score.checkable, 0, "a day that has not happened is not in the denominator");
    assert.equal(score.scorePct, null, "a plan that is entirely still to come scores NULL, never 0");
  }

  {
    // THE HEADLINE. A week of office days, meetings and vacation is not a 0% week. Production's
    // 640 plan items are 177 Office, 28 National Vacation, 19 Meeting, 10 Meeting with Team,
    // 8 Vacation, 8 Travel, 6 Admin, 5 Training — none of which the CRM can confirm or deny.
    // Scoring them would manufacture a failure out of an ordinary Tuesday, and ranking a manager
    // on it would punish him for the admin he was given.
    const score = scorePlanAdherence(
      [
        item({ activityType: "Office", id: "o1", partnerHrId: null, partnerName: null }),
        item({ activityType: "Meeting", id: "o2", partnerHrId: null, partnerName: null }),
        item({ activityType: "National Vacation", id: "o3", partnerHrId: null, partnerName: null }),
      ],
      evidence(),
      { today: TODAY },
    );

    assert.equal(score.notCheckable, 3, "office, meeting and vacation are reported as untracked, not swallowed");
    assert.equal(score.checkable, 0, "and none of them reaches the denominator");
    assert.equal(
      score.scorePct,
      null,
      "a plan with nothing verifiable in it scores NULL, never 0 — a 0 here is a scoreboard lie",
    );
    assert.equal(score.measurable, false, "and it says so, so no screen can sort or rank on the number");
  }

  {
    // 11 of production's 314 double-visit rows name no rep at all. There is nothing to confirm.
    const score = scorePlanAdherence(
      [item({ id: "unnamed", partnerHrId: null, partnerName: null })],
      evidence(),
      { today: TODAY },
    );
    assert.equal(score.items[0]?.verdict, "not_checkable", "no named partner means nothing to check, not a miss");
    assert.equal(score.checkable, 0);
  }

  // ── A field day asks a simpler question ─────────────────────────────────────

  {
    const kept = scorePlanAdherence(
      [item({ activityType: "Field", id: "f1", partnerHrId: null, partnerName: null })],
      evidence({ ownerActiveDates: new Set(["2026-08-24"]) }),
      { today: TODAY },
    );
    assert.equal(kept.items[0]?.verdict, "kept", "a field day only asks whether he was out at all");

    const missed = scorePlanAdherence(
      [item({ activityType: "Field", id: "f2", partnerHrId: null, partnerName: null })],
      evidence(),
      { today: TODAY },
    );
    assert.equal(missed.items[0]?.verdict, "no_trace");
  }

  assert.equal(isCheckableActivity("double visit"), true, "activity type is matched case-insensitively");
  assert.equal(isCheckableActivity("Field"), true);
  assert.equal(isCheckableActivity("Meeting with Team"), false);
  assert.equal(isCheckableActivity(null), false);

  // ── The mixed week, which is what a real plan looks like ────────────────────

  {
    const score = scorePlanAdherence(
      [
        item({ activityDate: "2026-08-24", id: "a" }),
        item({ activityDate: "2026-08-25", id: "b" }),
        item({ activityDate: "2026-08-26", id: "c", partnerHrId: REP_B, partnerName: "Mona Fouad" }),
        item({ activityDate: "2026-08-27", activityType: "Office", id: "d", partnerHrId: null, partnerName: null }),
        item({ activityDate: "2026-09-01", id: "e" }),
      ],
      evidence({
        ownerActiveDates: new Set(["2026-08-24", "2026-08-25"]),
        ownerPartnersByDate: new Map([
          ["2026-08-24", new Set([REP_A])],
          ["2026-08-25", new Set([REP_A])],
        ]),
      }),
      { today: TODAY },
    );

    assert.equal(score.kept, 2);
    assert.equal(score.checkable, 3, "two kept, one missed — the office day and the future day are outside");
    assert.equal(score.notCheckable, 1);
    assert.equal(score.notYetDue, 1);
    assert.equal(score.scorePct, 67, "2 of 3, rounded");
    assert.equal(score.measurable, true);
    assert.equal(score.scoredThrough, TODAY, "the screen has to be able to say what it scored through");
  }

  // ── The history tab ─────────────────────────────────────────────────────────

  {
    const entries: PlanAdherenceHistoryEntry[] = [
      { checkable: 1, kept: 0, measurable: true, periodEndDate: "2026-08-15", periodKey: "2026-W33", periodStartDate: "2026-08-09", planId: "p1", scorePct: 0, status: "hr_acknowledged" },
      { checkable: 10, kept: 10, measurable: true, periodEndDate: "2026-08-22", periodKey: "2026-W34", periodStartDate: "2026-08-16", planId: "p2", scorePct: 100, status: "hr_acknowledged" },
      { checkable: 0, kept: 0, measurable: false, periodEndDate: "2026-08-29", periodKey: "2026-W35", periodStartDate: "2026-08-23", planId: "p3", scorePct: null, status: "final_approved" },
    ];
    const history = buildPlanAdherenceHistory(entries);

    assert.equal(history.entries[0]?.planId, "p3", "newest period first");
    assert.equal(history.entries[2]?.planId, "p1");
    assert.equal(
      history.averagePct,
      91,
      "weighted by items (10 of 11), not a mean of percentages — a 1-item week must not outweigh a 10-item one",
    );
    assert.equal(history.measuredPeriods, 2, "the unmeasurable week is excluded, not counted as a zero");
    assert.equal(history.totalCheckable, 11);
  }

  {
    const empty = buildPlanAdherenceHistory([]);
    assert.equal(empty.averagePct, null, "no history is not a 0% history");
    assert.equal(empty.measuredPeriods, 0);
  }

  // ── Presentation ────────────────────────────────────────────────────────────

  assert.equal(planAdherenceTone(100), "text-emerald-600");
  assert.equal(planAdherenceTone(95), "text-amber-600");
  assert.equal(planAdherenceTone(75), "text-orange-600");
  assert.equal(planAdherenceTone(40), "text-rose-600");
  assert.equal(planAdherenceTone(null), "text-slate-400", "not measured is neutral, never red");

  assert.equal(planAdherenceVerdictLabel("partner_alone"), "They went without you");
  assert.equal(planAdherenceVerdictLabel("not_checkable"), "Not tracked in CRM");

  // ── The four surfaces, and the links between them ───────────────────────────
  //
  // The owner's ask was explicitly that they connect: "I want them to be linking." A score on the
  // plan, the same score on the dashboard, a click through to where the mismatch is, and a history
  // tab in the approvals hub. Each of those is one wire, and a wire that quietly comes loose leaves
  // a number with no way to act on it — which is the thing being replaced. So each is pinned.

  const service = readFileSync("src/lib/approvals-hub/service.ts", "utf8");
  const detail = readFileSync("src/components/approvals-hub/plan-request-detail.tsx", "utf8");
  const workspace = readFileSync("src/components/approvals-hub/approvals-workspace.tsx", "utf8");
  const planBody = readFileSync("src/components/approvals-hub/plan-approvals-body.tsx", "utf8");
  const commandCenter = readFileSync("src/components/employee-portal/portal-command-center.tsx", "utf8");
  const snapshot = readFileSync("src/lib/employee-portal/home-snapshot.ts", "utf8");

  // 1. A score on every plan.
  assert.match(service, /adherence: PlanAdherenceScore \| null;/, "PlanApprovalDetail carries the score");
  assert.match(service, /const adherence = await loadPlanAdherence\(id\);/, "getPlanApprovalDetail computes it");
  assert.match(detail, /<PlanAdherenceBadge score=\{detail\.adherence\}/, "the plan header shows the score");

  // ...and on the plan LIST too, not only once a plan is opened. "On every plan its score" is where
  // the owner started, and the planner is the screen a manager actually lives in.
  const planner = readFileSync("src/lib/weekly-planning/service.ts", "utf8");
  const plannerUi = readFileSync("src/components/employee-portal/plans-workspace.tsx", "utf8");
  assert.match(planner, /adherence\?: PlanAdherenceScore \| null;/, "EmployeePlan carries the score");
  assert.match(
    planner,
    /await loadPlanAdherenceForPlans\(ownPlanIds\)/,
    "the planner scores the viewer's own plans in ONE batched read, not one per plan",
  );
  assert.match(plannerUi, /<PlanAdherenceBadge score=\{p\.adherence\}/, "and the plan row renders it");

  // 2. Where the mismatch is — the same page, not a number with nowhere to go.
  assert.match(detail, /<PlanAdherenceReport score=\{detail\.adherence\}/, "the plan page shows the breakdown");

  // 3. The overview dashboard, and its click-through.
  assert.match(snapshot, /planAdherence: PortalPlanAdherence \| null;/, "the portal snapshot carries the score");
  assert.match(commandCenter, /<PlanAdherenceDashboardCard/, "the dashboard renders the card");
  assert.match(
    commandCenter,
    /planBaseHref="\/employee-portals\/approvals\/plan"/,
    "and the card links THROUGH to the plan that produced the number — the owner's whole point",
  );

  // 4. The extra approvals tab, prop-gated so it cannot leak onto Vacation and Excuse.
  assert.match(service, /scoreHistory: PlanAdherenceHistory \| null;/, "PlanWorkspaceData carries the history");
  assert.match(planBody, /scoreHistory=\{data\.scoreHistory\}/, "the plan hub passes it in");
  assert.match(workspace, /const showScoreHistoryTab = scoreHistory != null;/, "the tab is prop-gated");
  assert.match(
    workspace,
    /\.\.\.\(showScoreHistoryTab \? \[\{ key: "score-history"/,
    "so Vacation and Excuse — which share this workspace and have nothing to score — never render it",
  );
  assert.match(
    planBody,
    /scoreHistoryPlanBaseHref=\{data\.planDetailBaseHref\}/,
    "and a history row links back to its own plan",
  );

  // 5. Those links are built from a BASE STRING, never a `(planId) => href` callback.
  //
  // This is not style. `plan-approvals-body.tsx` is a server component and ApprovalsWorkspace is a
  // client one, so a function prop cannot be serialised and the page 500s at render — the crash
  // that took out Doctor Coverage, and the way this feature first went red in CI. The repo-wide RSC
  // boundary test catches the server->client case; this pin also catches the two call sites that
  // are server->server today and would start crossing the boundary the moment someone adds
  // "use client" to a parent.
  const report = readFileSync("src/components/weekly-planning/plan-adherence-report.tsx", "utf8");
  assert.ok(
    !/planHref/.test(report),
    "no adherence surface takes a link-building FUNCTION — a function prop cannot cross into a client component",
  );

  // 6. The screen agrees with the arithmetic about a partner swap.
  //
  // The score credits it, so nothing on the page may present it as outstanding work. This is a
  // separate failure from getting the number wrong: a correct 100% sitting above a list headed
  // "to fix" is the version a manager escalates.
  assert.match(
    report,
    /const MISS_ORDER: readonly PlanAdherenceVerdict\[\] = \["partner_alone", "no_trace"\];/,
    "a swap is not one of the misses — the fix list holds only days that did not happen",
  );
  assert.match(report, /counted as kept/, "and the swap chip says so in words, not only in the total");
  for (const [label, source] of [
    ["the portal dashboard", commandCenter],
    ["the approvals hub", planBody],
    ["the approvals workspace", workspace],
  ] as const) {
    assert.ok(
      !/planHref=\{|scoreHistoryPlanHref=\{/.test(source),
      `${label} passes a base path, not a callback`,
    );
  }

  // 7. A rejected plan is not scored in the history, and its replacement is not scored twice.
  //
  // manager_rejected and ceo_rejected are dead ends: the active-period unique index already lets
  // the owner file a REPLACEMENT plan for the same period. The history only left out drafts and
  // cancelled plans, so the rejected one was loaded and scored as no_trace beside its replacement
  // and one week counted twice.
  for (const status of ["draft", "cancelled", "manager_rejected", "ceo_rejected"]) {
    assert.equal(isScoredInAdherenceHistory(status), false, `a ${status} plan is not scored in the history`);
    assert.ok(PLAN_ADHERENCE_HISTORY_EXCLUDED_STATUSES.has(status), `${status} is in the exclusion set`);
  }
  assert.equal(isScoredInAdherenceHistory("MANAGER_REJECTED"), false, "the status is compared case-insensitively");
  for (const status of [
    "submitted",
    "edit_requested",
    "details_requested",
    "manager_approved",
    "manager_returned",
    "ceo_approved",
    "ceo_returned",
    "final_approved",
    "hr_acknowledged",
  ]) {
    assert.equal(isScoredInAdherenceHistory(status), true, `a ${status} plan is still scored - the same plan is reworked or decided`);
  }
  assert.equal(isScoredInAdherenceHistory(null), true, "an unknown status is scored rather than silently hidden");
  const dataSource = readFileSync("src/lib/weekly-planning/plan-adherence-data.ts", "utf8");
  assert.ok(
    dataSource.includes("filter((header) => isScoredInAdherenceHistory(header.status))"),
    "the history query must filter on the shared rule, not a private list that can drift from it",
  );
}
