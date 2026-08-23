import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { moveMarketingVenueChildren } from "../src/lib/marketing-requests/service.ts";

// The marketing venue merge trail.
//
// `direct_order_pharmacies` has carried merged_into_pharmacy_id since 2026-08-09, and it was used
// properly on 2026-08-13 to fold four duplicate nursery rows into one. `marketing_pharmacies` had
// no equivalent, so the only way to express a marketing merge was to deactivate the duplicate and
// write a sentence into validation_notes. That is not navigable: a pharmacy_code quoted in an older
// report resolves to a dead row with nothing saying where the live one is, which is exactly how one
// duplicated nursery capture cost a full re-investigation on 2026-08-23.
//
// The subtle half of this is NOT the columns — it is that moving children between venues collides
// by design. Three partial unique indexes make 23505 an ordinary outcome here, so those paths are
// exercised for real against a fake client; the database-side guarantees are pinned at the source.

const MIGRATION = "supabase/migrations/20260823080000_marketing_venue_merge.sql";
const SERVICE = "src/lib/marketing-requests/service.ts";

function read(path: string) {
  return readFileSync(path, "utf8");
}

/**
 * A client answering exactly the two calls the mover makes. Cast with `as never` at the call site
 * so the test need not reproduce the real client's type surface to exercise five lines of loop.
 */
function fakeClient(rows: Array<{ id: string }>, failures: Record<string, { code?: string }>) {
  const applied: Array<{ id: string; values: Record<string, unknown> }> = [];
  const client = {
    from() {
      return {
        select() {
          return {
            eq: async () => ({ data: rows, error: null }),
          };
        },
        update(values: Record<string, unknown>) {
          return {
            eq: async (_column: string, id: string) => {
              const failure = failures[id];
              if (failure) return { error: failure };
              applied.push({ id, values });
              return { error: null };
            },
          };
        },
      };
    },
  };
  return { applied, client };
}

async function testACollidingChildIsCountedNotThrown() {
  const { applied, client } = fakeClient([{ id: "a" }, { id: "b" }], { b: { code: "23505" } });

  // Caught explicitly: a Postgres error is a plain object, not an Error, so letting it propagate
  // would report `[object Object]` from no identifiable test rather than naming the rule that broke.
  const outcome = await moveMarketingVenueChildren(
    client as never,
    "marketing_customer_pharmacies",
    "pharmacy_id",
    "loser",
    "survivor",
  ).catch((error: unknown) => {
    assert.fail(
      `a 23505 collision must be tolerated and counted, not thrown — got ${JSON.stringify(error)}`,
    );
  });

  assert.equal(outcome.moved, 1, "the child that could move must be counted as moved");
  assert.equal(
    outcome.alreadyOnSurvivor,
    1,
    "a 23505 means the survivor already holds the equivalent child — the end state a merge wants, so it must be counted, not thrown",
  );
  assert.deepEqual(applied.map((row) => row.id), ["a"], "only the non-colliding child is rewritten");
}

async function testOneCollisionDoesNotAbortTheOtherMoves() {
  const { applied, client } = fakeClient(
    [{ id: "a" }, { id: "b" }, { id: "c" }],
    { b: { code: "23505" } },
  );

  const outcome = await moveMarketingVenueChildren(
    client as never,
    "marketing_request_pharmacies",
    "pharmacy_id",
    "loser",
    "survivor",
  );

  // The whole reason this is a loop and not one bulk UPDATE ... WHERE pharmacy_id = loser.
  assert.deepEqual(
    applied.map((row) => row.id),
    ["a", "c"],
    "a collision in the middle must not stop the children after it from moving",
  );
  assert.equal(outcome.moved, 2);
  assert.equal(outcome.alreadyOnSurvivor, 1);
}

async function testARealFailureStillThrows() {
  const { client } = fakeClient([{ id: "a" }], { a: { code: "23503" } });

  await assert.rejects(
    () => moveMarketingVenueChildren(
      client as never,
      "marketing_pharmacy_distributor_codes",
      "pharmacy_id",
      "loser",
      "survivor",
    ),
    (error: unknown) => String((error as { code?: string }).code) === "23503",
    "only 23505 is tolerable — every other database error must surface instead of being swallowed as already-there",
  );
}

async function testTheChildIsRewrittenOntoTheSurvivor() {
  const { applied, client } = fakeClient([{ id: "a" }], {});

  await moveMarketingVenueChildren(
    client as never,
    "marketing_customer_direct_order_transfers",
    "marketing_pharmacy_id",
    "loser",
    "survivor",
  );

  assert.deepEqual(
    applied[0]?.values,
    { marketing_pharmacy_id: "survivor" },
    "the mover must write the survivor id into the column it was given, not a hard-coded pharmacy_id",
  );
}

function testTheMigrationAddsTheWholeTrail() {
  const sql = read(MIGRATION);
  for (const column of ["merged_into_pharmacy_id uuid", "merged_at timestamptz", "merged_by_hr_id text"]) {
    assert.match(sql, new RegExp(column.replace(/ /g, "\\s+")), `the migration must add ${column}`);
  }
}

function testDeletingASurvivorMustNotDeleteTheRecordOfItsDuplicates() {
  const sql = read(MIGRATION);
  assert.match(
    sql,
    /references public\.marketing_pharmacies\(id\) on delete set null/,
    "the merge FK must be ON DELETE SET NULL — CASCADE would make deleting a survivor silently delete every duplicate that pointed at it",
  );
  assert.doesNotMatch(sql, /merged_into_fkey[\s\S]{0,200}on delete cascade/, "the merge FK must never be CASCADE");
}

function testAVenueCannotBeMergedIntoItself() {
  const sql = read(MIGRATION);
  assert.match(
    sql,
    /check \(merged_into_pharmacy_id is null or merged_into_pharmacy_id <> id\)/,
    "one mistyped id would otherwise make a venue its own survivor, which reads as merged while pointing nowhere",
  );
}

function testTheBackfillCannotFireOnTheWrongDatabaseOrOverwriteALaterMerge() {
  const sql = read(MIGRATION);
  const backfill = sql.slice(sql.indexOf("update public.marketing_pharmacies"));
  assert.match(
    backfill,
    /and merged_into_pharmacy_id is null/,
    "re-running the migration must never overwrite a real merge recorded after it",
  );
  assert.match(
    backfill,
    /and exists \(\s*select 1 from public\.marketing_pharmacies survivor/,
    "the backfill must no-op where the survivor does not exist, or it violates the FK on any database that lacks these rows",
  );
}

function testTheLosingVenueIsDeactivated() {
  const service = read(SERVICE);
  const mark = service.slice(service.indexOf("const markResult = await supabase"), service.length);
  assert.match(
    mark.slice(0, 700),
    /active: false/,
    "deactivating is what actually removes the duplicate from the Customer Database, the target picker and the master matcher — a merged-but-active row is still offered, which is how second copies get made",
  );
}

function testTheMarkIsIdempotentUnderAParallelSession() {
  const service = read(SERVICE);
  assert.match(
    service,
    /\.eq\("id", loserId\)[\s\S]{0,300}\.is\("merged_into_pharmacy_id", null\)/,
    "the mark must be guarded on merged_into_pharmacy_id being null, or a parallel merge gets its survivor overwritten by ours",
  );
}

function testTheMergeCannotBeSilent() {
  const service = read(SERVICE);
  const fn = service.slice(service.indexOf("export async function mergeMarketingVenue"));
  assert.match(
    fn,
    /await writeRequiredAuditLog\(/,
    "a structural change that retires one physical place in favour of another must use the required audit writer, not the best-effort one",
  );
  assert.match(fn, /entityType: "marketing_pharmacy"/, "the audit row must name the venue entity");
}

function testEveryChildTableIsMoved() {
  const service = read(SERVICE);
  const fn = service.slice(service.indexOf("export async function mergeMarketingVenue"));
  // The complete set of foreign keys pointing at marketing_pharmacies, verified against production
  // 2026-08-23. Missing one strands rows on a deactivated venue where nothing can reach them.
  for (const table of [
    "marketing_customer_pharmacies",
    "marketing_request_pharmacies",
    "marketing_pharmacy_distributor_codes",
    "marketing_customer_direct_order_transfers",
  ]) {
    assert.match(fn, new RegExp(`"${table}"`), `${table} points at marketing_pharmacies and must be moved by a merge`);
  }
  assert.match(
    fn,
    /"marketing_customer_direct_order_transfers", "marketing_pharmacy_id"/,
    "the transfers table names the venue column differently — passing pharmacy_id would silently move nothing",
  );
}

function testMergingIntoATombstoneIsRefused() {
  const service = read(SERVICE);
  const fn = service.slice(service.indexOf("export async function mergeMarketingVenue"));
  assert.match(
    fn,
    /if \(survivor\.mergedIntoPharmacyId\)/,
    "merging into a venue that was itself merged would build a chain every reader then has to walk",
  );
  assert.match(fn, /if \(loser\.mergedIntoPharmacyId\)/, "a venue must not be merged twice");
  assert.match(fn, /survivorId === loserId/, "a venue must not be merged into itself");
}

function testOnlyMarketingControlAuthorityMayMerge() {
  const service = read(SERVICE);
  const fn = service.slice(service.indexOf("export async function mergeMarketingVenue"));
  assert.match(
    fn.slice(0, 400),
    /assertMarketingControlAccess\(access\)/,
    "the merge must assert authority before it reads or writes anything — server-side access control is the boundary",
  );
}

export async function runMarketingVenueMergeTests() {
  await testACollidingChildIsCountedNotThrown();
  await testOneCollisionDoesNotAbortTheOtherMoves();
  await testARealFailureStillThrows();
  await testTheChildIsRewrittenOntoTheSurvivor();
  testTheMigrationAddsTheWholeTrail();
  testDeletingASurvivorMustNotDeleteTheRecordOfItsDuplicates();
  testAVenueCannotBeMergedIntoItself();
  testTheBackfillCannotFireOnTheWrongDatabaseOrOverwriteALaterMerge();
  testTheLosingVenueIsDeactivated();
  testTheMarkIsIdempotentUnderAParallelSession();
  testTheMergeCannotBeSilent();
  testEveryChildTableIsMoved();
  testMergingIntoATombstoneIsRefused();
  testOnlyMarketingControlAuthorityMayMerge();
}
