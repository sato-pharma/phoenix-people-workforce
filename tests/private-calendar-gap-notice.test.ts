import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { JOB_SCHEDULES } from "@/lib/observability/job-schedule";
import {
  GAP_NOTICE_CRON,
  GAP_NOTICE_JOB_SLUG,
  GAP_NOTICE_MAX_DATES,
  bundleGapNoticesByEmployee,
  composeGapNotice,
  gapNoticeDayKey,
  gapNoticeIdempotencyKey,
  gapNoticeWindow,
  type GapNoticeDay,
} from "@/lib/private-calendar/gap-notice-rules";

/**
 * Private Calendar — the employee's own unexplained-day notice (owner, 2026-10-08).
 *
 * PURE and source-level only: importing the server half (`gap-notice.ts`) would pull
 * `@/lib/supabase/server` into a unit test, exactly as the fraud-scan and daily-digest tests avoid.
 * Four things are pinned here, and they fail for different reasons:
 *
 *   1. The Sat-Thu window maths and the message composition — the week it reports, the cap, the
 *      singular/plural, and the no-ellipsis rule.
 *   2. The suppression — a day already carrying a review request is named to NOBODY, whatever the HR
 *      id's case. Without this the notice nags the employee about precisely the day they have already
 *      done the right thing on, which teaches them the control achieves nothing.
 *   3. The FIVE registration sites agree, so the cron is watched, armed and cannot strand: the route,
 *      the JOB_SCHEDULES declaration, the docs table, the cronjob-sync job and the access-registry
 *      entry. A declaration with no cron job behind it pages every Super Admin for ever, and a route
 *      with no declaration is unwatched.
 *   4. The two rules the server half must never lose: it is in-app and push with NO email channel
 *      (bulk outbound email from a business system is banned, and every automated email mirrors to the
 *      owner's Telegram), and the suppression read fails CLOSED.
 */

function day(employeeHrId: string, employeeName: string, date: string): GapNoticeDay {
  return { date, employeeHrId, employeeName };
}

export function runPrivateCalendarGapNoticeTests() {
  // ---------------------------------------------------------------------------
  // 1. The Sat-Thu window is the completed working week before the run day.
  // ---------------------------------------------------------------------------
  // 2026-10-10 is a Saturday: the week it reports is Sat 3 Oct through Thu 8 Oct.
  const saturday = gapNoticeWindow("2026-10-10");
  assert.equal(saturday.fromIso, "2026-10-03", "the window starts on the Saturday");
  assert.equal(saturday.toIso, "2026-10-08", "and ends on the Thursday");
  assert.equal(saturday.label, "Sat 3 Oct – Thu 8 Oct", "the label names both ends, no ellipsis");

  // It is the most recent Thursday STRICTLY before the run day, so a late run still reports the same
  // completed week rather than a half-finished one.
  const sundayRun = gapNoticeWindow("2026-10-11");
  assert.equal(sundayRun.toIso, "2026-10-08", "a run a day late still reports the completed Thursday");
  assert.equal(sundayRun.fromIso, "2026-10-03");

  // Run on a Thursday and it reports the PRIOR week, never the day it is standing in — an employee must
  // never be told a day is unexplained while the day is still being worked.
  const thursdayRun = gapNoticeWindow("2026-10-08");
  assert.equal(thursdayRun.toIso, "2026-10-01", "a Thursday run reports the week before, not today");
  assert.equal(thursdayRun.fromIso, "2026-09-26", "and its Saturday is in the previous month");

  // ---------------------------------------------------------------------------
  // 2. The message: the dates, the singular, and no HR code anywhere.
  // ---------------------------------------------------------------------------
  const two = composeGapNotice({
    days: [day("PD-0013", "Ebtissam Alaa", "2026-10-04"), day("PD-0013", "Ebtissam Alaa", "2026-10-05")],
    employeeName: "Ebtissam Alaa",
    window: saturday,
  });
  assert.deepEqual(two.dates, ["2026-10-04", "2026-10-05"], "the dates travel in order");
  assert.equal(two.title, "2 unexplained days on your calendar");
  assert.match(two.message, /Sun 4 Oct, Mon 5 Oct/, "the body spells the days out the way the calendar does");
  assert.match(two.message, /Request review/, "and names the control that answers them");
  assert.ok(!two.message.includes("PD-0013"), "an HR code never appears in the body (owner rule)");
  assert.ok(!two.message.includes("…") && !two.message.includes("..."), "no ellipsis anywhere (owner rule)");

  const one = composeGapNotice({
    days: [day("PD-0020", "Hoda Samir", "2026-10-06")],
    employeeName: "Hoda Samir",
    window: saturday,
  });
  assert.equal(one.title, "1 unexplained day on your calendar", "one day reads singular");
  assert.match(one.message, /has 1 day in Sat 3 Oct – Thu 8 Oct/, "and so does the body");

  // A duplicate date from two sources is one day to the employee, not two.
  const deduped = composeGapNotice({
    days: [day("PD-0020", "Hoda Samir", "2026-10-06"), day("PD-0020", "Hoda Samir", "2026-10-06")],
    employeeName: "Hoda Samir",
    window: saturday,
  });
  assert.deepEqual(deduped.dates, ["2026-10-06"], "the same date twice is one day");

  // ---------------------------------------------------------------------------
  // 3. The cap names the first N days and COUNTS the rest — never truncates.
  // ---------------------------------------------------------------------------
  const manyDays: GapNoticeDay[] = [];
  for (let index = 1; index <= GAP_NOTICE_MAX_DATES + 3; index += 1) {
    manyDays.push(day("PD-0031", "Mahmoud Adel", `2026-09-${String(index).padStart(2, "0")}`));
  }
  const capped = composeGapNotice({ days: manyDays, employeeName: "Mahmoud Adel", window: saturday });
  assert.equal(capped.dates.length, GAP_NOTICE_MAX_DATES + 3, "every day is still carried in the metadata");
  assert.match(capped.message, /and 3 more days\./, "the body names five and counts the rest");
  assert.ok(!capped.message.includes("…"), "no ellipsis in the capped body either");

  // ---------------------------------------------------------------------------
  // 4. SUPPRESSION — a day already under review is named to nobody.
  // ---------------------------------------------------------------------------
  assert.equal(
    gapNoticeDayKey({ date: "2026-10-04", employeeHrId: " pd-0013 " }),
    "PD-0013|2026-10-04",
    "both sides of the suppression test agree on one key form, trimmed and upper-cased",
  );

  const raised = new Set([
    gapNoticeDayKey({ date: "2026-10-04", employeeHrId: "PD-0013" }),
    // The dispute table stores whatever the portal sent, so the lower-case spelling must suppress too.
    gapNoticeDayKey({ date: "2026-10-06", employeeHrId: "pd-0020" }),
  ]);
  const bundles = bundleGapNoticesByEmployee({
    alreadyRaised: raised,
    days: [
      day("PD-0013", "Ebtissam Alaa", "2026-10-04"),
      day("PD-0013", "Ebtissam Alaa", "2026-10-05"),
      day("pd-0020", "Hoda Samir", "2026-10-06"),
      day("PD-0031", "Mahmoud Adel", "2026-10-07"),
    ],
  });

  assert.equal(bundles.length, 2, "Hoda Samir's only day was already raised, so she is not written to at all");
  const ebtissam = bundles.find((bundle) => bundle.employeeName === "Ebtissam Alaa");
  assert.deepEqual(
    ebtissam?.days.map((entry) => entry.date),
    ["2026-10-05"],
    "the day she already raised is dropped and the other one survives — one notice, not one per day",
  );
  assert.ok(
    !bundles.some((bundle) => bundle.employeeName === "Hoda Samir"),
    "a lower-case HR id in the dispute table still suppresses: the key is case-folded on both sides",
  );
  assert.deepEqual(
    bundles.map((bundle) => bundle.employeeName),
    ["Ebtissam Alaa", "Mahmoud Adel"],
    "bundles come back by name, so a run reads in an order a human can follow",
  );

  // One notice per employee per WEEK, keyed on the window end: a retry or double fire reaches nobody
  // twice, and it is independent of the message text, which a late-arriving punch could still change.
  assert.equal(
    gapNoticeIdempotencyKey({ employeeHrId: "pd-0013", windowEndIso: saturday.toIso }),
    "private-calendar-gap:2026-10-08:PD-0013",
  );
  assert.notEqual(
    gapNoticeIdempotencyKey({ employeeHrId: "PD-0013", windowEndIso: "2026-10-15" }),
    gapNoticeIdempotencyKey({ employeeHrId: "PD-0013", windowEndIso: saturday.toIso }),
    "a new week is a new notice",
  );

  // ---------------------------------------------------------------------------
  // 5. THE FIVE REGISTRATION SITES AGREE — the cron is watched, armed and cannot strand.
  // ---------------------------------------------------------------------------
  assert.equal(GAP_NOTICE_JOB_SLUG, "private-calendar-gap-notice");
  assert.equal(GAP_NOTICE_CRON, "9 8 * * 6", "Saturday 08:09 Cairo");

  const declaration = JOB_SCHEDULES.find((entry) => entry.slug === GAP_NOTICE_JOB_SLUG);
  assert.ok(declaration, "a JOB_SCHEDULES declaration exists, or the heartbeat never watches it");
  assert.equal(declaration?.kind, "cron");
  assert.equal(declaration?.schedule, GAP_NOTICE_CRON, "the declaration matches the constant");
  assert.equal(declaration?.graceSeconds, 2 * 60 * 60, "2h grace, agreeing with docs/observability.md");
  assert.equal(
    declaration?.watchingSince,
    undefined,
    "a NEW declaration carries no watchingSince — only a restored one does, or its stand-down window alarms",
  );

  const doc = readFileSync("docs/observability.md", "utf8");
  assert.match(
    doc,
    /\|\s*`private-calendar-gap-notice`\s*\|\s*`9 8 \* \* 6`\s*\|\s*2h\s*\|/,
    "docs/observability.md declares the same slug, schedule and grace (the heartbeat register test pins the parity)",
  );

  const sync = readFileSync("scripts/cronjob-sync.mjs", "utf8");
  assert.match(sync, /"private-calendar-gap-notice":\s*\{/, "cronjob-sync.mjs can create the cron-job.org job");
  assert.match(sync, /path:\s*"\/api\/cron\/private-calendar-gap-notice"/, "and points it at the route");
  assert.match(
    sync,
    /schedule:\s*\{\s*hours:\s*\[8\],\s*minutes:\s*\[9\],\s*mdays:\s*\[-1\],\s*months:\s*\[-1\],\s*wdays:\s*\[6\]\s*\}/,
    "on Saturday (wday 6) at 08:09, matching the cron expression — cron-job.org counts 0=Sunday",
  );

  const registry = readFileSync("src/lib/security/access-registry.ts", "utf8");
  assert.match(
    registry,
    /pattern:\s*"\/api\/cron\/private-calendar-gap-notice"/,
    "the route is declared in the access registry, or the required validate job goes red",
  );

  const route = readFileSync("app/api/cron/private-calendar-gap-notice/route.ts", "utf8");
  assert.match(route, /withDeadMansSwitch\(GAP_NOTICE_JOB_SLUG/, "the route pings the dead-man's switch under its slug");
  assert.match(
    route,
    /assertCronAuthorized\(request, "cron\/private-calendar-gap-notice"\)/,
    "and is guarded by CRON_SECRET",
  );

  // ---------------------------------------------------------------------------
  // 6. The two rules the server half must never lose.
  // ---------------------------------------------------------------------------
  const server = readFileSync("src/lib/private-calendar/gap-notice.ts", "utf8");
  assert.match(server, /channels: \["in_app", "push"\]/, "in-app and push");
  assert.ok(
    !server.includes('"email"'),
    "and NEVER email: bulk outbound email from a business system is banned, and every automated email "
      + "also mirrors to the owner's Telegram, so a weekly sweep over the roster would page him for news "
      + "that is not his",
  );
  assert.match(
    server,
    /recipientHrId: delivery\.employeeHrId,\s*\n\s*subjectHrId: delivery\.employeeHrId,/,
    "the employee is both recipient and subject — the audience is the employee alone, never a manager or HR",
  );
  assert.match(
    server,
    /if \(error\) throw new Error\(`Could not read existing review requests/,
    "the suppression read fails CLOSED: a notice is unretractable and a retry is free, so an unreadable "
      + "dispute table must stop the run rather than nag an employee about the day they already raised",
  );
  assert.match(
    server,
    /getCompanyNoActivityDays\(\{ access: systemAccessContext/,
    "and the days come from the SAME engine call the Deductions connector makes, so the day the notice "
      + "names, the day the calendar shows and the day that can become a deduction candidate are one day",
  );
}
