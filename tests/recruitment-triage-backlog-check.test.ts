import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  buildTriageBacklogMessage,
  summarizeTriageBacklog,
  TRIAGE_BACKLOG_ACTION_URL,
  TRIAGE_BACKLOG_CHANNELS,
  TRIAGE_BACKLOG_OVERDUE_AFTER_DAYS,
  type UntriagedApplicant,
} from "../src/lib/recruitment/triage-backlog-check.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * The rule that decides when nobody having looked at a CV becomes something worth saying.
 *
 * Every fixture is shaped on the real production state of 2026-08-29: 313 candidates at status
 * `new`, 252 of them past seven days, 51 past a month, 32 with neither a phone number nor an email
 * address, and the oldest waiting 36 days since 24 July. Those numbers are what the owner was shown
 * when he set the threshold, so they are the numbers this file reasons in.
 */

const MODULE = "src/lib/recruitment/triage-backlog-check.ts";
const read = (relative: string) => readFileSync(path.join(process.cwd(), relative), "utf8");

// Only line-leading `//` is stripped, so a `//` inside a URL survives. The header paragraphs quote
// the numbers and name the sibling digests deliberately, and a guard that cannot tell prose from
// code would force that explanation to be deleted to stay green.
const withoutComments = (source: string) =>
  stripComments(source);

const NOW = new Date("2026-08-29T09:00:00Z");

/** `waitingSince` for a candidate who has been waiting exactly `days` at NOW. */
function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 86_400_000).toISOString();
}

function waiting(days: number, overrides: Partial<UntriagedApplicant> = {}): UntriagedApplicant {
  return {
    contactable: true,
    id: `c-${days}-${overrides.id ?? "x"}`,
    waitingSince: daysAgo(days),
    ...overrides,
  };
}

export async function runRecruitmentTriageBacklogCheckTests(): Promise<void> {
  // ── 1. The threshold is a floor, not a rounding ────────────────────────────
  // Six days and twenty-three hours is not seven days. Getting this wrong in the generous direction
  // means the alarm reports a candidate as overdue on the day before they are, and a number the desk
  // can disprove by opening the screen is a number they stop trusting.
  {
    const justUnder = summarizeTriageBacklog(
      [waiting(TRIAGE_BACKLOG_OVERDUE_AFTER_DAYS - 0.05)],
      NOW,
    );
    assert.equal(justUnder.overdue, 0, "six days and twenty-three hours is not seven days");
    assert.equal(justUnder.withinThreshold, 1, "and it is still counted as waiting");

    const exactly = summarizeTriageBacklog([waiting(TRIAGE_BACKLOG_OVERDUE_AFTER_DAYS)], NOW);
    assert.equal(exactly.overdue, 1, "exactly seven days is overdue");
    assert.equal(exactly.longestWaitDays, TRIAGE_BACKLOG_OVERDUE_AFTER_DAYS);
    assert.equal(exactly.withinThreshold, 0, "and it is no longer merely waiting");
  }

  // ── 2. An empty queue is silent, and so is a queue nobody has kept waiting ─
  // The goal state. `overdue === 0` is what `runTriageBacklogCheck` returns on before it resolves a
  // single recipient, so this is the assertion that keeps the alarm quiet once the desk catches up.
  {
    assert.equal(summarizeTriageBacklog([], NOW).overdue, 0, "an empty queue is not overdue");
    assert.equal(
      summarizeTriageBacklog([waiting(0), waiting(3), waiting(6)], NOW).overdue,
      0,
      "a queue worked within the week raises nothing",
    );
    const fresh = summarizeTriageBacklog([waiting(0), waiting(3)], NOW);
    assert.equal(fresh.longestWaitSince, null, "with nothing overdue there is no longest wait");
    assert.deepEqual(fresh.bands, [], "and no bands to print");
  }

  // ── 3. "Newly overdue" is exactly one day wide ─────────────────────────────
  // This is the number that answers "what changed today" rather than restating the backlog, so it
  // must not silently become "everything overdue". Production on 2026-08-29 measured it at ZERO
  // against 252 overdue — arrivals here are bursty, and a metric that can only ever be nonzero would
  // not have been able to report that.
  {
    const summary = summarizeTriageBacklog(
      [
        waiting(TRIAGE_BACKLOG_OVERDUE_AFTER_DAYS, { id: "just-crossed" }),
        waiting(TRIAGE_BACKLOG_OVERDUE_AFTER_DAYS + 0.5, { id: "same-day" }),
        waiting(TRIAGE_BACKLOG_OVERDUE_AFTER_DAYS + 1, { id: "yesterday" }),
        waiting(36, { id: "ancient" }),
      ],
      NOW,
    );
    assert.equal(summary.overdue, 4, "all four are overdue");
    assert.equal(summary.newlyOverdue, 2, "only the two inside the crossing day are new information");

    const nothingNew = summarizeTriageBacklog([waiting(20), waiting(36)], NOW);
    assert.equal(nothingNew.overdue, 2);
    assert.equal(nothingNew.newlyOverdue, 0, "a backlog with no crossings today reports zero, not two");
  }

  // ── 4. The bands, on the real production shape ─────────────────────────────
  // 135 / 63 / 3 / 51 were the measured counts. The bands must not overlap and must not drop anyone:
  // a band boundary that double-counts inflates the headline the desk is asked to act on.
  {
    const applicants: UntriagedApplicant[] = [
      ...Array.from({ length: 5 }, (_, i) => waiting(9, { id: `b1-${i}` })),
      ...Array.from({ length: 3 }, (_, i) => waiting(17, { id: `b2-${i}` })),
      ...Array.from({ length: 2 }, (_, i) => waiting(25, { id: `b3-${i}` })),
      ...Array.from({ length: 4 }, (_, i) => waiting(36, { id: `b4-${i}` })),
      ...Array.from({ length: 6 }, (_, i) => waiting(2, { id: `fresh-${i}` })),
    ];
    const summary = summarizeTriageBacklog(applicants, NOW);

    assert.equal(summary.overdue, 14, "the fresh six are not overdue");
    assert.equal(summary.withinThreshold, 6, "and they are reported separately, not dropped");
    assert.equal(
      summary.bands.reduce((total, band) => total + band.count, 0),
      summary.overdue,
      "every overdue candidate lands in exactly one band",
    );
    assert.deepEqual(
      summary.bands,
      [
        { count: 4, label: "30 or more days" },
        { count: 2, label: "21 to 29 days" },
        { count: 3, label: "14 to 20 days" },
        { count: 5, label: "7 to 13 days" },
      ],
      "longest band first",
    );
    assert.equal(summary.longestWaitDays, 36, "the oldest wait is reported in full");
  }

  // ── 5. A band with nobody in it is not printed ─────────────────────────────
  // Production had exactly 3 candidates in the 21-29 band and 51 in the 30+ band. A summary that
  // printed every band as a zero would bury the two that matter under rows saying nothing.
  {
    const summary = summarizeTriageBacklog([waiting(8), waiting(36)], NOW);
    assert.deepEqual(
      summary.bands.map((band) => band.label),
      ["30 or more days", "7 to 13 days"],
      "empty bands are dropped, not printed as zero",
    );
  }

  // ── 6. Unreachable counts only the OVERDUE unreachable ─────────────────────
  // The message offers this number as work the desk can act on now. A candidate who arrived this
  // morning with no phone and no email is not yet anybody's problem, and folding them in would
  // report a number that does not match the list the desk finds on the screen.
  {
    const summary = summarizeTriageBacklog(
      [
        waiting(30, { contactable: false, id: "old-unreachable" }),
        waiting(9, { contactable: false, id: "overdue-unreachable" }),
        waiting(1, { contactable: false, id: "fresh-unreachable" }),
        waiting(30, { contactable: true, id: "old-reachable" }),
      ],
      NOW,
    );
    assert.equal(summary.overdue, 3);
    assert.equal(summary.uncontactableOverdue, 2, "the fresh unreachable one is not counted yet");
  }

  // ── 7. The message says what happened, names nobody, and never truncates ───
  // A summary rather than a list is the settled answer for this module (see `daily-cv-digest.ts`):
  // 252 names is unreadable in Telegram, and cutting the list short would need the ellipsis the
  // owner has ruled out everywhere.
  {
    const summary = summarizeTriageBacklog(
      [
        ...Array.from({ length: 51 }, (_, i) => waiting(36, { id: `old-${i}` })),
        ...Array.from({ length: 3 }, (_, i) => waiting(9, { contactable: false, id: `nc-${i}` })),
        ...Array.from({ length: 2 }, (_, i) => waiting(TRIAGE_BACKLOG_OVERDUE_AFTER_DAYS, { id: `new-${i}` })),
        waiting(1, { id: "fresh" }),
      ],
      NOW,
    );
    const message = buildTriageBacklogMessage(summary);

    assert.ok(message.includes("56 CVs"), "the headline is the overdue count");
    assert.ok(message.includes("more than 7 days"), "and it states the threshold it used");
    assert.ok(message.includes("30 or more days — 51"), "the bands carry their counts");
    assert.ok(message.includes("waited 36 days"), "the longest wait is named in days");
    assert.ok(message.includes("24 July 2026"), "and dated in Cairo, never as a raw UTC instant");
    assert.ok(message.includes("2 CVs crossed 7 days today"), "what changed today is called out");
    assert.ok(message.includes("3 of them have neither"), "and so is the unreachable share");
    assert.ok(message.includes("1 other CV is waiting"), "the rest of the queue is not hidden");
    assert.ok(!message.includes("…"), "no ellipsis");
    assert.ok(!message.includes("..."), "not even a typed-out one");
    assert.ok(!/\b(and|plus) \d+ more\b/i.test(message), "nothing is summarised away as 'and N more'");
  }

  // ── 8. Singulars read like a human wrote them ──────────────────────────────
  {
    const one = buildTriageBacklogMessage(summarizeTriageBacklog([waiting(10)], NOW));
    assert.ok(one.includes("1 CV has been waiting"), "one CV, not 1 CVs");
    assert.ok(!one.includes("CV(s)"), "never the parenthesised plural");
    assert.ok(!one.includes("0 CVs"), "never a zero headline");
    assert.doesNotMatch(one, /— 0$/m, "and never a band printed as zero");
  }

  // ── 9. NEVER EMAIL ─────────────────────────────────────────────────────────
  // Asserted out loud rather than left to the notification policy table. This job runs every day,
  // so email here would be a subscription nobody asked for — and the owner's standing rule is that
  // bulk email is never fired from this system.
  {
    assert.deepEqual(
      [...TRIAGE_BACKLOG_CHANNELS],
      ["in_app", "telegram", "push"],
      "in-app, Telegram and push only",
    );
    assert.ok(!TRIAGE_BACKLOG_CHANNELS.includes("email" as never), "email is not a channel here");

    const source = withoutComments(read(MODULE));
    assert.doesNotMatch(source, /"email"/, "and no email channel is named anywhere in the module");
    assert.equal(
      TRIAGE_BACKLOG_ACTION_URL,
      "/recruitment?status=new",
      "the desk lands on the workspace filtered to the very queue this counts",
    );
  }

  // ── 10. The loader must PAGE, and the run must stay silent at zero ─────────
  // Two properties no pure test can reach, both of which fail silently in production.
  //
  // An unbounded PostgREST select stops at 1000 rows with no error and no marker. This alarm exists
  // to report a queue depth, so that ceiling would under-report the exact number it is for — and
  // only once the backlog passed 1000, which is precisely when it matters most.
  //
  // And an alarm that fires on the goal state is one nobody reads by the second week, so the
  // zero-overdue early return has to come BEFORE the module resolves any recipient.
  {
    const source = withoutComments(read(MODULE));

    assert.match(source, /\.range\(page \* PAGE_SIZE/, "the untriaged queue is read in pages");
    assert.match(source, /\.order\("created_at"/, "with a stable sort, or pages repeat and skip rows");
    assert.ok(PAGE_SIZE_IN(source) < 1000, "and a page smaller than the 1000-row ceiling");

    const runBody = source.slice(source.indexOf("export async function runTriageBacklogCheck"));
    const guardAt = runBody.indexOf("summary.overdue === 0");
    const recipientsAt = runBody.indexOf("recruitmentDeskHrIds()");
    assert.ok(guardAt > 0, "the run returns early when nothing is overdue");
    assert.ok(
      guardAt < recipientsAt,
      "and it returns BEFORE resolving recipients — an alarm that also fires on success is one nobody reads",
    );
  }
}

/** The declared page size, read out of the source so the assertion cannot drift from the constant. */
function PAGE_SIZE_IN(source: string): number {
  const match = source.match(/const PAGE_SIZE = (\d+);/);
  assert.ok(match, "PAGE_SIZE is declared as a literal");
  return Number(match[1]);
}
