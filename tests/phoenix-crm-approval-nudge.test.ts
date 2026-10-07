import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import { phoenixCrmChannels } from "../src/lib/notifications/phoenix-crm-channel-guard.ts";
import { JOB_SCHEDULES } from "../src/lib/observability/job-schedule.ts";
import {
  APPROVAL_KINDS,
  APPROVAL_NUDGE_AFTER_MS,
  APPROVAL_NUDGE_CRON,
  APPROVAL_NUDGE_JOB_SLUG,
  APPROVAL_NUDGE_TITLE,
  approvalCountsText,
  approvalNudgeNotice,
  approversFor,
  composeApprovalNudges,
  isOverdue,
  listRequestStage,
  pendingStage,
  waitingSinceOf,
  type WaitingApproval,
} from "../src/lib/phoenix-crm/approval-nudge-rules.ts";
import { buildOrgIndex, type OrgSeat } from "../src/lib/phoenix-crm/scope.ts";
import { findAccessRegistryEntry } from "../src/lib/security/access-registry.ts";

/**
 * Owner, 2026-10-02 — the daily nudge to a slow approver.
 *
 * A sent weekly plan, a list request, an off-plan visit and a request to edit a sent week each wait on
 * a person: the
 * territory's district manager, then the SFE Manager. Each is told ONCE, when it is raised, and nothing
 * reminded anybody after that. Once a day at 09:57 Cairo, whoever has something waiting on him for
 * MORE THAN 24 HOURS at his step gets ONE message naming the counts by kind — "3 list requests, 1
 * off-plan visit and 1 request to edit a week have waited more than a day" — in-app, by Telegram and
 * to the phone, never by email, opening Team. Who is told is the decide rule's own people, never a
 * second copy of it; nobody hears about something already decided; real entries only.
 */

const source = (path: string) => stripComments(readFileSync(path, "utf8").replace(/\r\n/g, "\n"));

function seat(overrides: Partial<OrgSeat> & Pick<OrgSeat, "seatId" | "tier" | "path">): OrgSeat {
  return {
    parentSeatId: null,
    occupantHrId: null,
    lineCode: "pedia",
    lineName: "Pedia",
    areaName: "Area",
    regionName: "Delta (1)",
    seatLabel: overrides.tier,
    ...overrides,
  };
}

const NOW = new Date("2026-10-02T07:57:00.000Z"); // 09:57 Cairo, Friday 2 October 2026
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 60 * 60 * 1000).toISOString();

/** Every value a 5-field cron FIELD fires on: "*", "*\/5", "4-59/10", "3,13,23", "57". */
function cronField(field: string, max: number): Set<number> {
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const [range, stepText] = part.split("/");
    const step = stepText ? Number(stepText) : 1;
    let from: number;
    let to: number;
    if (range === "*") {
      from = 0;
      to = max;
    } else if (range.includes("-")) {
      [from, to] = range.split("-").map(Number);
    } else {
      from = Number(range);
      to = stepText ? max : from;
    }
    for (let value = from; value <= to; value += step) values.add(value);
  }
  return values;
}

export function runPhoenixCrmApprovalNudgeTests() {
  // ── Which step, and since when ─────────────────────────────────────────────────────────────────
  {
    assert.equal(listRequestStage(null), "manager", "a grade change has no stage: it is the territory's reviewer's alone");
    assert.equal(listRequestStage("manager"), "manager", "the first step of a drop, an add or a bring-back");
    assert.equal(listRequestStage("sfe"), "sfe", "and the second");
    assert.equal(pendingStage("manager_pending"), "manager");
    assert.equal(pendingStage("sfe_pending"), "sfe");
    for (const settled of ["hr_pending", "approved", "refused", "reopened", "expired", null]) {
      assert.equal(pendingStage(settled), null, `${String(settled)} waits on no district manager and no SFE Manager — never nudged`);
    }

    const raised = "2026-09-29T08:00:00.000Z";
    const managerSaidYes = "2026-10-02T06:00:00.000Z";
    assert.equal(waitingSinceOf("sfe", raised, managerSaidYes), managerSaidYes, "the SFE step waits from the manager's yes — not from the raise");
    assert.equal(waitingSinceOf("sfe", raised, null), raised, "an item that STARTED at SFE (a vacant chain) waits from the raise");
    assert.equal(waitingSinceOf("manager", raised, managerSaidYes), raised, "the manager step waits from the raise");

    assert.equal(APPROVAL_NUDGE_AFTER_MS, 24 * 60 * 60 * 1000);
    assert.equal(isOverdue(hoursAgo(24), NOW), false, "exactly a day is not MORE than a day");
    assert.equal(isOverdue(new Date(NOW.getTime() - APPROVAL_NUDGE_AFTER_MS - 1000).toISOString(), NOW), true, "a second past it is");
    assert.equal(isOverdue(hoursAgo(2), NOW), false, "an item raised this morning is nobody's to be chased for");
    assert.equal(isOverdue("not a time", NOW), false, "and nobody is nudged on a time that cannot be read");
  }

  // ── The words: counts by kind, in his own sentence ─────────────────────────────────────────────
  {
    assert.equal(
      approvalCountsText({ list_request: 3, unplanned_visit: 1, plan_edit: 1, weekly_plan: 0 }),
      "3 list requests, 1 off-plan visit and 1 request to edit a week",
      "the owner's own sentence",
    );
    assert.equal(approvalCountsText({ list_request: 1, unplanned_visit: 0, plan_edit: 0, weekly_plan: 0 }), "1 list request");
    assert.equal(approvalCountsText({ list_request: 0, unplanned_visit: 2, plan_edit: 0, weekly_plan: 0 }), "2 off-plan visits");
    assert.equal(approvalCountsText({ list_request: 1, unplanned_visit: 0, plan_edit: 2, weekly_plan: 0 }), "1 list request and 2 requests to edit a week", "a kind with nothing waiting is not named");

    const many = approvalNudgeNotice({ hrId: "D-1", counts: { list_request: 3, unplanned_visit: 1, plan_edit: 1, weekly_plan: 0 }, cairoToday: "2026-10-02" });
    assert.equal(many?.title, APPROVAL_NUDGE_TITLE);
    assert.equal(APPROVAL_NUDGE_TITLE, "Waiting on you for more than a day");
    assert.equal(
      many?.message,
      "3 list requests, 1 off-plan visit and 1 request to edit a week have waited more than a day. Open Team in Phoenix CRM to decide them.",
    );
    assert.equal(many?.idempotencyKey, "phoenix_crm:approval_nudge:D-1:2026-10-02", "one per approver per Cairo day");
    const one = approvalNudgeNotice({ hrId: "D-1", counts: { list_request: 0, unplanned_visit: 1, plan_edit: 0, weekly_plan: 0 }, cairoToday: "2026-10-03" });
    assert.equal(one?.message, "1 off-plan visit has waited more than a day. Open Team in Phoenix CRM to decide it.", "one item, said as one");
    assert.notEqual(one?.idempotencyKey, many?.idempotencyKey, "a new day is a new key");
    assert.equal(approvalNudgeNotice({ hrId: "D-1", counts: { list_request: 0, unplanned_visit: 0, plan_edit: 0, weekly_plan: 0 }, cairoToday: "2026-10-02" }), null, "nothing overdue, no message");

    // ── The sent weekly plan (2026-10-08) — the thing the module sends most and nudged least ──────
    //
    // It was missing from the run entirely: a week could sit `submitted` for days on the one notice
    // sent the evening it arrived, while the rep who sent it could not change a day of it.
    assert.ok(APPROVAL_KINDS.includes("weekly_plan"), "a sent week is one of the things that waits on a person");
    assert.equal(APPROVAL_KINDS[0], "weekly_plan", "named FIRST: it is the one that holds a rep's whole week");
    assert.equal(
      approvalCountsText({ list_request: 1, unplanned_visit: 0, plan_edit: 0, weekly_plan: 2 }),
      "2 weekly plans and 1 list request",
      "the weeks lead the sentence",
    );
    assert.equal(approvalCountsText({ list_request: 0, unplanned_visit: 0, plan_edit: 0, weekly_plan: 1 }), "1 weekly plan");
    assert.equal(
      approvalNudgeNotice({ hrId: "D-1", counts: { list_request: 0, unplanned_visit: 0, plan_edit: 0, weekly_plan: 1 }, cairoToday: "2026-10-08" })?.message,
      "1 weekly plan has waited more than a day. Open Team in Phoenix CRM to decide it.",
    );

    // 🔴 A PLAN HAS NO SFE STEP — the SFE Manager returns a week and approves none, so the loader files
    // every one of them at the MANAGER step and the count can never land on his board.
    const nudge = source("src/lib/phoenix-crm/server/approval-nudge.ts");
    assert.match(nudge, /items\.push\(\{ kind: "weekly_plan", seatId, stage: "manager", waitingSince: waitingSinceOf\("manager", sentAt, null\) \}\);/);
    assert.match(nudge, /\.from\("phoenix_crm_plans"\)[\s\S]*?\.eq\("is_test", false\)[\s\S]*?\.eq\("status", "submitted"\)/, "real entries, sent and not yet decided");
    assert.match(nudge, /\.lt\("submitted_at", raisedBefore\)/, "it waits from the SEND — so a re-sent week is chased from the re-send, not the first one");
    assert.match(nudge, /\.gte\("week_start", plannableWeeks\(cairoToday\)\[0\]\)/, "the Team tab's own window: a week that is over waits for nobody");
    assert.doesNotMatch(nudge, /kind: "weekly_plan", seatId, stage: "sfe"/, "there is no SFE step on a plan");
  }

  // ── Who is told: the decide rule's own people ───────────────────────────────────────────────────
  {
    const org = buildOrgIndex([
      seat({ seatId: "CEO", tier: "CEO", path: ["CEO"], occupantHrId: "B-2" }),
      seat({ seatId: "NSM", tier: "NSM", parentSeatId: "CEO", path: ["CEO", "NSM"], occupantHrId: "N-1" }),
      seat({ seatId: "DM-A", tier: "DM", parentSeatId: "NSM", path: ["CEO", "NSM", "DM-A"], occupantHrId: "D-A" }),
      // A vacant district: its territories pass to the national manager above it.
      seat({ seatId: "DM-B", tier: "DM", parentSeatId: "NSM", path: ["CEO", "NSM", "DM-B"] }),
      seat({ seatId: "A1", tier: "REP", parentSeatId: "DM-A", path: ["CEO", "NSM", "DM-A", "A1"], occupantHrId: "R-A1" }),
      seat({ seatId: "A2", tier: "REP", parentSeatId: "DM-A", path: ["CEO", "NSM", "DM-A", "A2"], occupantHrId: "R-A2" }),
      seat({ seatId: "B1", tier: "REP", parentSeatId: "DM-B", path: ["CEO", "NSM", "DM-B", "B1"], occupantHrId: "R-B1" }),
      // A territory on a line that has not opened: nobody's Team tab shows it.
      seat({ seatId: "X1", tier: "REP", parentSeatId: "DM-A", path: ["CEO", "NSM", "DM-A", "X1"], occupantHrId: "R-X1", lineCode: "cns", lineName: "CNS" }),
      // A chain with nobody in it at all: the manager step has no one, and is never handed to SFE.
      seat({ seatId: "V-DM", tier: "DM", parentSeatId: "CEO", path: ["CEO", "V-DM"] }),
      seat({ seatId: "V1", tier: "REP", parentSeatId: "V-DM", path: ["CEO", "V-DM", "V1"], occupantHrId: "R-V1" }),
    ]);
    const openLines = new Set(["pedia"]);
    const sfe = ["S-1", "s-2"];

    assert.deepEqual(approversFor({ seatId: "A1", stage: "manager" }, org, sfe), ["D-A"], "the manager step is the territory's reviewer");
    assert.deepEqual(approversFor({ seatId: "B1", stage: "manager" }, org, sfe), ["N-1"], "a vacant district passes to the manager above, as the decide rule says");
    assert.deepEqual(approversFor({ seatId: "V1", stage: "manager" }, org, sfe), [], "a chain with nobody in it has nobody to tell");
    assert.deepEqual(approversFor({ seatId: "A1", stage: "sfe" }, org, sfe), sfe, "the SFE step is every SFE Manager");

    const item = (kind: WaitingApproval["kind"], seatId: string, stage: WaitingApproval["stage"], hours: number): WaitingApproval => ({
      kind,
      seatId,
      stage,
      waitingSince: hoursAgo(hours),
    });
    const items: WaitingApproval[] = [
      item("list_request", "A1", "manager", 30),
      item("list_request", "A2", "manager", 25),
      item("unplanned_visit", "A1", "manager", 2), // raised this morning: not yet
      item("plan_edit", "A1", "sfe", 48),
      item("unplanned_visit", "B1", "manager", 30),
      item("list_request", "X1", "manager", 30), // a closed line
      item("list_request", "GONE", "manager", 30), // a territory no longer in the organogram
      item("unplanned_visit", "A2", "sfe", 26),
      item("plan_edit", "V1", "manager", 40), // a chain with nobody in it
    ];
    const plan = composeApprovalNudges({ org, items, sfeHrIds: sfe, openLines, now: NOW, cairoToday: "2026-10-02" });
    assert.equal(plan.overdue, 8, "everything raised more than a day ago, whoever it waits on");
    assert.equal(plan.unaddressed, 3, "a closed line, a territory gone, and a chain with nobody in it are told to nobody");
    assert.deepEqual(
      plan.notices.map((notice) => [notice.hrId, notice.message]),
      [
        ["D-A", "2 list requests have waited more than a day. Open Team in Phoenix CRM to decide them."],
        ["N-1", "1 off-plan visit has waited more than a day. Open Team in Phoenix CRM to decide it."],
        ["S-1", "1 off-plan visit and 1 request to edit a week have waited more than a day. Open Team in Phoenix CRM to decide them."],
        ["S-2", "1 off-plan visit and 1 request to edit a week have waited more than a day. Open Team in Phoenix CRM to decide them."],
      ],
      "ONE message per approver, the counts by kind, each SFE Manager his own, addressed in the stored form",
    );
    assert.ok(!plan.notices.some((notice) => notice.hrId === "B-2"), "the CEO is never a reviewer, so never nudged");
    assert.ok(!plan.notices.some((notice) => notice.hrId.startsWith("R-")), "and a rep is never told about his own request here");

    // No SFE Manager on file: the SFE step's items are told to nobody — never handed to a manager instead.
    const noSfe = composeApprovalNudges({ org, items, sfeHrIds: [], openLines, now: NOW, cairoToday: "2026-10-02" });
    assert.equal(noSfe.unaddressed, 5);
    assert.deepEqual(noSfe.notices.map((notice) => notice.hrId), ["D-A", "N-1"]);

    // The same person twice in the SFE list (two spellings of one id) is still one message.
    const twice = composeApprovalNudges({ org, items: [item("plan_edit", "A1", "sfe", 30)], sfeHrIds: ["S-1", "s-1"], openLines, now: NOW, cairoToday: "2026-10-02" });
    assert.equal(twice.notices.length, 1, "one person, one message");
    assert.equal(twice.notices[0].counts.plan_edit, 1, "and the item counted once for him");

    // Nothing overdue, nothing sent.
    assert.deepEqual(composeApprovalNudges({ org, items: [item("list_request", "A1", "manager", 3)], sfeHrIds: sfe, openLines, now: NOW, cairoToday: "2026-10-02" }).notices, []);
  }

  // ── The sender: real entries, the four queues, never email ─────────────────────────────────────
  {
    assert.deepEqual(phoenixCrmChannels("approval_nudge"), ["in_app", "telegram", "push"], "in-app, Telegram and the phone — never email");
    const runner = source("src/lib/phoenix-crm/server/approval-nudge.ts");
    assert.ok(runner.includes('channels: ["in_app", "telegram", "push"]'), "the runner asks for in-app, Telegram and the phone");
    assert.equal(/"email"/.test(runner), false, "and never names email");
    assert.ok(runner.includes('eventType: "approval_nudge"'), "under its own event");
    assert.ok(runner.includes("module: PHOENIX_CRM_NOTIFICATION_MODULE"), "under the module key the email guard filters on");
    assert.equal((runner.match(/\.eq\("is_test", false\)/g) ?? []).length, 4, "real entries only, in each of the four queues — the sent weeks joined them on 2026-10-08");
    for (const table of ["phoenix_crm_list_requests", "phoenix_crm_unplanned_visits", "phoenix_crm_plan_edit_requests"]) {
      assert.ok(runner.includes(`.from("${table}")`), `it reads ${table}`);
    }
    assert.ok(runner.includes('.eq("status", "pending")'), "a list request still waiting");
    assert.equal((runner.match(/\.in\("status", \["manager_pending", "sfe_pending"\]\)/g) ?? []).length, 2, "an off-plan visit or a week-edit at the manager's or SFE's step — never HR's");
    assert.ok(runner.includes('.gte("week_start", addDaysIso(cairoToday, -5))'), "a week-edit only while its week has a day ahead — the Team tab's own window");
    assert.ok(runner.includes("const actionUrl = `${PHOENIX_CRM_PORTAL_PATH}/team`;"), "it opens Team, where every one of these is decided");
    assert.ok(runner.includes("composeApprovalNudges("), "who is told is the rules' answer, never a second copy");
    assert.ok(runner.includes("await sfeManagerHrIds()"), "and the SFE step is the plan-edit notices' own resolver");

    const notify = source("src/lib/phoenix-crm/server/notifications.ts");
    assert.ok(notify.includes("export async function sfeManagerHrIds("), "one resolver for the SFE Managers, shared");
    assert.ok(notify.includes("const sfe = await sfeManagerHrIds();"), "and the plan-edit notices still use it");

    const rules = source("src/lib/phoenix-crm/approval-nudge-rules.ts");
    assert.ok(rules.includes("const reviewer = territoryReviewer(org, item.seatId);"), "the manager step is the decide rule's reviewer");
  }

  // ── Declared, scheduled and registered in one sitting, on a minute no other job holds ───────────
  {
    assert.equal(APPROVAL_NUDGE_JOB_SLUG, "phoenix-crm-approval-nudge");
    assert.equal(APPROVAL_NUDGE_CRON, "57 9 * * *", "09:57 Cairo, every day");
    const declared = JOB_SCHEDULES.find((entry) => entry.slug === APPROVAL_NUDGE_JOB_SLUG);
    assert.equal(declared?.schedule, APPROVAL_NUDGE_CRON, "the heartbeat expects the tick cron-job.org fires");
    assert.equal(declared?.kind, "cron");
    assert.equal(declared?.watchingSince, undefined, "a new job is never given a restore floor");

    for (const other of JOB_SCHEDULES) {
      if (other.slug === APPROVAL_NUDGE_JOB_SLUG || other.kind !== "cron" || !other.schedule) continue;
      const [minute, hour] = other.schedule.trim().split(/\s+/);
      assert.ok(!(cronField(minute, 59).has(57) && cronField(hour, 23).has(9)), `${other.slug} (${other.schedule}) also fires at 09:57 — a red execution must name one job`);
    }
    const sync = readFileSync("scripts/cronjob-sync.mjs", "utf8");
    assert.match(sync, /"phoenix-crm-approval-nudge": \{[\s\S]*?path: "\/api\/cron\/phoenix-crm-approval-nudge"[\s\S]*?hours: \[9\], minutes: \[57\], mdays: \[-1\], months: \[-1\], wdays: \[-1\]/);
    for (const match of sync.matchAll(/^ {2}"([a-z0-9-]+)": \{[\s\S]*?schedule: \{ hours: \[([^\]]*)\], minutes: \[([^\]]*)\]/gm)) {
      if (match[1] === APPROVAL_NUDGE_JOB_SLUG) continue;
      const hours = match[2].split(",").map((value) => Number(value.trim()));
      const minutes = match[3].split(",").map((value) => Number(value.trim()));
      const atNine = hours.includes(-1) || hours.includes(9);
      const at57 = minutes.includes(-1) || minutes.includes(57);
      assert.ok(!(atNine && at57), `cron-job.org job ${match[1]} also fires at 09:57`);
    }

    const route = source("app/api/cron/phoenix-crm-approval-nudge/route.ts");
    assert.ok(existsSync("app/api/cron/phoenix-crm-approval-nudge/route.ts"));
    assert.ok(route.includes('assertCronAuthorized(request, "cron/phoenix-crm-approval-nudge")'), "behind CRON_SECRET");
    assert.ok(route.includes("withDeadMansSwitch(APPROVAL_NUDGE_JOB_SLUG"), "and it reports its own heartbeat");
    const entry = findAccessRegistryEntry("/api/cron/phoenix-crm-approval-nudge", "GET");
    assert.equal(entry?.pattern, "/api/cron/phoenix-crm-approval-nudge", "its own registry entry, never a blanket");
    assert.equal(entry?.authMode, "cron-secret");
    assert.ok(readFileSync("docs/observability.md", "utf8").includes("| `phoenix-crm-approval-nudge` | `57 9 * * *` | 2h |"), "and its row in the job table");
  }

  console.log("phoenix-crm approval nudge: OK");
}
