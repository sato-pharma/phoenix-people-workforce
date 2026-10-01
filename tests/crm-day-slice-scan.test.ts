import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { addDaysIso } from "../src/lib/crm/dates.ts";
import {
  checkinFilterNamesPeople,
  compareCheckinScanOrder,
  compareUuidText,
  dayScanSlices,
  readCompanyWindow,
  visitFilterNamesPeople,
} from "../src/lib/crm/reads.ts";

// Production cancelled CRM reads at the 8-second statement timeout on 14, 16 and 17 Sep 2026 (Cairo).
// A company-wide visit or check-in window was keyset-paged `ORDER BY id LIMIT 1000`, and the unified
// views' cutover clause drops the planner's estimate for any date window to its 0.5% default, so
// every page re-read and re-sorted the WHOLE window: the Business Review's July–August visit read
// did that 37 times over 36,167 rows. The read door now probes the window with one unordered page and,
// when the probe comes back full, reads one calendar day per request.
//
// Every CRM figure must stay identical, so this suite pins the pieces that decide WHICH rows come back
// and in WHAT order: the day list, which filters keep the single scan, the two client-side orders,
// and the probe-then-days merge, run against an in-memory table. The door itself is DB-backed and
// getSupabaseAdmin() memoizes its client for the whole test process (see the note in ci.yml), so the
// wiring inside the three scans gets a source-shape guard, the convention
// tests/crm-checkin-page-boundary.test.ts already uses for the same loops. The end-to-end proof —
// old door and new door, every row compared on staging — is in the PR that introduced this.

/** The text of a top-level function, from its declaration to the first column-0 closing brace. */
function functionBody(source: string, declaration: string): string {
  const start = source.indexOf(declaration);
  assert.ok(start >= 0, `${declaration} must still exist`);
  const rest = source.slice(start);
  const end = rest.indexOf("\n}\n");
  return rest.slice(0, end > 0 ? end : rest.length);
}

/** Small deterministic PRNG, so a failure reproduces. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomUuid(random: () => number): string {
  const hex = Array.from({ length: 32 }, () => Math.floor(random() * 16).toString(16)).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Postgres's JSON form of a UTC timestamptz: fraction digits only when non-zero, trailing zeros trimmed. */
function postgresTimestamp(epochSeconds: number, microseconds: number): string {
  const whole = new Date(epochSeconds * 1000).toISOString().slice(0, 19);
  const fraction = microseconds === 0 ? "" : `.${String(microseconds).padStart(6, "0").replace(/0+$/, "")}`;
  return `${whole}${fraction}+00:00`;
}

async function runDayScanSlicesTests() {
  assert.deepEqual(dayScanSlices("2026-08-01", "2026-08-03"), ["2026-08-01", "2026-08-02", "2026-08-03"]);
  assert.deepEqual(
    dayScanSlices("2026-12-30", "2027-01-02"),
    ["2026-12-30", "2026-12-31", "2027-01-01", "2027-01-02"],
    "a window crossing a year end keeps every day",
  );
  assert.deepEqual(dayScanSlices("2028-02-28", "2028-03-01"), ["2028-02-28", "2028-02-29", "2028-03-01"], "leap day included");

  const july = dayScanSlices("2026-07-01", "2026-08-31");
  assert.ok(july, "a two-month window is sliced");
  assert.equal(july.length, 62);
  assert.equal(july[0], "2026-07-01", "the first slice is the window's first day");
  assert.equal(july[july.length - 1], "2026-08-31", "the last slice is the window's last day");
  for (let index = 1; index < july.length; index += 1) {
    assert.equal(july[index], addDaysIso(july[index - 1], 1), "slices are consecutive days with no gap and no repeat");
  }

  // Anything else keeps the single scan — never a guess at what the caller meant.
  assert.equal(dayScanSlices("2026-08-01", "2026-08-01"), null, "a one-day window is already one day");
  assert.equal(dayScanSlices("2026-08-03", "2026-08-01"), null, "an inverted window keeps the single scan");
  assert.equal(dayScanSlices(undefined, "2026-08-01"), null, "an open lower bound keeps the single scan");
  assert.equal(dayScanSlices("2026-08-01", undefined), null, "an open upper bound keeps the single scan");
  assert.equal(dayScanSlices("2026-02-30", "2026-03-05"), null, "an impossible day is not rolled into March");
  assert.equal(dayScanSlices("2026-12-01", "2026-13-01"), null, "month 13 returns null instead of throwing");
  assert.equal(dayScanSlices("2026-8-1", "2026-08-05"), null, "a non-padded date keeps the single scan");
  assert.equal(dayScanSlices("2026-08-01T00:00:00", "2026-08-05"), null, "a timestamp is not a day");

  const longest = addDaysIso("2026-01-01", 399);
  assert.equal(dayScanSlices("2026-01-01", longest)?.length, 400, "400 days is the longest sliced window");
  assert.equal(dayScanSlices("2026-01-01", addDaysIso(longest, 1)), null, "401 days keeps the single scan");
}

function runNamesPeopleTests() {
  const window = { dateFrom: "2026-08-01", dateTo: "2026-08-31" };
  assert.equal(visitFilterNamesPeople(window), false);
  assert.equal(
    visitFilterNamesPeople({ ...window, visitTypes: [-4], doubleOnly: true, requireAgentHrId: true, requireDoubleHrId: true, requireDoubleCrmId: true }),
    false,
    "a type or flag filter names nobody — the annual-leave and double-visit reads are still company-wide",
  );
  assert.equal(
    visitFilterNamesPeople({ ...window, visitDates: ["2026-08-02", "2026-08-09"] }),
    false,
    "a day list names nobody — the read stays a company window, probed and then read over the listed days",
  );
  for (const [label, filter] of [
    ["agentCrmIds", { agentCrmIds: [101] }],
    ["agentHrIds", { agentHrIds: ["B-1"] }],
    ["agentHrIdILike", { agentHrIdILike: "b-1" }],
    ["doubleHrIds", { doubleHrIds: ["B-1"] }],
    ["contactCrmIds", { contactCrmIds: [5] }],
    ["participantCrmIds", { participantCrmIds: [101] }],
    ["participantHrIds", { participantHrIds: ["B-1"] }],
  ] as const) {
    assert.equal(visitFilterNamesPeople({ ...window, ...filter }), true, `a visit read by ${label} keeps its single indexed scan`);
  }

  assert.equal(checkinFilterNamesPeople(window), false);
  assert.equal(checkinFilterNamesPeople({ ...window, requireContactCrmId: true }), false);
  for (const [label, filter] of [
    ["agentCrmIds", { agentCrmIds: [101] }],
    ["agentHrIds", { agentHrIds: ["B-1"] }],
    ["agentHrIdILike", { agentHrIdILike: "b-1" }],
    ["agentCrmOrHrIds", { agentCrmOrHrIds: { hrIds: ["B-1"] } }],
    ["bounds", { bounds: { maxLatitude: 31, maxLongitude: 32, minLatitude: 30, minLongitude: 31 } }],
  ] as const) {
    assert.equal(checkinFilterNamesPeople({ ...window, ...filter }), true, `a check-in read by ${label} keeps its single scan`);
  }
}

function runOrderTests() {
  // compareUuidText must be Postgres's uuid order: the 128-bit value, most significant byte first.
  const random = prng(20260917);
  const ids = [
    "00000000-0000-0000-0000-000000000000",
    "ffffffff-ffff-ffff-ffff-ffffffffffff",
    "9fffffff-ffff-ffff-ffff-ffffffffffff",
    "a0000000-0000-0000-0000-000000000000",
    "0fffffff-ffff-ffff-ffff-ffffffffffff",
    "10000000-0000-0000-0000-000000000000",
    ...Array.from({ length: 500 }, () => randomUuid(random)),
  ];
  const byValue = [...ids].sort((a, b) => {
    const left = BigInt(`0x${a.replace(/-/g, "")}`);
    const right = BigInt(`0x${b.replace(/-/g, "")}`);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  assert.deepEqual([...ids].sort(compareUuidText), byValue, "text order of a lowercase uuid is its byte order");

  const row = (check_date: string, id: string) => ({ check_date, id });
  const a = "00000000-0000-0000-0000-000000000001";
  const b = "00000000-0000-0000-0000-000000000002";
  assert.ok(compareCheckinScanOrder(row("2026-08-12T09:00:00+00:00", b), row("2026-08-12T09:00:00.5+00:00", a)) < 0, "a whole second sorts before a fraction of it");
  assert.ok(compareCheckinScanOrder(row("2026-08-12T09:00:00.25+00:00", b), row("2026-08-12T09:00:00.5+00:00", a)) < 0, ".25 before .5");
  assert.ok(compareCheckinScanOrder(row("2026-08-12T09:00:00.999999+00:00", b), row("2026-08-12T09:00:01+00:00", a)) < 0, "a fraction before the next second");
  assert.ok(compareCheckinScanOrder(row("2026-08-12T09:00:00+00:00", a), row("2026-08-12T09:00:00+00:00", b)) < 0, "a shared timestamp falls back to id");
  assert.equal(compareCheckinScanOrder(row("2026-08-12T09:00:00+00:00", a), row("2026-08-12T09:00:00+00:00", a)), 0);

  // Property: over timestamps shaped exactly as Postgres prints them, text order is time order, then id.
  const base = Date.UTC(2026, 7, 1) / 1000;
  const stamped = Array.from({ length: 2000 }, () => {
    const seconds = base + Math.floor(random() * 3 * 86400);
    // Mostly whole seconds, as the vendor sends them; some fractions, some sharing one instant.
    const roll = random();
    const micro = roll < 0.6 ? 0 : roll < 0.8 ? Math.floor(random() * 1000) * 1000 : Math.floor(random() * 1_000_000);
    return { check_date: postgresTimestamp(seconds, micro), id: randomUuid(random), instant: BigInt(seconds) * BigInt(1_000_000) + BigInt(micro) };
  });
  const expected = [...stamped].sort((left, right) =>
    left.instant !== right.instant ? (left.instant < right.instant ? -1 : 1) : compareUuidText(left.id, right.id),
  );
  assert.deepEqual([...stamped].sort(compareCheckinScanOrder), expected, "check-in text order is Postgres's (check_date, id) order");
}

/** An in-memory table behind the two request shapes readCompanyWindow issues. */
function fakeWindow<Row extends { day: string }>(rows: Row[], pageSize: number, scanOrder: (a: Row, b: Row) => number) {
  const calls = { probe: 0, days: [] as string[] };
  return {
    calls,
    // Unordered LIMIT: whatever order the table is stored in, reversed to make sure nobody relies on it.
    probe: async () => {
      calls.probe += 1;
      return [...rows].reverse().slice(0, pageSize);
    },
    // A day's keyset scan: every row of that day, in scan order.
    scanDay: async (day: string) => {
      calls.days.push(day);
      return rows.filter((row) => row.day === day).sort(scanOrder);
    },
  };
}

async function runReadCompanyWindowTests() {
  const random = prng(917);
  const days: string[] = dayScanSlices("2026-08-01", "2026-08-10") ?? assert.fail("ten days slice");
  const pageSize = 25;

  // ── Visits: id order crosses days, so the joined days are re-sorted ───────────────────────────
  type Visit = { day: string; id: string };
  const visitOrder = (a: Visit, b: Visit) => compareUuidText(a.id, b.id);
  for (const [label, count] of [
    ["an empty window", 0],
    ["a sparse window (short probe)", pageSize - 1],
    ["exactly one page", pageSize],
    ["a dense window", 400],
  ] as const) {
    const table: Visit[] = Array.from({ length: count }, () => ({ day: days[Math.floor(random() * days.length)], id: randomUuid(random) }));
    const fake = fakeWindow(table, pageSize, visitOrder);
    const rows = await readCompanyWindow<Visit>({ days, pageSize, probe: fake.probe, scanDay: fake.scanDay, order: visitOrder, sortDays: true });
    assert.deepEqual(rows, [...table].sort(visitOrder), `${label}: the rows and order the single id scan returned`);
    assert.equal(fake.calls.probe, 1, `${label}: one probe`);
    if (count < pageSize) {
      assert.deepEqual(fake.calls.days, [], `${label}: a short probe already holds every row — no day requests`);
    } else {
      assert.deepEqual([...fake.calls.days].sort(), days, `${label}: a full probe reads each day exactly once`);
    }
  }

  // ── Check-ins: days end to end ARE (check_date, id) order, so they are joined without a re-sort ─
  type Checkin = { day: string; id: string; check_date: string };
  const base = Date.UTC(2026, 7, 1) / 1000;
  const checkins: Checkin[] = Array.from({ length: 300 }, () => {
    const seconds = base + Math.floor(random() * days.length * 86400);
    const micro = random() < 0.7 ? 0 : Math.floor(random() * 1_000_000);
    const check_date = postgresTimestamp(seconds, micro);
    return { check_date, day: check_date.slice(0, 10), id: randomUuid(random) };
  });
  const dense = fakeWindow(checkins, pageSize, compareCheckinScanOrder);
  assert.deepEqual(
    await readCompanyWindow<Checkin>({ days, pageSize, probe: dense.probe, scanDay: dense.scanDay, order: compareCheckinScanOrder, sortDays: false }),
    [...checkins].sort(compareCheckinScanOrder),
    "dense check-ins: the rows and order the single (check_date, id) scan returned",
  );
  const few = checkins.slice(0, pageSize - 5);
  const sparse = fakeWindow(few, pageSize, compareCheckinScanOrder);
  assert.deepEqual(
    await readCompanyWindow<Checkin>({ days, pageSize, probe: sparse.probe, scanDay: sparse.scanDay, order: compareCheckinScanOrder, sortDays: false }),
    [...few].sort(compareCheckinScanOrder),
    "a short check-in probe is put in (check_date, id) order",
  );
  assert.deepEqual(sparse.calls.days, []);

  // ── A missing mirror anywhere reads as a missing mirror, never as a partial window ─────────────
  const full = Array.from({ length: pageSize }, (_, index) => ({ day: days[index % days.length], id: randomUuid(random) }));
  assert.equal(
    await readCompanyWindow<Visit>({ days, pageSize, probe: async () => null, scanDay: async () => [], order: visitOrder, sortDays: true }),
    null,
  );
  assert.equal(
    await readCompanyWindow<Visit>({
      days,
      pageSize,
      probe: async () => full,
      scanDay: async (day) => (day === days[4] ? null : full.filter((row) => row.day === day)),
      order: visitOrder,
      sortDays: true,
    }),
    null,
    "one day finding the schema missing voids the whole read, as the single scan did",
  );
}

function runCheckinDayBoundaryTests() {
  // Each day request is the half-open [day 00:00, next day 00:00) INSIDE the caller's own
  // [from 00:00:00, to 23:59:59], so every check-in the whole window holds falls in exactly one day.
  const days: string[] = dayScanSlices("2026-08-01", "2026-08-05") ?? assert.fail("five days slice");
  const from = Date.parse("2026-08-01T00:00:00Z");
  const to = Date.parse("2026-08-05T23:59:59Z");
  const random = prng(5);
  const instants = [
    from,
    to,
    Date.parse("2026-08-02T00:00:00Z"),
    Date.parse("2026-08-01T23:59:59.999Z"),
    ...Array.from({ length: 1000 }, () => from + Math.floor(random() * (to - from))),
  ];
  for (const instant of instants) {
    const holders = days.filter((day) => {
      const start = Date.parse(`${day}T00:00:00Z`);
      const end = Date.parse(`${addDaysIso(day, 1)}T00:00:00Z`);
      return instant >= start && instant < end;
    });
    assert.equal(holders.length, 1, `${new Date(instant).toISOString()} must fall in exactly one day request`);
  }
}

function runScanWiringGuards() {
  const source = readFileSync("src/lib/crm/reads.ts", "utf8");

  const visits = functionBody(source, "export async function queryVisits");
  assert.match(visits, /visitFilterNamesPeople\(options\) \? null : dayScanSlices\(options\.dateFrom, options\.dateTo\)/, "queryVisits slices only a read that names nobody");
  assert.match(visits, /if \(day\) query = query\.eq\("visit_date", day\);/, "queryVisits narrows each request to its day");
  assert.match(visits, /await filtered\(\)\.limit\(pageSize\);/, "queryVisits probes with an UNORDERED page of the same filter");
  assert.match(visits, /order: \(a, b\) => compareUuidText\(a\.id, b\.id\),\s+sortDays: true,/, "queryVisits returns the joined days in id order");

  const range = functionBody(source, "async function keysetScanVisitsForRange");
  assert.match(range, /const days = dayScanSlices\(options\.dateFrom, options\.dateTo\);/);
  assert.match(range, /if \(day\) query = query\.eq\("visit_date", day\);/, "the range scan narrows each request to its day");
  assert.match(range, /await windowed\(\)\.limit\(DEFAULT_PAGE_SIZE\);/, "the range scan probes with an UNORDERED page");
  assert.match(range, /order: \(a, b\) => compareUuidText\(a\.id, b\.id\),\s+sortDays: true,/, "the range scan returns the joined days in id order");

  const checkins = functionBody(source, "export async function queryCheckins");
  assert.match(checkins, /checkinFilterNamesPeople\(options\) \? null : dayScanSlices\(options\.dateFrom, options\.dateTo\)/, "queryCheckins slices only a read that names nobody");
  assert.match(
    checkins,
    /let query = filtered\(\);\s+\/\/[^\n]*\n\s+if \(day\) query = query\.gte\("check_date", `\$\{day\}T00:00:00`\)\.lt\("check_date", `\$\{addDaysIso\(day, 1\)\}T00:00:00`\);/,
    "each check-in day is the half-open day, applied on top of the caller's own filter and bounds",
  );
  assert.match(checkins, /await filtered\(\)\.limit\(pageSize\);/, "queryCheckins probes with an UNORDERED page of the same filter");
  assert.match(checkins, /order: compareCheckinScanOrder,\s+sortDays: false,/, "check-in days are joined end to end, a short probe sorted by (check_date, id)");
}

// THE PLAN MIRROR HAD THE SAME FAULT, on the busiest page in the portal. `scanPlanEntries` OFFSET-paged a
// company-wide window: every page re-read and re-sorted all 25,862 September rows (62 ms each, measured
// on production 2026-10-01), and all 26 pages ran one after another on EVERY rep landing, because the
// KPI tile reads the board company-wide. It now rides the same probe-then-days read as the visits door.
// Its end-to-end proof, run on production the same night: September 25,862 rows, August 25,584, one
// week 5,636 and October's first 812 — every row identical, in the same order, to the OFFSET scan.
function runPlanScanWiringGuards() {
  const source = readFileSync("src/lib/crm/rep-doctor-lists.ts", "utf8");
  const plan = functionBody(source, "export async function scanPlanEntries");
  assert.match(
    plan,
    /const days = agentChunks\.length === 1 && agentChunks\[0\] === null \? dayScanSlices\(from, to\) : null;/,
    "the plan scan slices only a window that names nobody",
  );
  assert.match(plan, /\.eq\("plan_date", day\);/, "each plan request is narrowed to its day");
  assert.match(
    plan,
    /if \(cursor !== null\) query = query\.gt\("crm_plan_entry_id", cursor\);/,
    "a day pages by keyset on the mirror's primary key, never by OFFSET",
  );
  assert.match(
    plan,
    /\.gte\("plan_date", from\)\s+\.lte\("plan_date", to\)\s+\.limit\(PLAN_PAGE_SIZE\);/,
    "the plan probe is an UNORDERED page of the whole window",
  );
  assert.match(
    plan,
    /order: \(left, right\) => Number\(left\.crm_plan_entry_id\) - Number\(right\.crm_plan_entry_id\),\s+sortDays: true,/,
    "the joined days come back in the single scan's entry-id order",
  );
}

export async function runCrmDaySliceScanTests() {
  await runDayScanSlicesTests();
  runNamesPeopleTests();
  runOrderTests();
  await runReadCompanyWindowTests();
  runCheckinDayBoundaryTests();
  runScanWiringGuards();
  runPlanScanWiringGuards();
}
