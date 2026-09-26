import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { InterviewDigestSummary } from "../src/lib/recruitment/interview-calendar.ts";
import { cairoLocalToUtc } from "../src/lib/recruitment/interview-calendar-week.ts";
import { planInterviewDigest, runInterviewDigest } from "../src/lib/recruitment/interview-digest.ts";
import { stripComments } from "./support/comment-strip.ts";

const read = (relative: string) => readFileSync(join(process.cwd(), relative), "utf8");

// The weekly recruitment-interview digest (owner, 2026-09-26, Tier 2): the week's interviews at a
// glance, to the Super Admin(s) ONLY, in-app + Telegram, never e-mail and never the CEO.

function summary(overrides: Partial<InterviewDigestSummary> = {}): InterviewDigestSummary {
  return {
    attendedCount: 4,
    avgDaysToDecision: 1.5,
    awaitingCount: 2,
    decidedCount: 5,
    heldCount: 7,
    noShowCount: 1,
    upcomingCount: 3,
    windowDays: 7,
    ...overrides,
  };
}

// 2026-09-27 is a Sunday.
const sundayEight = cairoLocalToUtc("2026-09-27", 8 * 60);

export async function runInterviewDigestTests() {
  // THE SENTENCE reads the numbers out plainly, and the metrics carry each one for the card.
  const plan = planInterviewDigest(summary(), ["B-10"], sundayEight);
  assert.equal(plan.length, 1, "one digest per recipient");
  const digest = plan[0];
  assert.match(digest.message, /3 coming up in the next 7 days/, "coming up");
  assert.match(digest.message, /7 held in the last 7 \(5 decided, 2 awaiting a decision\)/, "held, decided, awaiting");
  assert.match(digest.message, /4 attended, 1 did not come/, "attended vs did-not-come");
  assert.match(digest.message, /about 1\.5 days to a decision on average/, "average days to a decision");
  const value = (label: string) => digest.metrics.find((metric) => metric.label === label)?.value;
  assert.equal(value("Coming up"), "3");
  assert.equal(value("Held"), "7");
  assert.equal(value("Awaiting a decision"), "2");
  assert.equal(value("Did not come"), "1");
  assert.equal(value("Avg days to decision"), "1.5");

  // NO DECISIONS YET: the average is a dash, not a zero, and the sentence drops the clause.
  const noDecisions = planInterviewDigest(summary({ avgDaysToDecision: null, decidedCount: 0, awaitingCount: 7, attendedCount: 0, noShowCount: 0 }), ["B-10"], sundayEight)[0];
  assert.doesNotMatch(noDecisions.message, /days to a decision/, "no average when nothing is decided");
  assert.equal(noDecisions.metrics.find((metric) => metric.label === "Avg days to decision")?.value, "—", "a dash, never a misleading 0");

  // THE KEY is weekly and per-recipient, so the same week never tells anyone twice.
  const laterSameWeek = planInterviewDigest(summary(), ["B-10"], cairoLocalToUtc("2026-09-27", 20 * 60))[0];
  assert.equal(laterSameWeek.key, digest.key, "the same week reuses the key");
  const nextWeek = planInterviewDigest(summary(), ["B-10"], cairoLocalToUtc("2026-10-04", 8 * 60))[0];
  assert.notEqual(nextWeek.key, digest.key, "a new week is a new key");

  // RECIPIENTS are de-duplicated (case-insensitively), one digest each.
  const many = planInterviewDigest(summary(), ["B-10", "b-10", "B-11", ""], sundayEight);
  assert.deepEqual(many.map((entry) => entry.recipientHrId).sort(), ["B-10", "B-11"], "duplicates and blanks collapse");

  // THE RUN: summarize once, send to each Super Admin, count what went out, survive one failing.
  const sent: string[] = [];
  const run = await runInterviewDigest(
    sundayEight,
    async (entry) => {
      if (entry.recipientHrId === "B-11") throw new Error("Telegram exploded");
      sent.push(entry.recipientHrId);
      return true;
    },
    async () => summary(),
    async () => [{ hrId: "B-10" }, { hrId: "B-11" }],
  );
  assert.deepEqual({ delivered: run.delivered, failed: run.failed, recipients: run.recipients }, { delivered: 1, failed: 1, recipients: 2 }, "one failing send does not stop the others");
  assert.deepEqual(sent, ["B-10"]);

  // WIRING: in-app + Telegram only (never e-mail), deduped by key, and Super Admins only (never the CEO).
  const source = stripComments(read("src/lib/recruitment/interview-digest.ts"));
  assert.match(source, /channels: \["in_app", "telegram"\]/, "in-app + Telegram — never e-mail");
  assert.doesNotMatch(source, /"email"/, "no e-mail channel anywhere");
  assert.match(source, /idempotencyKey: digest\.key/, "each message is deduped by its weekly key");
  assert.match(source, /recipientHrId: digest\.recipientHrId/, "and goes to the resolved recipient");
  assert.match(source, /resolveSuperAdminRecipients/, "the recipients default to the Super Admin(s) — the CEO is not one");
  assert.doesNotMatch(source, /ceo|chief|CEO/, "the CEO is never a recipient");

  const route = stripComments(read("app/api/cron/interview-digest/route.ts"));
  assert.match(route, /assertCronAuthorized\(request, "cron\/interview-digest"\)/, "the cron route checks the secret");
  assert.match(route, /withDeadMansSwitch\("phoenix-interview-digest"/, "and reports to the heartbeat register");
  assert.match(route, /export async function POST/, "and answers the scheduler's POST too");

  assert.match(read("src/lib/observability/job-schedule.ts"), /"phoenix-interview-digest", kind: "cron", schedule: "0 8 \* \* 0"/, "declared to the heartbeat register for Sunday 08:00 Cairo");
  assert.match(read("scripts/cronjob-sync.mjs"), /wdays: \[0\]/, "and to the scheduler on Sunday");

  const registry = stripComments(read("src/lib/security/access-registry.ts"));
  assert.match(registry, /pattern: "\/api\/cron\/interview-digest"/, "the cron route is registered for coverage");
}
