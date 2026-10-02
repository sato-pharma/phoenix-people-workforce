import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import { awaitingValidationNote, computeCallRate, type VisitForCallRate } from "../src/lib/crm/call-rate.ts";

/**
 * A manager must be able to read a zero that a rep did not earn.
 *
 * A Phoenix CRM visit to a customer who is not validated yet is SAVED and scores nothing ("not
 * counted in KPIs till validated", owner 2026-10-01). That gate is invisible, and the first weeks of
 * a started team are its worst case: measured on production on 2026-10-02, the day before Delta (1)
 * began, **0 of its 1,551 customers were validated**. So every call those reps make scores nothing
 * until the lists are worked through, and a district manager opening the board sees a flat 0 with
 * nothing to explain it — the same unreadable zero `hasNoGpsFeed` already exists to explain.
 *
 * What this pins is that the count is a COUNT and never a score: it moves no rate, no target and no
 * slice, it is only a sentence; and it never reaches the rep, whose app never tells him he is being
 * measured (Phoenix CRM golden rule #1).
 */

const ROOT = new URL("../", import.meta.url);

function source(path: string): string {
  return stripComments(readFileSync(new URL(path, ROOT), "utf8"));
}

/** A Phoenix CRM visit on a Sunday inside the window. `validated` is the whole variable. */
function phoenixVisit(validated: boolean | null, day = "2026-10-04"): VisitForCallRate {
  return {
    agent_crm_id: 1441,
    agent_hr_id: "B-130",
    agent_name: "A rep",
    ampm: "PM",
    contact_crm_id: 555,
    crm_save_date: day,
    visit_date: day,
    visit_type: 0,
    visit_type_description: "Regular",
    comment: null,
    speciality: "Neurology",
    crm_visit_id: -1,
    source: "phoenix",
    phoenix_customer_validated: validated,
  };
}

function reportOf(visits: ReadonlyArray<VisitForCallRate>) {
  return computeCallRate(visits, [], { dateFrom: "2026-10-03", dateTo: "2026-10-08", basis: "submitted" });
}

export function runPhoenixCrmAwaitingValidationTests(): void {
  // ── 1. It counts the visits the validation gate held back, and only those ────────────────────
  {
    const report = reportOf([phoenixVisit(false), phoenixVisit(false), phoenixVisit(true)]);
    assert.equal(report.reps.length, 1, "one rep");
    const rep = report.reps[0];
    assert.equal(rep.awaitingValidation, 2, "the two held back, never the validated one");

    // A weekend, a holiday and the catch-all contact are held back for their own reasons, and none
    // of them is a customer waiting to be validated.
    const thursday = { ...phoenixVisit(false), visit_date: "2026-10-08", crm_save_date: "2026-10-08" };
    const catchAll = { ...phoenixVisit(false), contact_crm_id: 100000 };
    const other = reportOf([thursday, catchAll]);
    assert.equal(other.reps[0].awaitingValidation, 0, "only the validation gate feeds this count");

    // A vendor row carries no such gate at all, whatever its flag says.
    const vendor: VisitForCallRate = { ...phoenixVisit(false), crm_visit_id: 99, source: "ireports360" };
    assert.equal(reportOf([vendor]).reps[0].awaitingValidation, 0, "an iReports360 row is never held back by it");
  }

  // ── 2. It is a COUNT of work done, never a score ─────────────────────────────────────────────
  {
    const held = reportOf([phoenixVisit(false), phoenixVisit(false)]).reps[0];
    assert.equal(held.awaitingValidation, 2);
    // Nothing it touches moves: not a slice, not a rate, not a target.
    assert.equal(held.pm.verified + held.pm.unverified + held.pm.campaign, 0, "no slice counts a held visit");
    assert.equal(held.pm.totalRate, 0, "and no rate does either");
    assert.equal(held.am.verified + held.am.unverified, 0);
    assert.equal(held.pharmacy.verified + held.pharmacy.unverified, 0);

    // And validating the customer moves it into the slice, in its own day — the gate is a wait, not
    // a deletion.
    const freed = reportOf([phoenixVisit(true), phoenixVisit(true)]).reps[0];
    assert.equal(freed.awaitingValidation, 0, "nothing is waiting once the customers are validated");
    assert.equal(freed.pm.verified + freed.pm.unverified, 2, "and the visits are counted");
  }

  // ── 3. The sentence ──────────────────────────────────────────────────────────────────────────
  {
    assert.equal(awaitingValidationNote({ awaitingValidation: 0 }), null, "nothing waiting says nothing");
    assert.equal(
      awaitingValidationNote({ awaitingValidation: 1 }),
      "1 visit saved, waiting for its customer to be validated",
      "singular on both halves",
    );
    assert.equal(
      awaitingValidationNote({ awaitingValidation: 7 }),
      "7 visits saved, waiting for their customers to be validated",
    );
    // It is a statement about the LIST, never about the rep: no "not", no "failed", no "missing".
    const note = awaitingValidationNote({ awaitingValidation: 7 }) ?? "";
    for (const accusing of ["did not", "failed", "missing", "no visits"]) {
      assert.ok(!note.toLowerCase().includes(accusing), `the sentence never reads as a complaint about the rep (${accusing})`);
    }
  }

  // ── 4. The manager's boards say it, and never say "No calls" of a rep who called ──────────────
  {
    const board = source("src/lib/crm/kpis-board.ts");
    assert.match(board, /row\.awaitingValidation = rate\.awaitingValidation;/, "the KPI row carries the count");

    const view = source("src/components/crm/kpis-board-view.tsx");
    assert.match(view, /const waiting = awaitingValidationNote\(row\);/, "the caption reads the one sentence, never its own wording");
    assert.match(view, /if \(!row\.hasCallRate\) return waiting \?\? none;/, "with no rate at all, the sentence IS the caption");
    assert.match(
      view,
      /return row\.awaitingValidation > 0 \? NOT_SCORED_YET : "No calls";/,
      '"No calls" would be untrue of a rep whose every call is waiting',
    );

    const repsList = source("src/lib/crm/reps-plans.ts");
    assert.match(repsList, /awaitingValidation: rep\.awaitingValidation,/, "the Reps List row carries it too");
  }

  // ── 5. The rep never sees it (Phoenix CRM golden rule #1) ────────────────────────────────────
  {
    // His own portal visits screen shows what he did; it does not carry a manager's explanation of
    // a score, because he is never shown that he is being scored at all.
    for (const repFacing of [
      "src/components/employee-portal/my-visits-workspace.tsx",
      "src/lib/employee-portal/my-crm-visits.ts",
    ]) {
      assert.doesNotMatch(source(repFacing), /awaitingValidation/, `${repFacing} is the rep's own screen and never reads it`);
    }
  }

  console.log("phoenix-crm visits awaiting validation: OK");
}
