import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildPlanAdherenceHistory,
  isCheckableActivity,
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
    // He WAS in the field — with somebody else. The plan went stale; the day did not.
    const score = scorePlanAdherence([item()], evidence({
      ownerActiveDates: new Set(["2026-08-24"]),
      ownerPartnersByDate: new Map([["2026-08-24", new Set([REP_B])]]),
    }), { today: TODAY });

    const row = score.items[0];
    assert.equal(row?.verdict, "wrong_partner");
    assert.deepEqual(
      row?.actualPartnerNames,
      ["Mona Fouad"],
      "who he actually went with is reported BY NAME — the owner's standing rule is never a raw id",
    );
    assert.ok(row?.advice?.includes("Mona Fouad"), "the advice names the person, so it can be acted on");
    assert.ok(row?.advice?.includes("Ahmed Samir"), "and names who was planned, so the gap is visible");
    assert.equal(score.scorePct, 0);
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

  assert.equal(planAdherenceVerdictLabel("partner_alone"), "He went without you");
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

  // 2. Where the mismatch is — the same page, not a number with nowhere to go.
  assert.match(detail, /<PlanAdherenceReport score=\{detail\.adherence\}/, "the plan page shows the breakdown");

  // 3. The overview dashboard, and its click-through.
  assert.match(snapshot, /planAdherence: PortalPlanAdherence \| null;/, "the portal snapshot carries the score");
  assert.match(commandCenter, /<PlanAdherenceDashboardCard/, "the dashboard renders the card");
  assert.match(
    commandCenter,
    /planHref=\{\(planId\) => `\/employee-portals\/approvals\/plan\/\$\{encodeURIComponent\(planId\)\}`\}/,
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
  assert.match(planBody, /scoreHistoryPlanHref=/, "and a history row links back to its own plan");
}
