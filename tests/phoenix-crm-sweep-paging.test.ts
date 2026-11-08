import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { PHOTO_CORPUS_MAX, loadPhotoCorpus } from "../src/lib/phoenix-crm/server/photo-dupes.ts";
import { VISIT_READ_MAX, readMonthVisits } from "../src/lib/phoenix-crm/server/behaviour.ts";
import { PHOENIX_CRM_PAGE_SIZE, readEveryPage } from "../src/lib/phoenix-crm/server/paged-read.ts";
import { stripComments, stripSqlComments } from "./support/comment-strip.ts";

/**
 * Phoenix CRM — the nightly sweep's reads are PAGED, never capped.
 *
 * ## 🔴 WHAT WENT WRONG, AND WHY NOTHING WENT RED
 *
 * PostgREST answers every request with at most 1,000 rows and says nothing when it stops: no error,
 * no marker, a well-formed list that is simply short. `.limit(N)` can only ask for FEWER rows than
 * that ceiling — above it, it does nothing at all. Two reads in the sweep ended in one (audit,
 * 2026-10-02, against origin/main f14fd8834):
 *
 *   * `behaviour.ts` read a month's visits with `.limit(50_000)` ordered by `captured_at` ASCENDING,
 *     so the sweep judged the FIRST ~1,000 visits of the month company-wide and never saw the rest.
 *     Delta (1) alone — 14 reps, live from Saturday 3 Oct 2026 — makes about 3,700 visits a month,
 *     so a rep whose month began after that first thousand was judged on nothing at all, and one who
 *     straddled it was judged on half a month: a coverage share computed from part of his work, and a
 *     metronome "found" in the only fragment that was read.
 *   * `photo-dupes.ts` read its comparison corpus with `.limit(20_000)` ordered NEWEST first, so a
 *     new photo was only ever compared with the newest 1,000 fingerprints. A photograph re-used from
 *     a few weeks earlier was invisible to the check built to catch exactly that.
 *
 * Both reads are now paged with `.range()`. These tests drive the REAL functions against a fake
 * client that stops at 1,000 rows exactly as the live server does — not a regex over the source,
 * which would pass the day someone reintroduced a `.limit()` two lines away.
 *
 * ## The fake's whole point
 *
 * `rowsPerRequest` is PostgREST's own ceiling. A `.limit(50_000)` against it returns 1,000, which is
 * what production did. So a read that stops paging fails the FIRST assertion in each block below,
 * and the failure says how many rows it lost.
 */

const ROOT = new URL("../", import.meta.url);

function source(path: string): string {
  return stripComments(readFileSync(new URL(path, ROOT), "utf8"));
}

/**
 * The migration's SQL with its comments gone.
 *
 * 🔴 `stripSqlComments`, never a line filter — `tests/comment-strip-ratchet.test.ts` refuses one, and
 * it caught this file on its first CI run. A `^\s*--` replace judges a line by how it STARTS, so a
 * `--` written after code survives and a block comment survives entirely; this migration explains
 * the fix in prose that names the very predicate it pins, so a positive assertion could pass on the
 * comment, on a file that no longer held the statement.
 */
function sql(path: string): string {
  return stripSqlComments(readFileSync(new URL(path, ROOT), "utf8"));
}

type Row = Record<string, unknown>;

/**
 * A fake PostgREST builder that behaves like the real one in the one way that matters: it NEVER
 * returns more than `rowsPerRequest` rows, whatever `.range()` asks for and whatever `.limit()` says.
 */
function fakeClient(options: { rows: Row[]; rowsPerRequest?: number; failOnCall?: number; shiftOnCall?: number }) {
  const ceiling = options.rowsPerRequest ?? PHOENIX_CRM_PAGE_SIZE;
  const state = { calls: 0, ranges: [] as Array<[number, number]>, orders: [] as string[], tables: [] as string[], limited: [] as number[] };
  let rows = options.rows;

  const build = (table: string) => {
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    const answer = (from: number, to: number) => {
      state.calls += 1;
      state.ranges.push([from, to]);
      if (options.failOnCall && state.calls === options.failOnCall) {
        return Promise.resolve({ data: null, error: { message: "the read failed" } });
      }
      // A row inserted BEFORE the cursor while the walk runs — the seam where an offset walk repeats
      // a row. The pager's `uniqueBy` is what must absorb it.
      if (options.shiftOnCall && state.calls === options.shiftOnCall) rows = [{ ...rows[0], id: "inserted-first" }, ...rows];
      const width = Math.min(to - from + 1, ceiling);
      return Promise.resolve({ data: rows.slice(from, from + width), error: null });
    };

    for (const method of ["select", "eq", "neq", "in", "gte", "lte", "not", "is"]) chain[method] = self;
    chain.order = (column: string) => {
      state.orders.push(`${table}.${column}`);
      return chain;
    };
    // 🔴 Modelled as PostgREST really behaves: a limit ABOVE the server ceiling yields the ceiling.
    // This is what makes a reverted `.limit(50_000)` fail these tests instead of passing them.
    chain.limit = (count: number) => {
      state.limited.push(count);
      chain.then = (resolve: (result: { data: unknown; error: unknown }) => void) => answer(0, count - 1).then(resolve);
      return chain;
    };
    chain.range = (from: number, to: number) => answer(from, to);
    // Awaiting with neither range nor limit reads one capped page, as a bare select does.
    chain.then = (resolve: (result: { data: unknown; error: unknown }) => void) => answer(0, ceiling - 1).then(resolve);
    return chain;
  };

  return {
    client: {
      from(table: string) {
        state.tables.push(table);
        return build(table) as never;
      },
    },
    state,
  };
}

const visitRow = (n: number): Row => ({
  id: `v-${String(n).padStart(6, "0")}`,
  seat_id: "FAISAL",
  line_code: "CNS",
  customer_id: `c-${n}`,
  visit_date: "2026-10-05",
  captured_at: new Date(Date.parse("2026-10-05T07:00:00Z") + n * 1_000).toISOString(),
  rep_hr_id: "B-200",
  manager_hr_id: null,
  entered_by_hr_id: "B-200",
  form_open_seconds: 200 + (n % 40),
  objection: null,
  is_test: false,
});

const fingerprintRow = (n: number): Row => ({
  subject_kind: "visit",
  subject_id: `v-${n}`,
  photo_path: `visits/photo-${String(n).padStart(6, "0")}.jpg`,
  rep_hr_id: "B-200",
  customer_id: `c-${n}`,
  captured_at: new Date(Date.parse("2026-09-01T07:00:00Z") + n * 60_000).toISOString(),
  sha256: "a".repeat(64),
  dhash: "0123456789abcdef",
});

export async function runPhoenixCrmSweepPagingTests(): Promise<void> {
  // ── 1 · A MONTH BIGGER THAN ONE PAGE IS JUDGED WHOLE ───────────────────────────────────────────
  {
    // 3,700 is Delta (1)'s own month — the number that made this urgent rather than theoretical.
    const rows = Array.from({ length: 3_700 }, (_unused, index) => visitRow(index));
    const { client, state } = fakeClient({ rows });
    const read = await readMonthVisits(client, { from: "2026-10-01", to: "2026-10-31" });

    assert.equal(
      read.length,
      3_700,
      "RED every visit of the month must be judged — a read that stops at PostgREST's 1,000-row ceiling judges the first thousand and calls it a month",
    );
    assert.equal(read[0].id, "v-000000", "the first visit survives paging");
    assert.equal(read.at(-1)?.id, "v-003699", "and so does the last — the one a capped read always loses");
    // 🔴 FIVE requests for 3,700 rows, not four: the walk ends on an EMPTY page and never on a short
    // one. A short page looks like the end and is not — a server ceiling below the page size returns
    // one on every request — so the extra round trip at the true end is the price of never stopping
    // early. That is the pager's rule, and this is where it is visible.
    assert.equal(state.calls, 5, "three full pages, the 700-row remainder, and the empty page that ends the walk");
    assert.deepEqual(
      state.ranges.map(([from]) => from),
      [0, 1_000, 2_000, 3_000, 3_700],
      "each page starts where the previous one actually ENDED — by rows RECEIVED, never a page-size stride later",
    );
    assert.deepEqual(state.limited, [], "🔴 and NOTHING is read with .limit() — above 1,000 it does nothing, which is the whole defect");
  }

  // ── 2 · The month's order is TOTAL, or paging itself loses rows ────────────────────────────────
  {
    const { client, state } = fakeClient({ rows: [visitRow(0)] });
    await readMonthVisits(client, { from: "2026-10-01", to: "2026-10-31" });
    // Every page builds a FRESH query (a PostgREST builder is single-use), so the keys repeat once
    // per request — what matters is their order within one, and that both are always there.
    assert.deepEqual(
      state.orders.slice(0, 2),
      ["phoenix_crm_visits.captured_at", "phoenix_crm_visits.id"],
      "🔴 captured_at THEN id: two visits can share a capture instant, and an order that wobbles between pages both drops rows and repeats them",
    );
    assert.equal(state.orders.length, state.calls * 2, "and EVERY page carries both keys — one page ordered differently is the same defect");
  }

  // ── 3 · 🔴 A ROW MET TWICE AT THE SEAM IS KEPT ONCE ───────────────────────────────────────────
  //
  // A visit synced late carries an earlier capture time, so it lands BEFORE the cursor and shifts
  // every later page by one. The repeated row would be two captures in the same second — exactly the
  // shape `burst_visits` looks for — so a duplicate here is evidence nobody produced.
  {
    const rows = Array.from({ length: 2_000 }, (_unused, index) => visitRow(index));
    const { client } = fakeClient({ rows, shiftOnCall: 2 });
    const read = await readMonthVisits(client, { from: "2026-10-01", to: "2026-10-31" });
    const ids = read.map((row) => String(row.id));
    assert.equal(new Set(ids).size, ids.length, "RED a row the walk met twice must appear once — a repeat invents a visit in the same second");
  }

  // ── 4 · A FAILED PAGE IS AN ERROR, NEVER A SHORT MONTH ────────────────────────────────────────
  {
    const rows = Array.from({ length: 2_500 }, (_unused, index) => visitRow(index));
    const { client } = fakeClient({ rows, failOnCall: 2 });
    await assert.rejects(
      () => readMonthVisits(client, { from: "2026-10-01", to: "2026-10-31" }),
      "RED a read that failed half way must throw — carrying on with the pages it got would judge a month on a fragment and report success",
    );
  }

  // ── 5 · PAST THE CEILING A JUDGED READ REFUSES, AND A CORPUS READ STOPS ───────────────────────
  {
    const refuse = await readEveryPage<Row>(() => fakeClient({ rows: Array.from({ length: 40 }, (_u, i) => ({ id: i })), rowsPerRequest: 10 }).client.from("t"), {
      maxRows: 20,
      whenFull: "refuse",
      what: "A month of Phoenix CRM visits",
      pageSize: 10,
    });
    assert.equal(refuse.rows.length, 0, "a refusal answers with NO rows — a partial month must never reach a verdict");
    assert.ok(refuse.error instanceof Error, "and with an error, so the cron's dead-man's switch records a night that did not run");
    assert.equal(refuse.capped, true);

    const stop = await readEveryPage<Row>(() => fakeClient({ rows: Array.from({ length: 40 }, (_u, i) => ({ id: i })), rowsPerRequest: 10 }).client.from("t"), {
      maxRows: 20,
      whenFull: "stop",
      what: "The photo corpus",
      pageSize: 10,
    });
    assert.equal(stop.rows.length, 20, "a stop answers with exactly the ceiling, in the caller's own order");
    assert.equal(stop.error, null, "and no error — the corpus is newest first, so it simply looks back less far");
    assert.equal(stop.capped, true);
  }

  // ── 6 · THE PHOTO CORPUS REACHES PAST THE NEWEST THOUSAND ─────────────────────────────────────
  {
    const rows = Array.from({ length: 4_200 }, (_unused, index) => fingerprintRow(index));
    const { client, state } = fakeClient({ rows });
    const corpus = await loadPhotoCorpus(client, false);

    assert.equal(
      corpus.length,
      4_200,
      "RED six months of fingerprints must all be comparable — capped at 1,000 a photo re-used a few weeks ago is never seen, which is the one thing this detector exists for",
    );
    assert.equal(corpus.at(-1)?.photoPath, "visits/photo-004199.jpg", "including the oldest in the window");
    assert.deepEqual(
      state.orders.slice(0, 2),
      ["phoenix_crm_photo_fingerprints.captured_at", "phoenix_crm_photo_fingerprints.photo_path"],
      "🔴 a TOTAL order — the photo path is the identity — or paging drops and repeats fingerprints",
    );
    assert.equal(state.orders.length, state.calls * 2, "on every page, not only the first");
    assert.deepEqual(state.limited, [], "and no .limit() anywhere");
  }

  // ── 7 · The corpus stops at its ceiling rather than refusing ──────────────────────────────────
  {
    const rows = Array.from({ length: PHOTO_CORPUS_MAX + 500 }, (_unused, index) => fingerprintRow(index));
    const { client } = fakeClient({ rows });
    const corpus = await loadPhotoCorpus(client, false);
    assert.equal(corpus.length, PHOTO_CORPUS_MAX, `the corpus holds at most ${PHOTO_CORPUS_MAX}, so one night can never pull the table into RAM`);
  }

  // ── 8 · The ceilings are far above the real numbers, and are ceilings and not page sizes ──────
  {
    assert.equal(PHOENIX_CRM_PAGE_SIZE, 1_000, "the page size IS PostgREST's ceiling, so one request is one full page");
    assert.ok(VISIT_READ_MAX >= 50_000, "a month of the whole company must fit far inside the visit ceiling");
    assert.ok(PHOTO_CORPUS_MAX >= 20_000, "and six months of photos inside the corpus ceiling");

    const behaviour = source("src/lib/phoenix-crm/server/behaviour.ts");
    const photos = source("src/lib/phoenix-crm/server/photo-dupes.ts");
    // 🔴 Anchored on the CEILING CONSTANTS, not on the word "limit": `.limit(1)` is legitimate
    // elsewhere, and what must never come back is a limit asking for more than the server will give.
    for (const [name, text] of [
      ["behaviour.ts", behaviour],
      ["photo-dupes.ts", photos],
    ] as const) {
      assert.equal(
        /\.limit\(\s*(VISIT_READ_MAX|PHOTO_CORPUS_MAX|SEAT_ROW_READ_MAX|STRONG_CASE_READ_MAX|[0-9_]{4,})\s*\)/.test(text),
        false,
        `🔴 ${name} must not cap a read with a .limit() above 1,000 — PostgREST ignores it and answers with 1,000 rows and no error`,
      );
    }
    assert.ok(behaviour.includes("readEveryPage"), "the behaviour reads page");
    assert.ok(photos.includes("readEveryPage"), "and so does the corpus read");
  }

  // ── 9 · 🔴 THE PLACES READ: THE ONE UNPAGED READ THAT CAN ACCUSE SOMEBODY ─────────────────────
  //
  // It had no `.limit()` at all, which is not safer than a high one — PostgREST still stops at 1,000.
  // Past a thousand validated places a seat comes back with NO area codes, `areaSawSales` is then
  // false for a rep whose area did sell, and `flat_coverage_no_sales` fires on a rep who covered his
  // list and sold behind it. Every validated customer adds a place, so this has a date on it.
  {
    const behaviour = source("src/lib/phoenix-crm/server/behaviour.ts");
    const seatRead = behaviour.slice(behaviour.indexOf("async function readSeatRows"), behaviour.indexOf("async function readStrongCaseReps"));
    assert.ok(seatRead.includes("readEveryPage"), "RED the places and readiness reads must page");
    assert.ok(seatRead.includes('whenFull: "refuse"'), "and refuse past their ceiling — a seat silently missing its areas is an accusation");
    assert.ok(/\.eq\("is_test", false\)/.test(seatRead), "real places only — test places sit on real seats, and their area codes fed the real rep's verdict");
    assert.ok(
      /readSeatRows\(supabase, "phoenix_crm_places", "id, seat_id, area_code", seatIds, true\)/.test(behaviour),
      "and the places call asks for real rows — the last argument is what carries that, so it is read here rather than assumed",
    );
  }

  // ── 10 · 🔴 THE FINGERPRINT BACKLOG REQUIRES A PHOTO (applied to production 2026-10-02) ───────
  //
  // The anti-join `left join … on f.photo_path = c.photo_path where f.photo_path is null` can never
  // clear a row whose own photo_path is NULL — and since the one-tap visit (2026-09-29) that is every
  // visit. `toCandidate` drops it without filing anything, so after ~400 of them (PHOTO_SWEEP_LIMIT)
  // every night's batch is entirely photo-less: nothing is hashed, no place photo is ever
  // fingerprinted again, and the job still reports success. Measured on production before the fix:
  // 19 candidates, 4 of them photo-less and permanently stuck.
  {
    const migration = sql("supabase/migrations/20261002215832_phoenix_crm_fingerprint_candidates_need_a_photo.sql");
    assert.ok(/where v\.photo_path is not null/.test(migration), "RED the visit branch must require a photo, or the backlog can never clear");
    assert.ok(/where pl\.photo_path is not null/.test(migration), "and the place branch too, so the predicate does not rest on a NOT NULL a later migration could relax");
    assert.ok(
      /revoke execute on function public\.phoenix_crm_photos_to_fingerprint\(jsonb\) from public, anon, authenticated;/.test(migration),
      "a public SECURITY DEFINER function revokes from public, anon AND authenticated — the two inherit EXECUTE through PUBLIC",
    );
    assert.ok(/grant execute on function public\.phoenix_crm_photos_to_fingerprint\(jsonb\) to service_role;/.test(migration), "and re-grants service_role, which that revoke also stripped");
  }

  // ── 11 · 🔴 THE EVIDENCE IS FILED ON THE VISIT DAY, WHICH ENDS AT 02:00 CAIRO ─────────────────
  //
  // Both detectors filed the CALENDAR day, so a visit logged at 01:30 — which the owner expressly
  // allows (2026-09-29, "maximum 2 AM") — carried a different day here from the one on its own visit
  // row and on every other CRM screen. Evidence about a day the rep did not work is the worst
  // possible wording on a page about his honesty.
  {
    const gps = source("src/lib/phoenix-crm/server/location-integrity.ts");
    const photos = source("src/lib/phoenix-crm/server/photo-dupes.ts");
    const rules = source("src/lib/phoenix-crm/location-integrity.ts");
    for (const [name, text] of [
      ["server/location-integrity.ts", gps],
      ["server/photo-dupes.ts", photos],
      ["location-integrity.ts", rules],
    ] as const) {
      assert.ok(text.includes("cairoBusinessDay"), `RED ${name} must file and group by the VISIT day, not the calendar day`);
      assert.equal(
        /timeZone: "Africa\/Cairo"/.test(text),
        false,
        `🔴 ${name} must not format a Cairo day itself — a hand-rolled Intl format is how the 02:00 cutoff was lost here`,
      );
    }
  }

  // ── 12 · 🔴 A PLACE IS JUDGED ON ITS FIXED POINT, NOT ON THE PIN ──────────────────────────────
  //
  // Owner, 2026-09-29: "the photo + the location of photo is the more trustable". `placePayload`
  // stores `placePoint` as the place's own lat/lon and every later visit is measured against it, but
  // `judgeCaptureForPlace` judged `place.lat`/`place.lon` — so a place whose PHOTO reading was
  // spoofed was judged on its honest pin, and a coordinate replayed into the stored point was never
  // compared against, because the detectors were never shown that point.
  {
    const list = source("src/lib/phoenix-crm/server/list.ts");
    const judge = list.slice(list.indexOf("async function judgeCaptureForPlace"), list.indexOf("export type ValidateResult"));
    assert.ok(judge.includes("placePoint(place)"), "RED the place's FIXED point is what gets judged");
    assert.ok(
      /fix: \{ lat: point\.lat, lon: point\.lon, accuracyMeters: point\.accuracyMeters/.test(judge),
      "and all three parts of it — a pin's accuracy beside a photo's coordinate is a fix that never existed",
    );
    assert.equal(/fix: \{ lat: place\.lat/.test(judge), false, "the pin is not the fixed point");
  }

  // ── 13 · 🔴 PAGES IN WAVES ARE THE SAME ROWS AS PAGES ONE BY ONE, AND THE PLACE CHECKS READS ARE FEW ──
  //
  // Owner, 2026-11-08: "enhance more the performance of this page, hilarious slow". The Place checks page
  // read ~5,400 active places six pages one after another, then enriched them in 179 requests of 150 ids,
  // then read notes and evidence in 125 more. `concurrentPages` asks for pages in waves — and must answer
  // with exactly the rows, the order and the ceiling the sequential walk does, or it is a faster wrong answer.
  {
    const rows = Array.from({ length: 5_429 }, (_unused, index) => ({ id: `p-${String(index).padStart(5, "0")}` }));
    const one = fakeClient({ rows });
    const sequential = await readEveryPage<Row>(() => one.client.from("t"), { maxRows: 10_000, whenFull: "stop", what: "places" });
    const many = fakeClient({ rows });
    const waved = await readEveryPage<Row>(() => many.client.from("t"), { maxRows: 10_000, whenFull: "stop", what: "places", concurrentPages: 4 });
    assert.equal(waved.rows.length, 5_429, "RED every active place, waves or not");
    assert.deepEqual(waved.rows, sequential.rows, "and in exactly the order the one-by-one walk gives");
    assert.equal(waved.capped, false);
    assert.equal(many.state.calls, 9, "two waves of four pages (six hold rows, the sixth short), then ONE more page that comes back empty to prove the end — three round trips where the one-by-one walk took seven");

    // A server whose own ceiling is BELOW the page size: the wave's offsets were wrong, so a later page of
    // the wave holds rows the short page skipped — the walk must start again one page at a time.
    const low = fakeClient({ rows: Array.from({ length: 100 }, (_unused, index) => ({ id: index })), rowsPerRequest: 10 });
    const lowRead = await readEveryPage<Row>(() => low.client.from("t"), { maxRows: 1_000, whenFull: "refuse", what: "places", pageSize: 25, concurrentPages: 4 });
    assert.equal(lowRead.rows.length, 100, "RED a server ceiling below the page size must not lose the rows between its pages");
    assert.deepEqual(lowRead.rows.map((row) => row.id), Array.from({ length: 100 }, (_unused, index) => index), "each once, in order");

    // The ceiling reached inside the waves gives the sequential walk's two answers.
    const stop = await readEveryPage<Row>(() => fakeClient({ rows: Array.from({ length: 40 }, (_u, i) => ({ id: i })), rowsPerRequest: 10 }).client.from("t"), {
      maxRows: 20, whenFull: "stop", what: "places", pageSize: 10, concurrentPages: 4,
    });
    assert.equal(stop.rows.length, 20, "RED a stop inside the waves answers with exactly the ceiling");
    assert.equal(stop.capped, true, "and says it was capped");
    const refuse = await readEveryPage<Row>(() => fakeClient({ rows: Array.from({ length: 40 }, (_u, i) => ({ id: i })), rowsPerRequest: 10 }).client.from("t"), {
      maxRows: 20, whenFull: "refuse", what: "places", pageSize: 10, concurrentPages: 4,
    });
    assert.equal(refuse.rows.length, 0, "RED a refusal inside the waves answers with no rows");
    assert.ok(refuse.error instanceof Error);

    const reviews = source("src/lib/phoenix-crm/server/validation-reviews.ts");
    const validated = reviews.slice(reviews.indexOf("export async function loadValidatedPlaces"), reviews.indexOf("function newestValidatedFirst"));
    assert.ok(validated.includes('rpc("phoenix_crm_validated_place_facts"'), "RED the four lookups behind the validated places are one database call");
    assert.equal(validated.includes('selectByIds<Row>("phoenix_crm_visits"'), false, "and the visit count is not read in 150-id chunks again");
    assert.ok(validated.includes("concurrentPages: 4"), "the active places are read four pages at a time");
    const facts = sql("supabase/migrations/20261108200549_phoenix_crm_validated_place_facts.sql");
    assert.ok(facts.includes("revoke execute on function public.phoenix_crm_validated_place_facts(uuid[], uuid[]) from public, anon, authenticated"), "and its function is the service role's alone");
    const notes = source("src/lib/phoenix-crm/server/place-notes.ts");
    const noteIndex = notes.slice(notes.indexOf("export async function loadPlaceNoteIndex"), notes.indexOf("function subjectKeyOf"));
    assert.equal(noteIndex.split("selectByIdsFewestRequests<Row>(").length - 1, 4, "RED the notes and recommendations take the fewest-requests read");
    const integrity = source("src/lib/phoenix-crm/server/integrity-board.ts");
    const placeCases = integrity.slice(integrity.indexOf("export async function loadPlaceCheckIntegrity"), integrity.indexOf("export type VisitReportCaseFacts"));
    assert.ok(placeCases.includes("selectByIdsFewestRequests<Row>("), "RED and so does the device evidence");
  }

  console.log("phoenix-crm sweep paging: OK");
}
