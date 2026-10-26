import assert from "node:assert/strict";

import { readFileSync } from "node:fs";

import { permissionMatrix } from "../src/lib/auth/permissions.ts";
import { conversationMessageIdempotencyKey } from "../src/lib/conversations/notify.ts";
import { MARKET_AWARENESS_PORTAL_ROLES } from "../src/lib/employee-portal/navigation.ts";
import type { MarketAwarenessApproverSlot } from "../src/lib/market-awareness/approvers.ts";
import {
  canDecideSlot,
  groupHasApproved,
  pendingSlotsFor,
  planApproverSlots,
  summarizeApproverProgress,
} from "../src/lib/market-awareness/approvers.ts";
import { areaIn } from "../src/lib/market-awareness/geography.ts";
import { isTrackableProductLine } from "../src/lib/market-awareness/lines.ts";
import { MARKET_AWARENESS_STATUSES } from "../src/lib/market-awareness/types.ts";
import {
  resolveApprovalAudience,
  resolvePendingDecisionRecipients,
} from "../src/lib/market-awareness/notifications.ts";
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
  canReleaseHold,
  currentStep,
  describeInboxStep,
  describeInboxWait,
  findTransition,
  resolveGroupApproval,
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

/** A slot as the group holds it, with only the fields a rule reads. */
function slot(overrides: Partial<MarketAwarenessApproverSlot> = {}): MarketAwarenessApproverSlot {
  return {
    id: 1,
    approverRole: "nsm",
    lineId: 1,
    lineName: "Anti Infective",
    isPrimaryLine: true,
    assignedHrId: "AI-0008",
    assignedName: "Magdy El Senosey",
    decision: null,
    decidedByHrId: null,
    decidedByName: null,
    decidedAt: null,
    comment: null,
    ...overrides,
  };
}

const ANTI_INFECTIVE = { id: 1, lineCode: "anti_infective", name: "Anti Infective" };
const PEDIA = { id: 2, lineCode: "pedia", name: "Pedia" };
const CNS = { id: 3, lineCode: "cns", name: "CNS" };

/** The live directory, measured on production 2026-09-09. */
const DIRECTORY = [
  { hrId: "A-9", name: "Hossam Abdelghafar", approverRole: "marketing_manager" as const, lineId: 4 },
  { hrId: "AI-0008", name: "Magdy El Senosey", approverRole: "nsm" as const, lineId: 1 },
  { hrId: "A-12", name: "Ali Elsayed", approverRole: "nsm" as const, lineId: 2 },
  { hrId: "B-122", name: "Amr Elsebaey", approverRole: "nsm" as const, lineId: 3 },
];

export function runMarketAwarenessTests() {
  // ── The group is the Marketing Manager plus one NSM PER LINE ───────────────
  //
  // Owner, 2026-09-09: "based on the primary line the next step the approval should go to MM and the
  // primary NSM at the same time and if chosen second line then also the sec line NSM".

  const oneLine = planApproverSlots({
    requesterHrId: "A-10",
    primaryLine: ANTI_INFECTIVE,
    lines: [ANTI_INFECTIVE],
    directory: DIRECTORY,
  });
  assert.equal(oneLine.slots.length, 2, "one line means two approvers: the MM and that line's NSM");
  assert.deepEqual(
    oneLine.slots.map((entry) => entry.assignedHrId),
    ["A-9", "AI-0008"],
    "the Marketing Manager and the ANTI INFECTIVE national sales manager, nobody else's",
  );
  assert.equal(oneLine.slots[1]?.isPrimaryLine, true);

  const twoLines = planApproverSlots({
    requesterHrId: "A-10",
    primaryLine: ANTI_INFECTIVE,
    lines: [ANTI_INFECTIVE, CNS],
    directory: DIRECTORY,
  });
  assert.deepEqual(
    twoLines.slots.map((entry) => entry.assignedHrId),
    ["A-9", "AI-0008", "B-122"],
    "a second line adds that line's NSM — three approvers, the primary line's first",
  );
  // The NSM title is held by three people, one per line. A role check with no line in it would put
  // all three on every activity, which is the failure this ordering exists to make visible.
  assert.equal(
    twoLines.slots.filter((entry) => entry.approverRole === "nsm").length,
    2,
    "two lines means exactly two national sales managers, never all three",
  );

  // A line listed twice, and a primary line missing from the list, both resolve to one slot each.
  const duplicated = planApproverSlots({
    requesterHrId: "A-10",
    primaryLine: PEDIA,
    lines: [PEDIA, PEDIA],
    directory: DIRECTORY,
  });
  assert.equal(duplicated.slots.length, 2, "a line repeated cannot ask the same person twice");

  // Nobody approves his own spending. The Marketing Manager is a creator role, so this is real.
  const hossamsOwn = planApproverSlots({
    requesterHrId: "a-9",
    primaryLine: PEDIA,
    lines: [PEDIA],
    directory: DIRECTORY,
  });
  assert.deepEqual(
    hossamsOwn.slots.map((entry) => entry.assignedHrId),
    ["A-12"],
    "the Marketing Manager's own request drops his slot, in either HR id casing",
  );
  assert.deepEqual(hossamsOwn.droppedForRequester, ["marketing_manager"]);

  // A line whose NSM seat is empty is REPORTED, never silently dropped — a request carrying a slot
  // nobody can fill looks exactly like one somebody is being slow about.
  const noNsm = planApproverSlots({
    requesterHrId: "A-10",
    primaryLine: ANTI_INFECTIVE,
    lines: [ANTI_INFECTIVE],
    directory: DIRECTORY.filter((entry) => entry.hrId !== "AI-0008"),
  });
  assert.deepEqual(
    noNsm.linesWithoutNsm.map((line) => line.name),
    ["Anti Infective"],
    "a line with no NSM in the seat is named, so submission can refuse and say which",
  );

  assert.equal(statusAfterResubmit(true), "pending_group");
  assert.equal(
    statusAfterResubmit(false),
    "pending_ceo",
    "a request nobody could be resolved for goes to the CEO, never into an empty queue",
  );

  // ── A slot is a ROLE AND A LINE, never a frozen person ─────────────────────
  //
  // The Marketing Manager was on leave for a fortnight in August with the GPM covering him. A slot
  // welded to one person deadlocks the whole queue for the length of a holiday.

  assert.equal(
    canDecideSlot({
      access: { role: "National Sales Manager", hrId: "AI-0008" },
      slot: slot(),
      actorLineId: 1,
    }),
    true,
    "the Anti Infective NSM may answer the Anti Infective slot",
  );
  assert.equal(
    canDecideSlot({
      access: { role: "National Sales Manager", hrId: "A-12" },
      slot: slot(),
      actorLineId: 2,
    }),
    false,
    "the PEDIA national sales manager may NOT answer an Anti Infective slot — three people hold that title",
  );
  // HR ids are mixed case on this database; the comparison is canonical on both sides.
  assert.equal(
    canDecideSlot({
      access: { role: "National Sales Manager", hrId: "ai-0008" },
      slot: slot(),
      actorLineId: null,
    }),
    true,
    "HR id casing must not decide who may approve, even with no line resolved",
  );
  assert.equal(
    canDecideSlot({
      access: { role: "Marketing Manager", hrId: "A-99" },
      slot: slot({ approverRole: "marketing_manager", lineId: null, lineName: null, assignedHrId: "A-9" }),
      actorLineId: null,
    }),
    true,
    "whoever holds the Marketing Manager role may answer its slot, which is what makes cover work",
  );
  assert.equal(
    canDecideSlot({
      access: { role: "Group Product Manager", hrId: "A-8" },
      slot: slot({ approverRole: "marketing_manager", lineId: null, lineName: null, assignedHrId: "A-9" }),
      actorLineId: null,
    }),
    false,
    "a Group Product Manager is not in the group and may not answer for the Marketing Manager",
  );
  assert.equal(
    canDecideSlot({
      access: { role: "National Sales Manager", hrId: "AI-0008" },
      slot: slot({ approverRole: "marketing_manager", lineId: null, lineName: null, assignedHrId: "A-9" }),
      actorLineId: 1,
    }),
    false,
    "an NSM may not answer the Marketing Manager's slot, and vice versa",
  );

  // ── The gate: everybody, and every answer a yes ────────────────────────────

  assert.equal(
    groupHasApproved([]),
    false,
    "an EMPTY group is never unanimous consent — that would move a request nobody looked at",
  );
  assert.equal(groupHasApproved([slot({ decision: "approve" })]), true);
  assert.equal(
    groupHasApproved([slot({ id: 1, decision: "approve" }), slot({ id: 2, decision: null })]),
    false,
    "one approval out of two does not move it — the whole point of the parallel step",
  );
  assert.equal(
    resolveGroupApproval([slot({ id: 1, decision: "approve" }), slot({ id: 2, decision: null })])
      .nextStatus,
    "pending_group",
    "a partial approval leaves it exactly where it is",
  );
  assert.equal(
    resolveGroupApproval([
      slot({ id: 1, decision: "approve" }),
      slot({ id: 2, decision: "approve" }),
    ]).nextStatus,
    "pending_ceo",
    "the LAST approval is what informs the CEO",
  );

  const progress = summarizeApproverProgress([
    slot({ id: 1, decision: "approve", assignedName: "Hossam Abdelghafar" }),
    slot({ id: 2, decision: null, assignedName: "Magdy El Senosey" }),
  ]);
  assert.deepEqual(progress, { approved: 1, total: 2, waitingOn: ["Magdy El Senosey"] });

  // ── canDecideStep at the group step ───────────────────────────────────────

  const group = [
    slot({ id: 1, approverRole: "marketing_manager", lineId: null, lineName: null, assignedHrId: "A-9", assignedName: "Hossam Abdelghafar" }),
    slot({ id: 2 }),
  ];

  assert.equal(
    canDecideStep({
      access: { role: "National Sales Manager", hrId: "AI-0008" },
      step: "group",
      actorLineId: 1,
      approvers: group,
    }),
    true,
  );
  assert.equal(
    canDecideStep({
      access: { role: "National Sales Manager", hrId: "AI-0008" },
      step: "group",
      actorLineId: 1,
      approvers: [group[0]!, slot({ id: 2, decision: "approve" })],
    }),
    false,
    "somebody who has already answered is no longer being waited on",
  );
  assert.equal(
    canDecideStep({
      access: { role: "CEO", hrId: "AA" },
      step: "group",
      actorLineId: null,
      approvers: group,
    }),
    false,
    "the CEO does not get the group step by virtue of being the CEO",
  );
  assert.equal(
    canDecideStep({ access: { role: "CEO", hrId: "AA" }, step: "ceo", approvers: [] }),
    true,
  );
  assert.equal(
    canDecideStep({
      access: { role: "Marketing Manager", hrId: "A-9" },
      step: "ceo",
      approvers: [],
    }),
    false,
    "nobody approves the CEO step for him",
  );

  assert.deepEqual(
    pendingSlotsFor({
      access: { role: "Marketing Manager", hrId: "A-9" },
      actorLineId: null,
      slots: group,
    }).map((entry) => entry.id),
    [1],
    "an approver is offered his own slot and nobody else's",
  );

  // ── Hold: who may lift one ────────────────────────────────────────────────
  //
  // Whoever froze it, the CEO, and Super Admin. NOT every approver — a hold any peer can undo is
  // not a hold.

  assert.equal(canReleaseHold({ access: { role: "Marketing Manager", hrId: "a-9" }, heldByHrId: "A-9" }), true);
  assert.equal(
    canReleaseHold({ access: { role: "National Sales Manager", hrId: "AI-0008" }, heldByHrId: "A-9" }),
    false,
    "a peer approver may not lift somebody else's hold",
  );
  assert.equal(canReleaseHold({ access: { role: "CEO", hrId: "AA" }, heldByHrId: "A-9" }), true);
  assert.equal(canReleaseHold({ access: { role: "Super Admin", hrId: null }, heldByHrId: "A-9" }), true);

  // ── Transitions ───────────────────────────────────────────────────────────

  assert.equal(currentStep("pending_group"), "group");
  assert.equal(currentStep("pending_ceo"), "ceo");
  assert.equal(currentStep("approved"), null, "an approved activity waits on no decision");
  assert.equal(
    currentStep("on_hold"),
    null,
    "a FROZEN request is waiting on nobody, so it counts towards no badge and offers no buttons",
  );

  assert.equal(
    findTransition("pending_group", "approve"),
    null,
    "a group approval has TWO destinations and is resolved by the gate, never by the table",
  );
  assert.equal(findTransition("pending_group", "hold")?.to, "on_hold");
  assert.equal(findTransition("pending_group", "reject")?.to, "rejected");
  assert.equal(findTransition("pending_group", "return")?.to, "returned");
  assert.equal(findTransition("on_hold", "release")?.to, "pending_group");
  assert.equal(
    findTransition("on_hold", "approve"),
    null,
    "nothing can be approved while it is frozen — it has to be released first",
  );
  assert.equal(
    findTransition("pending_ceo", "hold"),
    null,
    "hold belongs to the group; the CEO's answers are approve, reject and return",
  );
  assert.equal(findTransition("pending_ceo", "approve")?.to, "approved");
  assert.equal(findTransition("pending_ceo", "return")?.to, "returned");

  // Owner answer 39: withdrawable "before the CEO decides" — so a request in his queue still is,
  // and one he has approved is not.
  assert.ok(findTransition("pending_ceo", "withdraw"), "a PM may withdraw before the CEO decides");
  assert.ok(
    findTransition("on_hold", "withdraw"),
    "a held request is frozen for the APPROVERS, never for its owner — he can still pull it back",
  );
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

  // ── The District Manager is out of the module entirely (owner, 2026-09-12) ─────────────────
  //
  // He was an informed reader under answers 42 and 43 until the owner asked for the module to be
  // hidden from district managers: it is "only applicable for product or group product managers and
  // marketing and national sales manager". FOUR gates had to close, and closing three of them is
  // indistinguishable from closing four on any screen — the sidebar list is UX only, the matrix is
  // what the routes actually enforce, and the approval announcement is a door of its own with a link
  // straight into the module. Each is pinned separately here because each one alone reads as done.
  assert.equal(
    permissionMatrix["District Manager"].market_awareness,
    undefined,
    "a District Manager holds NO market_awareness grant — this is the gate the API routes enforce",
  );
  assert.ok(
    !MARKET_AWARENESS_PORTAL_ROLES.includes("District Manager"),
    "the Market Awareness portal tab is not drawn for a District Manager",
  );
  assert.deepEqual(
    resolveActivityVisibility({ role: "District Manager", hrId: "B-12" }),
    { kind: "none" },
    "a District Manager sees no activity at all — he is out of MARKET_AWARENESS_SEE_ALL_ROLES",
  );
  assert.equal(
    canViewActivity({ role: "District Manager", hrId: "B-12" }, { requesterHrId: "B-155" }),
    false,
    "a District Manager cannot open an activity, his own region's included",
  );
  {
    const notificationsSource = readFileSync(
      new URL("../src/lib/market-awareness/notifications.ts", import.meta.url),
      "utf8",
    );
    // The CALL, not the word: the comment beside `resolveApprovalAudience` names the helper on
    // purpose, to say where it legitimately still runs (the service, filling the activity screen's
    // list of the region's DMs). Matching the bare name failed on that comment.
    assert.ok(
      !/loadRegionManagers\(/.test(notificationsSource),
      "the CEO-approval announcement must not resolve district managers — a notification whose link " +
        "opens a page the recipient is refused is the hide undone",
    );
    assert.ok(
      !/districtManagerHrIds/.test(notificationsSource),
      "no district manager may survive anywhere in the approval audience",
    );

    // ── And the area's own Medical Rep, off the same announcement (owner, 2026-09-12) ──────────
    //
    // He was the first name on the approval audience under answer 42, and the owner took him off
    // the same day the district managers went: "NO HIDE FROM MEDICAL REP". He never held a
    // market_awareness grant at all, so what he was receiving was a notice on three channels whose
    // link redirected him the moment he opened it.
    //
    // The audience is asserted by CALLING it rather than by reading the source, because the failure
    // this guards is not a mention of the rep — it is one extra id in the list that goes out. The
    // activity is no longer an argument at all, which is the structural half of the same fix: there
    // is no longer anything in scope here to read a rep off.
    assert.deepEqual(
      resolveApprovalAudience(["N-1", "S-2", "F-3"]).recipientHrIds,
      ["N-1", "S-2", "F-3"],
      "the CEO-approval announcement reaches the NSM, the SFE Manager and Finance — and nobody else",
    );
    assert.deepEqual(
      resolveApprovalAudience([]).recipientHrIds,
      [],
      "with no role holders resolved it reaches NOBODY — never a fallback to the rep or the region",
    );
    assert.deepEqual(
      resolveApprovalAudience(["N-1", "n-1", null, undefined, "  ", "S-2"]).recipientHrIds,
      ["N-1", "S-2"],
      "one person holding two roles is told once, and a blank id is not a recipient",
    );
    assert.ok(
      !notificationsSource.includes("resolveApprovalAudience(activity"),
      "the audience takes ONLY the resolved role holders — an activity argument is what a rep would " +
        "come back in through, and there is nothing to read one off any more",
    );
    assert.ok(
      !/repHrId|repNotified/.test(notificationsSource),
      "no rep survives in the approval audience or its result — the caller must not be able to " +
        "report a delivery that is deliberately not made",
    );
  }

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

  // THE GROUP STEP TELLS EVERY MEMBER STILL OUTSTANDING, AT ONCE. Telling only the first of them
  // reproduces the sequential chain the owner replaced, and it would do so silently: the request
  // would sit with somebody who had never been told it existed.
  assert.deepEqual(
    resolvePendingDecisionRecipients({
      approvers: [
        { assignedHrId: "A-9", decision: null },
        { assignedHrId: "AI-0008", decision: null },
      ],
      ceoHrIds: ["AA"],
      managerHrId: null,
      step: "group",
    }),
    ["A-9", "AI-0008"],
    "both members of the group are told at the same time, not one after the other",
  );
  assert.deepEqual(
    resolvePendingDecisionRecipients({
      approvers: [
        { assignedHrId: "A-9", decision: "approve" },
        { assignedHrId: "AI-0008", decision: null },
      ],
      ceoHrIds: ["AA"],
      managerHrId: null,
      step: "group",
    }),
    ["AI-0008"],
    "somebody who has already approved is not told again — that reads as his answer not registering",
  );
  assert.deepEqual(
    resolvePendingDecisionRecipients({
      approvers: [{ assignedHrId: null, decision: null }],
      ceoHrIds: ["AA"],
      managerHrId: null,
      step: "group",
    }),
    [],
    "an empty seat notifies nobody rather than falling back to somebody else",
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
    resolvePendingDecisionRecipients({ ceoHrIds: [], managerHrId: null, step: "ceo" }),
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
    /movedTo === "pending_ceo"[\s\S]{0,600}notifyDecisionPending\(/.test(decideBody),
    "advancing to the CEO must tell the CEO — the owner's 'once they approve, the CEO is informed'",
  );
  assert.ok(
    /movedTo === "returned" \|\| movedTo === "rejected"[\s\S]{0,600}notifyActivityReturned\(/.test(decideBody),
    "a returned or rejected activity must tell the person who raised it",
  );
  // A hold freezes the request with nothing asked of the requester, so the ONLY thing that tells him
  // why it stopped moving is this notification. Without it a hold is indistinguishable from an
  // approver who has gone quiet.
  assert.ok(
    /movedTo === "on_hold"[\s\S]{0,600}notifyActivityHeld\(/.test(decideBody),
    "putting a request on hold must tell the person who raised it, and say why",
  );

  const releaseBody = (() => {
    const start = maService.indexOf("async function releaseActivityHold");
    assert.notEqual(start, -1, "releaseActivityHold must exist for its pin to mean anything");
    const next = maService.indexOf("\nexport ", start + 1);
    return maService.slice(start, next === -1 ? maService.length : next);
  })();
  assert.ok(
    /canReleaseHold\(/.test(releaseBody),
    "releasing a hold must go through canReleaseHold, never through the ordinary decide gate",
  );
  assert.ok(
    /notifyDecisionPending\(/.test(releaseBody),
    "releasing must ask the outstanding approvers again, or a released request sits unnoticed",
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

  // ── An inbox card is headed by WHOSE decision it is, never by the status alone ─────────────
  //
  // The inbox lists every open activity the viewer may SEE, and the informed roles see all of
  // them. Reading the status back told Ali Elsayed, the Pedia National Sales Manager, "Waiting on
  // your approval" over two Anti Infective conferences he holds no slot on — while the summary
  // line above said "2 moving, none waiting on you" and no decision buttons were drawn. Verified
  // in the browser 2026-09-09 as both men.
  assert.equal(
    describeInboxStep({ canDecide: true, status: "pending_group" }),
    "Waiting on your approval",
    "the holder of an open slot is still told it is his",
  );
  assert.equal(
    describeInboxStep({ canDecide: false, status: "pending_group" }),
    "Waiting on the approval group",
    "somebody who cannot answer must not be told the decision is his",
  );
  assert.equal(
    describeInboxStep({ canDecide: true, status: "pending_ceo" }),
    "Waiting on you as the CEO",
    "the CEO step keeps its own words for the CEO",
  );
  assert.equal(
    describeInboxStep({ canDecide: false, status: "pending_ceo" }),
    "Waiting on the CEO",
    "every other viewer was told the CEO step was waiting on HIM — the worst case of the same bug",
  );
  // A hold reads the same either way: it is frozen for everyone, and saying so is the point.
  for (const canDecide of [true, false]) {
    assert.equal(
      describeInboxStep({ canDecide, status: "on_hold" }),
      "On hold",
      "a hold is frozen for everyone, so it reads the same to everyone",
    );
  }

  // ── History rows name the stage they are in, never "Moving through the chain" ───────────────
  //
  // Audit 2026-10-26: the National Sales Manager's History tab listed approved, rejected and
  // withdrawn activities under a header reading "Moving through the chain", because only the three
  // pending/held statuses had a label. A settled row is not moving anywhere.
  const settledLabels: Array<[string, string]> = [
    ["approved", "Approved"],
    ["closed", "Closed"],
    ["draft", "Draft"],
    ["executed", "Executed"],
    ["rejected", "Rejected"],
    ["returned", "Returned for changes"],
    ["withdrawn", "Withdrawn"],
  ];
  // `canDecide` is false for every settled status (no step is open), so that is the case that matters.
  for (const [status, label] of settledLabels) {
    assert.equal(
      describeInboxStep({ canDecide: false, status }),
      label,
      `a ${status} activity must be headed "${label}", not as if it were still moving`,
    );
  }
  assert.equal(
    describeInboxStep({ canDecide: false, status: "something_new" }),
    "Moving through the chain",
    "an unknown status keeps the neutral fallback rather than guessing a stage",
  );

  // ── The chip beside the title reads the CURRENT step's wait, never the viewer's own step ────
  //
  // The component derived `waitingFor` from the viewer, so a settled row read "Waiting 31 days".
  // A wait is shown only while the activity is open; a settled row reports when it was answered.
  const now = new Date("2026-10-26T12:00:00.000Z");
  const longAgo = "2026-09-25T12:00:00.000Z";
  const base = { submittedAt: longAgo, updatedAt: "2026-10-24T12:00:00.000Z" };
  assert.equal(describeInboxWait({ ...base, status: "pending_group" }, now), "Waiting 31 days");
  assert.equal(describeInboxWait({ ...base, status: "pending_ceo" }, now), "Waiting 31 days");
  assert.equal(
    describeInboxWait({ ...base, status: "pending_ceo", submittedAt: "2026-10-25T12:00:00.000Z" }, now),
    "Waiting 1 day",
  );
  assert.equal(
    describeInboxWait({ ...base, status: "pending_group", submittedAt: "2026-10-26T08:00:00.000Z" }, now),
    "Submitted today",
  );
  assert.equal(describeInboxWait({ ...base, status: "on_hold" }, now), "Frozen on hold");
  assert.equal(describeInboxWait({ ...base, status: "returned" }, now), "With the requester");
  for (const [status, key, word] of [
    ["approved", "approvedAt", "Approved"],
    ["rejected", "rejectedAt", "Rejected"],
    ["withdrawn", "withdrawnAt", "Withdrawn"],
    ["executed", "executedAt", "Executed"],
    ["closed", "closedAt", "Closed"],
  ] as const) {
    const chip = describeInboxWait({ ...base, status, [key]: "2026-10-23T12:00:00.000Z" }, now);
    assert.equal(chip, `${word} 3 days ago`, `${status} reports its own outcome date`);
    assert.ok(!/waiting/i.test(chip), `a ${status} row is not waiting on anyone`);
    // With no outcome stamp it falls back to the last update, still never a wait.
    assert.equal(describeInboxWait({ ...base, status }, now), `${word} 2 days ago`);
  }

  // ── The loader resolves every area from ONE load per line, not one RPC per row ──────────────
  const regions = [
    {
      regionCode: "r1",
      regionName: "Cairo",
      areas: [{ areaCode: "CA1" }, { areaCode: "ca2" }],
    },
    { regionCode: "r2", regionName: "Delta", areas: [{ areaCode: "DE1" }] },
  ] as unknown as Parameters<typeof areaIn>[0];
  assert.equal(areaIn(regions, " ca1 ")?.areaCode, "CA1", "lookup is trimmed and case-insensitive");
  assert.equal(areaIn(regions, "CA2")?.areaCode, "ca2");
  assert.equal(areaIn(regions, "DE1")?.areaCode, "DE1", "it searches every region");
  assert.equal(areaIn(regions, "nope"), null);
  assert.equal(areaIn([], "CA1"), null);

  const serviceSource = readFileSync(new URL("../src/lib/market-awareness/service.ts", import.meta.url), "utf8");
  const hydrateStart = serviceSource.indexOf("async function hydrate(");
  const hydrateEnd = serviceSource.indexOf("\nexport async function ", hydrateStart);
  assert.ok(hydrateStart > 0 && hydrateEnd > hydrateStart, "hydrate must be found in service.ts");
  const hydrateBody = serviceSource.slice(hydrateStart, hydrateEnd);
  assert.ok(
    !hydrateBody.includes("findArea("),
    "hydrate must not call findArea per row — that is one serial RPC per activity",
  );
  assert.ok(
    hydrateBody.includes("loadRegionsForLine(") && hydrateBody.includes("areaIn("),
    "hydrate resolves areas from one load per line",
  );
}
