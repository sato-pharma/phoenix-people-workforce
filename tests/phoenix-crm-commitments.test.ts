import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import { addDaysIso } from "../src/lib/crm/dates.ts";
import {
  buildRepCommitments,
  commitmentGroupTitle,
  commitmentWeekEnd,
  commitmentsNotListedNote,
  COMMITMENT_GROUP_ORDER,
  COMMITMENTS_EMPTY_NOTE,
  UNDATED_COMMITMENT_WINDOW_DAYS,
  type CommitmentVisitRow,
} from "../src/lib/phoenix-crm/commitments.ts";

/**
 * The rep's own open commitments — the four next steps that had no home at all.
 *
 * At every visit he records a next step (`VISIT_NEXT_STEPS`) with an optional day. Only `follow_up`
 * ever came back to him, and only as a suggestion while he planned next week (`followUpInWeek`):
 * "Send the data", "Arrange a double visit", "Invite to an event" and "Chase the pharmacy stock"
 * vanished when the visit closed.
 *
 * WHAT EACH SECTION CATCHES, in the words of the change that would break it:
 *
 *  1. A commitment invented out of "Nothing to follow" or out of a row with no next step at all.
 *  2. A second definition of "still open". The rule is `pickLastNextStep` — a LATER visit to the same
 *     customer addresses it, the NEWEST visit's answer stands, and a later "Nothing to follow" closes
 *     an older promise. A re-derivation here would drift from the visit form's own "what he said last
 *     time", and the two would then disagree about the same doctor on the same day.
 *  3. A group boundary read off the calendar day instead of the visit day, or a Friday reading its own
 *     week (which is the week BEHIND it) and so emptying "Later this week".
 *  4. An open promise SILENTLY dropped — dated past this week, or undated and older than the window.
 *  5. A figure or a judging word appearing on the rep's own screen. This is the whole point of the
 *     feature: Phoenix CRM golden rule #1 keeps anything that scores him off his app, the rep's
 *     surfaces were deliberately stripped of meters, and "Overdue" is said of the DAY HE CHOSE.
 *  6. The read widened past his own seat, moved onto `phoenix_crm_countable_visits`, or grown a POST.
 */

const ROOT = new URL("../", import.meta.url);

function source(path: string): string {
  return stripComments(readFileSync(new URL(path, ROOT), "utf8"));
}

function rawSource(path: string): string {
  return readFileSync(new URL(path, ROOT), "utf8");
}

/** One visit. `capturedAt` is derived from the day so a same-day tie is still decidable. */
function visit(input: {
  customerId: string;
  customerName?: string;
  visitDate: string;
  nextStep?: string | null;
  nextStepOn?: string | null;
  clock?: string;
}): CommitmentVisitRow {
  return {
    customerId: input.customerId,
    customerName: input.customerName ?? `Doctor ${input.customerId}`,
    visitDate: input.visitDate,
    capturedAt: `${input.visitDate}T${input.clock ?? "10:00"}:00.000Z`,
    nextStep: input.nextStep ?? null,
    nextStepOn: input.nextStepOn ?? null,
  };
}

/** Saturday 3 October 2026 is a field-week start, so the week it opens runs to Thursday the 8th. */
const TODAY = "2026-10-05"; // a Monday inside the week of Saturday 3 October

function build(visits: readonly CommitmentVisitRow[], today = TODAY) {
  return buildRepCommitments({ visits, today });
}

function flat(visits: readonly CommitmentVisitRow[], today = TODAY) {
  return build(visits, today).groups.flatMap((group) => group.commitments);
}

export function runPhoenixCrmCommitmentsTests(): void {
  // ── 1. What IS a commitment ───────────────────────────────────────────────────────────────────
  {
    // All five actionable next steps are commitments, not just `follow_up` — which is the whole gap
    // this closes, since `followUpInWeek` has only ever carried that one.
    for (const nextStep of ["follow_up", "send_data", "arrange_double", "invite_event", "pharmacy_stock"]) {
      const open = flat([visit({ customerId: "c1", visitDate: "2026-10-04", nextStep, nextStepOn: "2026-10-06" })]);
      assert.equal(open.length, 1, `${nextStep} is a commitment`);
      assert.equal(open[0].nextStep, nextStep);
      assert.ok(open[0].label.length > 0, "it carries the chip's own words, never the key");
      assert.notEqual(open[0].label, nextStep, "the label is a sentence, never the stored key");
    }

    // "Nothing to follow" is an ANSWER and is stored, but it is not something to do.
    assert.equal(flat([visit({ customerId: "c1", visitDate: "2026-10-04", nextStep: "none" })]).length, 0, "`none` is not a commitment");
    // A visit where he left the row alone carries nothing either.
    assert.equal(flat([visit({ customerId: "c1", visitDate: "2026-10-04" })]).length, 0, "no next step, no commitment");
    // A value a phone one release behind could send is dropped, never turned into a row.
    assert.equal(flat([visit({ customerId: "c1", visitDate: "2026-10-04", nextStep: "sample_left" })]).length, 0, "an unknown step is dropped");

    // Names, never ids: a visit the read could not name produces no row at all.
    assert.equal(
      flat([visit({ customerId: "c1", customerName: "", visitDate: "2026-10-04", nextStep: "send_data" })]).length,
      0,
      "a row with no name is never drawn with an id in its place",
    );
  }

  // ── 2. Open and closed are DERIVED — a later visit to the same customer addresses it ──────────
  {
    const promised = visit({ customerId: "c1", visitDate: "2026-09-28", nextStep: "send_data", nextStepOn: "2026-10-06" });

    // On its own it is open.
    assert.equal(flat([promised]).length, 1, "the newest visit's promise is open");

    // A LATER visit to the same customer addresses it — that is the "comes back at the next visit"
    // signal the module already works on, and it does NOT matter what the later visit says.
    const later = visit({ customerId: "c1", visitDate: "2026-10-01" });
    assert.equal(flat([promised, later]).length, 0, "a later visit addresses it");
    assert.equal(flat([later, promised]).length, 0, "the input order cannot change that");

    // A later "Nothing to follow" CLOSES it. A later repeat RE-OPENS it, on the new day.
    const closed = visit({ customerId: "c1", visitDate: "2026-10-01", nextStep: "none" });
    assert.equal(flat([promised, closed]).length, 0, "a later `none` closes an older promise");
    const again = visit({ customerId: "c1", visitDate: "2026-10-01", nextStep: "send_data", nextStepOn: "2026-10-07" });
    const reopened = flat([promised, again]);
    assert.equal(reopened.length, 1);
    assert.equal(reopened[0].promisedOn, "2026-10-01", "the NEWEST visit's promise is the one carried");
    assert.equal(reopened[0].dueOn, "2026-10-07");

    // Two visits on the SAME day: `capturedAt` decides, so the later save wins.
    const morning = visit({ customerId: "c1", visitDate: "2026-10-01", nextStep: "send_data", nextStepOn: "2026-10-06", clock: "09:00" });
    const evening = visit({ customerId: "c1", visitDate: "2026-10-01", nextStep: "none", clock: "19:00" });
    assert.equal(flat([morning, evening]).length, 0, "within one day the later capture is the answer");

    // Another customer's visit addresses nothing.
    const other = visit({ customerId: "c2", visitDate: "2026-10-02" });
    assert.equal(flat([promised, other]).length, 1, "a visit to somebody else closes nothing");

    // At most ONE open promise per customer, whatever the history holds.
    const history = [
      visit({ customerId: "c1", visitDate: "2026-09-10", nextStep: "follow_up", nextStepOn: "2026-10-06" }),
      visit({ customerId: "c1", visitDate: "2026-09-20", nextStep: "invite_event", nextStepOn: "2026-10-06" }),
      visit({ customerId: "c1", visitDate: "2026-09-28", nextStep: "send_data", nextStepOn: "2026-10-06" }),
    ];
    const one = flat(history);
    assert.equal(one.length, 1, "one customer, one open commitment");
    assert.equal(one[0].nextStep, "send_data");
  }

  // ── 3. The four groups ────────────────────────────────────────────────────────────────────────
  {
    const rows: CommitmentVisitRow[] = [
      visit({ customerId: "late", customerName: "Dr Overdue", visitDate: "2026-09-29", nextStep: "send_data", nextStepOn: "2026-10-01" }),
      visit({ customerId: "now", customerName: "Dr Today", visitDate: "2026-09-30", nextStep: "follow_up", nextStepOn: TODAY }),
      visit({ customerId: "soon", customerName: "Dr Thursday", visitDate: "2026-10-01", nextStep: "invite_event", nextStepOn: "2026-10-08" }),
      visit({ customerId: "blank", customerName: "Dr Undated", visitDate: "2026-10-02", nextStep: "arrange_double" }),
    ];
    const built = build(rows);
    assert.deepEqual(
      built.groups.map((group) => group.key),
      ["overdue", "today", "week", "undated"],
      "the groups come out in reading order",
    );
    assert.deepEqual(
      built.groups.map((group) => group.commitments[0].customerName),
      ["Dr Overdue", "Dr Today", "Dr Thursday", "Dr Undated"],
      "each lands in its own group",
    );
    // A group with nothing in it is DROPPED rather than drawn empty.
    const onlyToday = build([rows[1]]);
    assert.deepEqual(onlyToday.groups.map((group) => group.key), ["today"], "an empty group is not drawn");

    // Every group key has a title, and the array is the whole set.
    for (const key of COMMITMENT_GROUP_ORDER) assert.ok(commitmentGroupTitle(key).length > 0, `${key} has a title`);
    assert.equal(new Set(COMMITMENT_GROUP_ORDER).size, COMMITMENT_GROUP_ORDER.length, "no key is listed twice");

    // Inside a group: the day he set first, then the day he said it, then the name. A total order.
    const sameGroup = build([
      visit({ customerId: "b", customerName: "Beta", visitDate: "2026-10-01", nextStep: "send_data", nextStepOn: "2026-10-08" }),
      visit({ customerId: "a", customerName: "Alpha", visitDate: "2026-10-01", nextStep: "send_data", nextStepOn: "2026-10-07" }),
    ]);
    assert.deepEqual(
      sameGroup.groups[0].commitments.map((commitment) => commitment.customerName),
      ["Alpha", "Beta"],
      "the earliest day he set comes first",
    );
  }

  // ── 3b. The field week, and the Friday that belongs to the week before it ─────────────────────
  {
    // Monday 5 October sits in the week of Saturday 3 October, which runs to Thursday the 8th.
    assert.equal(commitmentWeekEnd("2026-10-05"), "2026-10-08");
    assert.equal(commitmentWeekEnd("2026-10-03"), "2026-10-08", "the Saturday itself");
    assert.equal(commitmentWeekEnd("2026-10-08"), "2026-10-08", "the Thursday itself");
    // 🔴 FRIDAY 9 OCTOBER belongs to the week of 3 October, whose Thursday is already behind it — so
    // without the second branch "Later this week" would be empty on every Friday and everything he
    // had dated for the coming Saturday would read as "dated later".
    assert.equal(commitmentWeekEnd("2026-10-09"), "2026-10-15", "a Friday looks into the week that starts the next morning");
    const friday = build([visit({ customerId: "c1", visitDate: "2026-10-08", nextStep: "send_data", nextStepOn: "2026-10-12" })], "2026-10-09");
    assert.deepEqual(friday.groups.map((group) => group.key), ["week"], "a Monday promise is this week's on a Friday");
    assert.equal(friday.datedLater, 0);
  }

  // ── 4. Nothing open is SILENTLY dropped ───────────────────────────────────────────────────────
  {
    // Dated after this week: not listed (it is not due), but COUNTED and said.
    const later = build([visit({ customerId: "c1", visitDate: "2026-10-02", nextStep: "send_data", nextStepOn: "2026-10-20" })]);
    assert.equal(later.groups.length, 0, "a commitment dated after this week is not a row");
    assert.equal(later.datedLater, 1, "but it is counted");
    assert.equal(later.staleUndated, 0);

    // Undated and recent: listed. Undated and older than the window: counted, not listed. The edge is
    // derived FROM the constant, so moving the window moves the test with it rather than breaking it.
    const edge = addDaysIso(TODAY, -UNDATED_COMMITMENT_WINDOW_DAYS);
    const recent = build([visit({ customerId: "c1", visitDate: edge, nextStep: "arrange_double" })]);
    assert.deepEqual(recent.groups.map((group) => group.key), ["undated"], "exactly at the window it is still listed");
    assert.equal(recent.staleUndated, 0);
    const stale = build([visit({ customerId: "c1", visitDate: addDaysIso(edge, -1), nextStep: "arrange_double" })]);
    assert.equal(stale.groups.length, 0, "an undated promise one day past the window is not a row");
    assert.equal(stale.staleUndated, 1, "but it is counted");

    // The sentence names both, and only what there is.
    assert.equal(commitmentsNotListedNote({ datedLater: 0, staleUndated: 0 }), null, "nothing hidden says nothing");
    const both = commitmentsNotListedNote({ datedLater: 2, staleUndated: 1 }) ?? "";
    assert.ok(both.includes("2"), "it names how many are dated later");
    assert.ok(both.includes("after this week"), "and says what that means");
    assert.ok(both.includes("more than a month ago"), "and names the undated ones");
    const oneLater = commitmentsNotListedNote({ datedLater: 1, staleUndated: 0 }) ?? "";
    assert.ok(oneLater.includes("is dated"), "singular reads as a sentence");
    assert.ok(!oneLater.includes("month ago"), "and says nothing about a group that is empty");
  }

  // ── 5. It never scores him, and never accuses him ─────────────────────────────────────────────
  {
    // No aggregate figure on the view. The shape is groups plus the two "not listed" numbers, and a
    // total, a rate, a kept/missed split or a streak would be a field — so the absence is the test.
    const built = build([
      visit({ customerId: "c1", visitDate: "2026-10-01", nextStep: "send_data", nextStepOn: "2026-10-01" }),
      visit({ customerId: "c2", visitDate: "2026-10-01", nextStep: "follow_up" }),
    ]);
    assert.deepEqual(Object.keys(built).sort(), ["datedLater", "groups", "staleUndated"], "no aggregate figure is produced");

    // No judging word anywhere in the wording the module owns: the titles, the empty note, and the
    // "also open" sentence. "Overdue" is said of the DAY HE CHOSE, never of the rep.
    const wording = [
      ...COMMITMENT_GROUP_ORDER.map(commitmentGroupTitle),
      COMMITMENTS_EMPTY_NOTE,
      commitmentsNotListedNote({ datedLater: 3, staleUndated: 2 }) ?? "",
    ].join(" | ");
    // "late" is deliberately NOT in this list — "Later this week" contains it, and that word is about
    // the DAY. The list is the words that would be about the REP.
    for (const accusing of ["missed", "failed", "did not", "you never", "broken", "forgot", "neglect", "overdue"]) {
      assert.ok(!wording.toLowerCase().includes(accusing), `the wording never reads as a verdict on the rep (${accusing})`);
    }

    // And the PANEL prints none of the four meters the rep's surfaces were stripped of.
    const panel = source("src/components/phoenix-crm/commitments-panel.tsx");
    for (const meter of ["CrmStat", "CrmStatGrid", "CrmFillBar", "percentText", "streak"]) {
      assert.ok(!panel.includes(meter), `the panel draws no meter (${meter})`);
    }
    // Read only: no write, no tick, no dismiss. A completion input would be a step added to his day.
    for (const write of ["useCrmAction", "crmPost", "onClick", "CrmCheck", "CrmButton"]) {
      assert.ok(!panel.includes(write), `the panel offers no action (${write})`);
    }
    assert.ok(panel.includes("CrmTable") && panel.includes("CrmCardsOnPhone"), "desktop a table, phone cards");
  }

  // ── 6. The read is the rep's OWN, on the RAW table, and there is no POST ──────────────────────
  {
    const server = source("src/lib/phoenix-crm/server/commitments.ts");
    assert.ok(
      server.includes("territoryForRepWrite("),
      "the gate is the rep's own seat. A manager-readable list of a rep's open promises is a judgement " +
        "of him, which Phoenix CRM golden rule #1 keeps off this module.",
    );
    assert.ok(
      server.includes('.from("phoenix_crm_visits")'),
      "it reads the RAW visits table. `phoenix_crm_countable_visits` would hide every promise made on a " +
        "day the rep's week was not sent — which on a team that has just started is most of them.",
    );
    assert.ok(!server.includes("countable_visits"), "and it must not move onto the countable view");
    assert.ok(server.includes("fetchAllRowsKeyset"), "it is paged: a read that grows with the field lies at 1,000 rows with no marker");
    assert.ok(server.includes("viewer.visitDay"), "the day it measures against is the VISIT day, not the calendar day");
    // The rule itself is not restated here.
    assert.ok(server.includes("buildRepCommitments("), "the server read holds no copy of the grouping rule");
    assert.ok(!/pickLastNextStep\s*\(/.test(server), "and no second reading of 'still open' either");

    const pure = source("src/lib/phoenix-crm/commitments.ts");
    assert.ok(pure.includes("pickLastNextStep("), "the pure module CALLS the module's own open/closed rule");

    const route = rawSource("app/api/phoenix-crm/commitments/route.ts");
    assert.ok(!/export async function POST/.test(route), "there is no POST: a commitment closes by going back, never by a tick");
    assert.ok(route.includes('assertPermission(access, "phoenix_crm", "read")'), "the route asserts the module permission first");
  }

  // ── 7. It never reaches a manager's surface ───────────────────────────────────────────────────
  {
    // Not on the team boards, not in the digest, not in a report — it is his notebook.
    for (const managerFacing of [
      "src/lib/phoenix-crm/server/team.ts",
      "src/lib/phoenix-crm/server/reports.ts",
      "src/lib/phoenix-crm/server/daily-digest.ts",
      "src/components/phoenix-crm/team-tab.tsx",
    ]) {
      assert.ok(
        !source(managerFacing).includes("buildRepCommitments") && !source(managerFacing).includes("loadRepCommitments"),
        `${managerFacing} reads a manager's team and must never read a rep's own commitments`,
      );
    }
  }

  console.log("phoenix-crm rep commitments: OK");
}
