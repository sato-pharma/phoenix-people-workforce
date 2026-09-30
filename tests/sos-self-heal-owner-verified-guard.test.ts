import assert from "node:assert/strict";

import { loadOwnerVerifiedMapKeys, selectCorrectionRows, type BrickRef } from "../src/lib/sales/normalizer/customer-map.ts";
import type { CustomerBrickCorrection } from "../src/lib/sales/normalizer/types.ts";

/**
 * The PostgREST chain `loadOwnerVerifiedMapKeys` builds, stopping at `.in()` which is awaited.
 * A stub rather than a live client: the point of these cases is what the function does with an
 * ERROR, and a real database will not produce one on demand.
 */
function stubDb(result: { data?: unknown[] | null; error?: { message: string } | null }) {
  const chain = {
    from: () => chain,
    select: () => chain,
    eq: () => chain,
    in: () => Promise.resolve({ data: result.data ?? null, error: result.error ?? null }),
  };
  return chain as unknown as Parameters<typeof loadOwnerVerifiedMapKeys>[0];
}

function bricks(): Map<string, BrickRef> {
  return new Map<string, BrickRef>([
    ["B200-5", { areaCode: "D17", brickId: "B200-5", regionCode: "D1" }],
    ["B199-9", { areaCode: "D16", brickId: "B199-9", regionCode: "D1" }],
  ]);
}

function correction(over: Partial<CustomerBrickCorrection> = {}): CustomerBrickCorrection {
  return {
    distributorCode: "PS",
    customerCode: "1507402",
    brickId: "B200-5",
    previousBrickId: "B199-9",
    ...over,
  } as CustomerBrickCorrection;
}

export async function runSosSelfHealOwnerVerifiedGuardTests() {
  // Baseline: with no owner ruling on file, the monthly upload's self-heal still wins. This is the
  // behaviour that keeps the crosswalk current, and the guard must not disturb it.
  {
    const out = selectCorrectionRows([correction()], bricks(), new Set<string>(), "admin");
    assert.equal(out.rows.length, 1, "an ordinary correction is still written");
    assert.equal(out.skippedOwnerVerified, 0, "nothing is owner-verified, so nothing is guarded");
    assert.equal(out.rows[0]?.brick_id, "B200-5", "the sheet's brick lands on the crosswalk");
  }

  // The regression: an owner ruling (confidence=100) must survive the upload untouched. Without the
  // guard this row is overwritten with the sheet's brick while confidence stays 100 — leaving a row
  // that still claims to be owner-verified but no longer carries the owner's brick.
  {
    const out = selectCorrectionRows([correction()], bricks(), new Set(["PS 1507402"]), "admin");
    assert.equal(out.rows.length, 0, "an owner-verified mapping is never overwritten by the sheet");
    assert.equal(out.skippedOwnerVerified, 1, "and the skip is counted, not silent");
    assert.equal(out.skipped, 0, "it is reported as owner-verified, not as an unresolvable row");
  }

  // The guard is keyed on (distributor, customer) exactly as the upsert's onConflict is, so a ruling
  // for one distributor must not shield the same customer code under another.
  {
    const out = selectCorrectionRows(
      [correction({ distributorCode: "IS-S" })], bricks(), new Set(["PS 1507402"]), "admin",
    );
    assert.equal(out.rows.length, 1, "a ruling on PS does not shield the IS-S mapping of that code");
    assert.equal(out.skippedOwnerVerified, 0, "the guard matches the upsert key, not the code alone");
  }

  // Distributor code is normalized the same way on both sides of the comparison.
  {
    const out = selectCorrectionRows([correction({ distributorCode: " ps " })], bricks(), new Set(["PS 1507402"]), "admin");
    assert.equal(out.skippedOwnerVerified, 1, "a padded/lower-cased distributor still matches the ruling");
  }

  // Mixed batch: the guard removes only the ruled customer and leaves the rest of the upload alone.
  {
    const out = selectCorrectionRows(
      [correction(), correction({ customerCode: "1507421" }), correction({ customerCode: "", brickId: "B199-9" })],
      bricks(),
      new Set(["PS 1507402"]),
      "admin",
    );
    assert.equal(out.rows.length, 1, "only the untouched, resolvable correction is written");
    assert.equal(out.skippedOwnerVerified, 1, "one skipped for the owner ruling");
    assert.equal(out.skipped, 1, "one skipped for a blank customer code — counted separately");
    assert.equal(out.rows[0]?.customer_code, "1507421", "the surviving row is the unruled customer");
  }

  // The payload must never carry `confidence`: the self-heal has no business scoring a mapping, and
  // an absent column is what lets an existing owner ruling keep its 100 on rows it does write.
  {
    const out = selectCorrectionRows([correction()], bricks(), new Set<string>(), "admin");
    assert.equal(
      Object.hasOwn(out.rows[0] ?? {}, "confidence"), false,
      "self-heal never writes confidence, so it cannot mint or erase an owner ruling",
    );
    assert.equal(out.rows[0]?.source, "sheet-verified", "provenance stays distinguishable in the Mapping Database");
  }

  // ── The guard's own read must FAIL CLOSED (2026-09-30) ────────────────────────────────────────
  // Every case above hands `selectCorrectionRows` a set that someone already built. The set comes
  // from `loadOwnerVerifiedMapKeys`, and until this date ANY error there returned an EMPTY set —
  // which is not "no rulings exist", it is "the guard is off". One timeout on one chunk of the
  // 200-code `in` list was enough to let the sheet overwrite every owner ruling in that run, while
  // the summary said `skippedOwnerVerified: 0` and nothing went red. On production 6,944 active rows
  // across 6,357 customers sit at confidence 100, and this only runs on a CONFIRMED import commit.
  const twoCorrections = [correction(), correction({ customerCode: "1507421" })];

  {
    // It still reads the rulings it finds, keyed exactly as the upsert keys them.
    const keys = await loadOwnerVerifiedMapKeys(
      stubDb({ data: [{ distributor_code: " ps ", customer_code: "1507402" }] }),
      twoCorrections,
    );
    assert.deepEqual([...keys], ["PS 1507402"], "a ruling read back is normalized to the upsert's key");
  }

  {
    // The ONE tolerated degradation: a deployment whose customer_map predates `confidence`.
    const keys = await loadOwnerVerifiedMapKeys(
      stubDb({ error: { message: `column source_of_sales_customer_map.confidence does not exist` } }),
      twoCorrections,
    );
    assert.equal(keys.size, 0, "a pre-migration schema still degrades to an empty set rather than failing the upload");
  }

  {
    // Everything else — the timeout, the blip, the statement error — must THROW.
    let threw: unknown = null;
    try {
      await loadOwnerVerifiedMapKeys(stubDb({ error: { message: "canceling statement due to statement timeout" } }), twoCorrections);
    } catch (e) {
      threw = e;
    }
    assert.ok(
      threw,
      "a read error other than the missing confidence column must THROW — returning an empty set here "
        + "silently switches off the guard and lets the sheet overwrite the owner's area rulings",
    );
    assert.match(
      String((threw as { message?: string })?.message ?? ""),
      /overwrite area rulings made at confidence 100/,
      "and the error must say what it was protecting, not just relay the driver's message",
    );
  }
}
