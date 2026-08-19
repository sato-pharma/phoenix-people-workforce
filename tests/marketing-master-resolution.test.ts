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

export function runMarketingMasterResolutionTests() {
  testValidationWritePathResolvesWhatItWrites();

  return Promise.all([
    testResolvesExactlyTheCodesItWasGiven(),
    testNeverAsksTheResolverToWalkTheWholeTable(),
    testDedupesAndTrimsTheIdList(),
    testNeverThrowsWhateverTheDatabaseDoes(),
  ]).then(() => undefined);
}
