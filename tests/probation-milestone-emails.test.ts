// Probation Day 30 / 60 / 75 milestone emails — owner rule, 2026-09-29.
//
// The rule being pinned: these three emails go to Yasmeena Elsafory (HR-009) ALONE, with Omar
// Gawish (B-10) on CC, and they ride their OWN notification type so re-enabling them never
// re-opens the `probation` policy the owner switched off on 2026-07-19.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { PROBATION_TOTAL_DAYS } from "../src/lib/probation/date.ts";
import {
  PROBATION_MILESTONES,
  PROBATION_MILESTONE_BCC_HR_IDS,
  PROBATION_MILESTONE_TO_HR_ID,
  milestoneCrossingDate,
  milestoneIsDue,
} from "../src/lib/probation/intelligence/milestone-emails.ts";
import {
  defaultEmailNotificationPolicies,
  emailNotificationTypes,
} from "../src/lib/notifications/email.ts";
import { isDateBeforeProbationEmailFreshStart } from "../src/lib/probation/intelligence/email-fresh-start.ts";

function src(p: string) { return readFileSync(p, "utf8"); }

export function runProbationMilestoneEmailsTests() {
  const sweep = src("src/lib/probation/intelligence/milestone-emails.ts");

  // ── The recipients, which are the whole point of the owner's instruction ──
  assert.equal(
    PROBATION_MILESTONE_TO_HR_ID,
    "HR-009",
    "the ONLY To recipient is Yasmeena Elsafory (HR-009) — owner, 2026-09-29",
  );
  assert.deepEqual(
    [...PROBATION_MILESTONE_BCC_HR_IDS],
    ["B-10"],
    "Omar Gawish (B-10) is the only BCC — owner, 2026-09-29",
  );
  // Regression guard: the retired 2026-07 fan-out resolved CEO/HR/DM/NSM/SFE stakeholders per case.
  // Any of those lookups reappearing here means the fan-out is creeping back in.
  for (const banned of ["resolveStakeholders", "activeHrIdsByRole", "getEmployeeDirectoryRows", "national_sales_manager"]) {
    assert.ok(
      !sweep.includes(banned),
      `${banned} must not reappear — the milestone email is addressed to one person, not a stakeholder set`,
    );
  }
  // One notification, one recipient: the sweep addresses HR-009 directly rather than looping.
  assert.match(
    sweep,
    /recipientHrId: PROBATION_MILESTONE_TO_HR_ID/,
    "the single To recipient is the named constant, not a resolved list",
  );
  assert.match(sweep, /^\s+bcc,$/m, "the resolved BCC addresses are passed to the email");
  // BCC, NOT CC — "to her only" (owner, 2026-09-29). A CC would print his address on her copy.
  assert.ok(
    !/^\s+cc[,:]/m.test(sweep),
    "the owner is BCC, never CC — Yasmeena must be the only recipient the delivered mail shows",
  );
  // The BCC address is read live from employees.work_email, so a mailbox change follows the record.
  assert.match(
    sweep,
    /from\("employees"\)\s*\.select\("hr_id, work_email"\)/,
    "BCC addresses are resolved from the live employee record, never hardcoded",
  );

  // ── Its own notification type, so the owner's `probation` OFF ruling is untouched ──
  assert.ok(
    (emailNotificationTypes as readonly string[]).includes("probation_milestone"),
    "probation_milestone is a real email notification type",
  );
  assert.match(
    sweep,
    /notificationType: "probation_milestone"/,
    "the milestone email sends under probation_milestone, NOT under the disabled `probation` policy",
  );
  const milestonePolicy = defaultEmailNotificationPolicies.find((p) => p.type === "probation_milestone");
  assert.ok(milestonePolicy, "probation_milestone has a default policy");
  assert.equal(milestonePolicy!.enabled, true, "the milestone policy ships enabled — the owner asked for these emails");
  assert.equal(
    milestonePolicy!.includeHrInbox,
    false,
    "the shared HR inbox is NOT added — the recipient list is Yasmeena and the owner, nobody else",
  );
  const legacyPolicy = defaultEmailNotificationPolicies.find((p) => p.type === "probation");
  assert.ok(legacyPolicy, "the legacy probation policy still exists");
  assert.notEqual(
    legacyPolicy!.type,
    milestonePolicy!.type,
    "the two policies are separate rows — enabling milestones must never enable the legacy manager reminders",
  );

  // ── The milestone schedule the owner named: 30, 60, 75 ──
  assert.deepEqual(
    PROBATION_MILESTONES.map((m) => m.day),
    [30, 60, 75],
    "the milestones are Day 30, 60 and 75",
  );
  assert.deepEqual(
    PROBATION_MILESTONES.map((m) => m.key),
    ["probation_day30", "probation_day60", "probation_day75"],
    "each milestone renders its own admin template",
  );

  // ── The fire window: crossed, and still on probation ──
  assert.ok(!milestoneIsDue(29, 30), "day 29 has not reached Day 30");
  assert.ok(milestoneIsDue(30, 30), "day 30 fires Day 30");
  assert.ok(milestoneIsDue(PROBATION_TOTAL_DAYS, 30), "the last day of probation still fires a milestone HR never saw");
  assert.ok(!milestoneIsDue(PROBATION_TOTAL_DAYS + 1, 30), "once probation is over a Day 30 notice is wrong information, not a late email");
  assert.ok(!milestoneIsDue(152, 30), "a case 150+ days in is never emailed a Day 30 early-progress notice");
  // A milestone crossed weeks ago is still DUE while the person is on probation — the window is the
  // probation, not a few days. One case can therefore emit several milestones in one pass.
  assert.ok(milestoneIsDue(85, 30) && milestoneIsDue(85, 60) && milestoneIsDue(85, 75), "a day-85 case is due all three");

  // ── THE CATCH-UP IS RELEASED (owner, 2026-09-29: "release the held probation milestones") ──
  // It was asked for, held back for a few hours under a start-date constant while Yasmeena's own
  // address was corrected, and then released. The constant is GONE, not merely moved back — a
  // dormant second cutoff beside the 2026-07-17 fresh start would read as a live gate to whoever
  // found it next. These are the 8 real milestones measured on production that day, across the 6
  // people still on probation; every one must come out DUE, or the release silently did nothing.
  for (const [who, day, milestone] of [
    ["Mohamed Khaled", 44, 30],
    ["Omayma Wael", 44, 30],
    ["Hanan Safwat", 50, 30],
    ["Adel Srour", 59, 30],
    ["Mahmoud Abdelreheem", 60, 30],
    ["Gannatallah Amer", 60, 30],
    ["Mahmoud Abdelreheem", 60, 60],
    ["Gannatallah Amer", 60, 60],
  ] as const) {
    assert.ok(milestoneIsDue(day, milestone), `${who} · Day ${milestone} (at day ${day}) is released, not held`);
  }
  // Nothing may re-introduce a second start cutoff without this test being rewritten.
  assert.ok(
    !/EMAIL_START_DATE|isMilestoneBeforeEmailStart/.test(sweep),
    "the held-back start-date guard is gone — the owner released the catch-up",
  );

  // ── Crossing date, which is what the fresh-start guard reads ──
  assert.equal(milestoneCrossingDate("2026-09-29", 30, 30), "2026-09-29", "crossed today when day === milestone");
  assert.equal(milestoneCrossingDate("2026-09-29", 37, 30), "2026-09-22", "crossed 7 days ago at the end of the window");
  assert.equal(milestoneCrossingDate("2026-03-05", 33, 30), "2026-03-02", "crosses a month boundary correctly");
  // A milestone crossed before the 2026-07-17 reset must never fire a catch-up email.
  assert.ok(
    isDateBeforeProbationEmailFreshStart(milestoneCrossingDate("2026-07-18", 35, 30)),
    "a milestone crossed on 2026-07-13 is before the fresh start and is skipped",
  );
  assert.ok(
    !isDateBeforeProbationEmailFreshStart(milestoneCrossingDate("2026-09-29", 31, 30)),
    "a milestone crossed after the fresh start is emailed",
  );
  assert.match(sweep, /isDateBeforeProbationEmailFreshStart/, "the sweep applies the fresh-start guard");

  // ── Idempotency: one email per (case, milestone), so a daily re-run is a no-op ──
  assert.match(
    sweep,
    /idempotencyKey: `probation:milestone:\$\{c\.id\}:day\$\{m\.day\}:\$\{PROBATION_MILESTONE_TO_HR_ID\}`/,
    "the dedup key is per case, per milestone day, per recipient",
  );

  // ── The sweep must not email someone who has already left ──
  assert.match(sweep, /filterResolvedProbationCases\(/, "resolved/terminal cases are filtered before any email");
  // That filter compares HR_IDs case-insensitively but used to FETCH them with an exact `.in()`.
  // probation_cases holds the older cohort as `ai-0004` where employees holds `AI-0004`, so the
  // employee row came back empty and a TERMINATED person passed through as a live case — measured
  // on production 2026-09-29, and it was the one terminated case in the 30-90 day band.
  const casesSource = src("src/lib/probation/intelligence/cases.ts");
  assert.match(
    casesSource,
    /const hrIdVariants = Array\.from\(\s*new Set\(hrIds\.flatMap\(\(id\) => \[id, id\.toLowerCase\(\), id\.toUpperCase\(\)\]\)\),?\s*\);/,
    "the resolved-case filter fetches HR_ID case variants, or it silently filters nothing for a mixed-case id",
  );
  assert.ok(
    !/\.in\("hr_id", hrIds\)/.test(casesSource) && !/\.in\("employee_hr_id", hrIds\)/.test(casesSource),
    "neither lookup may go back to the exact-match `.in(…, hrIds)` that missed the mixed-case rows",
  );

  // ── Wiring: the sweep actually runs ──
  const dailyCron = src("app/api/notifications/daily/route.ts");
  assert.match(
    dailyCron,
    /import \{ processProbationMilestoneEmails \} from "@\/lib\/probation\/intelligence\/milestone-emails"/,
    "the daily notifications cron imports the sweep",
  );
  assert.match(dailyCron, /processProbationMilestoneEmails\(\)\.catch\(/, "the sweep is called, with its own failure handler");
  assert.match(dailyCron, /probationMilestoneEmails,/, "its result is named in the destructure — an unnamed entry is the off-by-one this route has hit twice");

  // The on-demand trigger, so the backfill does not have to wait for 06:36 Cairo.
  const triggerRoute = src("app/api/cron/probation-milestones/route.ts");
  assert.match(triggerRoute, /assertCronAuthorized\(/, "the manual trigger is CRON_SECRET-authorized, never open");
  assert.match(triggerRoute, /processProbationMilestoneEmails\(\)/, "it runs the milestone sweep");
  // Declaring it in JOB_SCHEDULES with no cron job behind it would alarm every Super Admin for ever.
  const jobSchedules = src("src/lib/observability/job-schedule.ts");
  assert.ok(
    !jobSchedules.includes("probation-milestones"),
    "the manual trigger is NOT declared as a scheduled job — a declaration with no job behind it reads as a job that has STOPPED",
  );

  // ── The Email Control Center must not claim managers still receive these ──
  const templateEngine = src("src/lib/email-templates/service.ts");
  for (const key of ["probation_day30", "probation_day60", "probation_day75"]) {
    assert.match(
      templateEngine,
      new RegExp(`${key}: emptyRules\\(\\)`),
      `${key} carries NO role routing — its recipients are fixed in milestone-emails.ts`,
    );
  }
}
