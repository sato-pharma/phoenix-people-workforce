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
//   2. a rep already sitting on a real patch is never moved, whatever the mapping table says; and
//   3. a customer that PREDATES the submission and is completed by it is re-filed only when it is
//      stranded — no area at all, or an organisational bucket — because any real area on such a row
//      was somebody's choice.
//
// (2) is the dangerous direction. Getting it wrong would let a mapping table quietly reassign a
// rep's own customer out from under them, which is worse than the bug this module fixes. (3) is
// gated on the ROW rather than on the capturer for that same reason: a real territory is a decision.

const SERVICE = "src/lib/marketing-requests/service.ts";

type Op = {
  /** `[column, value, operator]` — the operator matters: only `is` may compare against null. */
  filters: Array<[string, unknown, string]>;
  op: "select" | "update";
  payload: Record<string, unknown> | null;
  /** True once `maybeSingle()` asked for the answer — how a one-row read is told from a batch. */
  single: boolean;
  table: string;
};

type StubResponses = {
  /** `areas` row looked up by code — the master area code → area id step. */
  areaByCode?: { data: unknown; error?: unknown };
  /** `areas` row looked up by the capturer's area id. */
  areaById?: { data: unknown; error?: unknown };
  /** `areas` rows looked up in bulk by id — the completed customers' current areas. */
  areasByIds?: { data: unknown[]; error?: unknown };
  /** Make `source_of_sales_bricks` unreadable, so "is this a territory" answers "cannot tell". */
  bricksError?: unknown;
  /** The `mapped_area_code` values the resolver wrote. */
  codes?: { data: unknown[]; error?: unknown };
  /** `marketing_customers` rows read back for the completed set: their id and current area. */
  completedCustomers?: { data: unknown[]; error?: unknown };
  /**
   * The area codes that ARE selling territories. `source_of_sales_bricks` answers the intersection
   * of this set with whatever the query asked about, so the single-code lookup and the batch one
   * can disagree about different codes — which is the whole point once two gates read this table.
   */
  territorialCodes?: string[];
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
      if (responses.bricksError) return { data: [], error: responses.bricksError };
      const territorial = new Set(responses.territorialCodes ?? []);
      const filter = record.filters.find(([column]) => column === "area_code");
      const asked = Array.isArray(filter?.[1])
        ? (filter?.[1] as string[])
        : [String(filter?.[1] ?? "")];
      return {
        data: asked.filter((code) => territorial.has(code)).map((code) => ({ area_code: code })),
        error: null,
      };
    }
    if (record.table === "marketing_pharmacy_distributor_codes") {
      const codes = responses.codes ?? { data: [] };
      return { data: codes.data, error: codes.error ?? null };
    }
    if (record.table === "marketing_customers") {
      const completed = responses.completedCustomers ?? { data: [] };
      return { data: completed.data, error: completed.error ?? null };
    }
    if (record.table === "areas") {
      // Distinguished by which column was filtered on, exactly as the module distinguishes them —
      // and, for the two id lookups, by whether one row or many were asked for.
      const byCode = record.filters.some(([column]) => column === "code");
      if (byCode) {
        return { data: responses.areaByCode?.data ?? null, error: responses.areaByCode?.error ?? null };
      }
      if (record.single) {
        return { data: responses.areaById?.data ?? null, error: responses.areaById?.error ?? null };
      }
      return { data: responses.areasByIds?.data ?? [], error: responses.areasByIds?.error ?? null };
    }
    return { data: null, error: null };
  };

  const builder = (record: Op) => {
    const chain: Record<string, unknown> = {
      eq(column: string, value: unknown) {
        record.filters.push([column, value, "eq"]);
        return chain;
      },
      in(column: string, value: unknown) {
        record.filters.push([column, value, "in"]);
        return chain;
      },
      is(column: string, value: unknown) {
        record.filters.push([column, value, "is"]);
        return chain;
      },
      limit() {
        return chain;
      },
      maybeSingle() {
        record.single = true;
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
          const record: Op = { filters: [], op: "select", payload: null, single: false, table };
          ops.push(record);
          return builder(record);
        },
        update(payload: Record<string, unknown>) {
          const record: Op = { filters: [], op: "update", payload, single: false, table };
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
    // … which no brick belongs to, so it is not a selling territory. `AB4`/`AB5` are.
    territorialCodes: ["AB4", "AB5"],
    codes: { data: [{ mapped_area_code: "AB5" }] },
    areaByCode: { data: { id: BEHIRA_2_AREA_ID } },
    ...overrides,
  });
}

async function run(client: VenueTerritoryClient, ownerAreaId: number | null = HEAD_OFFICE_AREA_ID) {
  return applyMasterTerritoryToVenues({
    completedCustomerIds: [],
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
  // A brick carries `AB4`, so it IS a selling territory — this capturer has a patch of their own.
  const { client, ops } = headOfficeCapture({ areaById: { data: { code: "AB4" } } });

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
  const { client, ops } = headOfficeCapture({ bricksError: { message: "permission denied" } });

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
    completedCustomerIds: ["completed-1"],
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

  assert.ok(
    source.includes("await resolveMarketingPharmacyCodes(supabase, distributorCodeIds);"),
    "the resolver must still be handed ONLY the codes this submission minted — an explicit list is "
      + "what keeps it off the whole table, and re-resolving codes already on file is work nobody "
      + "asked for. The wider `linkedDistributorCodeIds` is for deciding territory, not resolving.",
  );

  const rollback = source.indexOf("for (const pharmacyId of pharmacyIds) {");
  assert.ok(
    rollback > territoryCall,
    "the call must sit inside the try block it is written for, above the rollback that deletes "
      + "the submission",
  );
}

// ─── A CUSTOMER THAT PREDATES THE SUBMISSION ─────────────────────────────────
// The second gap of the original fix. An admin-created stub inherits the DESK's area, and
// completing it in the field overwrites the capture columns but never `area_id` — so a customer
// whose GPS fix and shop-front photo have just landed stays invisible to the team that has to visit
// it. It is deliberately absent from `customerIds` (that list is the rollback set, and unwinding it
// DELETES a row that predates the request), so it needs its own set and its own gate.

const REP_AREA_ID = 1092;
const COMPLETED_ID = "completed-1";

function completedCapture(overrides: Partial<StubResponses> = {}) {
  return headOfficeCapture({
    // The stub sits on `egypt` — a bucket, invisible to every rep in the field.
    areasByIds: { data: [{ code: "egypt", id: HEAD_OFFICE_AREA_ID }] },
    completedCustomers: { data: [{ area_id: HEAD_OFFICE_AREA_ID, id: COMPLETED_ID }] },
    ...overrides,
  });
}

async function runCompleted(
  client: VenueTerritoryClient,
  ownerAreaId: number | null = HEAD_OFFICE_AREA_ID,
  minted: { customerIds?: string[]; pharmacyIds?: string[] } = {},
) {
  return applyMasterTerritoryToVenues({
    completedCustomerIds: [COMPLETED_ID],
    customerIds: minted.customerIds ?? [],
    distributorCodeIds: ["code-1"],
    ownerAreaId,
    pharmacyIds: minted.pharmacyIds ?? [],
    supabase: client,
  });
}

/** THE HEADLINE FOR GAP 2. A completed customer stranded on a bucket adopts the master territory. */
async function testAStrandedCompletedCustomerIsRefiled() {
  const { client, ops } = completedCapture();

  const applied = await runCompleted(client);

  assert.equal(
    applied,
    BEHIRA_2_AREA_ID,
    "completing a customer that sits on a nationwide bucket must re-file it — its evidence has "
      + "just landed and the team that has to visit it still cannot see it",
  );
  const updates = ops.filter((op) => op.op === "update");
  assert.equal(updates.length, 1, "exactly one row moves");
  assert.equal(updates[0]?.table, "marketing_customers");
  assert.deepEqual(updates[0]?.payload, { area_id: BEHIRA_2_AREA_ID }, "only area_id may be written");
  assert.ok(
    updates[0]?.filters.some(([column, value]) => column === "id" && value === COMPLETED_ID),
    "the completed customer is addressed by id, one row at a time",
  );
  assert.ok(
    updates[0]?.filters.some(
      ([column, value, operator]) =>
        column === "area_id" && value === HEAD_OFFICE_AREA_ID && operator === "eq",
    ),
    "and guarded on ITS OWN current area — completed rows do not share one, so a single shared "
      + "guard would either miss them or clobber a value somebody else wrote",
  );
}

/** THE DANGEROUS DIRECTION, again. A considered area is a decision, not a gap. */
async function testACompletedCustomerOnARealTerritoryIsLeftAlone() {
  const { client, ops } = completedCapture({
    areasByIds: { data: [{ code: "AB4", id: REP_AREA_ID }] },
    completedCustomers: { data: [{ area_id: REP_AREA_ID, id: COMPLETED_ID }] },
  });

  assert.equal(
    await runCompleted(client),
    null,
    "a customer already on a real selling territory must never be re-filed by a mapping table",
  );
  assert.equal(ops.filter((op) => op.op === "update").length, 0, "and nothing is written");
}

/** The two gates are independent: a rep's own new rows stay put while a stranded old one moves. */
async function testARepCompletingAStrandedCustomerStillRefilesIt() {
  const { client, ops } = completedCapture({ areaById: { data: { code: "AB4" } } });

  const applied = await runCompleted(client, REP_AREA_ID, {
    customerIds: ["minted-1"],
    pharmacyIds: ["pharmacy-1"],
  });

  assert.equal(
    applied,
    BEHIRA_2_AREA_ID,
    "the stranded customer moves even though the capturer has a territory of their own",
  );
  const updates = ops.filter((op) => op.op === "update");
  assert.equal(
    updates.filter((op) => op.table === "marketing_pharmacies").length,
    0,
    "the rep's own newly minted venue is NOT touched — that gate is about the capturer",
  );
  assert.deepEqual(
    updates.map((op) => op.filters.find(([column]) => column === "id")?.[1]),
    [COMPLETED_ID],
    "and the only row written is the one that predates the submission, never the minted customer",
  );
}

/** No area at all is as invisible as a bucket — and null needs `is`, not `eq`. */
async function testACompletedCustomerWithNoAreaIsRefiled() {
  const { client, ops } = completedCapture({
    areasByIds: { data: [] },
    completedCustomers: { data: [{ area_id: null, id: COMPLETED_ID }] },
  });

  assert.equal(await runCompleted(client), BEHIRA_2_AREA_ID, "a customer with no area is stranded too");
  const update = ops.find((op) => op.op === "update");
  assert.ok(
    update?.filters.some(
      ([column, value, operator]) => column === "area_id" && value === null && operator === "is",
    ),
    "the guard must be `is` — Postgres never matches null with `eq`, so an `eq` guard would move "
      + "nothing at all and still report success",
  );
}

/**
 * THE CASE THE SECOND GATE EXISTS FOR. A customer completed at a pharmacy that was already on file
 * mints no distributor code at all, so a fix that read only the MINTED codes could never fire here.
 * The area comes from the codes the submission ATTACHED — and the submission's own new rows still
 * stay put, because that path (a reused pharmacy re-filing minted rows) is deliberately untouched.
 */
async function testAReusedPharmacyStillPlacesTheCompletedCustomer() {
  const { client, ops } = completedCapture();

  const applied = await applyMasterTerritoryToVenues({
    completedCustomerIds: [COMPLETED_ID],
    customerIds: ["minted-1"],
    // Nothing minted: every venue on this submission was already on file.
    distributorCodeIds: [],
    linkedDistributorCodeIds: ["code-1"],
    ownerAreaId: HEAD_OFFICE_AREA_ID,
    pharmacyIds: [],
    supabase: client,
  });

  assert.equal(
    applied,
    BEHIRA_2_AREA_ID,
    "a submission that minted no code still knows where it stands — the pharmacy it attached "
      + "carries a registered code, and without reading it this fix cannot fire on the reused-"
      + "pharmacy path at all",
  );
  const updates = ops.filter((op) => op.op === "update");
  assert.deepEqual(
    updates.map((op) => op.filters.find(([column]) => column === "id")?.[1]),
    [COMPLETED_ID],
    "and only the completed customer moves — re-filing the submission's OWN new rows off a venue "
      + "that was already on file is a separate change nobody has asked for",
  );
}

/** Unknown is not stranded. An area id with no readable row is left exactly where it is. */
async function testAnUnreadableAreaLeavesACompletedCustomerAlone() {
  const missing = completedCapture({
    areasByIds: { data: [] },
    completedCustomers: { data: [{ area_id: 999, id: COMPLETED_ID }] },
  });
  assert.equal(
    await runCompleted(missing.client),
    null,
    "an area id the areas table does not carry is unknown, not stranded",
  );

  const unreadable = completedCapture({ areasByIds: { data: [], error: { message: "denied" } } });
  assert.equal(await runCompleted(unreadable.client), null, "and a failed read changes nothing");

  for (const { ops } of [missing, unreadable]) {
    assert.equal(ops.filter((op) => op.op === "update").length, 0, "neither writes anything");
  }
}

export async function runMarketingVenueTerritoryTests() {
  testAgreementRule();
  testTerritoryIsAppliedAfterTheResolver();

  // Sequential, deliberately, not `Promise.all`. These share no state and would run happily in
  // parallel — but under `Promise.all` the rejection that surfaces is whichever assertion happens
  // to lose the race, so breaking the fix on purpose reports a DIFFERENT test than the one that
  // pins the broken behaviour. That is precisely the trap behind this repo's rule that a
  // regression test only counts once you have watched its OWN headline assertion fire.
  const tests = [
    testHeadOfficeCaptureAdoptsTheMasterTerritory,
    testRepOnARealTerritoryIsNeverMoved,
    testUnreadableTerritoryTableChangesNothing,
    testDisagreeingCodesChangeNothing,
    testOnlyAnActiveAreaRowIsUsed,
    testNeverThrowsWhateverTheDatabaseDoes,
    testNoCodesMeansNoWork,
    testAStrandedCompletedCustomerIsRefiled,
    testACompletedCustomerOnARealTerritoryIsLeftAlone,
    testARepCompletingAStrandedCustomerStillRefilesIt,
    testACompletedCustomerWithNoAreaIsRefiled,
    testAReusedPharmacyStillPlacesTheCompletedCustomer,
    testAnUnreadableAreaLeavesACompletedCustomerAlone,
  ];
  for (const test of tests) await test();
}
