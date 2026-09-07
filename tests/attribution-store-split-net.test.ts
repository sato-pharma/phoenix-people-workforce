import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  ATTRIBUTION_SPLIT_LINES,
  buildStoreSplitNetPayload,
  writeAttributionStoreSplitNet,
  type AttributionSplitRow,
} from "@/lib/sales/attribution-store-split-net";

/**
 * ATTRIBUTION MUST SEE THE SAME SPLIT THE CLOSING DOES.
 *
 * The wholesaler city split is applied by the Closing Matrix in TypeScript. au.f_monthly_attribution
 * — Sales vs Target, the Business Review, incentives — reads the fact rollup straight and cannot see
 * it, so until 2026-09-07 the two disagreed: El Qema's Qalubeya wholesalers read 950.86 units in D11
 * on the closing and 6,656 on achievement, and the six Cairo areas got nothing.
 *
 * These tests pin the bridge: the net this module builds, which SQL only adds up.
 *
 * WHAT WOULD BREAK SILENTLY WITHOUT EACH ASSERTION:
 *   · a net that does not sum to zero changes a month's TOTAL, not just its distribution
 *   · a net built for the wrong LINE or PERIOD restates a published month
 *   · a net whose money half is copied from its units half misprices every discounted row
 *   · a line name lower-cased on the way out joins to nothing in SQL and the split vanishes
 */

const QALUBEYA_TARGETS = ["CA1", "CA2", "CA3", "CA4", "CA5", "CA6", "D11"];

function qemaRow(overrides: Partial<AttributionSplitRow> = {}): AttributionSplitRow {
  return {
    areaCode: "D11",
    brickId: "B208-1",
    clientCode: "3743",
    clientName: "الفرسان بنها جملة(ت2)",
    distributorCode: "QM",
    includedInClosing: true,
    isDirect: false,
    officialLine: "Pedia",
    productCode: "LA001",
    qty: 700,
    effectiveUnits: 700,
    salesValue: 189000,
    ...overrides,
  };
}

function sumOf(rows: readonly { net_qty: number; net_effective_units: number }[]) {
  return rows.reduce(
    (acc, row) => ({
      qty: acc.qty + row.net_qty,
      effective: acc.effective + row.net_effective_units,
    }),
    { qty: 0, effective: 0 },
  );
}

export function runAttributionStoreSplitNetTests() {
  // ── The El Qema Qalubeya case, on the month it actually applies to ─────────────────────────────
  const august = buildStoreSplitNetPayload("Pedia", [qemaRow()], "2026-08");

  assert.equal(august.length, 7, "the Qalubeya rule reaches seven areas — Qalubeya plus all six Cairo");
  assert.deepEqual(
    august.map((row) => row.area_code).sort(),
    QALUBEYA_TARGETS,
    "and they are exactly Qalubeya and the six Cairo areas",
  );

  // 🔴 The invariant the whole change rests on. A split relocates units; it never creates or
  // destroys them. phx_write_monthly_store_split_net re-checks this independently and refuses to
  // write a payload that fails it — this assertion is what stops us sending one.
  const augustTotals = sumOf(august);
  assert.ok(Math.abs(augustTotals.qty) < 1e-9, `net qty must sum to zero, got ${augustTotals.qty}`);
  assert.ok(
    Math.abs(augustTotals.effective) < 1e-9,
    `net effective units must sum to zero, got ${augustTotals.effective}`,
  );

  const origin = august.find((row) => row.area_code === "D11");
  assert.ok(origin, "the origin area is in the net");
  // Seven ways, so the origin gives up six sevenths and keeps one.
  assert.ok(
    Math.abs(origin.net_qty - (700 / 7 - 700)) < 1e-6,
    `Qalubeya gives up six sevenths, got ${origin.net_qty}`,
  );
  for (const areaCode of ["CA1", "CA2", "CA3", "CA4", "CA5", "CA6"]) {
    const cairo = august.find((row) => row.area_code === areaCode);
    assert.ok(cairo, `${areaCode} receives a share`);
    assert.ok(
      Math.abs(cairo.net_qty - 700 / 7) < 1e-6,
      `${areaCode} receives one seventh, got ${cairo.net_qty}`,
    );
  }

  // ── THE PER-LINE GATE. Pedia starts in August; every other line starts in September. ───────────
  // August Anti Infective was published and announced on 2026-09-07, so a net for it would restate a
  // month the owner has frozen. The gate lives in customer-channel.ts; this proves it survives the
  // trip through this module rather than being re-decided here.
  const antiInfectiveAugust = buildStoreSplitNetPayload(
    "Anti Infective",
    [qemaRow({ officialLine: "Anti Infective" })],
    "2026-08",
  );
  assert.equal(
    antiInfectiveAugust.length,
    0,
    "August Anti Infective produces NO net — its cutover is September, and it is already published",
  );

  const antiInfectiveSeptember = buildStoreSplitNetPayload(
    "Anti Infective",
    [qemaRow({ officialLine: "Anti Infective" })],
    "2026-09",
  );
  assert.ok(
    antiInfectiveSeptember.length > 0,
    "September Anti Infective does split — the gate is a date, not a permanent exclusion",
  );

  // July is before the split's own start period on every line.
  assert.equal(
    buildStoreSplitNetPayload("Pedia", [qemaRow()], "2026-07").length,
    0,
    "July produces no net — the store city split itself starts in August",
  );

  // A line the split never touches.
  assert.equal(
    buildStoreSplitNetPayload("Head Office", [qemaRow({ officialLine: "Head Office" })], "2026-08").length,
    0,
    "Head Office never splits",
  );

  // ── THE TWO MEASURES ARE COMPUTED SEPARATELY ──────────────────────────────────────────────────
  // Attribution uses total_qty for sales_units and effective_units for money. They are equal on
  // every production row today, which is exactly why a bug that conflated them would not show up:
  // this row is discounted so they differ, and the net has to move each on its own measure.
  const discounted = buildStoreSplitNetPayload(
    "Pedia",
    [qemaRow({ qty: 700, effectiveUnits: 630, salesValue: 170100 })],
    "2026-08",
  );
  const discountedOrigin = discounted.find((row) => row.area_code === "D11");
  assert.ok(discountedOrigin, "the discounted row still has an origin cell");
  assert.ok(
    Math.abs(discountedOrigin.net_qty - (700 / 7 - 700)) < 1e-6,
    "units move on the invoiced quantity",
  );
  assert.ok(
    Math.abs(discountedOrigin.net_effective_units - (630 / 7 - 630)) < 1e-6,
    "money moves on the effective units, not on the invoiced quantity",
  );
  assert.notEqual(
    discountedOrigin.net_qty,
    discountedOrigin.net_effective_units,
    "and the two are genuinely different numbers — otherwise this test proves nothing",
  );
  const discountedTotals = sumOf(discounted);
  assert.ok(Math.abs(discountedTotals.qty) < 1e-9, "discounted net qty still sums to zero");
  assert.ok(Math.abs(discountedTotals.effective) < 1e-9, "discounted net effective units still sums to zero");

  // ── THE LINE NAME IS PASSED THROUGH VERBATIM ──────────────────────────────────────────────────
  // au.sos_official_line_map is NOT the identity: "Anti Infective" resolves to `anti_infective`. If
  // this module lower-cased it we would send "anti infective", which joins to nothing in
  // au.f_monthly_attribution — the split would silently not apply to that line. SQL does the
  // resolution; our job is to hand it the name unchanged.
  assert.ok(
    antiInfectiveSeptember.every((row) => row.official_line === "Anti Infective"),
    "the line name reaches SQL exactly as given, for the map to resolve",
  );
  assert.deepEqual(
    [...ATTRIBUTION_SPLIT_LINES],
    ["Pedia", "Anti Infective", "CNS"],
    "the three rep-carrying lines, spelled as the line map spells them",
  );

  // ── A ROW THAT MUST NOT MOVE ──────────────────────────────────────────────────────────────────
  // Direct orders carry no customer to classify and are attributed by region, never by area.
  assert.equal(
    buildStoreSplitNetPayload("Pedia", [qemaRow({ isDirect: true })], "2026-08").length,
    0,
    "a direct row never enters the net",
  );
  // A one-area governorate has nowhere to split to.
  assert.equal(
    buildStoreSplitNetPayload(
      "Pedia",
      [qemaRow({ areaCode: "GZ6", brickId: "B191-3", clientCode: "1161", clientName: "دلة الفيوم" })],
      "2026-08",
    ).length,
    0,
    "Fayoum is a one-area governorate — nothing to share with, so nothing moves",
  );

  // ── THE WRITER ALWAYS CALLS THROUGH, EVEN WITH AN EMPTY PAYLOAD ────────────────────────────────
  // Skipping the call for a quiet period would strand whatever net a previous run left behind, and
  // attribution would keep applying a split that no longer exists.
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const supabase = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      return { data: (args.p_rows as unknown[]).length, error: null };
    },
  };

  return (async () => {
    const quiet = await writeAttributionStoreSplitNet({
      period: "2026-07",
      supabase,
      loadRowsForLine: async () => [qemaRow()],
    });
    assert.equal(calls.length, 1, "a period with nothing to move STILL writes");
    assert.equal(calls[0].fn, "phx_write_monthly_store_split_net", "and it writes through the guarded RPC");
    assert.deepEqual(calls[0].args.p_rows, [], "with an empty payload, which clears any stale net");
    assert.equal(quiet.payloadRows, 0, "and reports nothing moved");
    assert.deepEqual(quiet.linesWithMovement, [], "and names no line");

    const live = await writeAttributionStoreSplitNet({
      period: "2026-08",
      supabase,
      loadRowsForLine: async (line) => (line === "Pedia" ? [qemaRow()] : []),
    });
    assert.equal(live.payloadRows, 7, "August sends the seven Qalubeya cells");
    assert.deepEqual(live.linesWithMovement, ["Pedia"], "and only Pedia moved");
    const sent = calls[1].args.p_rows as { net_qty: number; net_effective_units: number }[];
    const sentTotals = sumOf(sent);
    assert.ok(Math.abs(sentTotals.qty) < 1e-9, "what is actually sent to the database sums to zero");
    assert.ok(Math.abs(sentTotals.effective) < 1e-9, "in both measures");

    // A failing RPC must not be swallowed — a half-refreshed attribution is a wrong number on
    // everyone's Sales vs Target.
    let threw = false;
    try {
      await writeAttributionStoreSplitNet({
        period: "2026-08",
        supabase: { rpc: async () => ({ data: null, error: { message: "boom" } }) },
        loadRowsForLine: async () => [],
      });
    } catch (error) {
      threw = true;
      assert.match(String(error), /boom/, "and the database's own message survives");
    }
    assert.ok(threw, "a failed write throws rather than reporting success");

    // ── EVERY REFRESH SITE WRITES THE NET FIRST ─────────────────────────────────────────────────
    // au.f_monthly_attribution READS au.monthly_store_split_net, so a site that refreshes before
    // writing bakes the PREVIOUS split into the rollup and leaves it there until the next import —
    // a wrong number on every achievement surface, with nothing reporting it.
    //
    // Derived from the source rather than a fixed list, so a NEW refresh path added later is caught
    // too. This is the same shape as tests/sos-import-summaries-refresh.test.ts, and for the same
    // reason: an exception list is what lets these drift apart.
    const ROOT = resolve(import.meta.dirname, "..");
    const walk = (dir: string): string[] => {
      const out: string[] = [];
      for (const entry of readdirSync(dir)) {
        if (entry === "node_modules" || entry.startsWith(".")) continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) out.push(...walk(full));
        else if (/\.tsx?$/.test(full)) out.push(full);
      }
      return out;
    };

    const REFRESH_CALL = 'rpc("phx_refresh_monthly_attribution"';
    // The trailing "(" is load-bearing: without it this matches the IMPORT statement at the top of
    // the file, which always precedes every rpc call, and the ordering assertion below becomes
    // vacuously true. Caught by deliberately reversing a call site and watching this pass.
    const NET_WRITER = "writeStoreSplitNetForBatch(";
    const sites = [...walk(join(ROOT, "src")), ...walk(join(ROOT, "app"))]
      .map((file) => ({ file, body: readFileSync(file, "utf8") }))
      .filter((entry) => entry.body.includes(REFRESH_CALL));

    assert.ok(
      sites.length >= 4,
      `expected at least the 4 known attribution-refresh sites, found ${sites.length} — `
      + "if one was removed, confirm that was intended",
    );

    for (const { file, body } of sites) {
      const relative = file.slice(ROOT.length + 1).replace(/\\/g, "/");
      const writeAt = body.indexOf(NET_WRITER);
      const refreshAt = body.indexOf(REFRESH_CALL);
      const writeCalls = body.split(NET_WRITER).length - 1;
      const refreshCalls = body.split(REFRESH_CALL).length - 1;
      assert.ok(
        writeAt >= 0,
        `${relative} refreshes the attribution rollup but never calls ${NET_WRITER}. `
        + "The rollup would be built from a stale split net.",
      );
      assert.ok(
        writeCalls >= refreshCalls,
        `${relative} refreshes the attribution rollup ${refreshCalls}x but writes the split net `
        + `only ${writeCalls}x — one of those refreshes reads a stale net.`,
      );
      assert.ok(
        writeAt < refreshAt,
        `${relative} calls ${NET_WRITER} AFTER phx_refresh_monthly_attribution. `
        + "The net must be written first — the rollup reads it.",
      );
    }
  })();
}
