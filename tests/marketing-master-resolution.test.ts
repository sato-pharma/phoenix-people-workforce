import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  MARKETING_MASTER_RESOLVER_RPC,
  type MarketingMasterResolverClient,
  resolveMarketingPharmacyCodes,
} from "@/lib/marketing-requests/master-resolution";

// Marketing pharmacy codes must reach the Source-of-Sales customer master automatically.
//
// The resolver RPC shipped 2026-08-09 and was then never called by anything. Codes validated after
// that date piled up with `master_match_kind IS NULL` — 28 of them over ten days, found only
// because someone went looking. There is no error, no alert and no screen that shows the gap, so
// the ONLY thing standing between a working write path and another silent backlog is this file.
//
// Two properties are pinned here, and both are about failure rather than success:
//   1. resolution can never take down the submission that triggered it; and
//   2. resolution can never widen beyond the rows that submission wrote.

const SERVICE = "src/lib/marketing-requests/service.ts";
const RESOLVER_MIGRATION = "supabase/migrations/20260819234500_resolver_keeps_an_agreed_area.sql";

function code(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("//");
      return idx >= 0 ? line.slice(0, idx) : line;
    })
    .join("\n");
}

type RpcCall = { args: Record<string, unknown>; fn: string };

/**
 * A client that records what it was asked to do. `behaviour` decides how the RPC answers, so the
 * same stub covers the happy path, a Postgres error and a thrown connection failure.
 */
function stubClient(behaviour: "ok" | "error" | "throw" = "ok") {
  const calls: RpcCall[] = [];
  const client = {
    rpc(fn: string, args: Record<string, unknown>) {
      calls.push({ args, fn });
      if (behaviour === "throw") throw new Error("connection reset");
      return Promise.resolve(
        behaviour === "error" ? { error: { message: "permission denied for function" } } : { error: null },
      );
    },
  };
  return { calls, client: client as unknown as MarketingMasterResolverClient };
}

/** The happy path: exactly the ids handed in, under the parameter name the function declares. */
async function testResolvesExactlyTheCodesItWasGiven() {
  const { calls, client } = stubClient();

  const resolved = await resolveMarketingPharmacyCodes(client, ["code-a", "code-b"]);

  assert.equal(resolved, true, "a successful RPC must report that resolution happened");
  assert.equal(calls.length, 1, "resolution is one round trip, not one per code");
  assert.equal(calls[0].fn, MARKETING_MASTER_RESOLVER_RPC);
  assert.deepEqual(
    calls[0].args,
    { p_code_ids: ["code-a", "code-b"] },
    "the RPC takes p_code_ids — a renamed or extra argument would silently resolve nothing",
  );
}

/**
 * THE GUARD THAT MATTERS MOST FOR COST AND FOR TRUST.
 *
 * The RPC treats a null `p_code_ids` as "resolve every active code in the table". Sending null from
 * a write path would re-run all 317 rows on every single validation, and would silently re-verdict
 * rows a human may have curated since. No input may ever produce that call.
 */
async function testNeverAsksTheResolverToWalkTheWholeTable() {
  for (const input of [[], ["", "   "], ["", ""]]) {
    const { calls, client } = stubClient();
    const resolved = await resolveMarketingPharmacyCodes(client, input);

    assert.equal(resolved, false, "with nothing real to resolve, nothing was resolved");
    assert.equal(
      calls.length,
      0,
      `an empty id list must make NO call at all — input ${JSON.stringify(input)} reached the database`,
    );
  }

  // And when it does call, the argument is a concrete array — never null, never undefined.
  const { calls, client } = stubClient();
  await resolveMarketingPharmacyCodes(client, ["code-a"]);
  const sent = calls[0].args.p_code_ids;
  assert.ok(Array.isArray(sent) && sent.length > 0, "p_code_ids must always be a non-empty array");
}

/** One code row can be reached through several links in a multi-customer submission. */
async function testDedupesAndTrimsTheIdList() {
  const { calls, client } = stubClient();

  await resolveMarketingPharmacyCodes(client, ["code-a", "code-a", " code-b ", "", "code-b"]);

  assert.deepEqual(
    calls[0].args.p_code_ids,
    ["code-a", "code-b"],
    "duplicates and blanks must be collapsed before the call",
  );
}

/**
 * THE GUARD THAT PROTECTS A REP'S FIELD WORK.
 *
 * The caller runs this inside the try block whose catch DELETES every customer and pharmacy the
 * submission just wrote. If a failed resolution could throw, a transient database blip would
 * destroy a completed field visit — GPS fix, live shop-front photo and all — and report it to the
 * rep as a failed save. Both failure modes are covered: an error in the response, and a throw.
 */
async function testNeverThrowsWhateverTheDatabaseDoes() {
  for (const behaviour of ["error", "throw"] as const) {
    const { client } = stubClient(behaviour);

    const resolved = await resolveMarketingPharmacyCodes(client, ["code-a"]).catch(
      () => "THREW" as const,
    );

    assert.notEqual(
      resolved,
      "THREW",
      `a ${behaviour} from the resolver escaped — this would roll back and delete the submission`,
    );
    assert.equal(resolved, false, "a failed resolution must report that it did not resolve");
  }
}

/**
 * The write path has to actually call it. A module nothing invokes is exactly the state this whole
 * change exists to correct — the RPC itself sat uncalled for ten days.
 */
function testValidationWritePathResolvesWhatItWrites() {
  const service = code(SERVICE);

  assert.match(
    service,
    /import \{ resolveMarketingPharmacyCodes \} from "@\/lib\/marketing-requests\/master-resolution"/,
    "the validation service must import the resolver",
  );
  assert.match(
    service,
    /distributorCodeIds\.push\(distributorCode\.id\)/,
    "every distributor code row written must be collected for resolution",
  );
  assert.match(
    service,
    /await resolveMarketingPharmacyCodes\(supabase, distributorCodeIds\)/,
    "the validation write path must resolve the codes it just wrote, and must await the call — an "
      + "unawaited promise races the response and leaves the rows unresolved",
  );
}

/**
 * AN AMBIGUOUS IDENTITY MUST NOT THROW AWAY AN AGREED TERRITORY.
 *
 * The resolver's verdict comes from `count(distinct brick_id)` alone. Two candidate rows in the
 * customer master, two bricks, verdict `ambiguous` — and the UPDATE used to fill `mapped_*` only
 * for `exact`/`digit_normalized`, so the row was written back with every mapped column null. The
 * area was discarded even when every candidate agreed on it. Measured on production 2026-08-19:
 * 8 ambiguous codes, 6 of them with all their candidates inside ONE area.
 *
 * That is not a cosmetic gap in a mapping column. Since PR #2223 a marketing customer's area is
 * what decides who can SEE it, and that area comes from its pharmacy's `mapped_area_code` — so a
 * dropped area is a customer nobody in the field can find.
 *
 * The logic is SQL, so this pins the migration's clauses. Three properties, two of them about what
 * must NOT happen:
 *   1. an ambiguous row keeps an agreed area and region;
 *   2. it still gets NO identity — brick, distributor code and customer code stay null, because
 *      those are the columns that actually disagreed; and
 *   3. the agreement test guards the NULL trap: `count(distinct x)` ignores nulls, so a candidate
 *      with no area would otherwise let one other candidate speak for the whole set.
 */
function testAmbiguousKeepsAnAgreedArea() {
  // Comments are stripped FIRST. This migration's own commentary explains the ambiguous branch in
  // prose, sitting between the identity columns and the territory ones — so an assertion run
  // against the raw file could be satisfied by a sentence describing the fix rather than the fix.
  const sql = readFileSync(RESOLVER_MIGRATION, "utf8")
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx >= 0 ? line.slice(0, idx) : line;
    })
    .join("\n");

  // 1. The territory columns gain an ambiguous branch, and keep their original one.
  for (const [column, agreed] of [
    ["mapped_area_code", "area_agreed"],
    ["mapped_region_code", "region_agreed"],
  ] as const) {
    assert.match(
      sql,
      new RegExp(`${column}[\\s\\S]{0,240}?when v\\.kind = 'ambiguous' and v\\.${agreed}`),
      `${column} must be written for an ambiguous match whose candidates agree — dropping it is the bug`,
    );
    assert.match(
      sql,
      new RegExp(`${column}[\\s\\S]{0,240}?when v\\.kind in \\('exact', 'digit_normalized'\\)`),
      `${column} must keep its exact/digit_normalized branch written out separately, so a pinned `
        + "match cannot regress",
    );
  }

  // 2. The identity columns must NOT. An area with no brick reads as "territory known, shop row
  //    unknown", which is the truth. If any of these gained an ambiguous branch the row would start
  //    claiming an identity the master never agreed on.
  for (const column of ["mapped_distributor_code", "mapped_customer_code", "mapped_brick_id"] as const) {
    const from = sql.indexOf(`${column} `, sql.indexOf("update public.marketing_pharmacy_distributor_codes"));
    const next = sql.indexOf("\n      mapped_", from + 1);
    assert.doesNotMatch(
      sql.slice(from, next > from ? next : from + 240),
      /ambiguous/,
      `${column} must stay null for an ambiguous match — the identity is exactly what is in doubt`,
    );
  }

  // 3. The NULL trap. Agreement needs BOTH a single distinct value AND no candidate missing it.
  for (const [plural, singular] of [["areas", "area"], ["regions", "region"]] as const) {
    assert.match(
      sql,
      new RegExp(`a\\.${plural} = 1 and a\\.${plural}_missing = 0`),
      `agreement on ${plural} must also require ${plural}_missing = 0 — count(distinct) ignores `
        + "nulls, so a candidate with no value would let one other candidate speak for the whole set",
    );
    assert.match(
      sql,
      new RegExp(`count\\(\\*\\) filter \\(where c\\.${singular}_code is null\\)\\s+as ${plural}_missing`),
      `${plural}_missing must actually count the candidates that carry no ${singular}`,
    );
  }

  // 4. The verdict vocabulary is unchanged — a fifth kind would violate the table's CHECK constraint.
  assert.doesNotMatch(
    sql,
    /then '(?!exact|digit_normalized|ambiguous|unresolved)[a-z_]+'\s*\n?\s*end as kind/,
    "master_match_kind must stay one of the four kinds the CHECK constraint allows",
  );
}

export function runMarketingMasterResolutionTests() {
  testValidationWritePathResolvesWhatItWrites();
  testAmbiguousKeepsAnAgreedArea();

  return Promise.all([
    testResolvesExactlyTheCodesItWasGiven(),
    testNeverAsksTheResolverToWalkTheWholeTable(),
    testDedupesAndTrimsTheIdList(),
    testNeverThrowsWhateverTheDatabaseDoes(),
  ]).then(() => undefined);
}
