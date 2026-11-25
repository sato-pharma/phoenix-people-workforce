import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import {
  SHARED_READ_TTL_MS,
  _resetSharedReadCache,
  bumpSharedReadGeneration,
  getOrLoadShared,
  sharedReadKey,
} from "../src/lib/cache/shared-read.ts";
import { loadPeopleNames } from "../src/lib/phoenix-crm/server/people.ts";
import { scanPlanEntries } from "../src/lib/crm/rep-doctor-lists.ts";
import { refreshSharedCrmPlanWindows, refreshSharedCrmWindows } from "../src/lib/crm/shared-windows.ts";
import { stripComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// A DASHBOARD MAY REUSE A HEAVY READ FOR UP TO A MINUTE — AND NOTHING ELSE MAY (2026-10-16).
//
// The SFE Command Center read the whole company's 30 days of CRM visits and check-ins on every render: a
// probe plus a request per day, about 62 round trips, paid again by every viewer. The owner chose the
// freshness that day — a copy up to one minute old, refreshed at once by a write the app makes.
//
// Pinned here: the cache's own contract (lifetime, shared loads, a write drops it, a load a write
// overtook is never kept, nothing stored is handed out by reference, the bounds), and the two promises
// around it — ONLY a display reader opts in, and the app's own visit write refreshes it.
// ─────────────────────────────────────────────────────────────────────────────

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const LIMITS = { maxEntries: 3, maxRowsTotal: 10 };

function code(path: string): string {
  return stripComments(readFileSync(join(ROOT, path), "utf8").replace(/\r\n/g, "\n"));
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(path);
  }
  return out;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export async function runSharedReadCacheTests() {
  // ── (1) A copy lives one minute, then the next read goes to the source ────────
  {
    _resetSharedReadCache();
    let clock = 1_000;
    const now = () => clock;
    let loads = 0;
    const load = async () => {
      loads += 1;
      return [{ id: loads }];
    };
    const first = await getOrLoadShared("t", "k", load, LIMITS, now);
    assert.equal(first.cache, "miss");
    clock += SHARED_READ_TTL_MS - 1;
    const second = await getOrLoadShared("t", "k", load, LIMITS, now);
    assert.equal(second.cache, "hit", "inside the minute the copy is served");
    assert.equal(loads, 1);
    clock += 1;
    const third = await getOrLoadShared("t", "k", load, LIMITS, now);
    assert.equal(third.cache, "miss", "RED a copy older than the owner's one minute must never be served");
    assert.equal(loads, 2);
    assert.equal(SHARED_READ_TTL_MS, 60_000, "the owner chose up to ONE minute (2026-10-16) — never widen it silently");
  }

  // ── (1b) A read the owner gave longer keeps its own lifetime, and only that read ──
  {
    _resetSharedReadCache();
    let clock = 1_000;
    const now = () => clock;
    const load = async () => [{ id: 1 }];
    const longer = { ...LIMITS, ttlMs: 3_600_000 };
    await getOrLoadShared("long", "k", load, longer, now);
    await getOrLoadShared("t", "k", load, LIMITS, now);
    clock += SHARED_READ_TTL_MS;
    assert.equal((await getOrLoadShared("long", "k", load, longer, now)).cache, "hit", "past the minute, this one is still inside its hour");
    assert.equal((await getOrLoadShared("t", "k", load, LIMITS, now)).cache, "miss", "RED every other read keeps the one minute");
    clock += 3_600_000 - SHARED_READ_TTL_MS;
    assert.equal((await getOrLoadShared("long", "k", load, longer, now)).cache, "miss", "RED and an hour is an hour");
  }

  // ── (2) Two viewers missing at once share ONE load ────────────────────────────
  {
    _resetSharedReadCache();
    const gate = deferred<{ id: number }[]>();
    let loads = 0;
    const load = () => {
      loads += 1;
      return gate.promise;
    };
    const a = getOrLoadShared("t", "k", load, LIMITS);
    const b = getOrLoadShared("t", "k", load, LIMITS);
    gate.resolve([{ id: 1 }]);
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(loads, 1, "concurrent misses on one key must share a single load");
    assert.deepEqual(ra.rows, [{ id: 1 }]);
    assert.notEqual(ra.rows, rb.rows, "each caller gets its own array");
  }

  // ── (3) A write drops the copy, and a load the write overtook is served but never kept ─
  {
    _resetSharedReadCache();
    let loads = 0;
    const load = async () => {
      loads += 1;
      return [{ id: loads }];
    };
    await getOrLoadShared("t", "k", load, LIMITS);
    bumpSharedReadGeneration("t", "test write");
    const afterWrite = await getOrLoadShared("t", "k", load, LIMITS);
    assert.equal(afterWrite.cache, "miss", "RED a write must make the very next read go to the database");
    assert.equal(loads, 2);

    const gate = deferred<{ id: number }[]>();
    bumpSharedReadGeneration("t", "reset");
    const racing = getOrLoadShared("t", "k", () => gate.promise, LIMITS);
    bumpSharedReadGeneration("t", "a write lands while the read is running");
    gate.resolve([{ id: 99 }]);
    assert.deepEqual((await racing).rows, [{ id: 99 }], "the overtaken load is still served to its caller");
    const next = await getOrLoadShared("t", "k", load, LIMITS);
    // Two guards hold this, each enough alone: the generation is part of every key, and a load whose
    // generation moved is not stored. Breaking only one of them leaves the behaviour correct.
    assert.equal(next.cache, "miss", "RED a load that started before a write must never be kept — it may miss the write");

    // Namespaces are independent: a CRM write does not drop another namespace's copy.
    await getOrLoadShared("other", "k", load, LIMITS);
    bumpSharedReadGeneration("t", "write");
    assert.equal((await getOrLoadShared("other", "k", load, LIMITS)).cache, "hit");
  }

  // ── (4) A missing source (null) is passed through and never stored ────────────
  {
    _resetSharedReadCache();
    let loads = 0;
    const load = async () => {
      loads += 1;
      return null;
    };
    assert.equal((await getOrLoadShared("t", "k", load, LIMITS)).rows, null);
    await getOrLoadShared("t", "k", load, LIMITS);
    assert.equal(loads, 2, "a null answer must not be remembered for a minute");
  }

  // ── (5) Nothing stored is handed out by reference ─────────────────────────────
  {
    _resetSharedReadCache();
    type MarkedRow = { id: number; marked: boolean };
    const original: MarkedRow[] = [{ id: 1, marked: false }];
    const nothing = async (): Promise<MarkedRow[]> => [];
    const first = await getOrLoadShared("t", "k", async () => original, LIMITS);
    first.rows![0].marked = true;
    original[0].marked = true;
    const second = await getOrLoadShared("t", "k", nothing, LIMITS);
    assert.equal(second.cache, "hit");
    assert.equal(
      second.rows![0].marked,
      false,
      "RED the door's callers mark and collapse rows in place — one viewer's edit must never reach the next",
    );
    // And a copy handed out FROM the cache is the caller's own too.
    second.rows![0].marked = true;
    const third = await getOrLoadShared("t", "k", nothing, LIMITS);
    assert.equal(third.cache, "hit");
    assert.equal(third.rows![0].marked, false, "RED a cache hit must hand out copies, never the stored rows themselves");
  }

  // ── (6) Bounded: entry count and row budget, oldest out first ─────────────────
  {
    _resetSharedReadCache();
    const rows = (n: number) => async () => Array.from({ length: n }, (_, i) => ({ id: i }));
    await getOrLoadShared("t", "a", rows(1), LIMITS);
    await getOrLoadShared("t", "b", rows(1), LIMITS);
    await getOrLoadShared("t", "c", rows(1), LIMITS);
    await getOrLoadShared("t", "a", rows(1), LIMITS); // touch a, so b is now the oldest
    await getOrLoadShared("t", "d", rows(1), LIMITS);
    assert.equal((await getOrLoadShared("t", "b", rows(1), LIMITS)).cache, "miss", "the least recently used entry goes first");

    _resetSharedReadCache();
    const big = await getOrLoadShared("t", "big", rows(11), LIMITS);
    assert.equal(big.rows!.length, 11, "a load over the budget is still served whole");
    assert.equal((await getOrLoadShared("t", "big", rows(11), LIMITS)).cache, "miss", "but it is never stored");

    _resetSharedReadCache();
    await getOrLoadShared("t", "x", rows(6), LIMITS);
    await getOrLoadShared("t", "y", rows(6), LIMITS);
    assert.equal((await getOrLoadShared("t", "x", rows(6), LIMITS)).cache, "miss", "the row budget evicts the oldest");
  }

  // ── (7) The key reads the whole options object, in any key order ──────────────
  {
    assert.equal(sharedReadKey({ b: 1, a: { d: 2, c: [3, { f: 1, e: 2 }] } }), sharedReadKey({ a: { c: [3, { e: 2, f: 1 }], d: 2 }, b: 1 }));
    assert.equal(sharedReadKey({ a: 1, skip: undefined }), sharedReadKey({ a: 1 }));
    assert.notEqual(sharedReadKey({ dateFrom: "2026-10-01" }), sharedReadKey({ dateFrom: "2026-10-02" }));
  }

  // ── (8) ONLY a display reader opts in, and the door shares only the company window ─
  {
    const optIns = sourceFiles("src")
      .filter((path) => /reuseRecentWindow\s*:\s*true/.test(code(path)))
      .map((path) => relative(ROOT, join(ROOT, path)).replace(/\\/g, "/"))
      .sort();
    assert.deepEqual(
      optIns,
      ["src/components/crm/rep-visits-page.tsx", "src/lib/crm/brick-coverage.ts", "src/lib/crm/kpis-board.ts", "src/lib/crm/sfe-field-analytics.ts"],
      "RED a new reader opted into the minute-old CRM copy — only a DISPLAY reader may, never one that decides money, a deduction, an approval or a notification. Classify it here first.",
    );

    const door = code("src/lib/crm/reads.ts");
    assert.match(door, /readWindowMaybeShared<Row>\(CRM_VISIT_WINDOWS, sharedKey, \(\) => readCompanyWindow/);
    assert.match(door, /readWindowMaybeShared<Row>\(CRM_CHECKIN_WINDOWS, sharedKey, \(\) => readCompanyWindow/);
    const keys = door.match(/sharedReadKey\(\{[^}]*\}\)/g) ?? [];
    assert.equal(keys.length, 2);
    for (const key of keys) {
      for (const part of ["excludedInList", "options", "pageSize", "projection"]) {
        assert.ok(key.includes(part), `RED the shared key must carry ${part} — a key missing an input serves one read's rows to another`);
      }
    }
    assert.match(door, /options\.reuseRecentWindow \? sharedReadKey/, "the copy is opt-in: no option, no sharing");
  }

  // ── (9) The app's own writes refresh the copy at once ─────────────────────────
  {
    const save = code("src/lib/phoenix-crm/server/visits.ts");
    const rpc = save.indexOf('callPhoenixCrm<Row>("phoenix_crm_save_visit"');
    const refresh = save.indexOf("refreshSharedCrmWindows(");
    assert.ok(rpc > 0 && refresh > rpc, "RED a saved Phoenix CRM visit must drop the minute-old copy, after the save");
  }

  // ── (10) The KPIs board's three company reads share the copy, and nothing else inherits it ──
  // Every manager's Command Center, the KPIs pages, the trend and the business review build this
  // board, and each load read the same company month again (23 Oct 2026). The loaders take the option
  // and default it OFF, so a future caller that decides money reads live unless it says otherwise.
  {
    const board = code("src/lib/crm/kpis-board.ts");
    assert.equal(
      (board.match(/reuseRecentWindow: true/g) ?? []).length,
      4,
      "RED the KPIs board opts in on exactly its four company reads: call rate, doctor lists, rep KPI reports, the Phoenix half",
    );
    assert.match(board, /loadCallRateReport\(\{[^}]*reuseRecentWindow: true/, "RED the call rate shares the copy");
    assert.match(board, /getRepDoctorLists\(\{[\s\S]{0,700}?reuseRecentWindow: true/, "RED the doctor lists share the copy");
    assert.match(board, /loadRepKpiReports\(\{[\s\S]{0,700}?reuseRecentWindow: true/, "RED the rep KPI reports share the copy");
    assert.match(board, /loadPhoenixRepKpis\(\{[\s\S]{0,1200}?reuseRecentWindow: true/, "RED the Phoenix half shares the copy");

    const rate = code("src/lib/crm/call-rate-service.ts");
    assert.match(rate, /const reuseRecentWindow = input\.reuseRecentWindow === true;/, "RED the call rate defaults the copy OFF");
    assert.equal((rate.match(/^\s*reuseRecentWindow,$/gm) ?? []).length, 2, "RED both its visits and its check-ins forward it");

    const lists = code("src/lib/crm/rep-doctor-lists.ts");
    assert.match(lists, /visitTypes: \[0, CAMPAIGN_TYPE\],\s*reuseRecentWindow: input\.reuseRecentWindow === true,/, "RED the doctor lists forward it, default OFF");
    const reports = code("src/lib/crm/rep-kpi-reports-data.ts");
    assert.match(reports, /collapseDoubleVisits: true,\s*reuseRecentWindow: input\.reuseRecentWindow === true,/, "RED the rep KPI reports forward it, default OFF");
  }

  // ── (11) The Phoenix KPI half and the brick-coverage board share the copy; the audit does not ──
  // The Phoenix half read the company month's visits and check-ins on every Coverage-tab load, and the
  // brick-coverage board read the company's check-in month on every page view (23 Oct 2026). Both
  // loaders default the option OFF, so the system audit's narrowed Phoenix read and any reader that
  // decides money stay live.
  {
    const phoenix = code("src/lib/crm/phoenix-kpi-data.ts");
    assert.match(phoenix, /const reuseRecentWindow = input\.reuseRecentWindow === true;/, "RED the Phoenix half defaults the copy OFF");
    assert.equal((phoenix.match(/^\s*reuseRecentWindow,$/gm) ?? []).length, 2, "RED both its visits and its check-ins forward it");
    const audit = code("src/lib/system-audit/detectors/visit-lifecycle.ts");
    assert.ok(!/reuseRecentWindow/.test(audit), "RED the system audit must read live");
    const bricks = code("src/lib/crm/brick-coverage.ts");
    assert.match(bricks, /includePhoenixVisits: true,\s*reuseRecentWindow: true,/, "RED the brick-coverage check-ins share the copy");
  }

  // ── (12) The Reps List's sharing roster is one shared copy, dropped by every applied list change ──
  // Fetched fresh it was the heaviest read on the database on 25 Oct 2026: the whole company's open
  // doctor-list rows as 14 parallel pages for every rep opened, on the 2 GB box that kept restarting.
  {
    const repsList = code("src/lib/crm/reps-list.ts");
    const roster = repsList.slice(repsList.indexOf("export async function loadContactRoster()"));
    assert.match(
      roster,
      /^export async function loadContactRoster\(\): Promise<RosterEntry\[\]> \{\s*const \{ rows \} = await getOrLoadShared\(CRM_CONTACT_ROSTER,/,
      "RED THE REPS LIST'S ROSTER IS READ FRESH AGAIN: every rep opened re-reads the whole company's doctor lists as 14 parallel pages — the heaviest load on the database box that restarted under it",
    );

    const service = code("src/lib/crm/contact-lists/service.ts");
    const bust = service.slice(service.indexOf("function bustListSummaries(): void {"));
    assert.match(
      bust,
      /^function bustListSummaries\(\): void \{\s*try \{[\s\S]*?\} catch \(error\) \{[\s\S]*?\n  \}\s*(?:\/\/[^\n]*\s*)?refreshSharedContactRoster\(/,
      "RED an applied doctor-list change must drop the shared roster, after the cache-tag try so its failure never skips it",
    );
    const applies = service.match(/supabase\.rpc\(CRM_CONTACT_LIST_CHANGE_APPLY_FUNCTION/g) ?? [];
    const busts = service.match(/^\s*bustListSummaries\(\);$/gm) ?? [];
    assert.ok(applies.length > 0 && busts.length >= applies.length, "RED every path that applies a doctor-list change must refresh the roster after it");
  }

  // ── (13) The Phoenix CRM List's check-in pins are one shared copy per doctor set, display only ──
  // Every List open re-read every check-in of the same doctors, cold: 8,527 reads of one shape over
  // 25–28 Oct 2026, 234,221 of them from disk. The pin is a location for the address, the map link and
  // the board colour (rowPoint, list-row-facts.ts) — nothing approves, pays or notifies from it.
  {
    const shared = code("src/lib/crm/shared-customers.ts");
    const pins = shared.slice(shared.indexOf("export async function loadObservedPointsFor("));
    assert.match(
      pins,
      /^export async function loadObservedPointsFor\(contactCrmIds: readonly number\[\]\): Promise<Map<number, ObservedPoint>> \{[\s\S]{0,400}?const key = sharedReadKey\(\{ ids: \[\.\.\.ids\]\.sort\(\(left, right\) => left - right\) \}\);\s*const \{ rows \} = await getOrLoadShared\(CRM_OBSERVED_POINTS, key, \(\) => readObservedPoints\(ids\),/,
      "RED THE LIST'S CHECK-IN PINS ARE READ FRESH AGAIN: every List open re-reads every check-in of the same doctors — or the key stopped being the exact doctor set, which would serve one list's pins to another",
    );
    const read = shared.slice(shared.indexOf("async function readObservedPoints("));
    assert.match(read, /^async function readObservedPoints\([^)]*\): Promise<ObservedPointRow\[\]> \{\s*const checkins = await loadCheckins\(/, "RED the copy keeps an ARRAY of pins: a Map does not survive the copy");

    const windows = code("src/lib/crm/shared-windows.ts");
    const refresh = windows.slice(windows.indexOf("export function refreshSharedCrmWindows("));
    assert.match(
      refresh.slice(0, refresh.indexOf("\n}")),
      /bumpSharedReadGeneration\(CRM_OBSERVED_POINTS, reason\);/,
      "RED a poll that wrote check-ins must drop the List's pins with the other CRM copies",
    );
  }

  // ── (14) Phoenix CRM's people's names are one shared copy per set of people, display only ──
  // Every CRM screen names the rep and the manager above him, and each of its loaders asked for the same
  // names again: 2,239 requests in the two busiest hours of Wednesday 28 Oct 2026, 1,582 of them the very
  // same request made within the minute before. A name prints on a screen or in a notice's sentence —
  // nothing approves, pays or picks a recipient from it.
  {
    const people = code("src/lib/phoenix-crm/server/people.ts");
    assert.match(
      people,
      /const people = \[\.\.\.wanted\]\.sort\(\);\s*const \{ rows \} = await getOrLoadShared\(PEOPLE_NAMES_SHARED, sharedReadKey\(\{ people \}\), \(\) => readNameRows\(people\),/,
      "RED PHOENIX CRM'S NAMES ARE READ FRESH AGAIN: every loader on a screen re-reads the same rep's and manager's names — or the key stopped being the exact set of people, which would hand one caller names it never asked for",
    );

    const json = { "content-type": "application/json" };
    const original = globalThis.fetch;
    const realNow = Date.now;
    // The admin client is built from these, and the suite may run with the real ones in its environment —
    // so a sentinel pair stands in, and the stub below answers every request: nothing here reaches a database.
    const previousUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const previousKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
    const asked: string[] = [];
    let failing = false;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      if (url.pathname.endsWith("/employees")) {
        asked.push(url.searchParams.get("hr_id") ?? "");
        if (failing) return new Response(JSON.stringify({ code: "42703", message: "column employees.nickname does not exist" }), { status: 400, headers: json });
        return new Response(
          JSON.stringify([
            { hr_id: "B-7", full_name: "Seven Person", nickname: null },
            { hr_id: "B-12", full_name: "Twelve Person", nickname: null },
          ]),
          { status: 200, headers: json },
        );
      }
      return new Response("[]", { status: 200, headers: json });
    }) as typeof fetch;
    try {
      _resetSharedReadCache();
      const first = await loadPeopleNames(["B-7", "b-12"]);
      assert.equal(asked.length, 1, "the first ask reads the names");
      assert.deepEqual([...first.entries()].sort(), [["B-12", "Twelve Person"], ["B-7", "Seven Person"]]);

      const again = await loadPeopleNames(["B-12", "B-7", null, ""]);
      assert.equal(asked.length, 1, "RED the same people asked again inside the minute — in any order or case — must be served from the shared copy");
      assert.deepEqual([...again.entries()].sort(), [...first.entries()].sort(), "and name them exactly as the read did");

      const one = await loadPeopleNames(["b-7"]);
      assert.equal(asked.length, 2, "a different set of people is its own read");
      assert.deepEqual([...one.keys()], ["B-7"], "and hands back only the names it asked for, though the rows held another");

      _resetSharedReadCache();
      const [left, right] = await Promise.all([loadPeopleNames(["B-7"]), loadPeopleNames(["b-7"])]);
      assert.equal(asked.length, 3, "RED two screens asking for the same people at once must share one read");
      assert.equal(left.get("B-7"), "Seven Person");
      assert.equal(right.get("B-7"), "Seven Person");

      const start = realNow();
      Date.now = () => start + SHARED_READ_TTL_MS;
      await loadPeopleNames(["B-7"]);
      assert.equal(asked.length, 4, "a copy a minute old is read again");
      Date.now = realNow;

      assert.equal((await loadPeopleNames([null, " "])).size, 0);
      assert.equal(asked.length, 4, "nobody asked about reads nothing");

      _resetSharedReadCache();
      failing = true;
      await assert.rejects(loadPeopleNames(["B-12"]), "a failed read throws, exactly as before");
      assert.equal(asked.length, 5);
      failing = false;
      assert.equal((await loadPeopleNames(["B-12"])).get("B-12"), "Twelve Person");
      assert.equal(asked.length, 6, "RED a failed read must never be kept — the next ask reads again");
    } finally {
      Date.now = realNow;
      globalThis.fetch = original;
      _resetSharedReadCache();
      if (previousUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
      else process.env.NEXT_PUBLIC_SUPABASE_URL = previousUrl;
      if (previousKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
      else process.env.SUPABASE_SERVICE_ROLE_KEY = previousKey;
    }
  }

  // ── (15) The company plan window is one shared copy, display only, dropped by a saved plan or visit ──
  // 25 Nov 2026, 17:21–17:33 Cairo: the Anti Infective team kept opening KPIs → Frequency and Coverage, which
  // read the whole company's plans on purpose, twice per open, about 80 requests a read — 3,213 calls and
  // 9,947 s on the plan view in 18 minutes, and the 2-core database at 87–96% CPU. The visits beside it
  // already came from the minute-old copy; the plans did not.
  {
    const lists = code("src/lib/crm/rep-doctor-lists.ts");
    assert.match(
      lists,
      /: scanPlanEntries\(from, to, \{ reuseRecentWindow: input\.reuseRecentWindow === true \}\),/,
      "RED THE DOCTOR LISTS READ THE COMPANY'S PLANS FRESH AGAIN: every KPI Coverage or Frequency open re-reads the whole month — or the option stopped defaulting OFF",
    );
    const phoenix = code("src/lib/crm/phoenix-kpi-data.ts");
    assert.match(
      phoenix,
      /: scanPlanEntries\(input\.month\.start, input\.month\.end, \{ reuseRecentWindow \}\),/,
      "RED THE PHOENIX HALF READS THE COMPANY'S PLANS FRESH AGAIN: the second company plan read of every KPI open",
    );
    const scan = lists.slice(lists.indexOf("export async function scanPlanEntries("));
    assert.match(
      scan,
      /const windowRows = options\?\.reuseRecentWindow\s*\? \(await getOrLoadShared\(CRM_PLAN_WINDOWS, companyPlanWindowKey\(from, to\), readWindow, COMPANY_PLAN_WINDOW_LIMITS\)\)\.rows\s*: await readWindow\(\);/,
      "RED the company plan window must share ONLY when the caller opts in, keyed on the window and the projection",
    );

    const plans = code("src/lib/phoenix-crm/server/plans.ts");
    for (const [rpcName, label] of [
      ["phoenix_crm_save_plan", "a saved weekly plan"],
      ["phoenix_crm_plan_transition", "a weekly plan sent, approved, returned or reopened"],
    ] as const) {
      const rpc = plans.indexOf(`callPhoenixCrm<Row>("${rpcName}"`);
      const refresh = plans.indexOf("refreshSharedCrmPlanWindows(", rpc);
      const nextExport = plans.indexOf("\nexport async function", rpc);
      assert.ok(rpc > 0 && refresh > rpc && refresh < nextExport, `RED ${label} must drop the shared plan window, after the write`);
    }
    const windows = code("src/lib/crm/shared-windows.ts");
    const refreshAll = windows.slice(windows.indexOf("export function refreshSharedCrmWindows("));
    assert.match(
      refreshAll.slice(0, refreshAll.indexOf("\n}")),
      /bumpSharedReadGeneration\(CRM_PLAN_WINDOWS, reason\);/,
      "RED a saved visit marks a planned call done, so it must drop the plan copy too",
    );

    // Behaviour: the real scan, against a stub that answers every request, so nothing reaches a database.
    const json = { "content-type": "application/json" };
    const original = globalThis.fetch;
    const previousUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const previousKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
    let planRequests = 0;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      if (url.pathname.endsWith("/crm_plan_entries_unified")) {
        planRequests += 1;
        return new Response(
          JSON.stringify([
            { agent_crm_id: 7, agent_hr_id: "AI-0001", contact_crm_id: 70, crm_plan_entry_id: 2, plan_date: "2026-11-02", plan_status: "planned" },
            { agent_crm_id: 8, agent_hr_id: "AI-0002", contact_crm_id: 80, crm_plan_entry_id: 1, plan_date: "2026-11-01", plan_status: "planned" },
          ]),
          { status: 200, headers: json },
        );
      }
      return new Response("[]", { status: 200, headers: json });
    }) as typeof fetch;
    try {
      _resetSharedReadCache();
      const first = await scanPlanEntries("2026-11-01", "2026-11-30", { reuseRecentWindow: true });
      assert.equal(planRequests, 1, "a short month answers from its one probe page");
      assert.deepEqual(first.map((row) => row.contact_crm_id), [80, 70], "in entry-id order");

      first[0].contact_crm_id = 999;
      const again = await scanPlanEntries("2026-11-01", "2026-11-30", { reuseRecentWindow: true });
      assert.equal(planRequests, 1, "RED a second display board inside the minute must be served the shared company plan window");
      assert.deepEqual(again.map((row) => row.contact_crm_id), [80, 70], "and never the rows an earlier caller changed in place");

      await scanPlanEntries("2026-11-01", "2026-11-29", { reuseRecentWindow: true });
      assert.equal(planRequests, 2, "a different window is its own read");

      await scanPlanEntries("2026-11-01", "2026-11-30");
      assert.equal(planRequests, 3, "RED a caller that did not opt in must read live — a read that decides money never shares");

      await scanPlanEntries("2026-11-01", "2026-11-30", { agentHrIds: ["AI-0001"], reuseRecentWindow: true });
      assert.equal(planRequests, 4, "a read that names agents reads live");

      refreshSharedCrmPlanWindows("test: plan saved");
      await scanPlanEntries("2026-11-01", "2026-11-30", { reuseRecentWindow: true });
      assert.equal(planRequests, 5, "RED a saved plan must be on the boards at once");

      refreshSharedCrmWindows("test: visit saved");
      await scanPlanEntries("2026-11-01", "2026-11-30", { reuseRecentWindow: true });
      assert.equal(planRequests, 6, "RED a saved visit must drop the plan copy too");
    } finally {
      globalThis.fetch = original;
      _resetSharedReadCache();
      if (previousUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
      else process.env.NEXT_PUBLIC_SUPABASE_URL = previousUrl;
      if (previousKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
      else process.env.SUPABASE_SERVICE_ROLE_KEY = previousKey;
    }
  }

  console.log("shared read cache: 15 blocks passed");
}
