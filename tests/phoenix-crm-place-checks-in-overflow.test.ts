import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { chunk, dedupeIds, IN_ID_CHUNK } from "@/lib/phoenix-crm/server/db";

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
  assert.match(body, /cursorColumn: "id"/, "seeking on id, which every chunk's select must therefore include");
}

function checkLoadersGoThroughSelectByIds(): void {
  const service = read("src/lib/phoenix-crm/server/validation-reviews.ts");

  for (const name of ["loadValidatedPlaces", "loadValidationReviews"]) {
    const body = functionBody(service, name);
    assert.match(body, /selectByIds</, `${name} reads its id-keyed tables through selectByIds`);
    // The overflow path is a bare `.in(` on a derived id list — it must be gone from both loaders.
    assert.doesNotMatch(body, /\.in\(/, `${name} no longer issues a bare .in() that could overflow the request headers`);
  }

  // The two reads that return many rows per id must select `id`, or the keyset pager cannot seek.
  const validated = functionBody(service, "loadValidatedPlaces");
  assert.match(validated, /selectByIds<Row>\(\s*"phoenix_crm_visits",\s*"id, place_id"/, "the visits read carries id for the keyset walk");
  // Since 2026-10-08 it reads EVERY review of the customer (status tells held from merely reviewed),
  // so the select carries status beside the id the pager seeks on.
  assert.match(validated, /selectByIds<Row>\(\s*"phoenix_crm_validation_reviews",\s*"id, place_id, status"/, "the review read carries id too");
}

export function runPhoenixCrmPlaceChecksInOverflowTests(): void {
  checkChunkStaysUnderTheCliff();
  checkDedupeIds();
  checkSelectByIdsShape();
  checkLoadersGoThroughSelectByIds();
}
