import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildDirectOrderNeedsAction,
  buildDirectOrderWorkspaceSummary,
  countDirectOrderNeedsAction,
  type DirectOrderQueueRow,
} from "../src/lib/direct-orders/needs-action.ts";
import {
  DIRECT_ORDER_STAGE_SEQUENCE,
  describeDirectOrderOwner,
  describeDirectOrderStatus,
  resolveDirectOrderReachedStage,
} from "../src/lib/direct-orders/status-labels.ts";

// ─────────────────────────────────────────────────────────────────────────────
// The consolidated workspace's two rules, EXECUTED rather than read.
//
// Both live in pure .ts on purpose. The tests run under
// `node --experimental-strip-types`, which cannot load a .tsx file at all — so a
// rule kept in a component could only be checked by matching its source text, and
// a source match proves a string is present, not that the rule is right. That is
// the same reasoning that put `showsAwaitingFinanceMonth` in types.ts.
//
// What is actually protected here:
//   1. No status may reach a user as its DATABASE value. That was the state
//      before this change — the pill rendered `String(status).replace(/_/g, " ")`,
//      so a District Manager read "held" and had to already know it means "your
//      pharmacy is unknown and nobody is looking at your order".
//   2. The Needs Action inbox must never show a queue the viewer cannot clear.
// ─────────────────────────────────────────────────────────────────────────────

/** Every status `direct_order_requests_status_check` permits — the 9 in the union. */
const ALL_STATUSES = [
  "draft",
  "pending_approval",
  "approved",
  "rejected",
  "returned",
  "reversed",
  "held",
  "expired",
  "cancelled",
] as const;

function row(over: Partial<DirectOrderQueueRow> = {}): DirectOrderQueueRow {
  return {
    id: "req-1",
    requesterName: "Mona Salah",
    productName: "Ivyronc",
    qty: 100,
    pharmacyName: "El Ezaby",
    areaName: "Nasr City",
    regionName: "Cairo",
    salesValue: 12_000,
    createdAt: "2026-08-01T09:00:00.000Z",
    status: "pending_approval",
    salesMonth: null,
    bonusOverCap: false,
    ...over,
  };
}

export function runDirectOrderWorkspaceVocabularyTests() {
  // ── 1. No database value may ever reach a person ───────────────────────────
  for (const status of ALL_STATUSES) {
    const { label, explanation } = describeDirectOrderStatus(status, null);

    assert.doesNotMatch(
      label,
      /_/,
      `"${status}" STILL RENDERS ITS DATABASE VALUE: an underscore on screen means the label fell through to the raw column, which is the exact thing this vocabulary replaced`,
    );
    assert.ok(
      explanation.length > 20,
      `"${status}" has no explanation worth showing; the label alone cannot carry a rule like "held means nobody is looking at your order"`,
    );
  }

  // Four statuses ARE their own best label — "Draft", "Rejected", "Expired",
  // "Reversed" say exactly what happened, and renaming them would be change for
  // its own sake. The other five do not, and each one misleads in its own way:
  // these are the ones a de-underscoring pass would have left broken.
  const MUST_BE_TRANSLATED: Record<string, string> = {
    pending_approval: "'pending approval' names the row's state, not who is holding it up",
    held: "'held' reads as 'an approver paused this' when no approver has seen it at all",
    returned: "'returned' does not say the requester has to act, so returned orders sit untouched",
    cancelled: "'cancelled' is indistinguishable from 'rejected' to a reader, and they are different facts",
  };
  for (const [status, why] of Object.entries(MUST_BE_TRANSLATED)) {
    assert.notStrictEqual(
      describeDirectOrderStatus(status, null).label.toLowerCase(),
      status.replace(/_/g, " "),
      `"${status}" IS ONLY DE-UNDERSCORED, NOT TRANSLATED: ${why}`,
    );
  }

  // `held` is the one whose database name actively misleads: it reads as "an
  // approver paused this" when no approver has seen it at all.
  const held = describeDirectOrderStatus("held", null);
  assert.strictEqual(held.stage, "customer_check");
  assert.match(
    held.label,
    /verification/i,
    "HELD MUST NAME THE PROBLEM: the reader's next step is getting the pharmacy verified, and 'Held' tells them nothing about that",
  );

  // ── 2. The GOLDEN RULE survives the rename ─────────────────────────────────
  //
  // CEO approval injects no sales; only the Finance booking does. `approved` with
  // a null month and `approved` with a month are OPPOSITE facts about whether the
  // money is counted, and the vocabulary must not collapse them.
  const unbooked = describeDirectOrderStatus("approved", null);
  const booked = describeDirectOrderStatus("approved", "2026-08");
  assert.notStrictEqual(
    unbooked.label,
    booked.label,
    "AN APPROVED-BUT-UNBOOKED ORDER READS THE SAME AS A BOOKED ONE: its value is in nobody's numbers, and one shared label says the opposite",
  );
  assert.strictEqual(unbooked.stage, "finance");
  assert.strictEqual(unbooked.actionable, true, "somebody still has to book it, so it belongs in a queue");
  assert.strictEqual(booked.stage, "completed");
  assert.strictEqual(booked.actionable, false, "a booked order is nobody's outstanding work");

  // Every stage a status can report must be a real stage in the progression, or
  // the stepper renders a step that does not exist.
  const stages = new Set<string>([...DIRECT_ORDER_STAGE_SEQUENCE, "stopped"]);
  for (const status of ALL_STATUSES) {
    assert.ok(
      stages.has(describeDirectOrderStatus(status, null).stage),
      `"${status}" reports a stage outside the declared progression`,
    );
    assert.ok(
      stages.has(resolveDirectOrderReachedStage({ status, salesMonth: null })),
      `"${status}" reaches a stage outside the declared progression`,
    );
  }

  // A dead end must say WHERE it died — "rejected at approval" and "expired
  // before anyone saw it" are different stories about the same grey stepper.
  assert.strictEqual(resolveDirectOrderReachedStage({ status: "rejected", salesMonth: null }), "approval");
  assert.strictEqual(resolveDirectOrderReachedStage({ status: "expired", salesMonth: null }), "customer_check");

  // ── 3. "Who has it now" ────────────────────────────────────────────────────
  assert.strictEqual(
    describeDirectOrderOwner({
      status: "pending_approval",
      salesMonth: null,
      activeStepLabel: "Regional Manager",
      requesterName: "Mona Salah",
    }),
    "Regional Manager",
    "the rung's own label must pass through — approval-flow.ts is the only thing entitled to name a rung",
  );
  assert.strictEqual(
    describeDirectOrderOwner({
      status: "returned",
      salesMonth: null,
      activeStepLabel: "Regional Manager",
      requesterName: "Mona Salah",
    }),
    "Mona Salah",
    "A RETURNED ORDER IS THE REQUESTER'S WORK, not the approver's: naming the approver here is why returned orders sit untouched",
  );
  assert.strictEqual(
    describeDirectOrderOwner({ status: "approved", salesMonth: null, activeStepLabel: "", requesterName: "Mona" }),
    "Finance",
  );

  // ── 4. The inbox never shows a queue the viewer cannot clear ───────────────
  const empty = buildDirectOrderNeedsAction({
    awaitingMyApproval: [],
    myOrders: [],
    awaitingFinanceMonth: [],
    pendingCustomerValidations: 0,
    basePath: "/admin/direct-orders",
  });
  assert.deepStrictEqual(empty, [], "an empty inbox must render nothing at all, not five zero rows");

  const groups = buildDirectOrderNeedsAction({
    awaitingMyApproval: [row({ id: "a1" }), row({ id: "a2" })],
    myOrders: [
      row({ id: "m1", status: "returned" }),
      row({ id: "m2", status: "held" }),
      row({ id: "m3", status: "approved", salesMonth: "2026-08" }),
    ],
    awaitingFinanceMonth: [],
    pendingCustomerValidations: 0,
    basePath: "/admin/direct-orders",
  });
  const kinds = groups.map((group) => group.kind);
  assert.deepStrictEqual(kinds, ["approve", "correct", "verify_customer"]);
  assert.ok(
    !kinds.includes("assign_month"),
    "A VIEWER WHO CANNOT BOOK A MONTH MUST NOT SEE THE FINANCE QUEUE: a badge nobody can clear is how people learn to ignore badges",
  );
  assert.strictEqual(countDirectOrderNeedsAction(groups), 4);

  // A completed order is not outstanding work and must never enter the inbox.
  assert.ok(
    groups.every((group) => group.items.every((item) => item.id !== "m3")),
    "a booked, completed order appeared in Needs Action",
  );

  // Every row must deep-link to its own record, never to a list — the brief's
  // "clicking an item takes the user directly to the relevant record".
  for (const group of groups) {
    for (const item of group.items) {
      assert.match(
        item.href,
        /^\/admin\/direct-orders\/[^/]+$/,
        `"${group.kind}" links to a list instead of the record: the reader then has to find the row again`,
      );
    }
  }

  // Headlines are about the READER, so they must address them.
  for (const group of groups) {
    assert.match(
      group.headline,
      /\byou(r)?\b/i,
      `"${group.kind}" does not say it is the reader's: an inbox that describes records rather than duties is just another list`,
    );
  }

  // ── 5. Summary counts ──────────────────────────────────────────────────────
  const summary = buildDirectOrderWorkspaceSummary({
    needsAction: groups,
    scopedOrders: [
      row({ id: "s1", status: "pending_approval" }),
      row({ id: "s2", status: "held" }),
      row({ id: "s3", status: "returned" }),
      row({ id: "s4", status: "approved", salesMonth: "2026-08" }),
      row({ id: "s5", status: "approved", salesMonth: "2026-07" }),
      row({ id: "s6", status: "approved", salesMonth: null }),
    ],
    currentSalesMonth: "2026-08",
  });
  assert.strictEqual(summary.returned, 1);
  assert.strictEqual(
    summary.inProgress,
    3,
    "in-progress must count the held and the awaiting-Finance orders too — both are moving, and neither is done",
  );
  assert.strictEqual(
    summary.completedThisMonth,
    1,
    "COMPLETED MUST COUNT THE BOOKING MONTH, NOT THE APPROVAL: counting approvals reports money that was never injected (the GOLDEN RULE)",
  );
  assert.strictEqual(summary.needsMyAction, 4);

  // ── 6. The shared pill must not grow a second vocabulary ───────────────────
  const pill = readFileSync(
    new URL("../src/components/direct-orders/direct-order-status-pill.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    pill,
    /describeDirectOrderStatus/,
    "the pill must read the shared vocabulary — a local label map is how four copies of 'Approved' drifted apart in the first place",
  );
  // Anchored to the ASSIGNMENT, not swept over the file: the comment above it
  // quotes the old `String(status).replace(...)` expression to explain what was
  // replaced, and a whole-file sweep would fail on the explanation of its own fix.
  assert.match(
    pill,
    /const label = presentation\.label;/,
    "THE RAW-STATUS FALLBACK IS BACK IN THE PILL: the label must come from the shared vocabulary, or the four surfaces render the database value again",
  );
}
