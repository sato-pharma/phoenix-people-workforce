import assert from "node:assert/strict";

import { isTrackableProductLine } from "../src/lib/market-awareness/lines.ts";
import {
  canCreateActivity,
  canEditActivity,
  canMarkFinancePaid,
  canViewActivity,
  canWithdrawActivity,
  resolveActivityVisibility,
} from "../src/lib/market-awareness/scope.ts";
import {
  baselinePeriodsFor,
  describeWindowCompleteness,
  windowPeriodsFor,
} from "../src/lib/market-awareness/tracking.ts";
import {
  canDecideStep,
  currentStep,
  findTransition,
  resolveManagerStep,
  statusAfterResubmit,
} from "../src/lib/market-awareness/workflow.ts";

// Market Awareness — the rules that are wrong silently if they regress.
//
// Every case below is drawn from the live reporting chain, measured on production 2026-09-06:
//
//   AA    Anwar Gaweesh    CEO                     (no manager)
//   A-9   Hossam           Marketing Manager       -> AA
//   A-8   Rasha            Group Product Manager   -> A-9
//   A-10  Nahed            Product Manager         -> A-9      <- reports to the MARKETING MANAGER
//   B-155 Ahmed Sharaf     Product Manager         -> A-8      <- reports to the GPM
//
// The two Product Managers report to DIFFERENT people. A chain written as "PM -> GPM" looks correct,
// passes review, and silently routes Nahed's activity to the wrong approver — which is why the
// manager step is resolved from the reporting line and pinned here.

export function runMarketAwarenessTests() {
  // ── The manager step is resolved by IDENTITY, never by title ───────────────

  const ahmed = resolveManagerStep({
    requesterHrId: "B-155",
    requesterManagerHrId: "A-8",
    managerIsCeo: false,
  });
  assert.equal(ahmed.managerHrId, "A-8", "Ahmed Sharaf's manager step is Rasha, the GPM");
  assert.equal(ahmed.skipManagerStep, false);

  const nahed = resolveManagerStep({
    requesterHrId: "A-10",
    requesterManagerHrId: "A-9",
    managerIsCeo: false,
  });
  assert.equal(
    nahed.managerHrId,
    "A-9",
    "Nahed reports to the Marketing Manager, NOT to the Group Product Manager",
  );

  const rasha = resolveManagerStep({
    requesterHrId: "A-8",
    requesterManagerHrId: "A-9",
    managerIsCeo: false,
  });
  assert.equal(rasha.managerHrId, "A-9", "the GPM's own request goes to her manager");

  // The Marketing Manager reports to the CEO, so there is no step underneath him. Owner answer 35.
  const hossam = resolveManagerStep({
    requesterHrId: "A-9",
    requesterManagerHrId: "AA",
    managerIsCeo: true,
  });
  assert.equal(hossam.skipManagerStep, true, "a request from the Marketing Manager skips to the CEO");
  assert.equal(hossam.managerHrId, null, "and stores no manager, so nobody can decide that step");

  // A row with no manager, and a row that manages itself, both fall through to the CEO rather than
  // letting the requester approve his own activity.
  assert.equal(
    resolveManagerStep({ requesterHrId: "AA", requesterManagerHrId: null, managerIsCeo: false })
      .skipManagerStep,
    true,
  );
  assert.equal(
    resolveManagerStep({ requesterHrId: "A-8", requesterManagerHrId: "a-8", managerIsCeo: false })
      .skipManagerStep,
    true,
    "an HR id that manages itself must not become its own approver, in either casing",
  );

  assert.equal(statusAfterResubmit(false), "pending_manager");
  assert.equal(statusAfterResubmit(true), "pending_ceo");

  // ── The manager step is identity-checked, not role-checked ─────────────────
  //
  // A role check would let ANY Group Product Manager approve ANY Product Manager's activity, which
  // is not what "his direct manager" means.

  assert.equal(
    canDecideStep({
      access: { role: "Group Product Manager", hrId: "A-8" },
      step: "manager",
      managerHrId: "A-8",
    }),
    true,
    "the manager the activity was routed to may decide it",
  );
  assert.equal(
    canDecideStep({
      access: { role: "Group Product Manager", hrId: "A-8" },
      step: "manager",
      managerHrId: "A-9",
    }),
    false,
    "a GPM may NOT approve an activity routed to somebody else, even holding the same role",
  );
  // HR ids are mixed case on this database; the comparison is canonical on both sides.
  assert.equal(
    canDecideStep({
      access: { role: "Group Product Manager", hrId: "a-8" },
      step: "manager",
      managerHrId: "A-8",
    }),
    true,
    "HR id casing must not decide who may approve",
  );
  assert.equal(
    canDecideStep({ access: { role: "CEO", hrId: "AA" }, step: "manager", managerHrId: "A-8" }),
    false,
    "the CEO does not get the manager step by virtue of being the CEO",
  );
  assert.equal(
    canDecideStep({ access: { role: "CEO", hrId: "AA" }, step: "ceo", managerHrId: "A-8" }),
    true,
  );
  assert.equal(
    canDecideStep({
      access: { role: "Marketing Manager", hrId: "A-9" },
      step: "ceo",
      managerHrId: null,
    }),
    false,
    "nobody approves the CEO step for him",
  );

  // ── Transitions ───────────────────────────────────────────────────────────

  assert.equal(currentStep("pending_manager"), "manager");
  assert.equal(currentStep("pending_ceo"), "ceo");
  assert.equal(currentStep("approved"), null, "an approved activity waits on no decision");

  assert.equal(findTransition("pending_manager", "approve")?.to, "pending_ceo");
  assert.equal(findTransition("pending_ceo", "approve")?.to, "approved");
  assert.equal(findTransition("pending_ceo", "return")?.to, "returned");

  // Owner answer 39: withdrawable "before the CEO decides" — so a request in his queue still is,
  // and one he has approved is not.
  assert.ok(findTransition("pending_ceo", "withdraw"), "a PM may withdraw before the CEO decides");
  assert.equal(
    findTransition("approved", "withdraw"),
    null,
    "an APPROVED activity can never be withdrawn — it is locked",
  );
  assert.equal(findTransition("closed", "approve"), null);

  // ── Who sees what ─────────────────────────────────────────────────────────

  assert.equal(canCreateActivity({ role: "Product Manager" }), true);
  assert.equal(canCreateActivity({ role: "Group Product Manager" }), true);
  // Owner answer 2's NOTE — "also marketing manager and systemn admin" — overrides its dropdown.
  assert.equal(canCreateActivity({ role: "Marketing Manager" }), true);
  assert.equal(canCreateActivity({ role: "Super Admin" }), true);
  assert.equal(canCreateActivity({ role: "Medical Rep" }), false);
  assert.equal(canCreateActivity({ role: "District Manager" }), false);
  assert.equal(
    canCreateActivity({ role: "CEO" }),
    false,
    "the CEO approves activities; he does not raise them",
  );

  assert.deepEqual(resolveActivityVisibility({ role: "Product Manager", hrId: "B-155" }), {
    kind: "own",
    hrId: "B-155",
  });
  assert.deepEqual(resolveActivityVisibility({ role: "Group Product Manager", hrId: "A-8" }), {
    kind: "all",
  });
  assert.deepEqual(resolveActivityVisibility({ role: "Finance Manager", hrId: "F-1" }), {
    kind: "all",
  });
  // An unauthenticated caller resolves to role `Employee` rather than to null on this app, so a
  // `!role` guard would never fire. The refusal has to be positive.
  assert.deepEqual(resolveActivityVisibility({ role: "Employee", hrId: "X-1" }), { kind: "none" });
  assert.deepEqual(resolveActivityVisibility({ role: "Product Manager", hrId: null }), {
    kind: "none",
  });

  assert.equal(
    canViewActivity({ role: "Product Manager", hrId: "b-155" }, { requesterHrId: "B-155" }),
    true,
    "a PM sees his own activity whatever the id casing",
  );
  assert.equal(
    canViewActivity({ role: "Product Manager", hrId: "A-10" }, { requesterHrId: "B-155" }),
    false,
    "one Product Manager must not see another's activities",
  );
  assert.equal(
    canViewActivity({ role: "SFE Manager", hrId: "S-1" }, { requesterHrId: "B-155" }),
    true,
    "an informed role reads every activity — it holds read and nothing else",
  );

  // ── An approved activity is locked (owner answer 40) ───────────────────────

  const approved = { requesterHrId: "B-155", status: "approved" as const };
  assert.equal(canEditActivity({ role: "Product Manager", hrId: "B-155" }, approved), false);
  assert.equal(canWithdrawActivity({ role: "Product Manager", hrId: "B-155" }, approved), false);
  assert.equal(
    canEditActivity({ role: "Super Admin", hrId: null }, approved),
    false,
    "not even Super Admin edits an approved activity — the lock is on the STATUS, not the role",
  );

  const draft = { requesterHrId: "B-155", status: "draft" as const };
  assert.equal(canEditActivity({ role: "Product Manager", hrId: "B-155" }, draft), true);
  assert.equal(
    canEditActivity({ role: "Product Manager", hrId: "A-10" }, draft),
    false,
    "a PM cannot edit another PM's draft",
  );
  const returned = { requesterHrId: "B-155", status: "returned" as const };
  assert.equal(canEditActivity({ role: "Product Manager", hrId: "B-155" }, returned), true);

  // ── Finance marks paid, and only after approval ───────────────────────────

  assert.equal(canMarkFinancePaid({ role: "Finance Manager" }, { status: "approved" }), true);
  assert.equal(
    canMarkFinancePaid({ role: "Finance Manager" }, { status: "pending_ceo" }),
    false,
    "marking an unapproved activity paid would record a payment nobody authorised",
  );
  assert.equal(canMarkFinancePaid({ role: "Product Manager" }, { status: "approved" }), false);

  // ── Head Office can never be targeted ─────────────────────────────────────
  //
  // Head Office is absent from monthly closing tracking by golden rule, so one of its products could
  // only render a permanent zero — which reads as a broken report rather than as a rule.

  assert.equal(isTrackableProductLine("CNS"), true);
  assert.equal(isTrackableProductLine("Anti Infective"), true);
  assert.equal(isTrackableProductLine("Pedia"), true);
  assert.equal(isTrackableProductLine("Head Office"), false);
  assert.equal(isTrackableProductLine("head office"), false, "the exclusion is case-insensitive");
  assert.equal(isTrackableProductLine("IGNORE"), false, "IGNORE is a bucket, not a line");
  assert.equal(isTrackableProductLine(null), false);
  assert.equal(isTrackableProductLine(""), false);

  // ── Period arithmetic, including the year boundary ────────────────────────

  assert.deepEqual(
    baselinePeriodsFor("2026-09", 3),
    ["2026-06", "2026-07", "2026-08"],
    "three months BEFORE the activity, oldest first",
  );
  assert.deepEqual(
    baselinePeriodsFor("2026-02", 3),
    ["2025-11", "2025-12", "2026-01"],
    "the baseline crosses the year boundary correctly",
  );
  assert.deepEqual(windowPeriodsFor("2026-09", 3), ["2026-09", "2026-10", "2026-11"]);
  assert.deepEqual(
    windowPeriodsFor("2026-11", 3),
    ["2026-11", "2026-12", "2027-01"],
    "the window crosses the year boundary forwards",
  );
  assert.deepEqual(windowPeriodsFor("2026-09", 1), ["2026-09"]);
  assert.equal(
    baselinePeriodsFor("2026-09", 3).includes("2026-09"),
    false,
    "the activity's own month is never part of its own baseline",
  );

  // ── The running month is never presented as a closed one ──────────────────

  assert.equal(
    describeWindowCompleteness(["2026-06", "2026-07"], "2026-08"),
    null,
    "a fully closed window needs no caveat",
  );
  const partial = describeWindowCompleteness(["2026-08", "2026-09"], "2026-08");
  assert.ok(partial && partial.includes("2026-08"), "a partly open window names the last closed month");
  assert.ok(
    partial && partial.includes("1 of the 2"),
    "and says how many months are still open, rather than showing a half month as a fall",
  );
  const allOpen = describeWindowCompleteness(["2026-09", "2026-10"], "2026-08");
  assert.ok(
    allOpen && allOpen.includes("has not reached a closed month"),
    "a window entirely in the future says so instead of rendering zeros",
  );
  assert.ok(
    describeWindowCompleteness(["2026-09"], null)?.includes("No closing has been published"),
    "no closing at all is reported as such, never as zero sales",
  );
}
