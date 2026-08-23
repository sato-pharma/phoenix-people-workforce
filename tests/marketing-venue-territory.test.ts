import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  agreedMasterAreaCode,
  applyMasterTerritoryToVenues,
  type VenueTerritoryClient,
} from "@/lib/marketing-requests/venue-territory";

// A captured venue must be filed in the territory it stands in, not the one its photographer
// belongs to — but ONLY when that photographer has no territory of their own.
//
// Both halves matter and they pull in opposite directions, so both are pinned here:
//   1. a head-office capture adopts the area its registered code resolved to (without this, the
//      customer is invisible to every rep in the field — `canSeeMarketingCustomer` reads the stored
//      `area_id` since PR #2223); and
//   2. a rep already sitting on a real patch is never moved, whatever the mapping table says.
//
// (2) is the dangerous direction. Getting it wrong would let a mapping table quietly reassign a
// rep's own customer out from under them, which is worse than the bug this module fixes.

const SERVICE = "src/lib/marketing-requests/service.ts";

type Op = {
  filters: Array<[string, unknown]>;
  op: "select" | "update";
  payload: Record<string, unknown> | null;
  table: string;
};

type StubResponses = {
  /** `areas` row looked up by code — the master area code → area id step. */
  areaByCode?: { data: unknown; error?: unknown };
  /** `areas` row looked up by the capturer's area id. */
  areaById?: { data: unknown; error?: unknown };
  /** Rows returned from `source_of_sales_bricks`; non-empty means "a real selling territory". */
  bricks?: { data: unknown[]; error?: unknown };
  /** The `mapped_area_code` values the resolver wrote. */
  codes?: { data: unknown[]; error?: unknown };
  updateError?: unknown;
};

/**
 * A Supabase stub that records every call. The real client is a chainable builder that is also
 * awaitable, so the stub is too — `then` is what makes `await supabase.from(...).select(...).in(...)`
 * work without a terminal method.
 */
function stubClient(responses: StubResponses) {
  const ops: Op[] = [];

  const answerFor = (record: Op): { data: unknown; error: unknown } => {
    if (record.op === "update") {
      return { data: null, error: responses.updateError ?? null };
    }
    if (record.table === "source_of_sales_bricks") {
      const bricks = responses.bricks ?? { data: [] };
      return { data: bricks.data, error: bricks.error ?? null };
    }
    if (record.table === "marketing_pharmacy_distributor_codes") {
      const codes = responses.codes ?? { data: [] };
      return { data: codes.data, error: codes.error ?? null };
    }
    if (record.table === "areas") {
      // Distinguished by which column was filtered on, exactly as the module distinguishes them.
      const byCode = record.filters.some(([column]) => column === "code");
      const chosen = byCode ? responses.areaByCode : responses.areaById;
      return { data: chosen?.data ?? null, error: chosen?.error ?? null };
    }
    return { data: null, error: null };
  };

  const builder = (record: Op) => {
    const chain: Record<string, unknown> = {
      eq(column: string, value: unknown) {
        record.filters.push([column, value]);
        return chain;
      },
      in(column: string, value: unknown) {
        record.filters.push([column, value]);
        return chain;
      },
      is(column: string, value: unknown) {
        record.filters.push([column, value]);
        return chain;
      },
      limit() {
        return chain;
      },
      maybeSingle() {
        return Promise.resolve(answerFor(record));
      },
      then(onFulfilled: unknown, onRejected: unknown) {
        return Promise.resolve(answerFor(record)).then(
          onFulfilled as never,
          onRejected as never,
        );
      },
    };
    return chain;
  };

  const client = {
    from(table: string) {
      return {
        select() {
          const record: Op = { filters: [], op: "select", payload: null, table };
          ops.push(record);
          return builder(record);
        },
        update(payload: Record<string, unknown>) {
          const record: Op = { filters: [], op: "update", payload, table };
          ops.push(record);
          return builder(record);
        },
      };
    },
  };

  return { client: client as unknown as VenueTerritoryClient, ops };
}

const HEAD_OFFICE_AREA_ID = 42;
const BEHIRA_2_AREA_ID = 1093;

function headOfficeCapture(overrides: Partial<StubResponses> = {}) {
  return stubClient({
    // The capturer sits on `egypt` …
    areaById: { data: { code: "egypt" } },
    // … which no brick belongs to, so it is not a selling territory.
    bricks: { data: [] },
    codes: { data: [{ mapped_area_code: "AB5" }] },
    areaByCode: { data: { id: BEHIRA_2_AREA_ID } },
    ...overrides,
  });
}

async function run(client: VenueTerritoryClient, ownerAreaId: number | null = HEAD_OFFICE_AREA_ID) {
  return applyMasterTerritoryToVenues({
    customerIds: ["customer-1", "customer-2"],
    distributorCodeIds: ["code-1"],
    ownerAreaId,
    pharmacyIds: ["pharmacy-1"],
    supabase: client,
  });
}

/** THE HEADLINE. A head-office capture is filed where the registered code says it stands. */
async function testHeadOfficeCaptureAdoptsTheMasterTerritory() {
  const { client, ops } = headOfficeCapture();

  const applied = await run(client);

  assert.equal(
    applied,
    BEHIRA_2_AREA_ID,
    "a capture by someone with no selling territory must adopt the area its registered code resolved to",
  );

  const updates = ops.filter((op) => op.op === "update");
  assert.deepEqual(
    updates.map((op) => op.table).sort(),
    ["marketing_customers", "marketing_pharmacies"],
    "both the venue and the customers minted with it must move — territorial screens filter the "
      + "CUSTOMER's own area_id, so moving only the pharmacy looks done and changes nothing",
  );
  for (const update of updates) {
    assert.deepEqual(
      update.payload,
      { area_id: BEHIRA_2_AREA_ID },
      "only area_id may be written — any other column here would be a silent erase",
    );
    assert.ok(
      update.filters.some(
        ([column, value]) => column === "area_id" && value === HEAD_OFFICE_AREA_ID,
      ),
      "the update must be guarded on the area it is entitled to replace, so a considered value "
        + "written by a human or a parallel session is never clobbered",
    );
  }
}

/** THE DANGEROUS DIRECTION. A rep on a real patch is never moved. */
async function testRepOnARealTerritoryIsNeverMoved() {
  const { client, ops } = headOfficeCapture({
    areaById: { data: { code: "AB4" } },
    // A brick carries this area code, so it IS a selling territory.
    bricks: { data: [{ area_code: "AB4" }] },
  });

  const applied = await run(client, 1092);

  assert.equal(applied, null, "a capturer who already has a territory must be left alone");
  assert.equal(
    ops.filter((op) => op.op === "update").length,
    0,
    "no write at all may be issued for a rep — a mapping table must never reassign a rep's own "
      + "customer out from under them",
  );
}

/** An unknown answer is not permission to act. */
async function testUnreadableTerritoryTableChangesNothing() {
  const { client, ops } = headOfficeCapture({
    bricks: { data: [], error: { message: "permission denied" } },
  });

  assert.equal(await run(client), null, "if we cannot tell whether the capturer has a territory, nothing moves");
  assert.equal(ops.filter((op) => op.op === "update").length, 0, "and nothing is written");
}

/** Codes that do not speak with one voice establish no territory. */
async function testDisagreeingCodesChangeNothing() {
  const partial = headOfficeCapture({
    codes: { data: [{ mapped_area_code: "AB5" }, { mapped_area_code: null }] },
  });
  assert.equal(
    await run(partial.client),
    null,
    "a code the resolver could not place must veto the set, not be skipped over",
  );

  const conflicting = headOfficeCapture({
    codes: { data: [{ mapped_area_code: "AB5" }, { mapped_area_code: "AB4" }] },
  });
  assert.equal(await run(conflicting.client), null, "two different areas establish neither");

  for (const { ops } of [partial, conflicting]) {
    assert.equal(ops.filter((op) => op.op === "update").length, 0, "and neither writes anything");
  }
}

/** A master area code the `areas` table does not carry as ACTIVE is not usable. */
async function testOnlyAnActiveAreaRowIsUsed() {
  const { client, ops } = headOfficeCapture({ areaByCode: { data: null } });

  assert.equal(await run(client), null, "no active area for that code means no change");
  assert.equal(ops.filter((op) => op.op === "update").length, 0, "and no write");

  const { client: active, ops: activeOps } = headOfficeCapture();
  await run(active);
  const areaLookup = activeOps.find(
    (op) => op.table === "areas" && op.filters.some(([column]) => column === "code"),
  );
  assert.ok(
    areaLookup?.filters.some(([column, value]) => column === "is_active" && value === true),
    "the area lookup must require is_active — the 2026-08-22 consolidations left retired "
      + "duplicates under the same names, and filing into one is a different flavour of invisible",
  );
}

/** THE NEVER-THROWS CONTRACT. The caller's catch deletes the whole submission. */
async function testNeverThrowsWhateverTheDatabaseDoes() {
  const { client } = headOfficeCapture({ updateError: { message: "deadlock detected" } });
  assert.equal(await run(client), null, "a failed update must be swallowed, not thrown");

  const exploding = {
    from() {
      throw new Error("connection reset");
    },
  } as unknown as VenueTerritoryClient;
  assert.equal(
    await run(exploding),
    null,
    "a thrown client must be swallowed — a throw here would delete a completed field visit, GPS "
      + "fix and live shop-front photo included, to fix a mapping column",
  );
}

/** Nothing to derive from, or nothing to move: no calls at all. */
async function testNoCodesMeansNoWork() {
  const { client, ops } = headOfficeCapture();
  const applied = await applyMasterTerritoryToVenues({
    customerIds: ["customer-1"],
    distributorCodeIds: [],
    ownerAreaId: HEAD_OFFICE_AREA_ID,
    pharmacyIds: [],
    supabase: client,
  });
  assert.equal(applied, null, "a codeless venue — a nursery — has no registered territory to adopt");
  assert.equal(ops.length, 0, "and must not cost a single query");
}

/** The pure agreement rule, mirrored from the resolver migration. */
function testAgreementRule() {
  assert.equal(agreedMasterAreaCode(["AB5", "AB5"]), "AB5", "unanimous codes agree");
  assert.equal(agreedMasterAreaCode(["AB5"]), "AB5", "one code agrees with itself");
  assert.equal(agreedMasterAreaCode([]), null, "an empty set agrees about nothing");
  assert.equal(agreedMasterAreaCode(["AB5", "AB4"]), null, "different codes do not agree");
  assert.equal(
    agreedMasterAreaCode(["AB5", null]),
    null,
    "a missing value must veto — count(distinct) ignoring nulls is exactly the trap the resolver "
      + "migration calls out, where one candidate speaks for the whole set",
  );
  assert.equal(agreedMasterAreaCode(["  AB5  ", "AB5"]), "AB5", "whitespace is not disagreement");
  assert.equal(agreedMasterAreaCode(["AB5", "   "]), null, "a blank string is a missing value");
}

/**
 * ORDERING IS LOAD-BEARING. `mapped_area_code` is written by a database function, so reading it
 * before that function has run reads the column as it was before this submission existed.
 *
 * Compares positions rather than slicing a byte window around the call — a fixed-width window
 * false-fails the moment the surrounding comment is reworded.
 */
function testTerritoryIsAppliedAfterTheResolver() {
  const source = readFileSync(SERVICE, "utf8");

  const resolverCall = source.indexOf("await resolveMarketingPharmacyCodes(");
  const territoryCall = source.indexOf("await applyMasterTerritoryToVenues(");

  assert.ok(resolverCall >= 0, "the master resolver call must still exist in the write path");
  assert.ok(
    territoryCall >= 0,
    "the validation write path must apply the master territory — without this call a head-office "
      + "capture is invisible to every rep in the field",
  );
  assert.ok(
    territoryCall > resolverCall,
    "territory adoption must run AFTER the resolver — mapped_area_code does not exist until the "
      + "database function has written it",
  );

  const rollback = source.indexOf("for (const pharmacyId of pharmacyIds) {");
  assert.ok(
    rollback > territoryCall,
    "the call must sit inside the try block it is written for, above the rollback that deletes "
      + "the submission",
  );
}

export function runMarketingVenueTerritoryTests() {
  testAgreementRule();
  testTerritoryIsAppliedAfterTheResolver();

  return Promise.all([
    testHeadOfficeCaptureAdoptsTheMasterTerritory(),
    testRepOnARealTerritoryIsNeverMoved(),
    testUnreadableTerritoryTableChangesNothing(),
    testDisagreeingCodesChangeNothing(),
    testOnlyAnActiveAreaRowIsUsed(),
    testNeverThrowsWhateverTheDatabaseDoes(),
    testNoCodesMeansNoWork(),
  ]).then(() => undefined);
}
