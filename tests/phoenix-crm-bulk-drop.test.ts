import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import {
  BULK_DROP_FROM,
  bulkDropDecisionBody,
  bulkDropFailureText,
  bulkDropNotice,
  bulkDropTargets,
  isBulkDroppable,
  pruneSelection,
  type BulkDropFacts,
} from "../src/lib/phoenix-crm/bulk-drop.ts";
import { DROP_COMMENT_REQUIRED, parseDropDraft } from "../src/lib/phoenix-crm/entry-rules.ts";

/**
 * Phoenix CRM — the SFE Manager drops many customers at once, and a rep's drop request always carries
 * a comment (owner, 2026-10-12: "when the sfe receives the request to drop from reps … he can multi
 * select or select all and drop … the comment required not optional for the reps when submitting").
 */

const source = (path: string): string => stripComments(readFileSync(path, "utf8"));

function request(overrides: Partial<BulkDropFacts> & { requestId: string }): BulkDropFacts {
  return { kind: "drop", status: "pending", stage: "sfe", canDecide: true, ...overrides };
}

export function runPhoenixCrmBulkDropTests(): void {
  // ── A · The rep's ask: the comment is required on every reason ───────────────────────────────────
  {
    for (const reason of ["moved", "retired", "closed", "other"]) {
      const result = parseDropDraft({ reason, note: "  " }, { requireNote: true });
      assert.equal(result.ok, false, `a "${reason}" drop with no comment is refused for the rep`);
      if (!result.ok) assert.equal(result.error, DROP_COMMENT_REQUIRED, "in the module's own sentence");
    }
    const written = parseDropDraft({ reason: "moved", note: " Moved to Tanta " }, { requireNote: true });
    assert.deepEqual(written.ok ? written.value : null, { reason: "moved", note: "Moved to Tanta" }, "a written comment passes, trimmed");
    assert.equal(parseDropDraft({ reason: "gone", note: "x" }, { requireNote: true }).ok, false, "a reason outside the list is still refused first");
    // The SFE Manager dropping a customer himself is not the rep's ask: his comment stays optional.
    const sfe = parseDropDraft({ reason: "moved", note: "" });
    assert.deepEqual(sfe.ok ? sfe.value : null, { reason: "moved", note: null }, "without the option the comment is still optional");

    const list = source("src/lib/phoenix-crm/server/list.ts");
    assert.match(
      list,
      /else if \(kind === "drop"\) \{\s*const drop = parseDropDraft\(body, \{ requireNote: true \}\);/,
      "the rep's request is validated with the comment required, on the server and not only on the screen",
    );
    assert.match(list, /const drop = parseDropDraft\(body\);\s*if \(!drop\.ok\) throw validationError\(drop\.error\);\s*const created/, "the SFE's own drop is untouched");

    const screen = source("src/components/phoenix-crm/list-screens.tsx");
    assert.match(screen, /if \(!trimmed\) \{\s*setProblem\(DROP_COMMENT_REQUIRED\);/, "the rep's screen refuses an empty comment before sending");
    assert.match(screen, /hint=\{`Required · \$\{noteLength\} of \$\{DROP_REASON_MAX\} characters`\}/, "and says so on the field");
    assert.doesNotMatch(screen, /"Needed for Other" : "Optional"/, "the Optional hint on the drop comment is gone");
  }

  // ── B · What can be ticked ───────────────────────────────────────────────────────────────────────
  {
    const rows: BulkDropFacts[] = [
      request({ requestId: "drop-a" }),
      request({ requestId: "drop-b", stage: "manager" }),
      request({ requestId: "drop-waiting-elsewhere", canDecide: false }),
      request({ requestId: "drop-decided", status: "approved" }),
      request({ requestId: "add-1", kind: "add" }),
      request({ requestId: "grade-1", kind: "grade", stage: "manager" }),
      request({ requestId: "restore-1", kind: "restore" }),
    ];
    assert.deepEqual(
      bulkDropTargets(rows).map((row) => row.requestId),
      ["drop-a", "drop-b"],
      "only a drop waiting at this viewer's step: never an add, a grade or a bring-back, never another manager's, never a decided one",
    );
    assert.equal(isBulkDroppable(rows[2]), false);
    assert.equal(BULK_DROP_FROM, 2, "offered from two drops up: for one, its own Approve is the same press");

    // A tick on a request that left the screen is dropped from the selection and so never sent.
    assert.deepEqual([...pruneSelection(new Set(["drop-a", "gone", "add-1", "drop-decided"]), rows)], ["drop-a"], "the selection only ever holds live drops");
    assert.deepEqual([...pruneSelection(new Set(), rows)], [], "an empty selection stays empty");
  }

  // ── C · Each is the single-request decision, never a shortcut ───────────────────────────────────
  {
    assert.deepEqual(
      bulkDropDecisionBody({ requestId: "drop-a", stage: "manager" }),
      { requestId: "drop-a", decision: "approve", note: null, stage: "manager", approvedGrade: null, potentialGrade: null },
      "the same body the card's own Approve sends for a drop, carrying the step the screen showed so the race guard still bites",
    );
    assert.equal(bulkDropFailureText("phoenix_crm_request_decided", "x"), "it was already decided");
    assert.equal(bulkDropFailureText("phoenix_crm_request_wrong_stage", "x"), "it has moved on to the next step");
    assert.equal(bulkDropFailureText(null, "  Not allowed.  "), "Not allowed.");
    assert.equal(bulkDropFailureText(null, " "), "it was not saved");
  }

  // ── D · What he is told afterwards ──────────────────────────────────────────────────────────────
  {
    const allDropped = bulkDropNotice([
      { customerName: "Dr A", ok: true, final: true },
      { customerName: "Dr B", ok: true, final: true },
    ]);
    assert.deepEqual(allDropped, { tone: "info", title: "Approved 2 drop requests: 2 customers dropped from the list.", failures: [] });

    const sentOn = bulkDropNotice([
      { customerName: "Dr A", ok: true, final: false },
      { customerName: "Dr B", ok: true, final: false },
    ]);
    assert.equal(sentOn.title, "Approved 2 drop requests: 2 approved and sent on to SFE.", "a district manager's step is not a drop yet and is not reported as one");

    const mixed = bulkDropNotice([
      { customerName: "Dr A", ok: true, final: true },
      { customerName: "Dr B", ok: false, why: "it was already decided" },
      { customerName: "Dr C", ok: true, final: false },
    ]);
    assert.equal(mixed.tone, "warn");
    assert.equal(mixed.title, "Approved 2 of the 3 drop requests: 1 customer dropped from the list · 1 approved and sent on to SFE.");
    assert.deepEqual(mixed.failures, ["Dr B: it was already decided."], "the one that failed is named, with why");

    const none = bulkDropNotice([{ customerName: "Dr A", ok: false, why: "it was not saved" }]);
    assert.equal(none.tone, "bad");
    assert.equal(none.title, "None of the 1 drop request was approved.");
  }

  // ── E · The Team tab wires it to the one decide route, one at a time ────────────────────────────
  {
    const team = source("src/components/phoenix-crm/team-tab.tsx");
    assert.match(team, /const droppable = bulkDropTargets\(requests\);/, "the tab ticks only what the rule allows");
    assert.match(team, /const chosen = pruneSelection\(selected, requests\);/, "and acts on the selection after pruning it");
    assert.match(team, /for \(const request of batch\) \{[^]*?try \{\s*const result = await crmPost<\{ final: boolean \}>\("\/api\/phoenix-crm\/list\/requests\/decide", bulkDropDecisionBody\(request\)/, "one decision per request through the one decide route, in a loop that awaits each");
    assert.doesNotMatch(team, /Promise\.all\(batch|Promise\.all\(chosen/, "never all at once");
    assert.match(team, /Select all \$\{countText\(droppable\.length\)\} drop requests/, "a select-all above the cards");
    assert.match(team, /confirming \? \(/, "behind a confirm");
    assert.doesNotMatch(team, /rounded-(?!none)/, "square corners");

    const card = source("src/components/phoenix-crm/request-card.tsx");
    assert.match(card, /<CrmCheck checked=\{selection\.checked\} disabled=\{selection\.disabled\} onChange=\{selection\.onChange\}>/, "each drop card carries its tick box");
    assert.match(card, /selection\?: \{/, "and only the Team tab passes one: the rep's own card has none");
  }

  console.log("phoenix-crm bulk drop: OK");
}
