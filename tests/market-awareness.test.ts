import assert from "node:assert/strict";

import { readFileSync } from "node:fs";

import { conversationMessageIdempotencyKey } from "../src/lib/conversations/notify.ts";
import { isTrackableProductLine } from "../src/lib/market-awareness/lines.ts";
import { MARKET_AWARENESS_STATUSES } from "../src/lib/market-awareness/types.ts";
import { resolvePendingDecisionRecipients } from "../src/lib/market-awareness/notifications.ts";
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

  // -------------------------------------------------------------------------
  // The conversation emails EVERY message, not just the first one.
  // -------------------------------------------------------------------------
  //
  // Measured on staging 2026-09-06, before the fix: three comments on one activity produced ONE
  // email. `createSystemNotification` keys an event on { actionUrl, eventType, module, recipient,
  // title }, and a thread's title and action url never change between its messages — so every
  // comment after the first collapsed onto the first one's event and was deduplicated into silence.
  // Nothing failed and nothing was logged: the thread simply stopped emailing, which is the exact
  // shape of "a feature that ships green and reaches nobody".
  const first = conversationMessageIdempotencyKey(
    { eventType: "market_awareness_comment", messageKey: 41, module: "market_awareness", recordId: "act-1" },
    "B-155",
  );
  const second = conversationMessageIdempotencyKey(
    { eventType: "market_awareness_comment", messageKey: 42, module: "market_awareness", recordId: "act-1" },
    "B-155",
  );
  assert.ok(first, "a comment carrying a message key must produce an idempotency key");
  assert.notEqual(
    first,
    second,
    "two comments on one activity must be two events, or only the first one is ever emailed",
  );

  // Per recipient too: one key shared across the recipients of a single message is the same silence
  // one step further out, with everyone after the first collapsing onto one event.
  assert.notEqual(
    conversationMessageIdempotencyKey(
      { eventType: "market_awareness_comment", messageKey: 41, module: "market_awareness", recordId: "act-1" },
      "A-8",
    ),
    first,
    "one message to two people must be two events",
  );

  // Mixed case is one person — the id is canonicalized, so a retry spelled differently is still a
  // retry and does not email anybody twice.
  assert.equal(
    conversationMessageIdempotencyKey(
      { eventType: "market_awareness_comment", messageKey: 41, module: "market_awareness", recordId: "act-1" },
      "b-155",
    ),
    first,
    "the same message to the same person is one event however the hr id is spelled",
  );

  // A caller that supplies no message key keeps the old behaviour rather than getting a key built
  // from something that varies per call, which would defeat the deduplication entirely.
  assert.equal(
    conversationMessageIdempotencyKey(
      { eventType: "candidate_comment", messageKey: null, module: "recruitment", recordId: "cand-1" },
      "A-8",
    ),
    null,
    "a caller with no message key must not be given one",
  );

  // And the service must actually pass it. The helper being correct changes nothing if the comment
  // path never hands it the id — which is how this defect existed in the first place.
  const service = readFileSync(new URL("../src/lib/market-awareness/service.ts", import.meta.url), "utf8");
  assert.ok(
    /messageKey,/.test(service),
    "addActivityComment must pass the comment id to the notifier as messageKey",
  );
  assert.ok(
    service.includes('.select("id")'),
    "the comment insert must return its id, or there is no message key to pass",
  );

  // -------------------------------------------------------------------------
  // Somebody is actually TOLD there is a decision waiting.
  // -------------------------------------------------------------------------
  //
  // The module shipped with an approvals inbox and nothing that sent anyone to it. Two real
  // requests sat untouched on production 2026-09-07 — submitted 09:52 and 09:56 Cairo, zero
  // notification_events rows for the whole module — because the only notification wired was the one
  // that fires AFTER the CEO approves. A queue nobody is sent to is a queue nobody reads, and the
  // symptom is indistinguishable from "nobody wanted to approve it yet".

  // The manager step is identity-based, matching canDecideStep.
  assert.deepEqual(
    resolvePendingDecisionRecipients({ ceoHrIds: ["A-1"], managerHrId: "A-8", step: "manager" }),
    ["A-8"],
    "the manager step must tell the manager the activity was actually routed to",
  );

  // The CEO step is role-based and must IGNORE the manager entirely. A Group Product Manager has
  // nobody above them, so their activity reaches the CEO with managerHrId null — the real shape of
  // MAW-20260907-390A2720. Keying this step off the manager tells nobody at all.
  assert.deepEqual(
    resolvePendingDecisionRecipients({ ceoHrIds: ["A-1"], managerHrId: null, step: "ceo" }),
    ["A-1"],
    "a GPM's activity has no manager and must still reach the CEO",
  );
  assert.deepEqual(
    resolvePendingDecisionRecipients({ ceoHrIds: ["A-1"], managerHrId: "A-8", step: "ceo" }),
    ["A-1"],
    "the CEO step must not notify the manager who already approved it",
  );

  // Mixed-case ids are one person — hr_id is stored upper-case and compared lower, so a duplicate
  // spelling must not send the CEO two copies of the same request.
  assert.deepEqual(
    resolvePendingDecisionRecipients({ ceoHrIds: ["A-1", "a-1"], managerHrId: null, step: "ceo" }),
    ["A-1"],
    "one person spelled two ways is one recipient",
  );

  // No holder is an empty list, never a crash and never a silent fallback to somebody else.
  assert.deepEqual(
    resolvePendingDecisionRecipients({ ceoHrIds: [], managerHrId: null, step: "manager" }),
    [],
    "a step with no holder notifies nobody rather than guessing a recipient",
  );

  // And the workflow must actually CALL it. The resolver being right changes nothing if the submit
  // path never announces the hand-off — which is precisely the defect this pins.
  //
  // SLICED TO ONE FUNCTION, never matched across the whole file. The first version of this pin used
  // /submitActivity[\s\S]*?notifyDecisionPending\(/ and passed with the call deleted, because the
  // unbounded scan ran past the end of submitActivity and found the call inside decideActivity. A
  // pin that cannot fail is worse than no pin: it reports the thing it was written to protect.
  const maService = readFileSync(new URL("../src/lib/market-awareness/service.ts", import.meta.url), "utf8");
  const functionBody = (name: string): string => {
    const start = maService.indexOf(`export async function ${name}`);
    assert.notEqual(start, -1, `${name} must exist for its notification pin to mean anything`);
    const next = maService.indexOf("\nexport ", start + 1);
    return maService.slice(start, next === -1 ? maService.length : next);
  };

  const submitBody = functionBody("submitActivity");
  assert.ok(
    submitBody.includes("notifyDecisionPending("),
    "submitActivity must announce the hand-off, or the approvals inbox is never opened",
  );

  const decideBody = functionBody("decideActivity");
  assert.ok(
    /transition\.to === "pending_ceo"[\s\S]{0,400}notifyDecisionPending\(/.test(decideBody),
    "advancing to the CEO must tell the CEO",
  );
  assert.ok(
    /transition\.to === "returned" \|\| transition\.to === "rejected"[\s\S]{0,600}notifyActivityReturned\(/.test(decideBody),
    "a returned or rejected activity must tell the person who raised it",
  );

  // -------------------------------------------------------------------------
  // Tracking is not deciding.
  // -------------------------------------------------------------------------
  //
  // The owner asked for two things on 2026-09-07: the Group Product Manager must be able to track a
  // Product Manager's request while it sits with that PM's own manager, and the inbox must carry the
  // same two tabs as every other approval inbox. Widening what the inbox SHOWS is the whole point —
  // and it is also the moment the queue could start offering buttons the decision route refuses.
  //
  // So the two questions stay separate: `canViewActivity` decides what is listed, `canDecideStep`
  // decides what is actionable, and a row carries both answers rather than inferring one from the
  // other. These pin that a viewer can be true for the first and false for the second.
  const ahmedsActivity = { requesterHrId: "B-155" };
  const gpm = { hrId: "A-4", role: "Group Product Manager" as const };
  const rashaViewer = { hrId: "A-8", role: "Marketing Manager" as const };

  assert.equal(
    canViewActivity(gpm, ahmedsActivity),
    true,
    "the Group Product Manager must be able to track a Product Manager's request",
  );
  assert.equal(
    canDecideStep({ access: gpm, managerHrId: "A-8", step: "manager" }),
    false,
    "tracking a request must never make the tracker its approver",
  );
  assert.equal(
    canDecideStep({ access: rashaViewer, managerHrId: "A-8", step: "manager" }),
    true,
    "the manager it was actually routed to still decides it",
  );

  // The requester can see their own row in the same widened list, and still cannot approve it.
  const ahmedViewer = { hrId: "B-155", role: "Product Manager" as const };
  assert.equal(
    canViewActivity(ahmedViewer, ahmedsActivity),
    true,
    "a product manager keeps sight of their own request",
  );
  assert.equal(
    canDecideStep({ access: ahmedViewer, managerHrId: "A-8", step: "manager" }),
    false,
    "nobody approves their own request, however wide the list gets",
  );

  // And the widening must not reach a Product Manager's view of SOMEBODY ELSE'S request. The inbox
  // scopes on resolveActivityVisibility, which is `own` for that role — if this ever returns true
  // the new list has quietly handed every PM every other PM's spending.
  assert.equal(
    canViewActivity(ahmedViewer, { requesterHrId: "B-200" }),
    false,
    "a product manager must not see another product manager's request",
  );

  // The inbox's two scopes must between them cover every status a submitted activity can hold, or a
  // request becomes invisible the moment it reaches the missing one — which is the failure the
  // History tab was added to end. `draft` is deliberately in neither: nobody has been told about it.
  const inboxService = readFileSync(new URL("../src/lib/market-awareness/service.ts", import.meta.url), "utf8");
  const scopeList = (name: string): string[] => {
    const match = new RegExp(`const ${name}: MarketAwarenessStatus\\[\\] = \\[([^\\]]*)\\]`).exec(inboxService);
    assert.ok(match, `${name} must exist for the inbox scopes to be checkable`);
    return (match?.[1] ?? "").split(",").map((entry) => entry.trim().replace(/"/g, "")).filter(Boolean);
  };
  const covered = new Set([...scopeList("OPEN_STATUSES"), ...scopeList("HISTORY_STATUSES")]);
  for (const status of MARKET_AWARENESS_STATUSES) {
    if (status === "draft") continue;
    assert.ok(
      covered.has(status),
      `status "${status}" is in neither inbox tab, so an activity in it is visible to nobody`,
    );
  }

  // -------------------------------------------------------------------------
  // A decision and its audit row are ONE write.
  // -------------------------------------------------------------------------
  //
  // Every decision path used to do two: move the status, then insert the row saying who moved it.
  // Anything failing between them left a request that had MOVED with no record of who moved it —
  // on a spending approval, the whole audit trail. Reproduced on staging 2026-09-07: status
  // `approved`, approved_at set, one decision row where there should have been two.
  //
  // These are source pins, and they are the honest instrument here: the property lives in a plpgsql
  // function, so a unit test cannot exercise it. What a test CAN do is stop the two-write shape
  // coming back, which is how it arrived in the first place.
  const atomicService = readFileSync(new URL("../src/lib/market-awareness/service.ts", import.meta.url), "utf8");

  assert.ok(
    !atomicService.includes('from("market_awareness_decisions").insert'),
    "no path may insert an audit row on its own — every one goes through the atomic function, or a "
      + "failure between the two writes leaves a decision nobody made",
  );

  const atomicBody = (name: string): string => {
    const start = atomicService.indexOf(`export async function ${name}`);
    assert.notEqual(start, -1, `${name} must exist for its atomicity pin to mean anything`);
    const next = atomicService.indexOf("\nexport ", start + 1);
    return atomicService.slice(start, next === -1 ? atomicService.length : next);
  };

  // Sliced per function, never matched across the file: an unbounded scan here would find the call
  // in a neighbouring function and pass with this one's deleted.
  for (const name of ["decideActivity", "withdrawActivity", "closeActivity"]) {
    assert.ok(
      atomicBody(name).includes("applyDecisionAtomically("),
      `${name} must apply its state change and its audit row as one statement`,
    );
  }

  // The caller has to pass the status it believed it was acting on, or the function cannot refuse a
  // stale write and two people can decide the same step at once.
  assert.ok(
    /expectedStatus: existing\.status/.test(atomicService),
    "a decision must declare the status it expected, or a concurrent decision is written twice",
  );

  // The function is SECURITY DEFINER, so a browser-side key reaching it would be able to approve
  // spending. The migration must revoke it from anon and authenticated, not merely omit a grant.
  const atomicMigration = readFileSync(
    new URL("../supabase/migrations/20260907120000_market_awareness_atomic_decision.sql", import.meta.url),
    "utf8",
  );
  assert.ok(
    /revoke execute on function[\s\S]*?from public, anon, authenticated;/.test(atomicMigration),
    "the decision function must be revoked from anon and authenticated explicitly",
  );
  assert.ok(
    /grant execute on function[\s\S]*?to service_role;/.test(atomicMigration),
    "the decision function must be granted to service_role, which the revoke above strips",
  );
}
