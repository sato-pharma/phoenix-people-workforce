import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  enforcePhoenixCrmEmailBlock,
  enforcePhoenixCrmPushBlock,
  PHOENIX_CRM_PUSH_BLOCKED_EVENT_TYPES,
  phoenixCrmChannels,
} from "../src/lib/notifications/phoenix-crm-channel-guard.ts";
import { resolveNotificationPolicy } from "../src/lib/notifications/policy.ts";
import { JOB_SCHEDULES } from "../src/lib/observability/job-schedule.ts";
import { buildOrgIndex, type OrgSeat } from "../src/lib/phoenix-crm/scope.ts";
import {
  buildVisitRollupRecipients,
  planPhoenixCrmVisitRollup,
  VISIT_ROLLUP_CRON,
  VISIT_ROLLUP_EVENT_TYPE,
  VISIT_ROLLUP_JOB_SLUG,
  VISIT_ROLLUP_MAX_LINES,
  type RollupVisitRow,
} from "../src/lib/phoenix-crm/visit-rollup-rules.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * Phoenix CRM — the hourly routine-visit rollup (owner, 2026-10-05: "in nsm and sfe i want every
 * single action … sent to telegram to them", with routine planned visits batched into an hourly
 * rollup rather than a per-visit firehose).
 *
 * What this pins, without a database:
 *   1. the NATIONAL SALES MANAGER in a rep's chain hears the visits beneath him; every SFE MANAGER
 *      hears every routine visit in the hour; a person who is both hears the wider SFE bundle once;
 *   2. a manager with nothing in his scope this hour hears NOTHING — not an "all clear";
 *   3. visits are counted per rep, the message caps its lines, and the idempotency key is per manager
 *      per hour so a retried or double-fired cron tells nobody twice;
 *   4. in-app and Telegram only — email and the phone are both shut, like the mirror and the digest;
 *   5. all five registration sites agree, so the cron is watched and armed and cannot strand.
 */

function seat(overrides: Partial<OrgSeat> & Pick<OrgSeat, "seatId" | "tier" | "path">): OrgSeat {
  return {
    parentSeatId: overrides.path.length > 1 ? overrides.path[overrides.path.length - 2] : null,
    occupantHrId: null,
    lineCode: "pedia",
    lineName: "Pedia",
    areaName: null,
    regionName: null,
    seatLabel: null,
    ...overrides,
  };
}

const CEO = seat({ seatId: "SEAT-CEO", tier: "CEO", path: ["SEAT-CEO"], occupantHrId: "B-2", lineCode: null, lineName: null });
const PED_NSM = seat({ seatId: "SEAT-PED-NSM", tier: "NSM", path: ["SEAT-CEO", "SEAT-PED-NSM"], occupantHrId: "A-12" });
const PED_DM = seat({ seatId: "SEAT-PED-DM", tier: "DM", path: [...PED_NSM.path, "SEAT-PED-DM"], occupantHrId: "B-40" });
const PED_REP1 = seat({ seatId: "SEAT-PED-REP1", tier: "REP", path: [...PED_DM.path, "SEAT-PED-REP1"], occupantHrId: "B-7", areaName: "Tanta" });
const PED_REP2 = seat({ seatId: "SEAT-PED-REP2", tier: "REP", path: [...PED_DM.path, "SEAT-PED-REP2"], occupantHrId: "B-8", areaName: "Mansoura" });

const CNS_NSM = seat({ seatId: "SEAT-CNS-NSM", tier: "NSM", path: ["SEAT-CEO", "SEAT-CNS-NSM"], occupantHrId: "A-20", lineCode: "cns", lineName: "CNS" });
const CNS_DM = seat({ seatId: "SEAT-CNS-DM", tier: "DM", path: [...CNS_NSM.path, "SEAT-CNS-DM"], occupantHrId: "B-60", lineCode: "cns", lineName: "CNS" });
const CNS_REP = seat({ seatId: "SEAT-CNS-REP", tier: "REP", path: [...CNS_DM.path, "SEAT-CNS-REP"], occupantHrId: "B-121", lineCode: "cns", lineName: "CNS", areaName: "Heliopolis" });

const org = buildOrgIndex([CEO, PED_NSM, PED_DM, PED_REP1, PED_REP2, CNS_NSM, CNS_DM, CNS_REP]);

const SFE = ["B-150", "B-151"];

const NAMES = new Map([
  ["A-12", "Hossam Fouad"],
  ["A-20", "Khaled Samir"],
  ["B-7", "Aya Ibrahim"],
  ["B-8", "Mona Adel"],
  ["B-121", "Kareem Adel"],
  ["B-150", "Nour Hassan"],
  ["B-151", "Tarek Zaki"],
]);
const names = (hrId: string | null | undefined) => NAMES.get(String(hrId)) ?? "Unknown person";

/** Three visits by Aya and one by Mona under the Pedia NSM; two by Kareem under the CNS NSM. */
const VISITS: RollupVisitRow[] = [
  { seatId: "SEAT-PED-REP1", repHrId: "B-7" },
  { seatId: "SEAT-PED-REP1", repHrId: "B-7" },
  { seatId: "SEAT-PED-REP1", repHrId: "B-7" },
  { seatId: "SEAT-PED-REP2", repHrId: "B-8" },
  { seatId: "SEAT-CNS-REP", repHrId: "B-121" },
  { seatId: "SEAT-CNS-REP", repHrId: "B-121" },
];

export function runPhoenixCrmVisitRollupTests(): void {
  // ── 1 · the NSM hears his chain; every SFE Manager hears the whole hour ───────────────────────────
  {
    const recipients = buildVisitRollupRecipients(VISITS, org, names, SFE);
    const byHr = new Map(recipients.map((r) => [r.hrId, r]));

    assert.deepEqual(
      recipients.map((r) => r.hrId).sort(),
      ["A-12", "A-20", "B-150", "B-151"],
      "the Pedia NSM, the CNS NSM, and both SFE Managers — never the rep",
    );
    assert.equal(byHr.get("A-12")!.visits.length, 4, "the Pedia NSM hears the four visits beneath him");
    assert.equal(byHr.get("A-20")!.visits.length, 2, "the CNS NSM hears only his two");
    assert.equal(byHr.get("B-150")!.visits.length, 6, "an SFE Manager hears every routine visit in the hour");
    assert.equal(byHr.get("B-151")!.visits.length, 6, "and so does the other");
  }

  // ── 1b · a visit whose seat is not in the organogram is skipped, never miscounted ─────────────────
  {
    const withOrphan = buildVisitRollupRecipients(
      [...VISITS, { seatId: "SEAT-GONE", repHrId: "B-999" }],
      org,
      names,
      SFE,
    );
    const sfe = withOrphan.find((r) => r.hrId === "B-150");
    assert.equal(sfe!.visits.length, 6, "the orphan-seat visit is not placed in any scope");
  }

  // ── 1c · a person who is BOTH an NSM and an SFE Manager hears the wider bundle once ───────────────
  {
    const recipients = buildVisitRollupRecipients(VISITS, org, names, ["A-12", "B-150"]);
    const a12 = recipients.filter((r) => r.hrId === "A-12");
    assert.equal(a12.length, 1, "A-12 is told once, not twice");
    assert.equal(a12[0].visits.length, 6, "and it is the company-wide SFE bundle, not just his chain");
  }

  // ── 2 · one rollup per manager with visits; the message counts per rep ────────────────────────────
  {
    const recipients = buildVisitRollupRecipients(VISITS, org, names, SFE);
    const rollups = planPhoenixCrmVisitRollup(recipients, "1:00 PM–2:00 PM", "2026-10-05T11");
    const nsm = rollups.find((r) => r.hrId === "A-12")!;

    assert.ok(nsm, "the Pedia NSM gets a rollup");
    assert.equal(nsm.title, "4 routine visits · 1:00 PM–2:00 PM");
    assert.equal(nsm.idempotencyKey, "phoenix_crm:visit_rollup:A-12:2026-10-05T11", "stable per manager per hour");
    assert.match(nsm.message, /Aya Ibrahim · Tanta · Pedia — 3 visits/, "Aya's three, named and counted");
    assert.match(nsm.message, /Mona Adel · Mansoura · Pedia — 1 visit/, "Mona's single visit reads 'visit', not 'visits'");
    // Aya (3) sorts above Mona (1).
    assert.ok(
      nsm.message.indexOf("Aya Ibrahim") < nsm.message.indexOf("Mona Adel"),
      "the busiest rep is named first",
    );
    assert.doesNotMatch(nsm.message, /\bB-7\b|\bA-12\b/, "names, never HR codes (owner rule)");
  }

  // ── 3 · a manager with no visits this hour hears NOTHING ──────────────────────────────────────────
  {
    const rollups = planPhoenixCrmVisitRollup([{ hrId: "A-99", name: "Idle Manager", visits: [] }], "1:00 PM–2:00 PM", "2026-10-05T11");
    assert.deepEqual(rollups, [], "the whole feature: a quiet hour tells nobody, not an 'all clear'");
  }

  // ── 4 · the message caps its lines and counts the rest ────────────────────────────────────────────
  {
    const many = Array.from({ length: VISIT_ROLLUP_MAX_LINES + 3 }, (_unused, index) => ({
      repName: `Rep ${String(index).padStart(2, "0")}`,
      territoryName: "Area · Pedia",
    }));
    const rollups = planPhoenixCrmVisitRollup([{ hrId: "A-12", name: "Hossam Fouad", visits: many }], "1:00 PM–2:00 PM", "2026-10-05T11");
    const lines = rollups[0].message.split("\n").filter((line) => line.startsWith("• "));
    assert.equal(lines.length, VISIT_ROLLUP_MAX_LINES + 1, "fifteen rep lines plus the 'and N more' line");
    assert.match(rollups[0].message, /• and 3 more reps\./);
  }

  // ── 5 · in-app and Telegram only — email and the phone are both shut ──────────────────────────────
  {
    assert.equal(PHOENIX_CRM_PUSH_BLOCKED_EVENT_TYPES.includes(VISIT_ROLLUP_EVENT_TYPE), true, "the rollup is on the push-blocked list, like the digest and the mirror");
    assert.deepEqual(phoenixCrmChannels(VISIT_ROLLUP_EVENT_TYPE), ["in_app", "telegram"], "in-app and Telegram, never the phone or email");
    assert.deepEqual(phoenixCrmChannels(VISIT_ROLLUP_EVENT_TYPE, true), ["in_app"], "a test entry stays in the app");
    assert.deepEqual(
      enforcePhoenixCrmEmailBlock(["in_app", "email", "telegram"], "phoenix_crm", VISIT_ROLLUP_EVENT_TYPE),
      ["in_app", "telegram"],
      "the guard strips email even if something asks for it",
    );
    assert.deepEqual(
      enforcePhoenixCrmPushBlock(["in_app", "telegram", "push"], "phoenix_crm", VISIT_ROLLUP_EVENT_TYPE),
      ["in_app", "telegram"],
      "and strips the phone",
    );
    const policy = resolveNotificationPolicy({ module: "phoenix_crm", eventType: VISIT_ROLLUP_EVENT_TYPE });
    assert.equal(policy.channels.includes("email"), false, "the policy row never asks for email");
    assert.equal(policy.channels.includes("push"), false, "nor the phone");
    assert.equal(policy.channels.includes("telegram"), true, "Telegram is one of the two channels");
    assert.equal(policy.channels.includes("in_app"), true, "in-app is the other");
  }

  // ── 6 · all five registration sites agree, so the cron is watched, armed and cannot strand ────────
  {
    assert.equal(VISIT_ROLLUP_CRON, "49 * * * *", "an odd minute no other hourly job holds");

    const declared = JOB_SCHEDULES.find((entry) => entry.slug === VISIT_ROLLUP_JOB_SLUG);
    assert.ok(declared, "JOB_SCHEDULES declares the rollup");
    assert.equal(declared!.kind, "cron");
    assert.equal(declared!.schedule, VISIT_ROLLUP_CRON, "the declaration matches the rule constant");
    assert.equal(declared!.graceSeconds, 3600, "one hour of grace, like its hourly neighbours");

    const sync = readFileSync(new URL("../scripts/cronjob-sync.mjs", import.meta.url), "utf8");
    assert.ok(sync.includes('"phoenix-crm-visit-rollup": {'), "cron-job.org sync declares the job");
    assert.ok(sync.includes("hours: [-1], minutes: [49]"), "and on the same minute as the rule constant");

    const docs = readFileSync(new URL("../docs/observability.md", import.meta.url), "utf8");
    assert.ok(
      docs.includes("| `phoenix-crm-visit-rollup` | `49 * * * *` | 1h |"),
      "the observability table row agrees slug, schedule and grace",
    );
    assert.ok(
      /phoenix-crm-visit-rollup[^\n]*in-house only/.test(docs),
      "the row is marked in-house only — the Healthchecks free tier has no slot (owner, 2026-09-08)",
    );

    const registry = readFileSync(new URL("../src/lib/security/access-registry.ts", import.meta.url), "utf8");
    assert.ok(registry.includes("/api/cron/phoenix-crm-visit-rollup"), "the cron route is registered as cron-secret");

    const route = readFileSync(new URL("../app/api/cron/phoenix-crm-visit-rollup/route.ts", import.meta.url), "utf8");
    assert.ok(route.includes('assertCronAuthorized(request, "cron/phoenix-crm-visit-rollup")'), "the route checks the cron secret first");
    assert.ok(route.includes("withDeadMansSwitch(VISIT_ROLLUP_JOB_SLUG"), "and pings the dead-man's switch");
    assert.ok(route.includes("export async function POST"), "cron-job.org may POST");
    assert.ok(route.includes("export const maxDuration = 60"), "and the handler caps its duration");
  }

  // ── 7 · a manager's visit on a vacant territory is filed under HIM, never under nobody ────────────
  // (owner, 2026-10-20: "EVERYSINGLE ROLE THATS APLLICABLE TOAPPEAR IN A MODULE FIND ANAD SHOW"). A visit he logged
  // on a seat with no rep carries no rep id, and the rollup used to print it as "Unknown person".
  {
    const onVacant = buildVisitRollupRecipients([{ seatId: "SEAT-PED-REP2", repHrId: "B-40" }], org, (hrId) => (hrId === "B-40" ? "Mina Farouk" : names(hrId)), SFE);
    assert.equal(onVacant.find((entry) => entry.hrId === "A-12")?.visits[0]?.repName, "Mina Farouk", "the person handed in is the one named");

    const runner = stripComments(readFileSync(new URL("../src/lib/phoenix-crm/server/visit-rollup.ts", import.meta.url), "utf8"));
    assert.match(runner, /const VISIT_COLUMNS = "id, seat_id, rep_hr_id, manager_hr_id";/, "the hour's read carries the manager on the visit");
    assert.match(
      runner,
      /const personOf = \(row: VisitRow\) => personOnTheVisit\(\{ managerHrId: row\.manager_hr_id, repHrId: row\.rep_hr_id \}\);/,
      "the person on the visit is the rep, or the manager when there is no rep — the integrity board's own rule",
    );
    assert.match(runner, /liveRows\.map\(\(row\) => \(\{ seatId: row\.seat_id, repHrId: personOf\(row\) \}\)\)/, "and that person is who each visit is filed under");
    assert.match(runner, /const person = personOf\(row\);\s*if \(person\) needed\.add\(person\);/, "and whose name is read");
    assert.doesNotMatch(runner, /seatId: row\.seat_id, repHrId: row\.rep_hr_id/, "never the rep column alone");
  }

  console.log("phoenix-crm visit rollup: OK");
}
