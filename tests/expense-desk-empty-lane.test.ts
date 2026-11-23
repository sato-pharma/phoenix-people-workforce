/**
 * Expense Approvals — A FILTERED LANE THAT IS EMPTY SAYS WHERE THE CLAIMS WENT, pinned.
 *
 * Owner, 2026-11-23, about 22:10 Cairo, October picked with Meeting: "Entering on October and I can
 * see nothing. The tab are empty. No meetings. What the fuck? Of course, there's something wrong."
 * Read on production that minute: no claim with an October trip date was still waiting — all 116
 * were decided (8 meetings, 3 other, 105 traveling) and lived in History. The filter was right; the
 * page was not: the tabs still said "Ready (15) · Your call (51)" over two empty lists, History
 * carried no figure, and the lane said only "Nothing matches".
 *
 *   1. A tab counts what pressing it will show: each waiting lane is counted under the filters.
 *   2. With filters History also reads (kind, trip dates, search) and nothing waiting matching, the
 *      page opens on History. Without filters it opens as before: Ready, else Your call.
 *   3. An empty filtered lane names what was asked for and how many decided claims match, and offers
 *      one press to open them; a count not read is never shown as a zero.
 *   4. The decided count is History's own query asked for its count alone — the same filters, so
 *      the two can never disagree — and the page shows it on the History tab.
 */
import assert from "node:assert/strict";
import fs from "node:fs";

import { DEFAULT_DESK_VIEW, emptyLaneWords, filterWords, filteredLaneCounts, narrowsHistory, openingLane } from "@/lib/outstation/approvals/desk-view";
import type { DeskClaim } from "@/lib/outstation/approvals/types";

function claim(requestId: number, over: Partial<DeskClaim> = {}): DeskClaim {
  return {
    allowance: 200,
    approvedAmount: null,
    daysWaiting: 2,
    decidedAt: null,
    employeeName: `Employee ${requestId}`,
    employeeNote: null,
    employeeRole: "District Manager",
    from: "Cairo",
    holdReason: null,
    hrComment: "",
    hrId: null,
    kind: "traveling",
    locked: false,
    payable: 500,
    payoutMonth: 11,
    payoutYear: 2026,
    preCut: null,
    relatedRequestIds: [],
    requestId,
    revision: `rev-${requestId}`,
    standing: "waiting",
    submittedAt: "2026-11-20T08:00:00.000Z",
    systemNote: null,
    to: "Asyut",
    total: 500,
    transportation: "car",
    tripEnd: "2026-11-19",
    tripId: `OUTSTATION-${requestId}`,
    tripStart: "2026-11-19",
    tripType: "traveling",
    verdict: { checks: [], idleDates: [], lane: "ready", reason: null },
    ...over,
  } as DeskClaim;
}

const code = (file: string) => fs.readFileSync(file, "utf8");
const screen = (file: string) => code(`src/components/outstation/approvals-desk/${file}`);

export function runExpenseDeskEmptyLaneTests() {
  // November's waiting claims, as on 23 Nov 2026: one Ready trip, two unclear, one of them a meeting.
  const waiting = [
    claim(1),
    claim(2, { verdict: { checks: [], idleDates: [], lane: "your_call", reason: "Unclear" } }),
    claim(3, { kind: "meeting", verdict: { checks: [], idleDates: [], lane: "your_call", reason: "Unclear" } }),
  ];
  const october = { ...DEFAULT_DESK_VIEW, from: "2026-10-01", kind: "meeting" as const, to: "2026-10-31" };

  // ── 1. A tab counts what pressing it will show ────────────────────────────────────────────────
  assert.deepEqual(filteredLaneCounts(waiting, DEFAULT_DESK_VIEW), { ready: 1, your_call: 2 });
  assert.deepEqual(filteredLaneCounts(waiting, { ...DEFAULT_DESK_VIEW, kind: "meeting" }), { ready: 0, your_call: 1 });
  assert.deepEqual(filteredLaneCounts(waiting, october), { ready: 0, your_call: 0 }, "HEADLINE: October picked, the tabs read 0 and 0 — not the 15 and 51 that waited in November");

  // ── 2. Where the page opens ───────────────────────────────────────────────────────────────────
  assert.equal(openingLane(october, waiting), "history", "HEADLINE: with nothing waiting in October, the page opens on History, where the October claims are");
  assert.equal(openingLane({ ...DEFAULT_DESK_VIEW, kind: "meeting" }, waiting), "your_call", "a filter matching a waiting claim opens its lane");
  assert.equal(openingLane(DEFAULT_DESK_VIEW, waiting), "ready", "no filter: Ready while it holds a claim, as before");
  assert.equal(openingLane(DEFAULT_DESK_VIEW, []), "your_call", "no filter and nothing waiting: Your call, as before — never History unasked");
  assert.equal(openingLane({ ...DEFAULT_DESK_VIEW, overSevenDays: true }, waiting), "your_call", "'over 7 days' is about waiting, so alone it sends nobody to History");
  assert.equal(openingLane(october, null), "your_call", "before the claims are read, nothing is decided from them");
  assert.equal(openingLane({ ...october, lane: "ready" }, waiting), "ready", "a lane he chose is kept");
  assert.equal(narrowsHistory(DEFAULT_DESK_VIEW), false);
  assert.equal(narrowsHistory({ ...DEFAULT_DESK_VIEW, search: " wesam " }), true);

  // ── 3. What an empty filtered lane says ───────────────────────────────────────────────────────
  assert.equal(filterWords(october), "Meeting claims with a trip day in October 2026");
  assert.equal(filterWords({ ...DEFAULT_DESK_VIEW, from: "2026-11-12", to: "2026-11-12" }), "claims on 12 Nov 2026");
  assert.equal(filterWords({ ...DEFAULT_DESK_VIEW, from: "2026-11-01", to: "2026-11-05" }), "claims with a trip day from 1 Nov 2026 to 5 Nov 2026");
  assert.equal(filterWords({ ...DEFAULT_DESK_VIEW, from: "2026-11-01" }), "claims with a trip day from 1 Nov 2026 onward");
  assert.equal(filterWords({ ...DEFAULT_DESK_VIEW, to: "2026-11-05" }), "claims with a trip day up to 5 Nov 2026");
  assert.equal(filterWords({ ...DEFAULT_DESK_VIEW, kind: "other", search: "Wesam" }), "Other claims for “Wesam”");

  const eight = emptyLaneWords(october, 8);
  assert.equal(eight.history, true, "HEADLINE: decided claims match, so the lane offers to open them");
  assert.equal(eight.title, "8 in History");
  assert.equal(eight.message, "No waiting Meeting claims with a trip day in October 2026 are in this lane. The 8 already decided are in History.", "HEADLINE: the lane says what was asked and where the claims went");
  assert.match(emptyLaneWords(october, 1).message, /The 1 already decided is in History\.$/);
  const none = emptyLaneWords(october, 0);
  assert.equal(none.history, false);
  assert.equal(none.message, "No Meeting claims with a trip day in October 2026, waiting or decided. Clear the filters to see every waiting claim.");
  const unread = emptyLaneWords(october, null);
  assert.equal(unread.history, false, "a count not read offers nothing");
  assert.equal(unread.title, "Nothing matches", "and is never said as a zero");
  assert.equal(emptyLaneWords({ ...DEFAULT_DESK_VIEW, overSevenDays: true }, 5).history, false, "'over 7 days' alone is not a History question");

  // ── 4. The count is History's own query, and the page draws it ────────────────────────────────
  const history = code("src/lib/outstation/approvals/history.ts");
  assert.ok(history.includes('.select(DESK_CLAIM_COLUMNS, { count: "exact", head: options.countOnly === true })'), "HEADLINE: the count is the same query as the list, asked for its count alone");
  const countReturn = history.indexOf("if (options.countOnly === true) return { claims: [], nextOffset: null, total: count ?? 0 };");
  assert.ok(countReturn > history.indexOf('if (period.to) query = query.lt("trip_start_date", dayAfter(period.to));') && countReturn > history.indexOf("if (searchFilter) query = query.or(searchFilter);"), "it answers only after every filter and the access scope were applied");
  assert.ok(code("app/api/admin/outstation/approvals/history/route.ts").includes('countOnly: url.searchParams.get("count") === "1",'));

  const hook = screen("use-decided-count.ts");
  assert.ok(hook.includes('const params = new URLSearchParams({ count: "1", filter: "all" });'), "the hook asks for every decided claim, approved and rejected");
  assert.ok(hook.includes("const key = enabled ? `${url}|${version}` : null;"), "and asks nothing while no History filter is set");
  assert.ok(hook.includes("setRead({ key, total: null })"), "a failed read is unread, never zero");

  const workspace = screen("desk-workspace.tsx");
  assert.ok(workspace.includes("const shown = queue && narrowed ? filteredLaneCounts(queue.claims, view) : null;"), "HEADLINE: the tabs count the filtered lanes");
  assert.ok(workspace.includes("counts={{ history: decided, ready: shown?.ready ?? lanes?.ready.count ?? 0, your_call: shown?.your_call ?? lanes?.your_call.count ?? 0 }}"));
  assert.ok(workspace.includes("data-history-count={counts.history}"), "History carries its count on its tab");
  assert.ok(workspace.includes('onShowHistory={() => desk.setView({ history: "all", lane: "history" })}'), "the lane's press opens History, filters kept");
  assert.ok(code("src/components/outstation/approvals-desk/use-desk.ts").includes("openingLane(view, queue?.claims ?? null)"), "the opening lane waits for the claims");

  const row = screen("desk-row.tsx");
  assert.ok(row.includes("<NarrowedEmpty decided={decided} onShowHistory={onShowHistory} view={view} />"), "HEADLINE: a filtered empty lane draws the words and the press");
  assert.ok(row.includes("Show them in History"));
}
