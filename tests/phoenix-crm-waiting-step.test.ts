import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import {
  listRequestWaitingStep,
  matchesWaitingStep,
  offPlanWaitingStep,
  WAITING_STEP_FILTER_LABELS,
  waitingStepCounts,
} from "../src/lib/phoenix-crm/waiting-step.ts";

/**
 * Phoenix CRM — the Team tab's two approval steps, apart (owner, 2026-11-28):
 *
 *   "When I press approve, for example, in the SFE step, nothing happened … I want to be able to filter by
 *    waiting for manager or waiting for SFE … and the waiting for manager to be visually differentiated
 *    from the waiting for SFE."
 *
 * What is pinned, and why:
 *
 *   1. One rule names the step a list request or an off-plan visit waits at. A grade change has no stage
 *      and is the district manager's; a request returned to the rep, a decided one, and a recorded visit
 *      waiting for the Administrator are at NEITHER step, so they show under "Every step" only.
 *   2. The filter's counts come from the same rule, so a count can never disagree with the cards it shows.
 *   3. A SAVED decision is said on the card at once. Production, 28 Nov 13:51:54: his approval at SFE's step
 *      saved, the Team tab took 4.25 s to reload, the card sat there with Approve live again and the notice
 *      at the top of the tab out of sight, and he pressed it again at 13:51:59 — "nothing happened". Both
 *      cards (a list request, an off-plan visit) keep the saved answer and offer no button until the
 *      reload moves the item on or takes it away.
 *   4. The two steps wear different colours, from one look shared by both cards: amber for the manager,
 *      indigo for SFE.
 */

function source(path: string): string {
  return stripComments(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));
}

export function runPhoenixCrmWaitingStepTests(): void {
  // ── 1 · The step a list request waits at ──────────────────────────────────────────────────────────
  assert.equal(listRequestWaitingStep({ status: "pending", stage: "manager", withRep: false }), "manager");
  assert.equal(listRequestWaitingStep({ status: "pending", stage: "sfe", withRep: false }), "sfe");
  assert.equal(
    listRequestWaitingStep({ status: "pending", stage: null, withRep: false }),
    "manager",
    "a grade change has no stage and is the district manager's one step",
  );
  assert.equal(listRequestWaitingStep({ status: "pending", stage: null, withRep: true }), null, "with the rep: waiting for neither step");
  assert.equal(listRequestWaitingStep({ status: "approved", stage: null, withRep: false }), null, "decided: waiting for nobody");

  // ── 1 · The step an off-plan visit waits at ───────────────────────────────────────────────────────
  assert.equal(offPlanWaitingStep("manager_pending"), "manager");
  assert.equal(offPlanWaitingStep("sfe_pending"), "sfe");
  assert.equal(offPlanWaitingStep("admin_pending"), null, "a recorded visit waits for the Administrator, neither step");
  assert.equal(offPlanWaitingStep("approved"), null);
  assert.equal(offPlanWaitingStep("refused"), null);

  // ── 2 · The filter and its counts ─────────────────────────────────────────────────────────────────
  assert.equal(matchesWaitingStep("sfe", "all"), true);
  assert.equal(matchesWaitingStep(null, "all"), true, "Every step shows the rep's and the Administrator's too");
  assert.equal(matchesWaitingStep("sfe", "sfe"), true);
  assert.equal(matchesWaitingStep("manager", "sfe"), false);
  assert.equal(matchesWaitingStep(null, "manager"), false);
  const requests = [
    { status: "pending", stage: "manager", withRep: false },
    { status: "pending", stage: null, withRep: false },
    { status: "pending", stage: "sfe", withRep: false },
    { status: "pending", stage: null, withRep: true },
  ];
  assert.deepEqual(waitingStepCounts(requests, listRequestWaitingStep), { all: 4, manager: 2, sfe: 1 });
  assert.equal(
    requests.filter((request) => matchesWaitingStep(listRequestWaitingStep(request), "sfe")).length,
    waitingStepCounts(requests, listRequestWaitingStep).sfe,
    "the count beside Waiting for SFE is the number of cards it shows",
  );
  assert.deepEqual(WAITING_STEP_FILTER_LABELS, { all: "Every step", manager: "Waiting for the manager", sfe: "Waiting for SFE" });

  // ── 3 · A saved decision is said on the card at once, and its buttons go ──────────────────────────
  const requestCard = source("src/components/phoenix-crm/request-card.tsx");
  assert.match(requestCard, /function done\(message: string\) \{\s*setSaved\(\{ message, at: fingerprint \}\);\s*onChanged\(message\);/);
  assert.match(requestCard, /const decides = pending && canDecide && request\.canDecide && savedHere === null;/);
  assert.match(requestCard, /const administratorDecides = pending && canOverride && !decides && savedHere === null;/);
  assert.doesNotMatch(requestCard, /onChanged\(`(Approved|Returned|Comment sent|Request withdrawn)/, "every saved answer goes through done(), never straight to onChanged");
  const offPlanCard = source("src/components/phoenix-crm/unplanned-visit-card.tsx");
  assert.match(offPlanCard, /setSaved\(\{ message, at: visit\.status \}\);\s*onChanged\(message\);/);
  assert.match(offPlanCard, /const locked = disabled \|\| busy !== null \|\| savedHere !== null;/);
  assert.match(offPlanCard, /\{savedHere \? \(\s*<CrmNote title="Saved" tone="good">/);

  // ── 4 · The two steps wear different colours, from one shared look ────────────────────────────────
  const ui = source("src/components/phoenix-crm/ui.tsx");
  assert.match(ui, /manager: \{ tone: "warn", accent: "border-l-amber-500" \}/);
  assert.match(ui, /sfe: \{ tone: "sfe", accent: "border-l-indigo-600" \}/);
  assert.match(offPlanCard, /manager_pending: \{ label: "Waiting for the manager", \.\.\.WAITING_STEP_LOOK\.manager \}/);
  assert.match(offPlanCard, /sfe_pending: \{ label: "Waiting for SFE", \.\.\.WAITING_STEP_LOOK\.sfe \}/);
  assert.match(requestCard, /tone: step \? WAITING_STEP_LOOK\[step\]\.tone : STATUS\.pending\.tone/);
  assert.match(requestCard, /accent=\{cardAccent\(request\)\}/);
}
