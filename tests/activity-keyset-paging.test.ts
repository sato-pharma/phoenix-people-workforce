import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { fetchAllKeysetByTime } from "../src/lib/activity/service.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * Activity — the big activity_events reads page by KEYSET, not by OFFSET (PERF-015).
 *
 * The activity dashboard, the per-user timeline and the Excel export each read up to 200,000
 * activity_events rows 1,000 at a time. With `.range(offset, …)` every page made Postgres walk and
 * discard all the rows before it, so the read was quadratic; and the export had no order at all, so
 * two pages could disagree about which rows came first and a row could be read twice while its
 * neighbour was never read.
 *
 * `fetchAllKeysetByTime` seeks each page after the last row of the previous one on (created_at, id).
 * The fake client below is a small PostgREST: it enforces its own page size, parses the EXACT `or`
 * string the helper builds (anything else is refused, never guessed at), sorts by the orders it is
 * given, and has no `.range()` at all. The fixture puts seven rows on ONE created_at across a page
 * boundary — the case an offset read without a tie-break gets wrong.
 */

const ROOT = new URL("../", import.meta.url);
const SERVER_PAGE = 5;

type FixtureRow = { id: string; hr_id: string; path: string; created_at: string };

// Timestamps in PostgREST's own shape, with the `.`, `:` and `+` the or-grammar would trip on unquoted.
function ts(minute: number): string {
  return `2026-09-26T10:${String(minute).padStart(2, "0")}:00.123456+00:00`;
}

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

/** 23 rows. Minute 7 holds seven rows (ids out of insertion order), straddling the 5-row page seam. */
function fixture(): FixtureRow[] {
  const rows: FixtureRow[] = [];
  const minutes = [1, 2, 3, 4, 5, 6, 7, 7, 7, 7, 7, 7, 7, 8, 9, 10, 11, 12, 12, 13, 14, 15, 16];
  const idOrder = [3, 17, 9, 1, 22, 14, 6, 20, 11, 2, 18, 8, 13, 5, 21, 10, 16, 4, 19, 7, 12, 15, 0];
  minutes.forEach((minute, index) => {
    rows.push({
      id: uuid(idOrder[index] * 7919 + 11),
      hr_id: index % 3 === 0 ? "B-10" : index % 3 === 1 ? "b-10" : "B-200",
      path: `/page/${index}`,
      created_at: ts(minute),
    });
  });
  return rows;
}

function compareKey(left: FixtureRow, right: FixtureRow): number {
  if (left.created_at !== right.created_at) return left.created_at < right.created_at ? -1 : 1;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

const OR_SHAPE = /^created_at\.(gt|lt)\."([^"]+)",and\(created_at\.eq\."([^"]+)",id\.(gt|lt)\.([0-9a-f-]+)\)$/;

type Calls = { orStrings: string[]; limits: number[]; selects: string[]; pages: number };

/** A fake PostgREST over `rows`. `failOnPage` makes that (1-based) page answer with `failWith`. */
function fakeClient(
  rows: FixtureRow[],
  options: { failOnPage?: number; failWith?: { code?: string; message: string } } = {},
): { client: { from: (table: string) => unknown }; calls: Calls } {
  const calls: Calls = { orStrings: [], limits: [], selects: [], pages: 0 };
  const client = {
    from(table: string) {
      assert.equal(table, "activity_events", "the helper reads the table it was given");
      return {
        select(columns: string) {
          calls.selects.push(columns);
          const columnList = columns.split(",").map((column) => column.trim());
          const filters: Array<(row: FixtureRow) => boolean> = [];
          const orders: Array<{ column: "created_at" | "id"; ascending: boolean }> = [];
          let limit: number | null = null;
          const builder = {
            gte(column: keyof FixtureRow, value: string) {
              filters.push((row) => row[column] >= value);
              return builder;
            },
            lte(column: keyof FixtureRow, value: string) {
              filters.push((row) => row[column] <= value);
              return builder;
            },
            in(column: keyof FixtureRow, values: string[]) {
              filters.push((row) => values.includes(row[column]));
              return builder;
            },
            or(filter: string) {
              calls.orStrings.push(filter);
              const match = OR_SHAPE.exec(filter);
              assert.ok(match, `the fake PostgREST refuses an or-filter it cannot parse exactly: ${filter}`);
              const [, outerOp, outerTs, eqTs, idOp, id] = match;
              assert.equal(outerOp, idOp, "the created_at seek and the id tie-break must point the same way");
              assert.equal(outerTs, eqTs, "both halves of the seek name the same cursor timestamp");
              const after = outerOp === "gt";
              filters.push((row) =>
                after
                  ? row.created_at > outerTs || (row.created_at === eqTs && row.id > id)
                  : row.created_at < outerTs || (row.created_at === eqTs && row.id < id),
              );
              return builder;
            },
            order(column: "created_at" | "id", opts: { ascending: boolean }) {
              orders.push({ column, ascending: opts.ascending });
              return builder;
            },
            limit(count: number) {
              limit = count;
              calls.limits.push(count);
              return builder;
            },
            then(resolve: (value: { data: unknown; error: unknown }) => unknown, reject?: (reason: unknown) => unknown) {
              try {
                calls.pages += 1;
                if (options.failOnPage === calls.pages) return Promise.resolve({ data: null, error: options.failWith }).then(resolve, reject);
                const matched = rows.filter((row) => filters.every((keep) => keep(row)));
                matched.sort((left, right) => {
                  for (const order of orders) {
                    const a = left[order.column];
                    const b = right[order.column];
                    if (a !== b) return (a < b ? -1 : 1) * (order.ascending ? 1 : -1);
                  }
                  return 0;
                });
                // PostgREST's own ceiling: never more than SERVER_PAGE rows, whatever was asked.
                const take = Math.min(limit ?? SERVER_PAGE, SERVER_PAGE);
                const data = matched.slice(0, take).map((row) => {
                  const projected: Record<string, unknown> = {};
                  for (const column of columnList) projected[column] = row[column as keyof FixtureRow];
                  return projected;
                });
                return Promise.resolve({ data, error: null }).then(resolve, reject);
              } catch (error) {
                return Promise.reject(error).then(resolve, reject);
              }
            },
          };
          return builder;
        },
      };
    },
  };
  return { client, calls };
}

const COLUMNS = "hr_id,path,created_at";

function project(rows: FixtureRow[], withId: boolean): Array<Record<string, unknown>> {
  return rows.map((row) => (withId ? { id: row.id, hr_id: row.hr_id, path: row.path, created_at: row.created_at } : { hr_id: row.hr_id, path: row.path, created_at: row.created_at }));
}

export async function runActivityKeysetPagingTests(): Promise<void> {
  const rows = fixture();
  const ascending = [...rows].sort(compareKey);
  const descending = [...ascending].reverse();

  // ── 1. Every row, once, in (created_at, id) order — both directions ──────────────────────────
  for (const direction of ["asc", "desc"] as const) {
    const { client, calls } = fakeClient(rows);
    const result = await fetchAllKeysetByTime("activity_events", COLUMNS, (q) => q, direction, 1_000, { client, pageSize: SERVER_PAGE });
    const expected = direction === "asc" ? ascending : descending;
    assert.deepEqual(
      result.rows,
      project(expected, false),
      `🔴 a ${direction} keyset read must return every row exactly once, sorted by (created_at, id) — seven rows share one created_at across a page seam`,
    );
    assert.equal(new Set(result.rows.map((row) => row.path)).size, rows.length, `the ${direction} read has no duplicates and no losses`);
    assert.equal(result.truncated, false, `a ${direction} read that ran out of rows is not truncated`);
    assert.ok(calls.selects.every((columns) => columns === `${COLUMNS},id`), "id is selected for the cursor when the caller did not ask for it");
    assert.ok(result.rows.every((row) => !("id" in row)), "and taken off again, so the rows keep the caller's own shape");
    assert.ok(calls.limits.every((limit) => limit === SERVER_PAGE), "every page asks for exactly the page size");
    assert.equal(calls.orStrings.length, calls.pages - 1, "every page after the first seeks from a cursor");
    assert.ok(
      calls.orStrings.every((filter) => filter.includes(direction === "asc" ? "created_at.gt.\"" : "created_at.lt.\"")),
      `a ${direction} read seeks ${direction === "asc" ? "forward (gt)" : "backward (lt)"} with a double-quoted timestamp`,
    );
  }

  // ── 2. The caller's own filters still apply, and a caller who selects id keeps it ────────────
  {
    const { client } = fakeClient(rows);
    const result = await fetchAllKeysetByTime(
      "activity_events",
      `id,${COLUMNS}`,
      (q) => q.in("hr_id", ["B-10", "b-10"]).gte("created_at", ts(3)).lte("created_at", ts(12)),
      "asc",
      1_000,
      { client, pageSize: SERVER_PAGE },
    );
    const expected = ascending.filter((row) => (row.hr_id === "B-10" || row.hr_id === "b-10") && row.created_at >= ts(3) && row.created_at <= ts(12));
    assert.ok(expected.length > SERVER_PAGE, "the filtered window still spans more than one page");
    assert.deepEqual(
      result.rows.map((row) => ({ id: row.id, hr_id: row.hr_id, path: row.path, created_at: row.created_at })),
      project(expected, true),
      "the caller's filters are ANDed with the seek, and a caller who selected id keeps it",
    );
  }

  // ── 3. The cap: truncated fires exactly when a full page lands on it ──────────────────────────
  {
    const atTen = await fetchAllKeysetByTime("activity_events", COLUMNS, (q) => q, "desc", 10, { client: fakeClient(rows).client, pageSize: SERVER_PAGE });
    assert.equal(atTen.rows.length, 10, "a cap of 10 returns exactly 10 rows");
    assert.equal(atTen.truncated, true, "🔴 a read stopped by the cap with rows still waiting must say truncated");
    assert.deepEqual(atTen.rows, project(descending.slice(0, 10), false), "and the 10 it returns are the newest 10");

    const above = await fetchAllKeysetByTime("activity_events", COLUMNS, (q) => q, "desc", 25, { client: fakeClient(rows).client, pageSize: SERVER_PAGE });
    assert.equal(above.rows.length, rows.length, "a cap above the row count returns every row");
    assert.equal(above.truncated, false, "🔴 a read that ran out before the cap must NOT say truncated");

    // fetchAll's documented edge: a full last page landing exactly on the cap reports truncated,
    // because the read cannot know there is nothing after it. The keyset reader keeps that.
    const twenty = rows.slice(0, 20);
    const exact = await fetchAllKeysetByTime("activity_events", COLUMNS, (q) => q, "asc", 20, { client: fakeClient(twenty).client, pageSize: SERVER_PAGE });
    assert.equal(exact.rows.length, 20, "a cap equal to the row count returns them all");
    assert.equal(exact.truncated, true, "a full page landing exactly on the cap keeps fetchAll's truncated semantics");
  }

  // ── 4. The missing-relation degrade and a real error ─────────────────────────────────────────
  {
    const missing = await fetchAllKeysetByTime("activity_events", COLUMNS, (q) => q, "desc", 1_000, {
      client: fakeClient(rows, { failOnPage: 2, failWith: { code: "42P01", message: 'relation "activity_events" does not exist' } }).client,
      pageSize: SERVER_PAGE,
    });
    assert.deepEqual(missing, { rows: project(descending.slice(0, SERVER_PAGE), false), truncated: false }, "a missing table degrades to what was read, not truncated, exactly like fetchAll");

    await assert.rejects(
      fetchAllKeysetByTime("activity_events", COLUMNS, (q) => q, "desc", 1_000, {
        client: fakeClient(rows, { failOnPage: 1, failWith: { code: "57014", message: "statement timeout" } }).client,
        pageSize: SERVER_PAGE,
      }),
      /Failed to read activity_events: statement timeout/,
      "any other error throws rather than returning a fragment",
    );
  }

  // ── 5. The source: no activity_events read pages by offset except the one-page live feed ─────
  {
    const source = stripComments(readFileSync(new URL("src/lib/activity/service.ts", ROOT), "utf8"));
    // Each read ends in its cap constant, so the first `*_CAP` after the table name is that read's cap.
    const offsetReadCaps = [...source.matchAll(/\bfetchAll\(\s*"activity_events",[\s\S]*?\b([A-Z_]+_CAP)\b/g)].map((match) => match[1]);
    assert.equal(
      offsetReadCaps.length,
      1,
      `🔴 exactly one activity_events read may use the offset fetchAll — the one-page live feed — found ${offsetReadCaps.length} (${offsetReadCaps.join(", ")})`,
    );
    assert.equal(offsetReadCaps[0], "LIVE_EVENT_FETCH_CAP", "the one offset read left is the live feed, capped at one page");
    const keysetReads = source.match(/\bfetchAllKeysetByTime\(\s*"activity_events"/g)?.length ?? 0;
    assert.equal(keysetReads, 3, `the overview, the per-user timeline and the export read activity_events by keyset — found ${keysetReads}`);

    const helperStart = source.indexOf("export async function fetchAllKeysetByTime(");
    const helperEnd = source.indexOf("\nfunction withoutCursorId", helperStart);
    assert.ok(helperStart > 0 && helperEnd > helperStart, "the keyset helper is found in the source");
    assert.equal(source.slice(helperStart, helperEnd).includes(".range("), false, "the keyset helper never pages by offset");
  }

  console.log("activity keyset paging: OK");
}
