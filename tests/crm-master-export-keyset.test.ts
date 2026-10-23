import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { CrmMasterRow } from "../src/lib/crm/master.ts";
import { masterExportCursorFilter, walkMasterExportPages } from "../src/lib/crm/master.ts";

/** A check-in row as the export's select returns it — only the two keys the walk reads. */
type Row = { check_date: string; crm_checkin_id: number };

/** The export's order: newest first, the vendor id breaking a tie. */
function descending(a: Row, b: Row): number {
  if (a.check_date !== b.check_date) return a.check_date < b.check_date ? 1 : -1;
  return b.crm_checkin_id - a.crm_checkin_id;
}

/** "Strictly after this row" on that order — what the PostgREST cursor filter means in SQL. */
function strictlyAfter(row: Row, cursor: { at: string; id: number } | null): boolean {
  if (cursor === null) return true;
  if (row.check_date !== cursor.at) return row.check_date < cursor.at;
  return row.crm_checkin_id < cursor.id;
}

/**
 * A reader over a fixed row set that answers exactly as the database does: the rows of `day` that
 * sort strictly after `cursor`, in the export's order, capped at `pageSize`. Records every call so
 * the walk's own decisions (day order, cursor advance, when it stops asking) can be asserted.
 */
function readerOver(rows: Row[], pageSize: number) {
  const calls: Array<{ cursor: { at: string; id: number } | null; day: string | null }> = [];
  // A cursor that does not advance asks for the same page for ever. Left to the walk's own runaway
  // stop that is a million rows and an out-of-memory crash, which reads like a broken test rather
  // than a broken cursor — so fail here, in the words of the actual defect.
  const maxReads = Math.ceil(rows.length / pageSize) * 2 + 8;
  const read = async (slice: { cursor: { at: string; id: number } | null; day: string | null }) => {
    calls.push({ cursor: slice.cursor ? { ...slice.cursor } : null, day: slice.day });
    assert.ok(
      calls.length <= maxReads,
      `the walk asked for ${calls.length} pages to read ${rows.length} rows at ${pageSize} a page — the cursor is not advancing past the page it was given`,
    );
    return rows
      .filter((row) => (slice.day === null || row.check_date.startsWith(slice.day)) && strictlyAfter(row, slice.cursor))
      .sort(descending)
      .slice(0, pageSize) as unknown as CrmMasterRow[];
  };
  return { calls, read };
}

async function collect(pages: AsyncGenerator<CrmMasterRow[], void, unknown>): Promise<Row[][]> {
  const out: Row[][] = [];
  for await (const page of pages) out.push(page as unknown as Row[]);
  return out;
}

const WALK = { dateColumn: "check_date", idColumn: "crm_checkin_id", maxRows: 1_000_000 };

export async function runCrmMasterExportKeysetTests() {
  // ── The cursor filter is the page boundary, and its exact shape is the whole correctness story ──
  assert.equal(
    masterExportCursorFilter("check_date", "crm_checkin_id", { at: "2026-10-22T09:30:00+00:00", id: 814_222 }),
    'check_date.lt."2026-10-22T09:30:00+00:00",and(check_date.eq."2026-10-22T09:30:00+00:00",crm_checkin_id.lt.814222)',
    "the check-ins cursor must be `date.lt OR (date.eq AND id.lt)` — a bare `date.lt` drops every other row sharing that timestamp",
  );
  assert.equal(
    masterExportCursorFilter("visit_date", "crm_visit_id", { at: "2026-10-22", id: -1_996_622_939_714 }),
    'visit_date.lt."2026-10-22",and(visit_date.eq."2026-10-22",crm_visit_id.lt.-1996622939714)',
    "the same shape must carry the visits door's date column and its negative synthesised Phoenix ids",
  );

  // ── A window of ties, paged: every row exactly once, in the single ordered scan's order ─────────
  // 2,500 rows over three days, 40 of them sharing one timestamp — more than a third of a page — so a
  // page boundary lands INSIDE a tie group, which is where a `lt`-only cursor drops rows and an
  // `lte`-only cursor repeats them for ever.
  const rows: Row[] = [];
  let id = 1;
  for (const day of ["2026-10-20", "2026-10-21", "2026-10-22"]) {
    for (let minute = 0; minute < 833; minute += 1) {
      const at = `${day}T${String(8 + Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}:00+00:00`;
      rows.push({ check_date: at, crm_checkin_id: id });
      id += 1;
    }
  }
  const tied = `2026-10-21T09:00:00+00:00`;
  for (let extra = 0; extra < 40; extra += 1) {
    rows.push({ check_date: tied, crm_checkin_id: id });
    id += 1;
  }
  const expected = [...rows].sort(descending);

  const pageSize = 100;
  const daysNewestFirst = ["2026-10-22", "2026-10-21", "2026-10-20"];
  const sliced = readerOver(rows, pageSize);
  const slicedPages = await collect(
    walkMasterExportPages({ ...WALK, days: daysNewestFirst, pageSize, read: sliced.read }),
  );
  const slicedRows = slicedPages.flat();
  assert.deepEqual(
    slicedRows.map((row) => row.crm_checkin_id),
    expected.map((row) => row.crm_checkin_id),
    "the day slices, newest first, must hand back exactly the rows of one ordered scan, in its order — no row dropped, none repeated",
  );
  assert.equal(
    new Set(slicedRows.map((row) => row.crm_checkin_id)).size,
    rows.length,
    `all ${rows.length} rows must appear exactly once across the pages`,
  );
  assert.deepEqual(
    [...new Set(sliced.calls.map((call) => call.day))],
    daysNewestFirst,
    "the days must be read in the order they were handed over — newest first, each one finished before the next",
  );
  for (const day of daysNewestFirst) {
    assert.equal(
      sliced.calls.find((call) => call.day === day)?.cursor,
      null,
      `the first page of ${day} must start with no cursor — a cursor carried over from the previous day skips that day's newest rows`,
    );
  }

  // ── An unbounded export (no date filter) keeps ONE keyset walk over the whole window ────────────
  const whole = readerOver(rows, pageSize);
  const wholeRows = (await collect(walkMasterExportPages({ ...WALK, days: null, pageSize, read: whole.read }))).flat();
  assert.deepEqual(
    wholeRows.map((row) => row.crm_checkin_id),
    expected.map((row) => row.crm_checkin_id),
    "days: null must still walk the whole window by cursor and return every row once, in order",
  );
  assert.ok(
    whole.calls.every((call) => call.day === null),
    "an unbounded export must never invent a day bound — a derived window would silently drop rows outside it",
  );
  assert.equal(
    whole.calls.length,
    Math.floor(rows.length / pageSize) + 1,
    "a keyset walk asks for one page per page of rows, plus the short page that ends it — never a page per page-squared, which is what OFFSET cost",
  );

  // ── Stopping conditions ────────────────────────────────────────────────────────────────────────
  const shortFirst = readerOver(rows.slice(0, 7), 100);
  const shortPages = await collect(
    walkMasterExportPages({ ...WALK, days: null, pageSize: 100, read: shortFirst.read }),
  );
  assert.equal(shortPages.length, 1, "a short first page is the whole result — asking again can only return nothing");
  assert.equal(shortFirst.calls.length, 1, "a short page must not be followed by another request");

  let emptyCalls = 0;
  const emptyPages = await collect(
    walkMasterExportPages({
      ...WALK,
      days: ["2026-10-22", "2026-10-21"],
      pageSize: 100,
      read: async () => {
        emptyCalls += 1;
        return [];
      },
    }),
  );
  assert.deepEqual(emptyPages, [], "a day with no rows yields nothing");
  assert.equal(emptyCalls, 2, "an empty day must end THAT day and move to the next, not the whole export");

  let missingCalls = 0;
  const missingPages = await collect(
    walkMasterExportPages({
      ...WALK,
      days: ["2026-10-22", "2026-10-21"],
      pageSize: 100,
      read: async () => {
        missingCalls += 1;
        return null;
      },
    }),
  );
  assert.deepEqual(missingPages, [], "a missing mirror schema yields nothing and never throws");
  assert.equal(missingCalls, 1, "a missing schema ends the whole walk — it cannot become present on the next day");

  const capped = readerOver(rows, pageSize);
  const cappedRows = (
    await collect(walkMasterExportPages({ dateColumn: "check_date", days: null, idColumn: "crm_checkin_id", maxRows: 250, pageSize, read: capped.read }))
  ).flat();
  assert.equal(cappedRows.length, 300, "the runaway stop is checked per page, so it ends the walk on the first page that reaches it");
  assert.ok(cappedRows.length < rows.length, "the runaway stop must actually stop a walk that would otherwise continue");

  // ── The OFFSET walk must not come back ─────────────────────────────────────────────────────────
  const source = readFileSync(new URL("../src/lib/crm/master.ts", import.meta.url), "utf8");
  const generator = source.slice(source.indexOf("export async function* streamCrmMasterExportPages"));
  assert.ok(
    !/\.range\(/.test(generator),
    "the streaming export must not page with .range() — OFFSET makes the database rebuild and throw away every row before each page (142,363 rows and 116,832 buffers per page, measured on production 2026-10-23)",
  );
  assert.ok(
    generator.includes("walkMasterExportPages({"),
    "the streaming export must page through walkMasterExportPages, which is where the keyset and the day slices are proved",
  );
  assert.ok(
    generator.includes("dayScanSlices(range.dateFrom, range.dateTo)?.slice().reverse()"),
    "a bounded export must walk calendar days NEWEST first — reversing the ascending slices is what keeps the export's own order",
  );
}
