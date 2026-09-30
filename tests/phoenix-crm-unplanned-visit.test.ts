import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

import { emptyPlanCounts, emptyVisitCounts, groupPlanByTerritory, groupVisitsByRep, planKeptPercent } from "../src/lib/phoenix-crm/report-rules.ts";
import {
  isUnplannedVisitStatus,
  isUnplannedVisitWaiting,
  parseUnplannedReason,
  UNPLANNED_REASON_MAX,
  UNPLANNED_REASON_MIN,
  unplannedFirstStatus,
  unplannedVisitRepNote,
  unplannedVisitStageOf,
  unplannedVisitStatusLabel,
} from "../src/lib/phoenix-crm/unplanned-rules.ts";
import { stripComments, stripCommentsCompact } from "./support/comment-strip.ts";

/**
 * Phoenix CRM — the unplanned (off-plan) visit.
 *
 * Owner, 2026-09-26: the rep chooses the KIND of visit before he chooses the doctor. A PLANNED visit
 * offers only the doctors on a plan he has sent for today; an UNPLANNED one opens his whole list and
 * asks him why he went. It counts in NOTHING until his direct manager approves it and then the SFE
 * does — two steps, in that order, one refusal at either ending it.
 *
 * Two things are pinned here, and the second matters as much as the first:
 *
 *   1. THE RULES hold: the two steps run in order, a reason is a reason and not "ok", and a territory
 *      with no manager above it starts at the SFE step rather than falling into a queue nobody owns.
 *
 *   2. NEITHER off-plan figure can ever enter plan-kept %. Its denominator is what the rep PLANNED,
 *      and a visit he did not plan cannot make him better or worse at keeping the plan he did make.
 *      That is a property of the arithmetic rather than of one screen, so it is checked as one.
 */

export async function runPhoenixCrmUnplannedVisitTests(): Promise<void> {
  // ── The two steps, in order ──────────────────────────────────────────────────────────────────
  {
    assert.equal(unplannedFirstStatus(true), "manager_pending", "a territory with a manager starts with him");
    // A vacant chain must not leave the visit in a queue nobody owns: it starts at the SFE step.
    assert.equal(unplannedFirstStatus(false), "sfe_pending", "a territory with no manager above it starts at SFE");

    assert.equal(unplannedVisitStageOf("manager_pending"), "manager");
    assert.equal(unplannedVisitStageOf("sfe_pending"), "sfe");
    assert.equal(unplannedVisitStageOf("approved"), null, "a settled visit waits on nobody");
    assert.equal(unplannedVisitStageOf("refused"), null, "a refusal is terminal");

    assert.equal(isUnplannedVisitWaiting("manager_pending"), true);
    assert.equal(isUnplannedVisitWaiting("sfe_pending"), true);
    assert.equal(isUnplannedVisitWaiting("approved"), false);
    assert.equal(isUnplannedVisitWaiting("refused"), false);

    for (const status of ["manager_pending", "sfe_pending", "approved", "refused"] as const) {
      assert.equal(isUnplannedVisitStatus(status), true);
      assert.ok(unplannedVisitStatusLabel(status).length > 0, `${status} has words`);
      assert.ok(unplannedVisitRepNote(status).length > 0, `${status} has words for the rep`);
    }
    assert.equal(isUnplannedVisitStatus("pending"), false, "the grade request's word is not one of these");
    assert.equal(isUnplannedVisitStatus(null), false);
  }

  // ── The reason ───────────────────────────────────────────────────────────────────────────────
  {
    assert.equal(parseUnplannedReason("").ok, false, "an empty reason is no reason");
    assert.equal(parseUnplannedReason("   ").ok, false, "whitespace is no reason");
    assert.equal(parseUnplannedReason("ok").ok, false, '"ok" is not a reason a manager can act on');
    assert.equal(parseUnplannedReason("x".repeat(UNPLANNED_REASON_MIN - 1)).ok, false, "one short of the floor is refused");

    const justLong = parseUnplannedReason("x".repeat(UNPLANNED_REASON_MIN));
    assert.equal(justLong.ok, true, "the floor itself is accepted");

    // Cleaned the same way the database cleans it, so the two can never disagree about a length.
    const messy = parseUnplannedReason("  He   called me\n\nin for an urgent case  ");
    assert.equal(messy.ok, true);
    assert.equal(messy.ok && messy.value, "He called me in for an urgent case");

    assert.equal(parseUnplannedReason("x".repeat(UNPLANNED_REASON_MAX)).ok, true, "the ceiling itself is accepted");
    assert.equal(parseUnplannedReason("x".repeat(UNPLANNED_REASON_MAX + 1)).ok, false, "one over the ceiling is refused");
  }

  // ── An off-plan visit can never move plan-kept % ─────────────────────────────────────────────
  {
    const kept = { ...emptyPlanCounts(), planned: 4, visitedPlanned: 3, missed: 1 };
    const before = planKeptPercent(kept);
    assert.equal(before, 75);
    // The same day, with three off-plan visits on it in every state there is.
    const withOffPlan = { ...kept, unplanned: 3, unplannedWaiting: 2, unplannedRefused: 1 };
    assert.equal(planKeptPercent(withOffPlan), before, "off-plan visits are beside the ratio, never inside it");

    // And a visit he was SEEN on, that is still waiting, is neither kept nor missed: it sits in
    // plannedWaiting, out of the ratio, so a customer he really visited cannot read as a no-show.
    const seenWaiting = { ...emptyPlanCounts(), planned: 2, visitedPlanned: 1, plannedWaiting: 1 };
    assert.equal(planKeptPercent(seenWaiting), 50, "the waiting one is not counted as kept");
    assert.equal(seenWaiting.missed, 0, "and it is not counted as missed either");
  }

  // ── The counts carry through the grouping, per list, apart ───────────────────────────────────
  {
    const row = (listType: "AM" | "PM", extra: Record<string, number>) => ({
      seat_id: "SEAT-1",
      day: "2026-09-24",
      list_type: listType,
      planned: 2,
      visited_planned: 1,
      missed: 1,
      unplanned: 0,
      unplanned_waiting: 0,
      unplanned_refused: 0,
      ...extra,
    });
    const { groups, totals } = groupPlanByTerritory([
      row("PM", { unplanned: 3, unplanned_waiting: 2, unplanned_refused: 1 }),
      row("AM", { unplanned: 1, unplanned_waiting: 1 }),
    ]);
    assert.equal(groups.length, 1);
    const [group] = groups;
    assert.equal(group.pm.unplanned, 3);
    assert.equal(group.pm.unplannedWaiting, 2);
    assert.equal(group.pm.unplannedRefused, 1);
    assert.equal(group.am.unplanned, 1);
    assert.equal(group.am.unplannedWaiting, 1);
    assert.equal(group.am.unplannedRefused, 0);
    // AM and PM are ALWAYS reported apart and never added together (the call-rate golden rule).
    assert.equal(totals.PM.unplannedWaiting, 2);
    assert.equal(totals.AM.unplannedWaiting, 1);
    assert.equal(group.days.length, 1, "one day, two lists");
    assert.equal(group.days[0].pm.unplannedRefused, 1);
  }

  // ── The visit count carries "waiting" beside it, and `visits` already leaves it out ──────────
  {
    const { groups, totals } = groupVisitsByRep([
      {
        seat_id: "SEAT-1",
        rep_hr_id: "R-1",
        visit_date: "2026-09-24",
        list_type: "PM",
        visits: 7,
        double_visits: 1,
        chain_visits: 0,
        far_visits: 0,
        test_visits: 0,
        unplanned_waiting: 2,
      },
    ]);
    assert.equal(groups[0].pm.visits, 7, "the countable view already excluded the waiting ones");
    assert.equal(groups[0].pm.unplannedWaiting, 2, "and the day says how many are waiting, so the dip is explained");
    assert.equal(totals.PM.unplannedWaiting, 2);
    assert.equal(emptyVisitCounts().unplannedWaiting, 0);
  }

  // ── Two days of the same list add up, in the group and in the totals ─────────────────────────
  {
    const day = (date: string, waiting: number, refused: number) => ({
      seat_id: "SEAT-1",
      day: date,
      list_type: "PM",
      planned: 1,
      visited_planned: 1,
      missed: 0,
      unplanned: waiting + refused,
      unplanned_waiting: waiting,
      unplanned_refused: refused,
    });
    const { groups, totals } = groupPlanByTerritory([day("2026-09-23", 1, 2), day("2026-09-24", 3, 4)]);
    assert.equal(groups[0].pm.unplannedWaiting, 4);
    assert.equal(groups[0].pm.unplannedRefused, 6);
    assert.equal(totals.PM.unplannedWaiting, 4);
    assert.equal(totals.PM.unplannedRefused, 6);
    // And the ratio is untouched by either: two days, two planned, two visited.
    assert.equal(planKeptPercent(groups[0].pm), 100);
  }

  // ── The two guards are ONE predicate each, not a role list scattered about ───────────────────
  {
    const access = stripComments(readFileSync(new URL("../src/lib/phoenix-crm/server/access.ts", import.meta.url), "utf8"));
    // The manager step is the territory's own reviewer — the same authority a grade request uses.
    assert.match(access, /canDecideUnplannedVisit[\s\S]*?isTerritoryReviewer/, "the manager step is the territory's reviewer");
    // The SFE step is a ROLE with no seat in the organogram, which is why it cannot be one chain walk.
    assert.match(access, /canDecideUnplannedVisit[\s\S]*?isSfeManager/, "the SFE step is the SFE Manager");
    assert.ok(access.includes("assertUnplannedVisitApprover"), "and the assert twin exists beside it");

    const service = stripComments(readFileSync(new URL("../src/lib/phoenix-crm/server/unplanned.ts", import.meta.url), "utf8"));
    // The STAGE is read from the row, never from the request: a phone naming "sfe" on a visit still
    // sitting with the manager would otherwise choose its own approver.
    assert.equal(/body\.stage/.test(service), false, "the decision must never take its stage from the body");
    assert.match(service, /unplannedVisitStageOf\(status\)/, "the stage comes from the row's own status");
    assert.match(service, /assertUnplannedVisitApprover\(viewer, seat, isTest, stage\)/, "and is asserted before the write");
    assert.match(service, /expectedVersion/, "a stale screen cannot decide twice");
  }

  // ── A section that only renders on a phone is a section a manager never sees ─────────────────
  {
    // `CrmCardsOnPhone` is `md:hidden` and `CrmTable` is `hidden md:block`: they are two halves of
    // one control, and one without the other is a screen that is blank at half the widths there are.
    // The two Team sections added for the off-plan visit were written with the phone half alone, so
    // a district manager, the SFE or the NSM — the only people who can decide anything there — would
    // have opened Monthly plans or Off-plan visits on a desktop and seen a heading and nothing else.
    // No render test exists in this module, and no source pin caught it, which is why this is here.
    const problems: string[] = [];
    for (const file of readdirSync(new URL("../src/components/phoenix-crm/", import.meta.url)).filter((name) => name.endsWith(".tsx"))) {
      // 🔴 COMPACT, NOT `stripComments` — this loop slices a fixed-SIZE window, and `stripComments`
      // BLANKS a comment to spaces rather than deleting it, to keep line numbers honest. So a long
      // comment written between the phone half and the desktop half fills the whole window with
      // whitespace and the guard fires on a file that is correct. It did, on customer-list-board.tsx
      // (2026-09-30): the table sat 1,288 characters past the close tag, about 1,100 of them spaces,
      // and `validate` went red on a board whose two halves were four lines apart. comment-strip.ts
      // documents this exact trap and sends a fixed-window test here. Nothing below reads a line
      // number — the message names a FILE — so the compact strip costs this loop nothing.
      const text = stripCommentsCompact(readFileSync(new URL(`../src/components/phoenix-crm/${file}`, import.meta.url), "utf8"));
      for (const match of text.matchAll(/<CrmCardsOnPhone[\s>]/g)) {
        const after = text.slice(match.index ?? 0);
        const close = after.indexOf("</CrmCardsOnPhone>");
        // The desktop half has to follow it, and closely: the next thing rendered, not somewhere else
        // in the file. 400 characters clears the closing tag and the table's own opening props. It may
        // be a <CrmTable> written out, or a component that wraps one — the Visits tab's own
        // <VisitTable> is the second shape, and it is correct.
        if (close === -1 || !/<[A-Z][A-Za-z]*Table[\s/>]/.test(after.slice(close, close + 400))) {
          problems.push(`${file}: a <CrmCardsOnPhone> block has no <CrmTable> beside it, so it renders nothing from 768px up`);
        }
      }
    }
    assert.deepEqual(problems, [], problems.join("; "));
  }

  console.log("phoenix-crm unplanned visit: OK");
}
