import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { chunk, dedupeIds, IN_ID_CHUNK, seatScoped } from "@/lib/phoenix-crm/server/db";

import { stripComments } from "./support/comment-strip.ts";

/**
 * Phoenix CRM — the Place checks page must survive a field that has grown.
 *
 * `/admin/field-crm/validation-reviews` went down on production with "Admin workspace unavailable"
 * once the active-place list crossed ~395 rows (482 on 2026-10-07). `loadValidatedPlaces` passed up to
 * 400 place/customer UUIDs straight into a PostgREST `.in()`, and PostgREST echoes the request URL back,
 * percent-encoded, in the `Content-Location` RESPONSE header — so the response header block crossed
 * undici's 16 KB cap and node's `fetch` threw `UND_ERR_HEADERS_OVERFLOW`, which the admin error boundary
 * showed as a crash. (`loadValidationReviews` carried the same latent bug at its 500-review cap.)
 *
 * The id-keyed reads now go through `selectByIds`, which de-duplicates and drops nullish ids (a single
 * `null` 22P02s the whole read), keeps each `.in()` chunk well below the ~395 cliff, and keyset-pages
 * each chunk so the 1,000-row cap cannot silently shorten it either. See the memory note
 * `postgrest-in-with-hundreds-of-ids-silently-returns-nothing`.
 */

const ROOT = new URL("../", import.meta.url);

function read(path: string): string {
  return stripComments(readFileSync(new URL(path, ROOT), "utf8").replace(/\r\n/g, "\n"));
}

/**
 * `export (async )?function name(...) { ... }` — the text from its signature to its closing brace at
 * column 0. `[\s\S]*?\(` tolerates a generic parameter list (`selectByIds<T …>(`) between name and
 * the first parenthesis, which is the argument list's.
 */
function functionBody(source: string, name: string): string {
  const match = new RegExp(`export (?:async )?function ${name}[\\s\\S]*?\\([\\s\\S]*?\\n\\}`).exec(source);
  assert.ok(match, `${name} is still an exported function — this test resolves it by that name`);
  return match[0];
}

/** The cliff that took the page down, measured on production: 395 ids succeed, 396 overflow. */
const OVERFLOW_CLIFF_IDS = 395;

function checkChunkStaysUnderTheCliff(): void {
  assert.equal(typeof IN_ID_CHUNK, "number", "IN_ID_CHUNK is a number");
  assert.ok(IN_ID_CHUNK >= 1, "IN_ID_CHUNK is positive");
  // The whole point: a single `.in()` chunk must stay well below the ~395-id header-overflow cliff.
  assert.ok(IN_ID_CHUNK < OVERFLOW_CLIFF_IDS, `IN_ID_CHUNK (${IN_ID_CHUNK}) must stay below the ${OVERFLOW_CLIFF_IDS}-id overflow cliff`);

  // 420 ids — past the cliff — with duplicates and nullish entries mixed in, as a real derived list is.
  const ids: Array<string | null | undefined> = [];
  for (let i = 0; i < 420; i += 1) ids.push(`id-${i}`);
  ids.push(ids[0], ids[0], null, undefined, "", ids[7]);

  const unique = dedupeIds(ids);
  assert.equal(unique.length, 420, "dedupeIds drops the duplicates and the nullish entries");
  assert.ok(
    !unique.some((id) => id === null || id === undefined || id === ""),
    "no nullish id survives — a single null would 22P02 the whole read",
  );

  const chunks = chunk(unique, IN_ID_CHUNK);
  assert.ok(chunks.length >= 2, "a 420-id list is split into more than one chunk");
  for (const part of chunks) {
    assert.ok(part.length <= IN_ID_CHUNK, `every chunk (${part.length}) stays at or under IN_ID_CHUNK (${IN_ID_CHUNK})`);
    assert.ok(part.length < OVERFLOW_CLIFF_IDS, "and so under the overflow cliff");
  }
  // Nothing is lost and nothing is read twice across the chunks.
  assert.deepEqual(chunks.flat(), unique, "the chunks concatenate back to the whole id list, in order");
}

function checkDedupeIds(): void {
  assert.deepEqual(dedupeIds(["a", "a", null, undefined, "", "b", "a"]), ["a", "b"], "dedupe, keep order, drop nullish and empty");
  assert.deepEqual(dedupeIds([]), [], "an empty list stays empty");
  assert.deepEqual(dedupeIds([null, undefined, ""]), [], "an all-nullish list collapses to nothing");
}

function checkSelectByIdsShape(): void {
  const db = read("src/lib/phoenix-crm/server/db.ts");
  const body = functionBody(db, "selectByIds");
  assert.match(body, /dedupeIds\(ids\)/, "selectByIds cleans the ids through dedupeIds");
  assert.match(body, /chunk\(unique, IN_ID_CHUNK\)/, "and chunks them by IN_ID_CHUNK, so no `.in()` can overflow");
  assert.match(body, /fetchAllRowsKeyset</, "and keyset-pages each chunk, so the 1,000-row cap cannot shorten it");
  assert.match(body, /cursorColumn = "id"/, "seeking on id by default, which every chunk's select must therefore include");
  assert.match(body, /cursorOf: \(row\) => \(row\[cursorColumn\]/, "and the cursor is read from the same column it seeks on");

  // A table with no `id` must name its own key, or the keyset orders on a column that is not there (42703).
  // phoenix_crm_visit_recordings is keyed on `path`; with `id` every day holding a visit failed to load
  // ("Could not load the visits."), seen first in the test accounts, the only ones with a visit that day.
  const recordings = read("src/lib/phoenix-crm/server/visit-recordings.ts");
  const loader = functionBody(recordings, "loadRecordingsByVisit");
  assert.match(
    loader,
    /selectByIds<Row>\("phoenix_crm_visit_recordings",[^;]*"visit_id",\s*visitIds,\s*undefined,\s*"path"\)/,
    "the recordings read seeks on path, the table's key, because it has no id",
  );
}

function checkLoadersGoThroughSelectByIds(): void {
  const service = read("src/lib/phoenix-crm/server/validation-reviews.ts");

  for (const name of ["loadValidatedPlaces", "loadValidationReviews"]) {
    const body = functionBody(service, name);
    // loadValidatedPlaces sends its ids in an RPC's POST body since 2026-11-08 — no URL, so no header to overflow.
    if (name === "loadValidationReviews") assert.match(body, /selectByIds</, `${name} reads its id-keyed tables through selectByIds`);
    else assert.match(body, /\.rpc\("phoenix_crm_validated_place_facts"/, `${name} sends its ids in one function call's body`);
    // The overflow path is a bare `.in(` on a derived id list — it must be gone from both loaders.
    assert.doesNotMatch(body, /\.in\(/, `${name} no longer issues a bare .in() that could overflow the request headers`);
  }

  // The two reads that return many rows per id must select `id`, or the keyset pager cannot seek.
  const validated = functionBody(service, "loadValidatedPlaces");
  // Since 2026-11-08 the many-rows-per-id reads are inside phoenix_crm_validated_place_facts: the visits are COUNTED
  // in the database (one number per place, so no row cap can shorten them) and every review of the customer comes
  // back in one jsonb value, status included (it tells held from merely reviewed).
  const facts = read("supabase/migrations/20261108200549_phoenix_crm_validated_place_facts.sql");
  assert.match(facts, /from public\.phoenix_crm_visits\s+where place_id = any\(p_place_ids\)\s+group by place_id/, "the visits are counted per place in the database");
  assert.match(facts, /from public\.phoenix_crm_validation_reviews r\s+where r\.customer_id = any\(p_customer_ids\)/, "and every review of these customers is read, whatever its status");

  // Production read audit, 28 Oct 2026: there is no index on `created_at`, so ordering the pages by it
  // made every page scan and sort the whole table. The pages walk the primary key; the board's
  // newest-first order is made in code, after the read.
  assert.match(
    validated,
    /seatScoped\(query, seats\)\.order\("id", \{ ascending: false \}\)/,
    "the validated-places pages are ordered by the primary key alone",
  );
  assert.doesNotMatch(validated, /\.order\("created_at"/, "no page of the validated-places read sorts on created_at");
  assert.match(validated, /\.sort\(newestValidatedFirst\)/, "the rows are put back newest first in code");
  const newest = /\nfunction newestValidatedFirst\([\s\S]*?\n\}/.exec(service)?.[0] ?? "";
  assert.ok(newest, "newestValidatedFirst is still the function the rows are sorted by");
  assert.match(newest, /right\.created_at/, "the in-code order is by created_at");
  assert.match(newest, /leftId < rightId \? 1 : -1/, "a tie on created_at falls to id, descending");
}

/**
 * The seat scope is the ONE `.in()` on this board that is not a derived id list — and it is bounded
 * where it is applied, not where it is written.
 *
 * Owner, 2026-10-13: a district manager's board shows "only his team". That filter is his own manager
 * seats, which `TEAM_PLACE_CHECKS_TIERS` caps at one district, so it is nowhere near the cliff above.
 * But `doesNotMatch(/\.in\(/)` is a TEXT check: a seat filter written inline would satisfy it merely by
 * being spelled differently, and a session reading that green would learn nothing about the bound. So
 * the filter goes through `seatScoped`, which is the one place that can check the bound — and does,
 * loudly, because the failure it replaces (`UND_ERR_HEADERS_OVERFLOW` rendered as "unavailable") names
 * nothing at all. Widening the tier set is what would arm it, which is why the message says so.
 */
function checkSeatScopeIsBoundedWhereItIsApplied(): void {
  const db = read("src/lib/phoenix-crm/server/db.ts");
  const body = functionBody(db, "seatScoped");
  assert.match(body, /if \(!seats\) return query;/, "a null scope is the whole company, and adds no filter at all");
  assert.match(body, /seats\.length > IN_ID_CHUNK/, "seatScoped checks the scope against the same cap selectByIds chunks by");
  assert.match(body, /throw new Error\(/, "and refuses an over-large scope here, rather than letting the request overflow on the wire");

  // Every Place checks read applies the scope through it, and none of them spells the filter inline.
  for (const path of ["src/lib/phoenix-crm/server/validation-reviews.ts", "src/lib/phoenix-crm/server/shared-places.ts"]) {
    const source = read(path);
    assert.match(source, /seatScoped\(query, seats\)/, `${path} narrows its reads through seatScoped`);
    assert.doesNotMatch(source, /query\.in\("seat_id"/, `${path} does not spell the seat filter inline, where nothing checks its size`);
  }

  // And it behaves: a null scope passes the query through untouched, a real one filters on seat_id,
  // and a scope past the cap throws instead of being sent.
  // `fake` is annotated rather than inferred: an object whose own method returns it is referenced
  // inside its own initializer, which TypeScript resolves to an implicit `any` and rejects.
  type FakeQuery = { in: (column: string, values: readonly string[]) => FakeQuery };
  const calls: Array<[string, readonly string[]]> = [];
  const fake: FakeQuery = { in: (column, values) => { calls.push([column, values]); return fake; } };
  assert.equal(seatScoped(fake, null), fake, "no scope, no filter");
  assert.equal(calls.length, 0, "and nothing was added to the query");
  seatScoped(fake, ["seat-1", "seat-2"]);
  assert.deepEqual(calls, [["seat_id", ["seat-1", "seat-2"]]], "a real scope filters on seat_id");
  assert.throws(
    () => seatScoped(fake, Array.from({ length: IN_ID_CHUNK + 1 }, (_, i) => `seat-${i}`)),
    /cannot be read in one request/,
    "a scope past the cap is refused by name, not sent and left to fail as a network fault",
  );
  assert.equal(calls.length, 1, "and the refused scope added no filter");
}

export function runPhoenixCrmPlaceChecksInOverflowTests(): void {
  checkChunkStaysUnderTheCliff();
  checkDedupeIds();
  checkSelectByIdsShape();
  checkLoadersGoThroughSelectByIds();
  checkSeatScopeIsBoundedWhereItIsApplied();
}
