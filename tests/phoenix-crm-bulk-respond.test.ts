import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import {
  BULK_RESPOND_FROM,
  bulkRespondDecisionBody,
  bulkRespondNoteProblem,
  bulkRespondNotice,
  bulkRespondSkip,
  bulkRespondTargets,
  isBulkRespondable,
  pruneRespondSelection,
  type BulkRespondFacts,
} from "../src/lib/phoenix-crm/bulk-respond.ts";

/**
 * Phoenix CRM — answering many list requests at once, and a decision that never moves the page (owner,
 * 2026-11-27: "when i press approve the page jumps to the top which is very irritating in bulks so fix it
 * and make option of multi select and bulk respond").
 */

const source = (path: string): string => stripComments(readFileSync(path, "utf8"));

function request(overrides: Partial<BulkRespondFacts> & { requestId: string }): BulkRespondFacts {
  return {
    kind: "drop",
    status: "pending",
    stage: "sfe",
    canDecide: true,
    canOverride: false,
    canReturn: true,
    withRep: false,
    placeCheckHold: null,
    managerDecision: { at: "2026-11-26T10:00:00Z" },
    ...overrides,
  };
}

export function runPhoenixCrmBulkRespondTests(): void {
  // ── A · What can be ticked ──────────────────────────────────────────────────────────────────────
  {
    const rows: BulkRespondFacts[] = [
      request({ requestId: "drop" }),
      request({ requestId: "add", kind: "add" }),
      request({ requestId: "grade", kind: "grade", stage: null }),
      request({ requestId: "elsewhere", canDecide: false }),
      request({ requestId: "as-admin", canDecide: false, canOverride: true }),
      request({ requestId: "decided", status: "approved" }),
    ];
    assert.deepEqual(
      bulkRespondTargets(rows).map((row) => row.requestId),
      ["drop", "add", "grade", "as-admin"],
      "every kind the viewer answers from its own card, the Administrator's included; never another manager's, never a decided one",
    );
    assert.equal(isBulkRespondable(rows[3]), false);
    assert.equal(BULK_RESPOND_FROM, 2, "offered from two up: for one, its own buttons are the same press");
    assert.deepEqual([...pruneRespondSelection(new Set(["drop", "gone", "elsewhere", "decided"]), rows)], ["drop"], "the selection only ever holds live requests");
  }

  // ── B · What each response leaves out, as the card would ────────────────────────────────────────
  {
    const graded = request({ requestId: "add-graded", kind: "add", stage: "sfe" });
    const toGrade = request({ requestId: "add-manager", kind: "add", stage: "manager", managerDecision: null });
    const vacantSeatAdd = request({ requestId: "add-vacant", kind: "add", stage: "sfe", managerDecision: null });
    const held = request({ requestId: "restore-held", kind: "restore", placeCheckHold: "Waiting on Place checks." });
    const heldForAdmin = { ...held, requestId: "restore-admin", canDecide: false, canOverride: true };
    const withRep = request({ requestId: "with-rep", withRep: true, canReturn: false });
    const managerStep = request({ requestId: "drop-manager", stage: "manager", canReturn: false });

    assert.equal(bulkRespondSkip(graded, "approve"), null, "an add the district manager already graded is approved in bulk");
    assert.equal(bulkRespondSkip(toGrade, "approve"), "set its grade and potential on its own card", "an add still to be graded is graded on its card");
    assert.equal(bulkRespondSkip(vacantSeatAdd, "approve"), "set its grade and potential on its own card", "and so is SFE's add on a territory with no manager");
    assert.equal(bulkRespondSkip(held, "approve"), "its place is still on Place checks", "a held place is not approved past the hold");
    assert.equal(bulkRespondSkip(heldForAdmin, "approve"), null, "the Administrator approves through the hold, as his card does");
    for (const row of [graded, toGrade, held, withRep, managerStep]) {
      assert.equal(bulkRespondSkip(row, "refuse"), null, `every chosen request can be refused: ${row.requestId}`);
    }
    assert.equal(bulkRespondSkip(graded, "return"), null, "SFE's step goes back to the rep");
    assert.equal(bulkRespondSkip(withRep, "return"), "it is already with the rep");
    assert.equal(bulkRespondSkip(managerStep, "return"), "it cannot go back to the rep at this step");
  }

  // ── C · Each is the single-request call, and Refuse and Return carry a note ─────────────────────
  {
    assert.deepEqual(
      bulkRespondDecisionBody({ requestId: "r1", stage: "manager" }, "refuse", "Not on the territory."),
      { requestId: "r1", decision: "refuse", note: "Not on the territory.", stage: "manager", approvedGrade: null, potentialGrade: null },
      "the card's own body, with the step the screen showed so the race guard still bites",
    );
    assert.equal(bulkRespondNoteProblem("approve", ""), null, "Approve needs no note");
    assert.equal(bulkRespondNoteProblem("refuse", "  "), "Write a note for the reps explaining why.");
    assert.equal(bulkRespondNoteProblem("return", ""), "Write what you want the reps to explain.");
    assert.equal(bulkRespondNoteProblem("return", "Why?"), null);
  }

  // ── D · What he is told afterwards ──────────────────────────────────────────────────────────────
  {
    assert.deepEqual(
      bulkRespondNotice("approve", [
        { customerName: "Dr A", ok: true, final: true },
        { customerName: "Dr B", ok: true, final: false },
      ]),
      { tone: "info", title: "Approved 2 requests: 1 decided · 1 sent on to SFE.", failures: [] },
    );
    assert.equal(bulkRespondNotice("refuse", [{ customerName: "Dr A", ok: true, final: true }]).title, "Refused 1 request.");
    const returned = bulkRespondNotice("return", [
      { customerName: "Dr A", ok: true, final: false },
      { customerName: "Dr B", ok: false, why: "it was already decided" },
    ]);
    assert.equal(returned.tone, "warn");
    assert.equal(returned.title, "Returned 1 of the 2 requests: each rep is asked for a comment.");
    assert.deepEqual(returned.failures, ["Dr B: it was already decided."], "the one that failed is named, with why");
    assert.equal(bulkRespondNotice("approve", [{ customerName: "Dr A", ok: false, why: "it was not saved" }]).tone, "bad");
  }

  // ── E · The screen: one bar over every group, through the cards' own routes, one at a time ──────
  {
    const team = source("src/components/phoenix-crm/team-tab.tsx");
    const section = team.slice(team.indexOf("function RequestsSection("), team.indexOf("function ListsSection("));
    assert.ok(section.length > 0);
    assert.match(section, /const targets = bulkRespondTargets\(requests\);/);
    assert.match(
      section,
      /await crmPost\("\/api\/phoenix-crm\/list\/requests\/return", \{ requestId: request\.requestId, note \}, "request"\)/,
      "a return goes through the card's own return route",
    );
    assert.match(section, /bulkRespondDecisionBody\(request, response, note\)/, "an approve or a refuse through the card's own decide route");
    assert.match(section, /const batch = chosenRequests\.filter\(\(request\) => bulkRespondSkip\(request, response\) === null\);/, "what the card would not do is left out, and named");
    assert.doesNotMatch(section, /Promise\.all/, "never all at once");
    const bar = section.indexOf('title="Answer several at once"');
    assert.ok(bar > 0 && bar < section.indexOf("Waiting for your decision ·"), "the bar sits above every group, so the Administrator's requests (in none of his own) are reached");
    assert.match(section, /Approve \$\{chosenCount\}/);
    assert.match(section, /Refuse \$\{chosenCount\}/);
    assert.match(section, /Return \$\{chosenCount\} for a comment/);
    assert.match(section, /selection=\{\s*bulkOffered && targets\.includes\(request\)/, "every answerable card carries its tick box");

    const card = source("src/components/phoenix-crm/request-card.tsx");
    assert.match(card, /Select to answer with the others/, "the tick box no longer reads as drops only");
  }

  // ── F · A decision never moves the page ─────────────────────────────────────────────────────────
  {
    const team = source("src/components/phoenix-crm/team-tab.tsx");
    const notice = team.slice(team.indexOf("function showNotice("), team.indexOf("function requestDecided("));
    assert.ok(notice.length > 0);
    assert.doesNotMatch(notice, /scrollToTop|scrollIntoView|scrollTo\(/, "a decision's notice never scrolls the page to the top");
    assert.match(notice, /if \(current\) setSection\(current\);/, "and the open section stays the one being worked, whatever the counts now say");
    assert.match(team, /<RequestsSection idPrefix=\{idPrefix\} onBatchDone=\{refreshInPlace\}/, "the bulk reloads in place and tells its result inside the section");
  }

  console.log("phoenix-crm bulk respond: OK");
}
