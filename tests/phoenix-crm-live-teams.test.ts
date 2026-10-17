import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { liveTeamSeatIds, seatIdIsInLiveTeam, seatIsInLiveTeam } from "../src/lib/phoenix-crm/live-team-rules.ts";

/**
 * Phoenix CRM — only a LIVE team is told anything (owner, 2026-10-08: "bump notifications to people who
 * didn't go live yet. The only ones who go live are Cairo and Giza, and Delta One").
 *
 *   1. a team is live from the day the Super Admin starts it — not from the Saturday it is counted from —
 *      until a stop takes effect;
 *   2. a territory is in a live team when its district-manager seat is;
 *   3. the notifier, the reminder, the nudge, the digest, the roll-up and the badges all ask, and an
 *      unreadable gate fails OPEN.
 */

const read = (path: string) => readFileSync(path, "utf8");

export function runPhoenixCrmLiveTeamTests() {
  {
    const live = liveTeamSeatIds(
      [
        { teamSeatId: "DM-CAIRO", stopsOn: null },
        { teamSeatId: "DM-GIZA", stopsOn: "2026-10-31" },
        { teamSeatId: "DM-OLD", stopsOn: "2026-09-26" },
      ],
      "2026-10-08",
    );
    assert.deepEqual([...live].sort(), ["DM-CAIRO", "DM-GIZA"], "a running team and one whose stop is still ahead are live; a stopped one is not");
    assert.equal(liveTeamSeatIds([], "2026-10-08").size, 0, "no start, no live team");
    assert.equal(liveTeamSeatIds([{ teamSeatId: "DM-X", stopsOn: "2026-10-08" }], "2026-10-08").size, 0, "a stop that has taken effect today is over");
  }

  {
    const live = new Set(["DM-CAIRO"]);
    assert.equal(seatIsInLiveTeam({ seatId: "T-1", parentSeatId: "DM-CAIRO" }, live), true, "a territory under a live team");
    assert.equal(seatIsInLiveTeam({ seatId: "T-2", parentSeatId: "DM-ALEX" }, live), false, "a territory under a team that has not started");
    assert.equal(seatIsInLiveTeam({ seatId: "DM-CAIRO", parentSeatId: null }, live), true, "the team seat itself");
    assert.equal(seatIsInLiveTeam({ seatId: "T-3", parentSeatId: null }, live), false, "a seat nobody can place is not live");
    assert.equal(seatIsInLiveTeam(null, live), false);
    const seats = new Map([["T-1", { seatId: "T-1", parentSeatId: "DM-CAIRO" }]]);
    assert.equal(seatIdIsInLiveTeam(seats, "T-1", live), true);
    assert.equal(seatIdIsInLiveTeam(seats, "T-9", live), false, "an unknown seat is not live");
    assert.equal(seatIdIsInLiveTeam(seats, null, live), false);
  }

  {
    const loader = read("src/lib/phoenix-crm/server/live-teams.ts");
    assert.match(loader, /phoenix_crm_team_starts/, "the starts are the Super Admin's Start control");
    assert.match(loader, /return null;/, "an unreadable gate answers null, never an empty set");
    assert.match(loader, /logError\(/, "and says so");

    const notifier = read("src/lib/phoenix-crm/server/notifications.ts");
    assert.match(notifier, /if \(!isTest\) \{\s*const live = await loadLiveTeamSeatIds\(\);\s*if \(live && !\(await noticeIsForALiveTeam\(notice, live\)\)\) return;/, "a notice about a team that has not started tells nobody; the test world keeps its copies; null fails open");
    // The manager's weekly plan widened to the regional, national and product managers (owner, 2026-10-17):
    // a regional or national manager's week is live when ANY team below his seat is, a product manager's
    // (no seat) always is — every other notice still asks the seat's own team.
    assert.match(notifier, /if \(notice\.kind !== "manager_plan"\) return seatIsInLiveTeam\(notice\.seat, live\);/, "every other notice asks the seat's own team, as before");
    assert.match(notifier, /if \(seat\.tier !== "RSM" && seat\.tier !== "NSM"\) return seatIsInLiveTeam\(seat, live\);/, "a district manager's week asks his own team");
    assert.match(notifier, /return \[\.\.\.live\]\.some\(\(liveSeatId\) => liveSeatId !== seat\.seatId && \(org\.seats\.get\(liveSeatId\)\?\.path\.includes\(seat\.seatId\) \?\? false\)\);/, "a regional or national manager's week asks for any live team below his seat");

    for (const [path, pattern, what] of [
      ["src/lib/phoenix-crm/server/plan-reminder.ts", /loadLiveTeamSeatIds\(cairoToday\)[\s\S]*seatIsInLiveTeam\(seat, live\)/, "the plan reminder"],
      ["src/lib/phoenix-crm/server/approval-nudge.ts", /seatIdIsInLiveTeam\(org\.seats, item\.seatId, live\)/, "the approval nudge"],
      ["src/lib/phoenix-crm/server/daily-digest.ts", /started\.has\(seat\.seatId\) && \(!live \|\| seatIsInLiveTeam\(seat, live\)\)/, "the morning digest"],
      ["src/lib/phoenix-crm/server/visit-rollup.ts", /seatIdIsInLiveTeam\(org\.seats, row\.seat_id, live\)/, "the visit roll-up"],
      ["src/lib/phoenix-crm/server/unread-notices.ts", /seatIdIsInLiveTeam\(org\.seats, row\.seatId, live\)/, "the pulsing badges"],
    ] as const) {
      assert.match(read(path), pattern, `${what} asks whether the team is live`);
    }
  }
}
