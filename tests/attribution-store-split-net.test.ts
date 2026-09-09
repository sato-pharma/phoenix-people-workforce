import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  ATTRIBUTION_SPLIT_LINES,
  buildStoreSplitNetPayload,
  writeAttributionStoreSplitNet,
  type AttributionSplitRow,
} from "@/lib/sales/attribution-store-split-net";
import { othersLookupLineCode, usesOrganogramRegions } from "@/lib/sales/closing-organogram-regions";
import { resolveTargetLineCode } from "@/lib/sales/monthly-targets";
import { ALL_SPLIT_AREAS } from "@/lib/sales/store-sales-city-split";

import { referenceQemaShares } from "./qema-warehouse-split.test.ts";

/**
 * ATTRIBUTION MUST SEE THE SAME SPLIT THE CLOSING DOES.
 *
 * The wholesaler city split is applied by the Closing Matrix in TypeScript. au.f_monthly_attribution
 * — Sales vs Target, the Business Review, incentives — reads the fact rollup straight and cannot see
 * it, so until 2026-09-07 the two disagreed: El Qema's Qalubeya wholesalers read 950.86 units in D11
 * on the closing and 6,656 on achievement, and the rest of the country got nothing.
 *
 * The rule those figures came from has been replaced several times since; the geometry below is
 * whatever the current one produces. The BRIDGE is what these tests pin, and it is unchanged: the
 * application computes the split and SQL only adds the result up. Every expected share here comes
 * from `referenceQemaShares` — a second reading of the owner's words that shares no code with the
 * engine — so this file follows a rule change without being rewritten for it.
 *
 * These tests pin the bridge: the net this module builds, which SQL only adds up.
 *
 * WHAT WOULD BREAK SILENTLY WITHOUT EACH ASSERTION:
 *   · a net that does not sum to zero changes a month's TOTAL, not just its distribution
 *   · a net built for the wrong LINE or PERIOD restates a published month
 *   · a net whose money half is copied from its units half misprices every discounted row
 *   · a line name lower-cased on the way out joins to nothing in SQL and the split vanishes
 */

/** Every area on the city list. No regions map is passed here, so Others is empty and all 49 play. */
const COUNTRY_AREAS = 49;

/** Pedia's Others areas that exist in AREA_CITY — the twelve the split can actually remove. */
const PEDIA_OTHERS: ReadonlySet<string> = new Set([
  "CA5", "D17", "UE8", "OT1", "OT2", "OT4", "OT5", "OT6", "OT7", "OT8", "OT9", "OT10",
]);

/** Qalubeya's LOCAL block is itself plus the six Cairo areas, so the rest of the country is 42. */

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
  // ── 🔴 THE LINE NAMES THESE CALLERS PASS MUST RESOLVE TO THE CODES THE ORG MAP IS KEYED BY ───
  //
  // `loadOthersAreas` looks the organogram up by line. The callers hold DISPLAY NAMES — this very
  // list is ["Pedia", "Anti Infective", "CNS"] — while `au_v_line_area_map*` is keyed by CODE
  // (`anti_infective`). Hand the view a name and the `.eq` matches nothing, which yields an EMPTY
  // exclusion set; and an empty set is precisely how the split spells "nothing is in Others". So the
  // rule silently does not apply: no error, no missing row, every area keeps its share.
  //
  // That is not hypothetical. The first deploy of the Others rule (2026-09-08) was completely inert
  // in production for exactly this reason, and nothing caught it but a backfill dry run still
  // printing "49 areas". This assertion is the cheap check that would have.
  for (const line of ATTRIBUTION_SPLIT_LINES) {
    const code = othersLookupLineCode(line);
    assert.equal(code, resolveTargetLineCode(line), `${line} is looked up by its canonical code`);
    assert.ok(
      usesOrganogramRegions(code),
      `${line} -> ${code} is a line the organogram map covers, so an Others lookup can return rows`,
    );
  }
  // THE ASSERTION THAT WOULD HAVE CAUGHT IT: the two forms genuinely differ, so a lookup helper that
  // passed its input straight through would fail here rather than quietly finding nothing.
  assert.equal(
    othersLookupLineCode("Anti Infective"),
    "anti_infective",
    "the display name is converted, not passed through — passing it through finds no rows and reads "
      + "as an empty Others set, which is how the rule silently stops applying",
  );
  assert.equal(othersLookupLineCode("Pedia"), "pedia");
  assert.equal(othersLookupLineCode("pedia"), "pedia", "a code already in canonical form survives unchanged");

  // ── The El Qema Qalubeya case, on the month it actually applies to ─────────────────────────────
  const august = buildStoreSplitNetPayload("Pedia", [qemaRow()], "2026-08");

  assert.equal(august.length, COUNTRY_AREAS, "700 packs is over 200, so the net reaches every area");
  assert.ok(
    august.some((row) => row.area_code === "D11"),
    "Qalubeya is in the net — it keeps half of its own sale, it is not emptied out",
  );
  assert.ok(
    august.some((row) => row.area_code === "AB1"),
    "and so is Alexandria, which the Cairo-only rule this replaced never reached",
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

  // 🔒 THE THREE BANDS AND THE UPPER EGYPT REDISTRIBUTION — owner, 2026-09-09 evening. This
  // block has asserted a 60/40, then a 75/25, then a four-rung priority ladder. It now asserts
  // nothing of its own: `referenceQemaShares` derives the expected share from his words, and the net
  // is that share minus whatever the area sold. Nothing here is passed a regions map, so Others is
  // empty and all 49 areas are in play — which is what makes 49 the count asserted above.
  const NO_OTHERS: ReadonlySet<string> = new Set<string>();
  const shareOf = (origin: string, code: string, total: number) =>
    referenceQemaShares(origin, total, total, NO_OTHERS).get(code) ?? 0;

  const origin = august.find((row) => row.area_code === "D11");
  assert.ok(origin, "the origin area is in the net");
  assert.ok(
    Math.abs(origin.net_qty - (shareOf("D11", "D11", 700) - 700)) < 1e-6,
    `Qalubeya keeps its share of its own sale and gives up the rest, got ${origin.net_qty}`,
  );

  // The shape, seen through the net rather than through the plan: at 700 packs the governorate
  // block keeps half, so Qalubeya and Cairo sit above the country, and Upper Egypt sits below it
  // because the second rule takes half of what the bands credited there back out again.
  const netOf = (code: string) => august.find((row) => row.area_code === code)?.net_qty ?? 0;
  assert.ok(netOf("CA1") > netOf("AB1"), "Cairo is inside Qalubeya's block, so it keeps more");
  assert.ok(netOf("AB1") > netOf("UE7"), "and Qena ends below Alexandria after the Upper Egypt pass");
  assert.equal(
    Number(netOf("AB1").toFixed(9)),
    Number(netOf("D21").toFixed(9)),
    "the national half is flat outside Upper Egypt",
  );
  for (const code of ["AB1", "UE7", "OT7", "CA1", "GZ6"]) {
    assert.ok(
      Math.abs(netOf(code) - shareOf("D11", code, 700)) < 1e-6,
      `${code} receives what his rule gives it, got ${netOf(code)}`,
    );
  }

  // ── THE PER-LINE GATE. Pedia starts in August; every other line starts in September. ───────────
  // August Anti Infective was published and announced on 2026-09-07, so a net for it would restate a
  // month the owner has frozen. The gate lives in customer-channel.ts; this proves it survives the
  // trip through this module rather than being re-decided here.
  // ALEXANDRIA, not Qalubeya. El Qema is Pedia only (owner golden rule, 2026-09-08), so on Anti
  // Infective it takes no national split at all — and Qalubeya holds ONE area, so a Qalubeya row
  // would produce an empty net in BOTH months and prove nothing about the date gate. Alexandria has
  // three areas, so the ordinary city split answers here and the only variable left is the date.
  const antiInfectiveAugust = buildStoreSplitNetPayload(
    "Anti Infective",
    [qemaRow({ areaCode: "AB2", brickId: "B152-2", officialLine: "Anti Infective" })],
    "2026-08",
  );
  assert.equal(
    antiInfectiveAugust.length,
    0,
    "August Anti Infective produces NO net — its cutover is September, and it is already published",
  );

  const antiInfectiveSeptember = buildStoreSplitNetPayload(
    "Anti Infective",
    [qemaRow({ areaCode: "AB2", brickId: "B152-2", officialLine: "Anti Infective" })],
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
    Math.abs(discountedOrigin.net_qty - (shareOf("D11", "D11", 700) - 700)) < 1e-6,
    "units move on the invoiced quantity",
  );
  // 🔴 The BAND is judged on the invoiced 700 for BOTH passes — only the amount divided changes.
  // Re-banding the effective pass on 630 would put units and money on two different geometries.
  assert.ok(
    Math.abs(
      discountedOrigin.net_effective_units
      - ((referenceQemaShares("D11", 700, 630, NO_OTHERS).get("D11") ?? 0) - 630),
    ) < 1e-6,
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
  // 🔴 A ONE-AREA GOVERNORATE IS NO LONGER A DEAD END. Under the bands alone a 12-pack Fayoum
  // order would stay exactly where it was — its governorate holds one area and 12 is under 200.
  // Fayoum is Upper Egypt, so the SECOND rule takes that sale national anyway: "كل البيع اللي
  // محسوب للصعيد", all of it, whatever band produced it. A 400-pack order lands on the same
  // geometry for a different reason — it is over 200 to begin with — so these two are not duplicates.
  const fayoum = (qty: number) => qemaRow({
    areaCode: "GZ6",
    brickId: "B191-3",
    clientCode: "1161",
    clientName: "دلة الفيوم",
    effectiveUnits: qty,
    qty,
    salesValue: qty * 270,
  });
  const fayoumSmall = buildStoreSplitNetPayload("Pedia", [fayoum(12)], "2026-08");
  assert.equal(
    fayoumSmall.length,
    COUNTRY_AREAS,
    "12 packs reaches every area — the Upper Egypt redistribution runs in band 1 too",
  );
  const fayoumSmallOrigin = fayoumSmall.find((row) => row.area_code === "GZ6");
  assert.ok(fayoumSmallOrigin, "Fayoum keeps a cell of its own");
  assert.ok(
    Math.abs(fayoumSmallOrigin.net_qty - (shareOf("GZ6", "GZ6", 12) - 12)) < 1e-6,
    `Fayoum keeps its share of its 12, got ${fayoumSmallOrigin.net_qty}`,
  );

  const fayoumBig = buildStoreSplitNetPayload("Pedia", [fayoum(400)], "2026-08");
  assert.equal(fayoumBig.length, COUNTRY_AREAS, "and 400 packs reaches every area as well");
  const fayoumOrigin = fayoumBig.find((row) => row.area_code === "GZ6");
  assert.ok(fayoumOrigin, "with a cell of its own again");
  assert.ok(
    Math.abs(fayoumOrigin.net_qty - (shareOf("GZ6", "GZ6", 400) - 400)) < 1e-6,
    `Fayoum keeps its share of its 400, got ${fayoumOrigin.net_qty}`,
  );
  // The two bands are genuinely different geometries underneath, or the pair above proves nothing.
  assert.notEqual(
    Number((shareOf("GZ6", "GZ6", 12) / 12).toFixed(9)),
    Number((shareOf("GZ6", "GZ6", 400) / 400).toFixed(9)),
    "12 packs and 400 packs are banded differently — band 1 keeps its half inside Fayoum",
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

    // The organogram is INJECTED, not read from the live org chart. Without this the writer reaches
    // into production, and a test that cannot control the answer silently exercises an EMPTY set —
    // which looks exactly like the exclusion rule not existing.
    const live = await writeAttributionStoreSplitNet({
      period: "2026-08",
      supabase,
      loadRowsForLine: async (line: string) => (line === "Pedia" ? [qemaRow()] : []),
      loadSplitRegionsForLine: async (line: string) => ({
        areasByRegion: new Map<string, ReadonlySet<string>>(),
        others: line === "Pedia" ? PEDIA_OTHERS : new Set<string>(),
      }),
    });
    assert.equal(
      live.payloadRows,
      COUNTRY_AREAS - PEDIA_OTHERS.size,
      "August sends one cell per area that is NOT in Others — 37, not 49",
    );
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

    // 🔴 THE HALF THE MARKER ABOVE CANNOT SEE. The main import path does not call
    // phx_refresh_monthly_attribution from TypeScript at all — it calls
    // finalizeSosBatchAndAuditSupersede, and the attribution refresh happens inside
    // phx_finalize_sos_batch, in SQL. So a file can refresh attribution on every upload while
    // containing none of the string the loop above searches for, and the guard stays silent.
    //
    // That is not hypothetical: writeStoreSplitNetForBatch lived ONLY in each file's "defensive
    // fallback" branch, which fires only when no single period resolves. Every real upload took the
    // main branch, refreshed attribution from fresh sales against a stale net, and reported nothing.
    // Measured 2026-09-09 — four imports in one day, the net untouched since the previous evening.
    //
    // The net must come AFTER finalize, not before: it resolves the batch's periods from
    // source_of_sales_fact_rollup, which finalize is what populates.
    const FINALIZE = "finalizeSosBatchAndAuditSupersede(";
    // The module that DEFINES it matches the same string and is not a call site.
    const FINALIZE_DEF = "function finalizeSosBatchAndAuditSupersede(";
    const finalizeSites = [...walk(join(ROOT, "src")), ...walk(join(ROOT, "app"))]
      .map((file) => ({ file, body: readFileSync(file, "utf8") }))
      .filter((entry) => entry.body.includes(FINALIZE) && !entry.body.includes(FINALIZE_DEF));

    assert.ok(
      finalizeSites.length >= 2,
      `expected at least the 2 known finalize sites, found ${finalizeSites.length}`,
    );

    for (const { file, body } of finalizeSites) {
      const relative = file.slice(ROOT.length + 1).replace(/\\/g, "/");
      const netCalls = body.split(NET_WRITER).length - 1;
      const finalizeAt = body.indexOf(FINALIZE);
      const netAt = body.indexOf(NET_WRITER);
      assert.equal(
        netCalls,
        1,
        `${relative} calls ${NET_WRITER} ${netCalls}x — expected exactly ONE shared call. More than `
        + "one means a branch kept its own copy, which is the shape this check exists to stop.",
      );

      // 🔴 THE QUESTION IS WHICH BRANCH THE CALL SITS IN, and nothing simpler answers it.
      // "the net writer comes after finalize" PASSES on the known-bad code, because the one call
      // sat in the period-UNKNOWN fallback branch, which is textually after the finalize call. It
      // was written that way first and it did pass. Indentation answers it but breaks the moment
      // the tail is wrapped in a gate, which monthly-distributor-import.ts needs and
      // normalizer/service.ts does not. So match the braces instead and ask the real question: is
      // the call inside the else branch, which only an upload with no resolvable period reaches?
      const elseAt = body.indexOf("} else", finalizeAt);
      assert.ok(elseAt > finalizeAt, `${relative}: expected an else branch after ${FINALIZE}`);
      const elseOpen = body.indexOf("{", body.indexOf("else", elseAt) + 4);
      let depth = 0;
      let elseClose = -1;
      for (let i = elseOpen; i < body.length; i += 1) {
        if (body[i] === "{") depth += 1;
        else if (body[i] === "}") {
          depth -= 1;
          if (depth === 0) { elseClose = i; break; }
        }
      }
      assert.ok(elseClose > elseOpen, `${relative}: could not brace-match the else branch`);
      assert.ok(
        netAt > elseClose,
        `${relative} calls ${NET_WRITER} INSIDE the fallback branch that follows ${FINALIZE}. That `
        + "branch runs only when no single period resolves, which no real upload does — so the "
        + "period-known path refreshes the attribution rollup from the PREVIOUS import's split and "
        + "reports nothing. The call belongs after the whole if/else, where both paths reach it.",
      );
    }
  })();
}
