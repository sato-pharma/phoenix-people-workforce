import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { PHOENIX_CRM_PUSH_BLOCKED_EVENT_TYPES } from "@/lib/notifications/phoenix-crm-channel-guard";
import { JOB_SCHEDULES } from "@/lib/observability/job-schedule";
import {
  FRAUD_SCAN_CRON,
  FRAUD_SCAN_JOB_SLUG,
  FRAUD_SCAN_MAX_LINES,
  fraudScanWindow,
  sfeVisibleCases,
  summarizeFraudCases,
  type FraudScanCase,
} from "@/lib/phoenix-crm/fraud-scan-rules";

/**
 * Phoenix CRM — the weekly visit-fraud scan.
 *
 * PURE and source-level only: importing the server half (`server/fraud-scan.ts`) would pull
 * `@/lib/supabase/server` into a unit test, exactly as the daily-digest and heartbeat tests avoid.
 * Two things are pinned here, and they fail for different reasons:
 *
 *   1. The window maths and the summary composition — the owner's Sat–Wed window, the tier split,
 *      the clean-week message, and the line cap.
 *   2. The FIVE registration sites agree, so this cron is watched, armed and cannot strand: the
 *      route, the JOB_SCHEDULES declaration, the docs table, the cronjob-sync job and the
 *      access-registry entry. A declaration with no cron job behind it pages every Super Admin for
 *      ever (see job-schedule.ts), and a route with no declaration is unwatched — this is the guard
 *      against shipping either half alone.
 */

function gps(repHrId: string, repName: string, strong: boolean, reasons: string[]): FraudScanCase {
  return { repHrId, repName, source: "gps", strong, reasons };
}
function photo(repHrId: string, repName: string, strong: boolean, reasons: string[]): FraudScanCase {
  return { repHrId, repName, source: "photo", strong, reasons };
}

export function runPhoenixCrmFraudScanTests() {
  // ---------------------------------------------------------------------------
  // 1. The Sat–Wed window is the completed working week before the run day.
  // ---------------------------------------------------------------------------
  // 2026-10-08 is a Thursday: the week it reports is Sat 3 Oct through Wed 7 Oct.
  const thursday = fraudScanWindow("2026-10-08");
  assert.equal(thursday.fromIso, "2026-10-03", "the window starts on the Saturday");
  assert.equal(thursday.toIso, "2026-10-07", "and ends on the Wednesday");
  assert.equal(thursday.label, "Sat 3 Oct – Wed 7 Oct", "the label names both ends, no ellipsis");

  // It is the most recent Wednesday STRICTLY before the run day, so a later run day still reports the
  // same completed week rather than a half-finished one.
  const saturdayRun = fraudScanWindow("2026-10-10"); // the Saturday after
  assert.equal(saturdayRun.toIso, "2026-10-07", "a run two days late still reports the completed Wednesday");
  assert.equal(saturdayRun.fromIso, "2026-10-03");

  // Run on a Wednesday and it reports the PRIOR week, never the day it is standing in.
  const wednesdayRun = fraudScanWindow("2026-10-07");
  assert.equal(wednesdayRun.toIso, "2026-09-30", "a Wednesday run reports the week before, not today");

  // ---------------------------------------------------------------------------
  // 2. A clean week is reported as clean — never suppressed.
  // ---------------------------------------------------------------------------
  const clean = summarizeFraudCases([], thursday);
  assert.equal(clean.flaggedVisits, 0);
  assert.equal(clean.strongVisits, 0);
  assert.equal(clean.reps, 0);
  assert.match(clean.title, /^No integrity flags · /);
  assert.match(clean.message, /No Phoenix CRM visits were flagged this week/);

  // ---------------------------------------------------------------------------
  // 3. A flagged week: counts, strong-first ordering, reasons, and names not codes.
  // ---------------------------------------------------------------------------
  const cases: FraudScanCase[] = [
    gps("PD-0013", "Ebtissam Alaa", true, ["The phone reported a fake location"]),
    photo("PD-0013", "Ebtissam Alaa", false, ["The same photo was sent again"]),
    photo("PD-0020", "Hoda Samir", false, ["The same photo was sent again"]),
  ];
  const summary = summarizeFraudCases(cases, thursday);
  assert.equal(summary.flaggedVisits, 3, "every flagged capture is counted");
  assert.equal(summary.strongVisits, 1, "one carried an individually damning flag");
  assert.equal(summary.reps, 2, "across two reps");
  assert.match(summary.title, /1 strong, 3 flagged · Sat 3 Oct – Wed 7 Oct/);
  // The rep with a strong flag is named first; the body uses the NAME, never the HR code.
  const firstLine = summary.message.split("\n").find((line) => line.startsWith("•"));
  assert.ok(firstLine?.includes("Ebtissam Alaa"), "the rep with a strong flag leads");
  assert.ok(!summary.message.includes("PD-0013"), "an HR code never appears in the body (owner rule)");
  assert.match(summary.message, /Ebtissam Alaa — 2 \(1 strong\)/, "a rep's count and strong count read together");

  // ---------------------------------------------------------------------------
  // 4. The SFE tier never sees the GPS (position) cases.
  // ---------------------------------------------------------------------------
  const sfeCases = sfeVisibleCases(cases);
  assert.equal(sfeCases.length, 2, "the two photo cases survive");
  assert.ok(sfeCases.every((entry) => entry.source === "photo"), "and no GPS case reaches the SFE copy");
  const sfeSummary = summarizeFraudCases(sfeCases, thursday);
  assert.equal(sfeSummary.strongVisits, 0, "the SFE copy carries no strong GPS flag");

  // ---------------------------------------------------------------------------
  // 5. The line cap names the first N reps and counts the rest, never truncates with an ellipsis.
  // ---------------------------------------------------------------------------
  const many: FraudScanCase[] = [];
  for (let index = 0; index < FRAUD_SCAN_MAX_LINES + 3; index += 1) {
    many.push(photo(`PD-${index}`, `Rep ${String(index).padStart(2, "0")}`, false, ["The same photo was sent again"]));
  }
  const capped = summarizeFraudCases(many, thursday);
  const bulletLines = capped.message.split("\n").filter((line) => line.startsWith("•"));
  assert.equal(bulletLines.length, FRAUD_SCAN_MAX_LINES + 1, "the shown reps plus one 'and N more' line");
  assert.match(capped.message, /• and 3 more on the board\./);
  assert.ok(!capped.message.includes("…") && !capped.message.includes("..."), "no ellipsis anywhere");

  // ---------------------------------------------------------------------------
  // 6. THE FIVE REGISTRATION SITES AGREE — the cron is watched, armed and cannot strand.
  // ---------------------------------------------------------------------------
  assert.equal(FRAUD_SCAN_JOB_SLUG, "phoenix-crm-fraud-scan");
  assert.equal(FRAUD_SCAN_CRON, "0 7 * * 4", "Thursday 07:00 Cairo");

  const declaration = JOB_SCHEDULES.find((entry) => entry.slug === FRAUD_SCAN_JOB_SLUG);
  assert.ok(declaration, "a JOB_SCHEDULES declaration exists, or the heartbeat never watches it");
  assert.equal(declaration?.kind, "cron");
  assert.equal(declaration?.schedule, FRAUD_SCAN_CRON, "the declaration matches the constant");
  assert.equal(declaration?.graceSeconds, 2 * 60 * 60, "2h grace, agreeing with docs/observability.md");
  assert.equal(
    declaration?.watchingSince,
    undefined,
    "a NEW declaration carries no watchingSince — only a restored one does, or its stand-down window alarms",
  );

  const doc = readFileSync("docs/observability.md", "utf8");
  assert.match(
    doc,
    /\|\s*`phoenix-crm-fraud-scan`\s*\|\s*`0 7 \* \* 4`\s*\|\s*2h\s*\|/,
    "docs/observability.md declares the same slug, schedule and grace (the heartbeat register test pins the parity)",
  );

  const sync = readFileSync("scripts/cronjob-sync.mjs", "utf8");
  assert.match(sync, /"phoenix-crm-fraud-scan":\s*\{/, "cronjob-sync.mjs can create the cron-job.org job");
  assert.match(sync, /path:\s*"\/api\/cron\/phoenix-crm-fraud-scan"/, "and points it at the route");
  assert.match(sync, /wdays:\s*\[4\]/, "on Thursday (wday 4), matching the cron expression");

  const registry = readFileSync("src/lib/security/access-registry.ts", "utf8");
  assert.match(
    registry,
    /pattern:\s*"\/api\/cron\/phoenix-crm-fraud-scan"/,
    "the route is declared in the access registry, or the required validate job goes red",
  );

  const route = readFileSync("app/api/cron/phoenix-crm-fraud-scan/route.ts", "utf8");
  assert.match(route, /withDeadMansSwitch\(FRAUD_SCAN_JOB_SLUG/, "the route pings the dead-man's switch under its slug");
  assert.match(route, /assertCronAuthorized\(request, "cron\/phoenix-crm-fraud-scan"\)/, "and is guarded by CRON_SECRET");

  assert.ok(
    PHOENIX_CRM_PUSH_BLOCKED_EVENT_TYPES.includes("crm_fraud_scan"),
    "the scan's event type is in-app and Telegram only — never email or push (Golden Rule #1 evidence)",
  );
}
