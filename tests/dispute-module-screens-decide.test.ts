import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

/**
 * THE TWO MODULE INBOXES CAN DECIDE, NOT ONLY REPLY (owner, 2026-11-07: "in deduction disputes I want
 * to be able to approve or reject the dispute and the calendar dispute — today I do not have the
 * option except reply").
 *
 * - The deductions Disputes tab carries the Dispute Center's own decision panel on every card, fed by
 *   the Dispute Center's case route, so accept / reduce / reject run the ONE server rule in
 *   src/lib/dispute-center/deduction.ts — this tab never posts a decision of its own.
 * - The calendar inbox shows Accept and Reject on every card. They sat behind a "Review" toggle,
 *   which read as if replying were the only thing the inbox could do.
 *
 * Comments are stripped before matching, so a comment that names a call cannot stand in for the call.
 */

function code(path: string): string {
  return stripComments(readFileSync(path, "utf8"));
}

export async function runDisputeModuleScreensDecideTests() {
  const tab = code("src/components/admin/deductions-disputes-tab.tsx");
  assert.match(tab, /<DisputeDecisionPanel\b/, "the deductions Disputes tab renders the decision panel");
  assert.match(tab, /<CaseDecision\b/, "…on every dispute card");
  assert.match(
    tab,
    /\/api\/dispute-center\/cases\/deduction\//,
    "…fed by the Dispute Center's own case, so the money rule stays in one place",
  );
  assert.doesNotMatch(tab, /\/decide["`]/, "the tab never posts a decision itself; the shared panel does");

  const calendar = code("src/components/admin/private-calendar-disputes-workspace.tsx");
  assert.match(calendar, /decide\(dispute\.id, "accept"\)/, "the calendar inbox offers Accept");
  assert.match(calendar, /decide\(dispute\.id, "reject"\)/, "…and Reject");
  assert.doesNotMatch(calendar, /decidingId/, "Accept and Reject are not hidden behind a Review toggle");
}
