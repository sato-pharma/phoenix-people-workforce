import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  DISTRIBUTOR_UPLOAD_OVERDUE_AUDIENCE,
  DISTRIBUTOR_UPLOAD_OVERDUE_CHANNELS,
  DISTRIBUTOR_UPLOAD_OVERDUE_EVENT_TYPE,
  DISTRIBUTOR_UPLOAD_OVERDUE_URL,
  FALLBACK_LAG_DAYS,
  buildOverdueDistributors,
  followingMonthStart,
  medianOf,
  overdueDistributorMessage,
  periodBeingCollected,
  priorPeriodOf,
  type DistributorUploadRow,
} from "../src/lib/sales/distributor-upload-nudge.ts";
import {
  DEFAULT_NOTIFICATION_ROLE_POLICIES,
  notificationRoleKeys,
} from "../src/lib/notifications/role-recipients.ts";
import { permissionMatrix } from "../src/lib/auth/permissions.ts";
import { resolveNotificationPolicy } from "../src/lib/notifications/policy.ts";

const ROOT = process.cwd();

/**
 * August 2026 exactly as production held it on 3 September — the fourteen distributors whose files
 * had not arrived, each with the day of the previous month its own July file landed and what that
 * file was worth. Read live from source_of_sales_import_batches, not invented.
 *
 * The four that HAD arrived are deliberately not in this fixture: they cannot be overdue by
 * construction, and their July arrival days were never read, so putting them here would mean making
 * numbers up. The arrived case gets its own fixture below instead.
 */
const AUGUST_2026: DistributorUploadRow[] = [
  { code: "PS", name: "overseas", currentArrivedOn: null, priorArrivedOn: "2026-08-09", priorValue: 45_364_844 },
  { code: "OFFICE", name: "Marcyrl", currentArrivedOn: null, priorArrivedOn: "2026-08-12", priorValue: 3_930_227 },
  { code: "IS", name: "Ibn sina", currentArrivedOn: null, priorArrivedOn: "2026-08-10", priorValue: 1_637_422 },
  { code: "RM", name: "ramco", currentArrivedOn: null, priorArrivedOn: "2026-08-06", priorValue: 473_202 },
  { code: "SF", name: "sofico", currentArrivedOn: null, priorArrivedOn: "2026-08-06", priorValue: 165_552 },
  { code: "EG-HOS", name: "EGD Hospital", currentArrivedOn: null, priorArrivedOn: "2026-08-09", priorValue: 161_507 },
  { code: "EG", name: "EGD", currentArrivedOn: null, priorArrivedOn: "2026-08-06", priorValue: 115_601 },
  { code: "PS-T", name: "Overseas Tender", currentArrivedOn: null, priorArrivedOn: "2026-08-06", priorValue: 43_554 },
  { code: "EG-BR", name: "EGD Branch", currentArrivedOn: null, priorArrivedOn: "2026-08-06", priorValue: 39_427 },
  { code: "IS-T", name: "Ibn Sina Tender", currentArrivedOn: null, priorArrivedOn: "2026-08-06", priorValue: 26_113 },
  { code: "RM-T", name: "Ramco Tender", currentArrivedOn: null, priorArrivedOn: "2026-08-06", priorValue: 18_881 },
  { code: "MC", name: "mec", currentArrivedOn: null, priorArrivedOn: "2026-08-06", priorValue: 1_269 },
  { code: "SF-T", name: "Sofico Tender", currentArrivedOn: null, priorArrivedOn: "2026-08-06", priorValue: 750 },
  { code: "EP", name: "epda", currentArrivedOn: null, priorArrivedOn: "2026-08-06", priorValue: 258 },
];

function august(todayIso: string) {
  return buildOverdueDistributors({ period: "2026-08", rows: AUGUST_2026, todayIso });
}

export function runDistributorUploadNudgeTests() {
  // ── Channels: the owner's 2026-07-25 rule, asserted out loud ────────────────────────────────
  assert.ok(
    !(DISTRIBUTOR_UPLOAD_OVERDUE_CHANNELS as readonly string[]).includes("email"),
    "a lateness reminder is never emailed here — the owner retired that channel on 2026-07-25 after an unactionable mail re-sent every morning for weeks",
  );
  assert.deepEqual(
    [...DISTRIBUTOR_UPLOAD_OVERDUE_CHANNELS],
    ["in_app", "telegram", "push"],
    "in-app, Telegram and push — the same three both sibling nudges use",
  );

  // The call site's argument is the intent; the policy table is the layer that still holds if that
  // argument is ever dropped. Asserted through the resolver rather than by reading the table,
  // because the bare default — which is what applies when no row matches — carries email and omits
  // Telegram, so a missing row fails in exactly the direction that would go unnoticed.
  const policyChannels = resolveNotificationPolicy({
    eventType: DISTRIBUTOR_UPLOAD_OVERDUE_EVENT_TYPE,
    module: "sales",
  }).channels;
  assert.ok(
    !policyChannels.includes("email"),
    "the policy table must not restore email for this event — with no row of its own the default would, and that is the inverse of the owner's rule arrived at silently",
  );
  assert.ok(
    policyChannels.includes("telegram"),
    "the default policy omits Telegram, so a missing row would quietly drop the channel the owner asked for",
  );

  // ── The rule: silence is the normal state of the first week ─────────────────────────────────
  // This is the assertion the whole job lives or dies on. Fourteen of eighteen files were missing
  // on 3 September 2026 and NOT ONE of them was late: July's arrived between the 2nd and the 12th,
  // so a job that fires on "the month is incomplete" would have opened by crying wolf about
  // fourteen distributors on the third of the month, and been muted by the fourth.
  assert.deepEqual(
    august("2026-09-03"),
    [],
    "on 3 September 2026 fourteen August files were missing and none was overdue — a month being incomplete in its first week is the normal state, not an alert",
  );

  // Marcyrl's own file landed on 12 August, eleven days after July closed. It is not late until the
  // 13th, however many of its faster peers are already overdue by then.
  assert.ok(
    !august("2026-09-12").some((one) => one.name === "Marcyrl"),
    "a distributor is never late ON its own expected date — only past it",
  );
  assert.ok(
    august("2026-09-13").some((one) => one.name === "Marcyrl"),
    "and it IS late the day after — an expected date that never fires is not a deadline",
  );

  const dayOne = august("2026-09-07");
  assert.equal(
    dayOne.length,
    10,
    "on 7 September only the ten whose July file landed on the 6th are past their own date — the four slower ones are still inside their own rhythm",
  );
  assert.equal(dayOne[0].name, "ramco", "biggest money first: the message is read top-down and value decides which call to make first");
  assert.equal(dayOne[0].daysOverdue, 1, "one day past 2026-09-06");
  assert.equal(dayOne[0].expectedDate, "2026-09-06", "expected date is the day this distributor's own file landed last month");
  assert.equal(dayOne[0].basis, "own-history", "a distributor with a previous file is judged against itself, never against a company-wide deadline");
  assert.ok(
    !dayOne.some((one) => one.name === "Marcyrl"),
    "Marcyrl is eleven days slow every month and must not be nagged on day one — that asymmetry is the reason for per-distributor dates",
  );

  const dayLate = august("2026-09-13");
  assert.equal(dayLate.length, 14, "by 13 September every one of the fourteen is past its own date");
  assert.equal(dayLate[0].name, "overseas", "overseas carried 87% of the missing value and must lead the list");
  assert.equal(dayLate[0].daysOverdue, 4, "overseas was expected 2026-09-09, so it is four days late on the 13th");

  // ── An arrived file is never chased ─────────────────────────────────────────────────────────
  const arrived = buildOverdueDistributors({
    period: "2026-08",
    rows: [
      { code: "EP-PHS", name: "EPDA-Pharmacies", currentArrivedOn: "2026-09-02", priorArrivedOn: "2026-08-06", priorValue: 8_161_651 },
      { code: "RM", name: "ramco", currentArrivedOn: null, priorArrivedOn: "2026-08-06", priorValue: 473_202 },
    ],
    todayIso: "2026-09-30",
  });
  assert.deepEqual(
    arrived.map((one) => one.name),
    ["ramco"],
    "a distributor whose file is in is never chased, however late in the month the job runs",
  );

  // ── A distributor with no history of its own ────────────────────────────────────────────────
  const newcomer: DistributorUploadRow = { code: "NEW", name: "A new distributor", currentArrivedOn: null, priorArrivedOn: null, priorValue: 0 };
  const withPeers = buildOverdueDistributors({ period: "2026-08", rows: [...AUGUST_2026, newcomer], todayIso: "2026-09-30" });
  const peerJudged = withPeers.find((one) => one.code === "NEW");
  assert.ok(peerJudged, "a distributor with no previous file is still chased — it is just judged differently");
  assert.equal(peerJudged.basis, "peer-median", "with no history of its own it borrows the median of what its peers did that same month");
  assert.equal(
    peerJudged.expectedDate,
    "2026-09-06",
    "the August peer median is five days — ten of the fourteen landed on the 6th, so both middle values are five — giving 1 September plus five",
  );

  const alone = buildOverdueDistributors({ period: "2026-08", rows: [newcomer], todayIso: "2026-09-30" });
  assert.equal(alone[0].basis, "fallback", "with nobody to learn from at all it falls back to a fixed grace period");
  assert.equal(
    alone[0].expectedDate,
    followingMonthStart("2026-08").replace("01", String(1 + FALLBACK_LAG_DAYS)),
    "the fallback is the slowest lag ever actually observed plus one — nudging early is what trains a reader to dismiss the job",
  );
  assert.equal(FALLBACK_LAG_DAYS, 12, "twelve: Marcyrl's eleven days, the slowest real observation, plus one");

  // ── Calendar arithmetic, including the boundaries that bite ─────────────────────────────────
  assert.equal(periodBeingCollected("2026-09-03"), "2026-08", "the month being collected is always the one that just ended");
  assert.equal(
    periodBeingCollected("2026-01-04"),
    "2025-12",
    "January chases December of the previous YEAR — an off-by-one here would chase a month that does not exist",
  );
  assert.equal(followingMonthStart("2026-12"), "2027-01-01", "December's files start arriving in January of the next year");
  assert.equal(priorPeriodOf("2026-01"), "2025-12", "the month before January is December of the previous year");
  assert.equal(followingMonthStart("2026-08"), "2026-09-01", "August's files start arriving on 1 September");
  assert.equal(medianOf([1, 2, 3]), 2, "odd count takes the middle");
  assert.equal(medianOf([1, 2, 3, 4]), 3, "even count averages the two middles and rounds");
  assert.equal(medianOf([]), null, "no values means no median, not zero — zero would make every distributor late on the 1st");

  // ── The message: the owner's standing rules about how anything is worded ────────────────────
  const message = overdueDistributorMessage("2026-08", august("2026-09-13"));
  assert.ok(message.includes("August 2026"), "months are spelled out, never a period code");
  assert.ok(message.includes("overseas"), "names, never codes — the owner's standing rule in both UI and message text");
  assert.ok(!message.includes("PS-T"), "a distributor code must never reach the reader");
  assert.ok(!message.includes("…") && !message.includes("..."), "the ellipsis ban: text is never truncated here");
  assert.ok(message.includes("45,364,844 EGP"), "the money is what makes the message actionable, so it is spelled with separators");
  assert.ok(
    message.includes("51,978,607 EGP"),
    "the total carried by every late file — 51,978,607 EGP was the real August figure",
  );

  const singular = overdueDistributorMessage("2026-08", august("2026-09-07").slice(0, 1));
  assert.ok(
    singular.startsWith("1 distributor file for August 2026 is later"),
    "one late file reads as one file, not as '1 files' — the plural is agreed, not appended",
  );
  assert.ok(singular.includes("1 day past"), "one day reads as 'day', not 'days'");

  // ── The audience ────────────────────────────────────────────────────────────────────────────
  assert.ok(
    (notificationRoleKeys as readonly string[]).includes(DISTRIBUTOR_UPLOAD_OVERDUE_AUDIENCE),
    "the audience key must be in the registry or /admin/notification-recipients cannot render it",
  );
  const policy = DEFAULT_NOTIFICATION_ROLE_POLICIES[DISTRIBUTOR_UPLOAD_OVERDUE_AUDIENCE];
  assert.deepEqual(
    policy.roles,
    ["Super Admin", "SFE Manager"],
    "owner decision 2026-09-03, asked directly: sfe, plus him and the Super Admins",
  );
  assert.equal(policy.enabled, true, "the job is on by default — a lateness alert nobody switched on is the gap this closes");

  // Every default recipient must be able to DO the thing the message links to. A recipient who
  // lands on a redirect learns only that the system is broken.
  for (const role of policy.roles) {
    assert.ok(
      permissionMatrix[role]?.sales?.includes("import"),
      `${role} is a default recipient and must hold sales:import, which is what ${DISTRIBUTOR_UPLOAD_OVERDUE_URL} requires — otherwise the alert links them to a redirect`,
    );
  }
  assert.equal(DISTRIBUTOR_UPLOAD_OVERDUE_URL, "/sales/upload", "the link goes to the screen that FIXES the problem, not the dashboard that shows it");

  // ── The migration that makes the audience editable without a deploy ─────────────────────────
  const migration = readFileSync(
    join(ROOT, "supabase/migrations/20260903180000_notification_role_policies_distributor_upload_overdue_key.sql"),
    "utf8",
  );
  for (const key of notificationRoleKeys) {
    assert.ok(
      migration.includes(`'${key}'`),
      `the rebuilt CHECK constraint drops every key it does not list, and ADD CONSTRAINT validates existing rows — omitting ${key} would fail the migration outright`,
    );
  }
  assert.ok(
    migration.includes("on conflict (notification_key) do nothing"),
    "re-running the migration must never clobber an admin's real edit",
  );
  const seededDescription = migration.match(/'((?:[^']|'')*)',\s*\n\s*array\[/)?.[1].replace(/''/g, "'");
  assert.equal(
    seededDescription,
    policy.description,
    "the seed row is byte-matched to the TypeScript default, so applying this migration changes nothing on deploy day — that is what makes it safe to apply before the code ships",
  );

  // ── The plumbing that makes it run at all ───────────────────────────────────────────────────
  const routeSource = readFileSync(join(ROOT, "app/api/cron/distributor-upload-overdue-nudge/route.ts"), "utf8");
  assert.ok(routeSource.includes("assertCronAuthorized"), "the cron route is guarded by CRON_SECRET like every other job here");
  assert.ok(
    routeSource.includes('withDeadMansSwitch("phoenix-distributor-upload-overdue-nudge"'),
    "a job nobody watches is a job that fails silently — the outbox drain ran green and did nothing for thirteen days",
  );

  const registrySource = readFileSync(join(ROOT, "src/lib/security/access-registry.ts"), "utf8");
  assert.ok(
    registrySource.includes("/api/cron/distributor-upload-overdue-nudge"),
    "an unregistered route fails the access-registry CI gate",
  );

  const moduleSource = readFileSync(join(ROOT, "src/lib/sales/distributor-upload-nudge.ts"), "utf8");
  assert.ok(
    moduleSource.includes('.eq("status", "validated")'),
    "only a validated batch counts as arrived — the same test the closing screen applies, so this job and that screen can never disagree about whether a file is in",
  );
  assert.ok(
    moduleSource.includes(".toUpperCase()"),
    "distributor codes are stored mixed-case here, and an exact-case comparison silently under-returns rather than erroring",
  );
  assert.ok(
    moduleSource.includes("isPeriodLocked"),
    "a locked period means the closing is finished and chasing is over — chasing past it would nag about a month already sent",
  );
  assert.equal(
    DISTRIBUTOR_UPLOAD_OVERDUE_EVENT_TYPE,
    "distributor_upload_overdue",
    "its own event type: nothing else in this system means 'a source file has not arrived'",
  );
}
