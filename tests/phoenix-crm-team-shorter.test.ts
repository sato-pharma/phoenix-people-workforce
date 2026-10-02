import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import { teamWaitingLine, teamWeeksToShow } from "../src/lib/phoenix-crm/team-waiting.ts";

/**
 * Phoenix CRM — the Team tab a district manager actually reads (owner, 2026-10-02: *"the page is
 * many long, is very long also … make the DM page more smarter"*).
 *
 * Measured on the live preview as the district manager at 375px before the change: **3,335px, 4.1
 * phone screens, for 2,320 characters of text**. "Nothing waiting" appeared TEN times, her own name
 * five, and "the rep has not started this week's plan" five more beside five NOT STARTED pills.
 *
 * What this pins is the rule, not the pixels: a figure that is zero says nothing at all, a name the
 * reader already owns is not printed back at him, and a nine-week strip shows the weeks with
 * something in them. The one place a zero still speaks is the headline, which has to be able to say
 * "nothing is waiting for you" — once.
 */

const ROOT = new URL("../", import.meta.url);

function source(path: string): string {
  return stripComments(readFileSync(new URL(path, ROOT), "utf8"));
}

const CONTEXT = { territories: 5, vacant: 0, ready: 4, notReady: 1, elsewhere: 0, test: false };
const QUIET = { plans: 0, months: null, planEdits: 0, unplanned: 0, requests: 0 };

export function runPhoenixCrmTeamShorterTests(): void {
  // ── 1. The headline NAMES what waits ───────────────────────────────────────────────────────────
  {
    const one = teamWaitingLine({ ...QUIET, plans: 3 }, CONTEXT);
    assert.equal(one.title, "3 weekly plans are waiting for you");
    assert.equal(one.tone, "warn");
    assert.equal(one.detail, "5 territories · 4 of 5 lists ready");

    // One thing, singular on both halves.
    assert.equal(teamWaitingLine({ ...QUIET, requests: 1 }, CONTEXT).title, "1 list request is waiting for you");

    // Several kinds read as a sentence, in the order he works them, and the verb follows the TOTAL.
    assert.equal(
      teamWaitingLine({ plans: 3, months: 1, planEdits: 0, unplanned: 1, requests: 2 }, CONTEXT).title,
      "3 weekly plans, 1 monthly plan, 1 off-plan visit and 2 list requests are waiting for you",
    );
  }

  // ── 2. Nothing waiting is said ONCE, and the standing facts ride with it ───────────────────────
  {
    const quiet = teamWaitingLine(QUIET, CONTEXT);
    assert.equal(quiet.title, "Nothing is waiting for you");
    assert.equal(quiet.tone, "good");
    assert.equal(quiet.detail, "5 territories · 4 of 5 lists ready");

    // A vacant seat and work at someone ELSE'S step are context, never a call to act.
    assert.equal(
      teamWaitingLine(QUIET, { ...CONTEXT, vacant: 1, elsewhere: 2 }).detail,
      "5 territories, 1 without a rep · 4 of 5 lists ready · 2 waiting at another step",
    );
    // Test mode carries no readiness at all, so it never claims "0 of 0 lists ready".
    assert.equal(teamWaitingLine(QUIET, { ...CONTEXT, ready: 0, notReady: 0, test: true }).detail, "5 territories");
    assert.equal(teamWaitingLine(QUIET, { ...CONTEXT, territories: 1 }).detail, "1 territory · 4 of 5 lists ready");
  }

  // ── 3. A count still loading is NOT a zero ─────────────────────────────────────────────────────
  {
    // Null means "not read yet". It is left out of the sentence rather than told to him as nothing,
    // so a slow week never reads as an empty one — and a month nobody has ever sent stays unmentioned.
    assert.equal(teamWaitingLine({ ...QUIET, plans: null }, CONTEXT).title, "Nothing is waiting for you");
    assert.equal(teamWaitingLine({ ...QUIET, plans: null, requests: 2 }, CONTEXT).title, "2 list requests are waiting for you");
  }

  // ── 4. The week strip shows the weeks with something in them ───────────────────────────────────
  {
    const weeks = [
      { weekStart: "2026-10-03", waiting: 0 },
      { weekStart: "2026-10-10", waiting: 2 },
      { weekStart: "2026-10-17", waiting: 0 },
      { weekStart: "2026-10-24", waiting: 0 },
      { weekStart: "2026-10-31", waiting: 0 },
    ];
    const shown = teamWeeksToShow(weeks, { selectedWeek: "2026-10-03", thisWeek: "2026-10-03", showAll: false });
    assert.deepEqual(
      shown.map((week) => week.weekStart),
      ["2026-10-03", "2026-10-10"],
      "this week, and the week with two plans waiting",
    );

    // The week he is LOOKING at never disappears under him, however quiet it is.
    assert.ok(
      teamWeeksToShow(weeks, { selectedWeek: "2026-10-31", thisWeek: "2026-10-03", showAll: false })
        .map((week) => week.weekStart)
        .includes("2026-10-31"),
    );

    // "Every week" gives the whole strip back, because planning a month ahead has to be reachable.
    assert.equal(teamWeeksToShow(weeks, { selectedWeek: "2026-10-03", thisWeek: "2026-10-03", showAll: true }).length, 5);

    // Still loading, and a week list that matches nothing: never hand back an empty strip.
    const unread = weeks.map((week) => ({ weekStart: week.weekStart, waiting: null }));
    assert.equal(teamWeeksToShow(unread, { selectedWeek: "2026-11-07", thisWeek: "2026-11-07", showAll: false }).length, 5);
  }

  // ── 5. On the screen: no tile grid, no zero that speaks, no name he already owns ───────────────
  {
    const tab = source("src/components/phoenix-crm/team-tab.tsx");

    // The six tiles repeated the switcher's own notes one block below them. One sentence replaced them.
    assert.doesNotMatch(tab, /CrmStatGrid|<CrmStat\b/, "the Team tab draws no tile grid above the switcher");
    assert.match(tab, /<CrmNote title=\{waiting\.title\} tone=\{waiting\.tone\}>/, "the headline is the one sentence");
    assert.match(tab, /teamWaitingLine\(/, "and it is the pure rule that writes it, not the component");

    // Not one note anywhere says a count is zero.
    assert.doesNotMatch(tab, /Nothing waiting/, "no note on this page says nothing is waiting");
    assert.doesNotMatch(tab, /has not started this week's plan/, "the NOT STARTED pill says that already");
    assert.doesNotMatch(tab, /Nothing to look at yet/, "and so does the row with no plan on it");

    // The reviewer is named only when it is somebody else.
    assert.match(tab, /function reviewerText\(territory: TerritorySummary, viewerHrId: string \| null\): string \| null/);
    assert.match(tab, /if \(viewerHrId && territory\.reviewerHrId === viewerHrId\) return null;/, "a manager is not told he reviews his own team");
    assert.doesNotMatch(tab, /reviewerText\(row\.territory\)/, "every call site passes the viewer");

    // The strip reads the pure rule, and the way back to every week is on the screen.
    assert.match(tab, /teamWeeksToShow\(weeks, \{ selectedWeek, thisWeek, showAll: showAllWeeks \}\)/);
    assert.match(tab, /Every week · \$\{countText\(weeks\.length\)\}/, "and the full strip is one press away");
  }

  // ── 6. The viewer's own id reaches the screen from the server ──────────────────────────────────
  {
    const team = source("src/lib/phoenix-crm/server/team.ts");
    assert.match(team, /viewerHrId: string;/, "the Team view carries who is reading it");
    assert.match(team, /viewerHrId: viewer\.hrId,/, "from the viewer, never from a row");
  }

  console.log("phoenix-crm team page shorter: OK");
}
