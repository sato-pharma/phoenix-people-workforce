import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

import { isPlanEditable, isPlanSentForReview } from "../src/lib/phoenix-crm/plan-rules.ts";
import { emptyPlanCounts, emptyVisitCounts, groupPlanByTerritory, groupVisitsByRep, planKeptPercent } from "../src/lib/phoenix-crm/report-rules.ts";
import { mapUnplannedRow } from "../src/lib/phoenix-crm/server/unplanned.ts";
import { plannedStartEmptyNote } from "../src/lib/phoenix-crm/today-rules.ts";
import {
  isUnplannedVisitStatus,
  isUnplannedVisitWaiting,
  parseUnplannedReason,
  reviewerWasOnTheVisit,
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
    // OPTIONAL (owner, 2026-10-29: "Make this question optional."). A blank reason is no reason
    // written — accepted as null, and the visit still goes to its manager and SFE — and a short one
    // is his to write. Only the ceiling is a refusal.
    const blank = parseUnplannedReason("");
    assert.equal(blank.ok, true, "an empty reason is accepted: the question is optional");
    assert.equal(blank.ok && blank.value, null, "and is stored as no reason at all");
    const spaces = parseUnplannedReason("   \n ");
    assert.equal(spaces.ok && spaces.value, null, "whitespace is no reason written, never an empty string");
    const short = parseUnplannedReason("ok");
    assert.equal(short.ok && short.value, "ok", "a short reason is kept as he wrote it");
    assert.equal(parseUnplannedReason("x".repeat(UNPLANNED_REASON_MIN - 1)).ok, true, "the missed-visit floor is not the rep's");

    // Cleaned the same way the database cleans it, so the two can never disagree about a length.
    const messy = parseUnplannedReason("  He   called me\n\nin for an urgent case  ");
    assert.equal(messy.ok, true);
    assert.equal(messy.ok && messy.value, "He called me in for an urgent case");

    assert.equal(parseUnplannedReason("x".repeat(UNPLANNED_REASON_MAX)).ok, true, "the ceiling itself is accepted");
    assert.equal(parseUnplannedReason("x".repeat(UNPLANNED_REASON_MAX + 1)).ok, false, "one over the ceiling is refused");

    // The database agrees: the LATEST save refuses only an over-long reason, and the reason column
    // takes a null. The Super Admin's missed-visit entry keeps its own 10-character floor.
    const dir = new URL("../supabase/migrations/", import.meta.url);
    const latest = (needle: RegExp) => {
      const file = readdirSync(dir).filter((name) => name.endsWith(".sql")).sort().filter((name) => needle.test(readFileSync(new URL(name, dir), "utf8"))).at(-1);
      assert.ok(file, `a migration matches ${needle}`);
      return readFileSync(new URL(file, dir), "utf8");
    };
    const save = latest(/create or replace function public\.phoenix_crm_save_visit\(/);
    assert.match(save, /if v_clarification is not null and char_length\(v_clarification\) > 500 then\s+raise exception 'phoenix_crm:clarification_required'/, "the rep's save refuses only a reason over the ceiling");
    assert.doesNotMatch(save, /v_clarification is null or char_length\(v_clarification\) < /, "and never a blank or short one");
    const column = latest(/add constraint phoenix_crm_unplanned_visits_clarification/);
    assert.match(column, /alter column clarification drop not null/, "the reason column takes no reason");
    assert.match(column, /check \(clarification is null or char_length\(clarification\) <= 500\)/, "and checks only the ceiling");

    const picker = stripComments(readFileSync(new URL("../src/components/phoenix-crm/visit-customer-picker.tsx", import.meta.url), "utf8"));
    assert.doesNotMatch(picker, /UNPLANNED_REASON_MIN/, "the out-of-plan question never holds Continue back for a short reason");
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
      // The seated customers' desktop half is a block inside the venue row's own first cell (tables-said-once-fit,
      // 2026-10-28: a table inside a cell was a second row), so it has no <CrmTable> beside its phone cards by design.
      // tests/phoenix-crm-shared-place-groups.test.ts pins that shape.
      if (file === "shared-place-customers.tsx") continue;
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
        //
        // 🔴 THE WINDOW IS MEASURED ON COLLAPSED WHITESPACE, OR A COMMENT BETWEEN THE TWO HALVES
        // FAILS THE FILE THAT IS CORRECT. `stripComments` blanks a JSX comment's CONTENT and keeps
        // its whitespace, so the 16-line note explaining the List's columns became ~430 characters
        // of spaces and pushed the very <CrmTable> it was explaining out of a raw 400-character
        // window — customer-list-board.tsx went red on 2026-09-30 with its desktop table on the next
        // line but one. Collapsing first keeps the window honest about what is RENDERED, which is
        // all this rule is about: any real markup between the two halves still spends the budget.
        const beside = close === -1 ? "" : after.slice(close).replace(/\s+/g, " ").slice(0, 400);
        if (close === -1 || !/<[A-Z][A-Za-z]*Table[\s/>]/.test(beside)) {
          problems.push(`${file}: a <CrmCardsOnPhone> block has no <CrmTable> beside it, so it renders nothing from 768px up`);
        }
      }
    }
    assert.deepEqual(problems, [], problems.join("; "));
  }

  // ── Why "Planned visit" has nobody to offer (owner, 2026-10-01) ───────────────────────────────
  //
  // His own morning: "I submitted the doctors … the doctors in the plan are not appearing and I'm
  // obligatory should enter them as unplanned visits — why". He had SAVED five accounts on Thursday
  // 1 October and SENT the weeks of 3 and 10 October; 1 October belongs to the field week starting
  // Saturday 26 September, so today's stops sat in a DRAFT. Refusing to offer them was right — it is
  // the whole point of the status filter. Saying only "Nobody on today's sent plan yet" was not.
  {
    assert.equal(
      plannedStartEmptyNote({ saved: 5, status: "draft" }),
      "5 planned for today, but your plan for this week is still a draft. Open Plan to send it.",
      "the exact case that cost him the morning: what he placed, what state it is in, and where to go",
    );
    assert.match(plannedStartEmptyNote({ saved: 0, status: "draft" }), /still a draft/);
    assert.ok(!plannedStartEmptyNote({ saved: 0, status: "draft" }).includes("0 planned"), "never '0 planned for today'");
    assert.match(plannedStartEmptyNote({ saved: 3, status: "returned" }), /^3 planned for today, but your plan for this week was sent back/);
    assert.equal(plannedStartEmptyNote({ saved: 0, status: null }), "No plan sent for this week yet. Open Plan to send it.");

    // Sent or approved with nobody on today is the ONE case where "nobody" is the whole answer: he
    // planned the day empty, and there is nothing of his left to send.
    for (const status of ["submitted", "approved"] as const) {
      assert.equal(plannedStartEmptyNote({ saved: 0, status }), "Nobody on today's sent plan yet.");
    }

    // Golden Rule #1: this is HIS OWN WORK, so it is visible — and it judges nothing. No "late", no
    // "overdue", no ellipsis (his no-truncation rule), and always the one screen that fixes it.
    for (const status of ["draft", "returned", null] as const) {
      const note = plannedStartEmptyNote({ saved: 2, status });
      assert.match(note, /Open Plan/, `${status ?? "a week with no plan row"} names where to go`);
      assert.doesNotMatch(note, /late|overdue|should have|…/i, `${status ?? "a week with no plan row"} accuses him of nothing`);
    }

    // The complement, named for what it means at the door: a draft and a returned plan are the rep's
    // own to edit TODAY, which is exactly why neither can make a visit planned.
    for (const status of ["draft", "submitted", "approved", "returned"] as const) {
      assert.equal(isPlanSentForReview(status), !isPlanEditable(status), `${status}: sent for review is exactly "not his to edit"`);
    }
    assert.equal(isPlanSentForReview(null), false, "no plan row at all is not a sent plan");
  }

  // The wiring, which is where this would rot back: the screen asks the rule instead of carrying a
  // sentence of its own, the form carries the state that rule needs, and — the half that must never
  // be widened to fix the other — the picker is still fed the SENT set alone.
  {
    const start = stripComments(readFileSync(new URL("../src/components/phoenix-crm/visit-start.tsx", import.meta.url), "utf8"));
    assert.match(start, /plannedStartEmptyNote\(planToday\)/, "Add visit asks the rule for the empty note");
    assert.ok(!start.includes("Nobody on today's sent plan yet"), "the bare sentence no longer lives on the screen");

    const visits = stripComments(readFileSync(new URL("../src/lib/phoenix-crm/server/visits.ts", import.meta.url), "utf8"));
    assert.match(visits, /planToday: \{ status: planDay\.status, saved: planDay\.customerIds\.length \}/, "the form carries today's plan state");
    assert.match(visits, /isPlanSentForReview\(planDay\.status\) \? planDay\.customerIds : \[\]/, "and the picker is still fed the SENT set alone");
  }

  // ── 🔴 WHO WAS ON THE VISIT IS ON THE CARD — 2026-10-12 ──────────────────────────────────────
  //
  // The decider's card carried the evidence and nothing else, so a manager deciding a ride-along he
  // had been on himself read nothing that said so. Measured on production that day: of the 31
  // off-plan visits that carried a companion, 27 were decided by that companion — every one the
  // NAMED manager, and every one approved, 0 refused. That is a missing piece of INFORMATION, never
  // a finding against anybody: this half states it and changes no step of the chain.
  //
  // The chain itself is NOT touched here and must not be: direct manager, then SFE; one refusal ends
  // it; a vacant chain starts at SFE; the Administrator is not a step. Whether a participant's own
  // step should be skipped is the owner's ruling to make, not this test's.
  {
    const unplanned = stripComments(readFileSync(new URL("../src/lib/phoenix-crm/server/unplanned.ts", import.meta.url), "utf8"));
    const columns = /const UNPLANNED_COLUMNS =([\s\S]*?);\n/.exec(unplanned)?.[1] ?? "";
    // 🔴 A PLAIN SUBSTRING CANNOT ASK THIS QUESTION: "product_manager_hr_id" ENDS IN "manager_hr_id",
    // so includes("manager_hr_id") stayed true with the manager’s own column deleted and the check could
    // not fail. Caught by breaking it on 2026-10-12; both reads now ask with a boundary on each side.
    for (const column of ["manager_hr_id", "senior_hr_id", "product_manager_hr_id"]) {
      assert.match(
        columns,
        new RegExp(`(^|[^a-z_])${column}\\b`),
        `the read must load ${column} itself — the card cannot show a companion it never read`,
      );
    }
    // The names have to be loaded too, or the card would print an HR id, which Golden Rule #1 forbids.
    assert.match(unplanned, /\.\.\.companionHrIds\(row\)/, "unplannedPeople must ask for the companions' names");

    const names = new Map([
      ["AI0001", "Khaled Saied"],
      ["AI0002", "Nermeen Salah"],
      ["AI0003", "Mahmoud Fathy"],
    ]);
    const row: Record<string, unknown> = {
      visit_id: "11111111-1111-4111-8111-111111111111",
      seat_id: "seat-1",
      rep_hr_id: "AI0001",
      customer_id: "22222222-2222-4222-8222-222222222222",
      visit_date: "2026-10-07",
      clarification: "He asked me to come in while I was at the hospital.",
      status: "sfe_pending",
      version: 1,
      created_at: "2026-10-07T09:00:00.000Z",
      manager_decided_by_hr_id: "AI0002",
      customer: { name: "محمود سعد", list_type: "doctor", speciality: "Paediatrics" },
      visit: {
        photo_path: null,
        location_flag: null,
        products: [],
        comment: null,
        captured_at: "2026-10-07T08:40:00.000Z",
        manager_hr_id: "AI0002",
        senior_hr_id: null,
        product_manager_hr_id: "AI0003",
      },
    };

    const view = mapUnplannedRow(row, names);
    assert.deepEqual(
      view.companions,
      [
        { role: "Manager", name: "Nermeen Salah" },
        { role: "Product or training manager", name: "Mahmoud Fathy" },
      ],
      "the companions are NAMED, in role order, and a null column drops out rather than printing a blank",
    );
    assert.equal(view.managerDecidedByWasOnTheVisit, true, "the manager who approved it was on it — the card says so");
    assert.equal(view.sfeDecidedByWasOnTheVisit, false, "and the step nobody has taken yet claims nothing");
    // It is a statement, never a refusal: the step it waits on is untouched by it.
    assert.equal(view.stage, "sfe", "stating who was on the visit must not move the step it is waiting on");

    const alone = mapUnplannedRow(
      { ...row, visit: { ...(row.visit as Record<string, unknown>), manager_hr_id: null, product_manager_hr_id: null } },
      names,
    );
    assert.deepEqual(alone.companions, [], "a rep who went alone shows no companion line at all");
    assert.equal(alone.managerDecidedByWasOnTheVisit, false, "and nothing is claimed about the manager who approved it");

    // The card prints it, and the owner's rule holds: this is the DECIDER's Team tab, never a rep's
    // screen — `tests/phoenix-crm-blind-half.test.ts` sweeps the rep-facing roots for exactly that.
    const card = stripComments(readFileSync(new URL("../src/components/phoenix-crm/unplanned-visit-card.tsx", import.meta.url), "utf8"));
    assert.match(card, /visit\.companions\.length > 0/, "the card shows the companions when there are any");
    assert.match(card, /visit\.managerDecidedByWasOnTheVisit/, "and says plainly when the approver was one of them");
  }

  // 🔴 THE OWNER'S 2026-10-12 RULING — A MANAGER WHO WAS ON THE VISIT DOES NOT APPROVE IT; SFE DOES.
  //
  // He was shown the measurement (of the 31 off-plan visits carrying a companion, 27 were decided by
  // that companion, every one the named manager, every one approved) and chose: "No — the SFE approves
  // it instead", because that manager's step is unavailable exactly as a vacant chain's already is.
  //
  // What is pinned here is as much what did NOT change as what did: no stage is added, no step is
  // removed, no flag is raised, and the rep is told nothing about any of it.
  {
    assert.equal(
      unplannedFirstStatus(true, true),
      "sfe_pending",
      "a manager who was ON the visit does not decide it — it starts at the SFE step",
    );
    assert.equal(
      unplannedFirstStatus(true, false),
      "manager_pending",
      "and every other off-plan visit still starts with the territory's own manager, untouched",
    );
    assert.equal(
      unplannedFirstStatus(false),
      "sfe_pending",
      "the vacant-chain rule this one reuses is itself unchanged, and the new argument is optional",
    );
    assert.equal(unplannedFirstStatus(false, true), "sfe_pending", "a vacant chain cannot also have been on the visit");

    // The comparison has to fold: these hr ids differ in case and padding between the columns that
    // store them, and a raw `===` would answer "not on the visit" and hand the step straight back.
    assert.equal(
      reviewerWasOnTheVisit(" b-1 ", [null, "B-1", null]),
      true,
      "the reviewer is matched through personKey — case and padding alone must not miss him",
    );
    assert.equal(reviewerWasOnTheVisit("B-1", ["B-2", null, "B-3"]), false, "a manager who was not on it is not matched");
    assert.equal(reviewerWasOnTheVisit(null, [null, null, null]), false, "a vacant reviewer is on nothing — hasReviewer answers that case");
    assert.equal(reviewerWasOnTheVisit("", ["", null, null]), false, "and an EMPTY key must never match an empty companion column");

    // The rep's own sentence. `sfe_pending` is reached two ways and only one of them means a manager
    // approved something; telling this rep otherwise would be a plain untruth about his own visit.
    assert.equal(
      unplannedVisitRepNote("sfe_pending", false),
      "Off the plan. It counts once SFE approves it.",
      "a visit whose manager step was never available must not tell the rep his manager approved it",
    );
    assert.match(
      unplannedVisitRepNote("sfe_pending", true),
      /manager approved it/,
      "and where a manager really did approve it, the sentence he has always read is unchanged",
    );
    for (const note of [unplannedVisitRepNote("sfe_pending", false), unplannedVisitRepNote("sfe_pending", true)]) {
      assert.doesNotMatch(note, /B-\d|was on (the|this) visit/i, "nothing a rep reads names a person or mentions who was on it");
    }

    // The decision path is the third fence, and the only one that reads whoever is actually clicking.
    // It needs the companion columns on its OWN read — the board's select is a different string.
    const decide = stripCommentsCompact(readFileSync(new URL("../src/lib/phoenix-crm/server/unplanned.ts", import.meta.url), "utf8"));
    for (const column of ["manager_hr_id", "senior_hr_id", "product_manager_hr_id"]) {
      assert.match(
        decide,
        new RegExp(`visit:phoenix_crm_visits!visit_id\\(([^)]*(,|\\s))?${column}\\b`),
        `the decision's own read must load ${column} — it cannot compare a companion it never read`,
      );
    }
    assert.match(
      decide,
      /stage === "manager" && reviewerWasOnTheVisit\(viewer\.hrId, companionHrIds\(row\)\)/,
      "the fence tests the VIEWER against the visit, at the manager stage only",
    );
    assert.doesNotMatch(
      decide,
      /stage === "sfe" && reviewerWasOnTheVisit/,
      "and never the SFE step — the SFE Manager holds no sales seat and is on no rep's ride-along",
    );

    // The rows that were ALREADY waiting are moved by a migration, because the application only ever
    // chooses a first status as a visit saves. Without it the new fence would strand them for good.
    const move = readFileSync(
      new URL("../supabase/migrations/20261012140000_phoenix_crm_offplan_reviewer_on_the_visit.sql", import.meta.url),
      "utf8",
    );
    assert.match(move, /set status = 'sfe_pending'/, "the waiting rows are moved to the SFE step");
    assert.match(move, /u\.status = 'manager_pending'/, "and only the ones still waiting on a manager — a settled visit is never reopened");
    assert.match(move, /btrim\(u\.manager_hr_id\) <> ''/, "an empty reviewer key must not match the coalesce('') arms");
    assert.doesNotMatch(
      stripComments(move),
      /manager_decided_at\s*=|manager_decided_by_hr_id\s*=/,
      "nobody took that step, so no decision may be written for one",
    );
    assert.doesNotMatch(stripComments(move), /delete\s+from/i, "nothing is deleted");
    assert.match(move, /version = u\.version \+ 1/, "the optimistic lock is bumped so a page loaded before this is told to reload");
  }

  console.log("phoenix-crm unplanned visit: OK");
}
