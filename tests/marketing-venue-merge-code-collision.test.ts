import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  moveMarketingVenueChildren,
  settleMarketingVenueCodeCollisions,
} from "../src/lib/marketing-requests/service.ts";

// A venue merge must not leave the survivor's links naming the duplicate's distributor code.
//
// Production, 2026-11-14 22:14 Cairo: two "اسامه" venues carrying the same POS code 11568735 were
// merged. The merge moves links and request targets first, then codes. The duplicate's code could
// not move — the survivor already held (distributor, 11568735), so it hit
// marketing_pharmacy_distributor_codes_unique and was stepped over — but the customer link had
// already moved onto the survivor still carrying that leftover code's id. The leftover stayed
// active, so it also kept surfacing as an unmatched code in the nightly master re-check. It was
// fixed by hand. These tests run the real movers against an in-memory database that enforces the
// real unique constraints, so they fail the moment the settle step is missing or wrong.

const SERVICE = "src/lib/marketing-requests/service.ts";

type Row = Record<string, unknown> & { id: string };

/** The unique constraints the merge can hit, copied from supabase/schema/production.sql. */
const UNIQUE: Record<string, string[][]> = {
  marketing_customer_pharmacies: [["customer_id", "distributor_code_id"]],
  marketing_pharmacy_distributor_codes: [["pharmacy_id", "distributor_id", "normalized_pharmacy_code"]],
  marketing_request_pharmacies: [["request_id", "distributor_code_id"]],
};

function fakeDatabase(tables: Record<string, Row[]>) {
  const rowsOf = (table: string) => (tables[table] ??= []);

  function violatesUnique(table: string, candidate: Row) {
    return (UNIQUE[table] ?? []).some((columns) =>
      rowsOf(table).some(
        (other) =>
          other.id !== candidate.id
          // Postgres treats NULLs as distinct in a plain UNIQUE constraint.
          && columns.every((column) => candidate[column] != null && other[column] === candidate[column]),
      ),
    );
  }

  const client = {
    from(table: string) {
      return {
        select() {
          return {
            eq: async (column: string, value: unknown) => ({
              data: rowsOf(table).filter((row) => row[column] === value).map((row) => ({ ...row })),
              error: null,
            }),
          };
        },
        update(values: Record<string, unknown>) {
          return {
            eq: async (column: string, value: unknown) => {
              for (const row of rowsOf(table).filter((candidate) => candidate[column] === value)) {
                const next = { ...row, ...values };
                if (violatesUnique(table, next)) {
                  return { error: { code: "23505", message: `duplicate key on ${table}` } };
                }
                Object.assign(row, values);
              }
              return { error: null };
            },
          };
        },
      };
    },
  };

  return { client: client as never, rowsOf };
}

/** The merge's own order: links, request targets, codes, transfers — then the settle step. */
async function runMergeMoves(client: never, loserId: string, survivorId: string) {
  await moveMarketingVenueChildren(client, "marketing_customer_pharmacies", "pharmacy_id", loserId, survivorId);
  await moveMarketingVenueChildren(client, "marketing_request_pharmacies", "pharmacy_id", loserId, survivorId);
  await moveMarketingVenueChildren(client, "marketing_pharmacy_distributor_codes", "pharmacy_id", loserId, survivorId);
  await moveMarketingVenueChildren(
    client, "marketing_customer_direct_order_transfers", "marketing_pharmacy_id", loserId, survivorId,
  );
  return settleMarketingVenueCodeCollisions(client, loserId, survivorId, "2026-11-14T20:14:00.000Z");
}

function code(id: string, pharmacyId: string, normalized: string, notes: string | null = null): Row {
  return {
    active: true,
    distributor_id: 7,
    id,
    normalized_pharmacy_code: normalized,
    pharmacy_id: pharmacyId,
    validation_notes: notes,
  };
}

async function testTheProductionCaseEndsWithEveryLinkOnTheSurvivorsOwnCode() {
  const { client, rowsOf } = fakeDatabase({
    marketing_customer_pharmacies: [
      { customer_id: "customer-1", distributor_code_id: "code-loser", id: "link-1", pharmacy_id: "loser" },
    ],
    marketing_pharmacy_distributor_codes: [
      code("code-loser", "loser", "11568735", "Captured by the rep."),
      code("code-survivor", "survivor", "11568735"),
    ],
    marketing_request_pharmacies: [
      { distributor_code_id: "code-loser", id: "target-1", pharmacy_id: "loser", request_id: "request-1" },
    ],
  });

  const outcome = await runMergeMoves(client, "loser", "survivor");

  const codes = new Map(rowsOf("marketing_pharmacy_distributor_codes").map((row) => [row.id, row]));
  for (const table of ["marketing_customer_pharmacies", "marketing_request_pharmacies"]) {
    for (const row of rowsOf(table)) {
      assert.equal(row.pharmacy_id, "survivor", `${table} ${row.id} must be on the survivor`);
      assert.equal(
        codes.get(String(row.distributor_code_id))?.pharmacy_id,
        "survivor",
        `${table} ${row.id} names distributor code ${String(row.distributor_code_id)}, which belongs to the merged duplicate — `
        + "a link on the survivor must name the survivor's own copy of the code",
      );
    }
  }

  const leftover = codes.get("code-loser");
  assert.equal(leftover?.pharmacy_id, "loser", "the colliding code cannot move, so it stays on the duplicate");
  assert.equal(
    leftover?.active,
    false,
    "the duplicate's leftover code must be switched off, or the nightly master re-check keeps listing it as an active unmatched code",
  );
  assert.match(
    String(leftover?.validation_notes),
    /^Captured by the rep\.\nDuplicate left by the venue merge on .+: the surviving venue already holds this distributor code/,
    "the leftover keeps its earlier note and gains one line saying it was a duplicate left by the merge",
  );
  assert.equal(codes.get("code-survivor")?.active, true, "the survivor's own code is untouched");

  assert.deepEqual(outcome, {
    alreadyOnSurvivorCode: 0,
    customerLinksRepointed: 1,
    duplicateCodesRetired: 1,
    requestTargetsRepointed: 1,
  });
}

async function testARepointThatCollidesIsCountedAndLeftNotThrown() {
  // The same customer already holds the survivor's code, so the second link cannot take it too.
  const { client, rowsOf } = fakeDatabase({
    marketing_customer_pharmacies: [
      { customer_id: "customer-2", distributor_code_id: "code-survivor", id: "link-kept", pharmacy_id: "survivor" },
      { customer_id: "customer-2", distributor_code_id: "code-loser", id: "link-duplicate", pharmacy_id: "loser" },
    ],
    marketing_pharmacy_distributor_codes: [
      code("code-loser", "loser", "11568735"),
      code("code-survivor", "survivor", "11568735"),
    ],
  });

  const outcome = await runMergeMoves(client, "loser", "survivor").catch((error: unknown) => {
    assert.fail(`a repoint colliding on (customer, code) must be counted, not thrown — got ${JSON.stringify(error)}`);
  });

  assert.equal(outcome.alreadyOnSurvivorCode, 1, "the colliding repoint is counted");
  assert.equal(outcome.customerLinksRepointed, 0);
  assert.equal(
    rowsOf("marketing_customer_pharmacies").find((row) => row.id === "link-duplicate")?.distributor_code_id,
    "code-loser",
    "the colliding link is left as it was — nothing is deleted",
  );
  assert.equal(outcome.duplicateCodesRetired, 1, "the leftover code is still switched off");
}

async function testACodeThatMovedIsNeitherRetiredNorRepointed() {
  const { client, rowsOf } = fakeDatabase({
    marketing_customer_pharmacies: [
      { customer_id: "customer-3", distributor_code_id: "code-unique", id: "link-3", pharmacy_id: "loser" },
    ],
    marketing_pharmacy_distributor_codes: [code("code-unique", "loser", "555")],
  });

  const outcome = await runMergeMoves(client, "loser", "survivor");

  const moved = rowsOf("marketing_pharmacy_distributor_codes")[0];
  assert.equal(moved.pharmacy_id, "survivor", "a code the survivor lacks simply moves");
  assert.equal(moved.active, true, "a code that moved must stay active — only a duplicate is switched off");
  assert.equal(rowsOf("marketing_customer_pharmacies")[0].distributor_code_id, "code-unique");
  assert.deepEqual(outcome, {
    alreadyOnSurvivorCode: 0,
    customerLinksRepointed: 0,
    duplicateCodesRetired: 0,
    requestTargetsRepointed: 0,
  });
}

function testTheMergeSettlesCollisionsAfterTheCodesMoveAndReportsIt() {
  const service = readFileSync(SERVICE, "utf8");
  const fn = service.slice(service.indexOf("export async function mergeMarketingVenue"));
  const codesMove = fn.indexOf('"marketing_pharmacy_distributor_codes", "pharmacy_id"');
  const settle = fn.indexOf("await settleMarketingVenueCodeCollisions(supabase, loserId, survivorId");
  assert.ok(codesMove > 0, "the merge must still move the distributor codes");
  assert.ok(
    settle > codesMove,
    "the merge must call settleMarketingVenueCodeCollisions after the codes move — before it, no code has collided yet",
  );
  assert.ok(
    settle < fn.indexOf("await writeRequiredAuditLog("),
    "the settle step must run before the audit row so its counts are in the summary",
  );
  for (const field of ["duplicateCodesRetired", "customerLinksRepointed", "requestTargetsRepointed"]) {
    assert.match(fn, new RegExp(`\\$\\{result\\.${field}\\}`), `the audit summary must state ${field}`);
  }
}

export async function runMarketingVenueMergeCodeCollisionTests() {
  await testTheProductionCaseEndsWithEveryLinkOnTheSurvivorsOwnCode();
  await testARepointThatCollidesIsCountedAndLeftNotThrown();
  await testACodeThatMovedIsNeitherRetiredNorRepointed();
  testTheMergeSettlesCollisionsAfterTheCodesMoveAndReportsIt();
}
