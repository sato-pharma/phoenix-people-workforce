import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ─────────────────────────────────────────────────────────────────────────────
// Re-running the Sales → Marketing pharmacy-code sync must be boring.
//
// `phx_sync_sales_pharmacy_codes_into_marketing()` was run against production on 2026-08-19 and
// instantly turned 44,244 codes from 'matched' into 'ambiguous' — POS 27,590, Ibn sina 12,913,
// EGD 1,807, ramco 1,045, sofico 692, mec 141, epda 56. It blind-inserted one
// marketing_pharmacy_code_references row per source_of_sales_customer_map row, and because it
// resolves the vendor by normalized name, those rows landed on the SAME distributor_id as the rows
// already loaded from the two spreadsheet imports, storing the code in the same zero-padded form.
// Two rows for one code is what PASS 1 of `resolvePharmacyCodeReference` sees, and
// `buildPharmacyCodeReferenceResult` calls >1 match 'ambiguous'. PASS 2 cannot rescue it — pass 2
// only runs when pass 1 finds nothing. The 44,244 duplicates were deleted by hand.
//
// So the invariant this file exists to hold is one line long:
//
//     however many times the sync runs, every (distributor_id, normalized_pharmacy_code) pair
//     must be carried by exactly ONE reference row.
//
// The model below is a faithful, deliberately small re-implementation of the SQL in migration
// 20260819210000. A model can drift from the thing it models, so the second half of this file pins
// the migration's own text: if the guard, the intra-source `distinct on`, or the retirement
// predicate is edited away, those assertions fail even though the model still passes.
//
// Rehearsed end to end on staging (cifwmndunmlxjhyjugxa) before shipping:
//   old function, one run   → 95,159 rows, 44,213 ambiguous pairs
//   new function, three runs → 50,946 rows,      0 ambiguous pairs (runs 2 and 3 inserted nothing)
// ─────────────────────────────────────────────────────────────────────────────

const SALES_SOURCE_FILE = "source_of_sales_customer_map";

type ReferenceRow = {
  distributorId: number;
  id: number;
  rawPharmacyCode: string;
  sourceFile: string;
  sourceRow: number;
};

type MapRow = { active: boolean; customerCode: string; distributorId: number; id: number };

/** Vendors the owner has hidden. A code created under one is unreachable from the Vendor picker. */
type VendorState = Map<number, boolean>;

/** The fake's copy of the generated column `normalized_pharmacy_code`. */
function normalized(raw: string) {
  return String(raw ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

/** The fake's copy of the generated column `compact_pharmacy_code` (migration 20260816050358). */
function compact(raw: string) {
  const norm = normalized(raw);
  if (!/^[0-9]+$/.test(norm)) return norm;
  return norm.replace(/^0+/, "") || "0";
}

function pairKey(distributorId: number, code: string) {
  return `${distributorId} ${normalized(code)}`;
}

/** How many reference rows carry each (distributor_id, normalized_pharmacy_code) pair. */
function pairCounts(table: ReferenceRow[]) {
  const counts = new Map<string, number>();
  for (const row of table) {
    const key = pairKey(row.distributorId, row.rawPharmacyCode);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function duplicatedPairs(table: ReferenceRow[]) {
  return [...pairCounts(table).entries()].filter(([, count]) => count > 1);
}

/**
 * `phx_v_sales_pharmacy_code_candidates`: one row per (marketing distributor, normalized code)
 * that the LIVE customer map justifies. The `distinct on` is the intra-source guard — a `not
 * exists` subquery cannot see rows the same INSERT is adding, so without it two map rows landing
 * on one vendor would recreate the ambiguity the guard exists to prevent.
 */
function candidates(map: MapRow[]) {
  const byPair = new Map<string, MapRow>();
  for (const row of [...map].sort((a, b) => a.id - b.id)) {
    if (!row.active) continue;
    if (normalized(row.customerCode) === "") continue;
    const key = pairKey(row.distributorId, row.customerCode);
    if (!byPair.has(key)) byPair.set(key, row); // lowest map id wins, deterministically
  }
  return [...byPair.values()];
}

/** The shipped function: retire what the map no longer justifies, then insert additively. */
function syncAdditive(
  table: ReferenceRow[],
  map: MapRow[],
  links: Array<{ referenceId: number | null }>,
  vendors: VendorState = new Map(),
) {
  const isActive = (distributorId: number) => vendors.get(distributorId) ?? true;
  const live = candidates(map);
  const livePairs = new Set(live.map((row) => pairKey(row.distributorId, row.customerCode)));
  // Every code the live map carries, under ANY vendor. This is the merge guard: when the owner
  // merges vendor B into vendor A he re-points B's codes onto A's distributor_id, and the map can
  // then only ever justify them under B — the vendor he just hid. Judging staleness per-vendor
  // therefore reads all 2,671 merged production rows as dead. Judging it per-code does not.
  const liveCodes = new Set(live.map((row) => normalized(row.customerCode)));
  const linked = new Set(links.map((link) => link.referenceId).filter((id): id is number => id !== null));

  // RETIREMENT — only our own rows, only when the live map no longer produces the pair, only when
  // the code has left the map entirely, and only when nothing points at the row. reference_id is a
  // FK with ON DELETE SET NULL, so deleting a referenced row silently detaches a validated
  // customer code instead of raising anything.
  let retired = 0;
  let retainedLinked = 0;
  const kept: ReferenceRow[] = [];
  for (const row of table) {
    const staleHere =
      row.sourceFile === SALES_SOURCE_FILE && !livePairs.has(pairKey(row.distributorId, row.rawPharmacyCode));
    if (!staleHere) {
      kept.push(row);
      continue;
    }
    retainedLinked += 1;
    // Still live somewhere in the map — a merged code, or one that moved vendor. Keeping it costs
    // one redundant row under a DIFFERENT distributor_id, which the resolver does not read as
    // ambiguous because matching is scoped by distributor. Deleting it costs a real customer code.
    if (liveCodes.has(normalized(row.rawPharmacyCode)) || linked.has(row.id)) kept.push(row);
    else retired += 1;
  }

  // ADDITIVE INSERT — a pair already present under this distributor is skipped no matter which
  // source_file owns it. The compact guard protects PASS 2's "zero-stripping collapses nothing
  // inside a distributor" invariant against a same-pharmacy row arriving under different padding.
  //
  // The two guards are not independent: compact is a function of normalized, so equal normalized
  // codes always have equal compacts and the compact guard alone would hold the headline
  // invariant. The normalized guard is kept because it is the clause that mirrors what PASS 1
  // actually matches on, and it is the one that still works if compact_pharmacy_code is ever
  // absent. Behaviour cannot tell them apart, so the SQL pins at the bottom assert BOTH — deleting
  // either from the migration must fail this file.
  const existingNorm = new Set(kept.map((row) => pairKey(row.distributorId, row.rawPharmacyCode)));
  const existingCompact = new Set(kept.map((row) => `${row.distributorId} ${compact(row.rawPharmacyCode)}`));
  let nextId = Math.max(0, ...table.map((row) => row.id)) + 1;
  let synced = 0;
  for (const row of live) {
    // A hidden vendor's codes are held back, never created. Two of this sync's own vendors were
    // MERGED into their parents on 2026-08-19; the merge moved their codes to a different
    // distributor_id, so the guards below cannot see them and would rebuild 5,520 rows.
    if (!isActive(row.distributorId)) continue;
    if (existingNorm.has(pairKey(row.distributorId, row.customerCode))) continue;
    if (existingCompact.has(`${row.distributorId} ${compact(row.customerCode)}`)) continue;
    kept.push({
      distributorId: row.distributorId,
      id: nextId++,
      rawPharmacyCode: row.customerCode.trim(),
      sourceFile: SALES_SOURCE_FILE,
      sourceRow: row.id,
    });
    synced += 1;
  }

  const liveActive = live.filter((row) => isActive(row.distributorId));
  return {
    references_held_hidden_vendor: live.length - liveActive.length,
    references_retained_linked: retainedLinked - retired,
    references_retired: retired,
    references_skipped_existing: liveActive.length - synced,
    references_synced: synced,
    table: kept,
  };
}

/** What the function did BEFORE this fix: wipe its own rows, then insert every map row blindly. */
function syncBlindInsert(table: ReferenceRow[], map: MapRow[], links: Array<{ referenceId: number | null }>) {
  const surviving = table.filter((row) => row.sourceFile !== SALES_SOURCE_FILE);
  const deleted = new Set(table.filter((row) => row.sourceFile === SALES_SOURCE_FILE).map((row) => row.id));
  // ON DELETE SET NULL: the blanket delete detaches every link that pointed at a synced row.
  const linksAfter = links.map((link) => ({
    referenceId: link.referenceId !== null && deleted.has(link.referenceId) ? null : link.referenceId,
  }));

  let nextId = Math.max(0, ...table.map((row) => row.id)) + 1;
  for (const row of map) {
    if (!row.active || normalized(row.customerCode) === "") continue;
    surviving.push({
      distributorId: row.distributorId,
      id: nextId++,
      rawPharmacyCode: row.customerCode.trim(),
      sourceFile: SALES_SOURCE_FILE,
      sourceRow: row.id,
    });
  }
  return { links: linksAfter, table: surviving };
}

const POS = 19;

/** Rows already loaded from the two spreadsheet imports — the ones the sync must not shadow. */
function spreadsheetRows(): ReferenceRow[] {
  return [
    { distributorId: POS, id: 30537, rawPharmacyCode: "0001503246", sourceFile: "pos_master.xlsx", sourceRow: 11 },
    { distributorId: POS, id: 30538, rawPharmacyCode: "0001509482", sourceFile: "pos_master.xlsx", sourceRow: 12 },
  ];
}

/**
 * The live Sales map. Rows 1 and 2 repeat the spreadsheet codes verbatim — that overlap is the
 * whole incident. Row 3 is genuinely new coverage. Rows 4 and 5 are the SAME pair arriving twice
 * from two Sales distributors that normalize onto one marketing vendor, which no `not exists`
 * guard can catch on its own. Row 6 is the same pharmacy as row 1 under different padding.
 */
function liveMap(): MapRow[] {
  return [
    { active: true, customerCode: "0001503246", distributorId: POS, id: 728527 },
    { active: true, customerCode: "0001509482", distributorId: POS, id: 728778 },
    { active: true, customerCode: "0001564574", distributorId: POS, id: 730319 },
    { active: true, customerCode: "0001600001", distributorId: POS, id: 730328 },
    { active: true, customerCode: "0001600001", distributorId: POS, id: 730329 },
    { active: true, customerCode: "1503246", distributorId: POS, id: 730330 },
  ];
}

function source(relPath: string): string {
  return readFileSync(relPath, "utf8");
}

export function runMarketingSalesCodeSyncRerunTests() {
  const migration = source("supabase/migrations/20260819210000_marketing_sales_code_sync_is_additive.sql");
  // The follow-up that stops retirement undoing a vendor merge. It is the version of the function
  // actually running, so its retirement clause is the one that has to hold.
  const mergeGuardMigration = source(
    "supabase/migrations/20260819220000_sync_retirement_must_not_undo_a_vendor_merge.sql",
  );

  // ── THE TEST CAN FAIL ────────────────────────────────────────────────────
  // Before pinning the fix, prove the fixture reproduces the incident. If this stops failing under
  // the old strategy the fixture has gone toothless and every assertion below is worthless.
  {
    const broken = syncBlindInsert(spreadsheetRows(), liveMap(), [{ referenceId: 30537 }]);
    const duplicates = duplicatedPairs(broken.table);
    assert.ok(
      duplicates.length >= 2,
      "the fixture must reproduce the production defect under the OLD blind insert — otherwise the headline assertion below cannot fail and pins nothing",
    );
    assert.ok(
      duplicates.some(([key]) => key === pairKey(POS, "0001503246")),
      "the duplicated pair must be the spreadsheet code the map repeats — that is exactly what turned 44,244 codes ambiguous",
    );
  }

  // ── THE HEADLINE ─────────────────────────────────────────────────────────
  // Run the sync twice. Every pair must be carried by exactly one row, both times.
  {
    const links = [{ referenceId: 30537 }];
    const first = syncAdditive(spreadsheetRows(), liveMap(), links);
    assert.deepEqual(
      duplicatedPairs(first.table),
      [],
      "one run must leave every (distributor_id, normalized_pharmacy_code) pair with exactly one row — a second row is what makes resolvePharmacyCodeReference report 'ambiguous'",
    );

    const second = syncAdditive(first.table, liveMap(), links);
    assert.deepEqual(
      duplicatedPairs(second.table),
      [],
      "running the sync a SECOND time must still leave exactly one row per pair — this is the whole point of the fix",
    );
    assert.equal(
      second.references_synced,
      0,
      "the second run must insert nothing at all: every live pair is already present, so there is nothing additive left to do",
    );
    assert.equal(
      second.table.length,
      first.table.length,
      "a re-run must not change the row count — churn here is what would recycle ids out from under marketing_pharmacy_distributor_codes.reference_id",
    );

    const third = syncAdditive(second.table, liveMap(), links);
    assert.equal(third.references_synced, 0, "idempotence must hold beyond the second run, not just alternate");
    assert.deepEqual(duplicatedPairs(third.table), [], "still exactly one row per pair on the third run");
  }

  // The rows already loaded from a spreadsheet must survive untouched — the guard has to look at
  // the WHOLE table, not only at rows this sync owns. Guarding on source_file was the bug.
  {
    const result = syncAdditive(spreadsheetRows(), liveMap(), []);
    const survivors = result.table.filter((row) => row.sourceFile === "pos_master.xlsx").map((row) => row.id);
    assert.deepEqual(
      survivors.sort((a, b) => a - b),
      [30537, 30538],
      "both spreadsheet rows must survive: the sync adds coverage, it does not restate what another import already loaded",
    );
    assert.equal(
      result.references_synced,
      2,
      "only genuinely new pairs may be inserted — 0001564574 and 0001600001, not the two the spreadsheet already carries",
    );
    assert.equal(
      result.references_skipped_existing,
      3,
      "the skipped count must report every candidate the sync deliberately left alone — the two the spreadsheet already carries plus the padding twin of 0001503246 — so a re-run is legible rather than silent",
    );
  }

  // Two map rows collapsing onto one vendor must insert ONCE. A `not exists` guard cannot see rows
  // its own statement is inserting, so `distinct on` is load-bearing, not tidiness.
  {
    const result = syncAdditive([], liveMap(), []);
    const inserted = result.table.filter((row) => normalized(row.rawPharmacyCode) === "0001600001");
    assert.equal(
      inserted.length,
      1,
      "one pair arriving twice from the source must insert exactly once — the guard is blind to its own statement's rows, so the source set has to be de-duplicated first",
    );
    assert.equal(
      inserted[0].sourceRow,
      730328,
      "the lowest map id wins, so which row represents the pair is deterministic across runs rather than whatever the planner returned first",
    );
  }

  // Same pharmacy, different padding. PASS 2 of the resolver assumes zero-stripping collapses
  // nothing inside a distributor; importing the twin would quietly break that assumption.
  {
    const result = syncAdditive(spreadsheetRows(), liveMap(), []);
    const padded = result.table.filter((row) => compact(row.rawPharmacyCode) === "1503246");
    assert.equal(
      padded.length,
      1,
      "'1503246' must not be added alongside '0001503246' — they are one pharmacy, and two rows sharing a compact key is the ambiguity PASS 2 would then report",
    );
  }

  // ── A HIDDEN VENDOR'S CODES ARE NEVER CREATED ────────────────────────────
  // On 2026-08-19 the owner pruned the vendor list to 12 and MERGED two of this sync's own vendors
  // into their parents — Ibn Sina-Sato into Ibn sina (3,949 codes), EPDA-Pharmacies into epda
  // (1,571). A merge re-points codes onto a different distributor_id, which the guards above cannot
  // see, so without an active check a re-run rebuilds all 5,520 rows and undoes both merges.
  {
    const HIDDEN = 44;
    const hiddenVendors: VendorState = new Map([[HIDDEN, false]]);
    const map = [
      ...liveMap(),
      { active: true, customerCode: "0002000001", distributorId: HIDDEN, id: 740001 },
      { active: true, customerCode: "0002000002", distributorId: HIDDEN, id: 740002 },
    ];

    const result = syncAdditive(spreadsheetRows(), map, [], hiddenVendors);
    assert.ok(
      !result.table.some((row) => row.distributorId === HIDDEN),
      "no row may be created under a hidden vendor — it is unreachable from the Vendor picker, and for a merged vendor recreating it silently undoes the merge",
    );
    assert.equal(
      result.references_held_hidden_vendor,
      2,
      "codes held back by a hidden vendor must be counted and reported, not silently dropped — that number is how the owner sees what his vendor pruning costs",
    );
    assert.equal(
      result.references_synced,
      2,
      "hiding a vendor must not disturb what the visible vendors get: the same two genuinely new POS codes still land",
    );

    const again = syncAdditive(result.table, map, [], hiddenVendors);
    assert.equal(again.references_synced, 0, "still idempotent with a hidden vendor in the mix");
    assert.deepEqual(duplicatedPairs(again.table), [], "still exactly one row per pair");
  }

  // Rows that ALREADY sit under a hidden vendor are left alone. The owner kept 423 of them on
  // purpose; retirement must not quietly clear them out just because the insert skips that vendor.
  {
    const HIDDEN = 44;
    const hiddenVendors: VendorState = new Map([[HIDDEN, false]]);
    const existing: ReferenceRow[] = [
      ...spreadsheetRows(),
      {
        distributorId: HIDDEN,
        id: 90001,
        rawPharmacyCode: "0002000001",
        sourceFile: SALES_SOURCE_FILE,
        sourceRow: 740001,
      },
    ];
    const map = [...liveMap(), { active: true, customerCode: "0002000001", distributorId: HIDDEN, id: 740001 }];

    const result = syncAdditive(existing, map, [], hiddenVendors);
    assert.equal(
      result.references_retired,
      0,
      "a row under a hidden vendor that the live map still justifies must survive — the owner chose to keep those 423 rows, and retirement reads the map, not the vendor's visibility",
    );
    assert.ok(
      result.table.some((row) => row.id === 90001),
      "the kept row must still be there, not merely uncounted",
    );
  }

  // ── RETIREMENT, AND THE LINK IT MUST NOT BREAK ───────────────────────────
  // reference_id is a FK with ON DELETE SET NULL. The old blanket delete unlinked validated
  // customer codes with no error and no cascade — the least visible failure in this whole story.
  {
    const seeded = syncAdditive(spreadsheetRows(), liveMap(), []);
    const syncedRow = seeded.table.find((row) => normalized(row.rawPharmacyCode) === "0001564574");
    assert.ok(syncedRow, "fixture sanity: the sync must have created the row the link will point at");

    const links = [{ referenceId: syncedRow.id }];
    const shrunkMap = liveMap().map((row) => (row.id === 730319 ? { ...row, active: false } : row));

    const afterOld = syncBlindInsert(seeded.table, shrunkMap, links);
    assert.equal(
      afterOld.links[0].referenceId,
      null,
      "the OLD blanket delete silently NULLs a live link through ON DELETE SET NULL — proving the branch below is worth having",
    );

    const afterNew = syncAdditive(seeded.table, shrunkMap, links);
    assert.equal(
      afterNew.references_retired,
      0,
      "a stale row that something still points at must NOT be retired — dropping it detaches a validated customer code without saying so",
    );
    assert.equal(
      afterNew.references_retained_linked,
      1,
      "keeping a stale row has to be reported, or the sync quietly accumulates rows the map no longer justifies",
    );
    assert.ok(
      afterNew.table.some((row) => row.id === syncedRow.id),
      "the referenced row must still exist after the sync, so the link keeps pointing at something real",
    );
  }

  // A stale row nothing points at IS retired, or the table only ever grows and dead codes keep
  // telling the Customer Validation gate they are tracked.
  {
    const seeded = syncAdditive(spreadsheetRows(), liveMap(), []);
    const shrunkMap = liveMap().map((row) => (row.id === 730319 ? { ...row, active: false } : row));
    const result = syncAdditive(seeded.table, shrunkMap, []);
    assert.equal(result.references_retired, 1, "an unreferenced row the live map no longer justifies must be dropped");
    assert.ok(
      !result.table.some((row) => normalized(row.rawPharmacyCode) === "0001564574"),
      "the retired code must actually be gone, not merely counted",
    );
    assert.ok(
      result.table.some((row) => row.sourceFile === "pos_master.xlsx"),
      "retirement is scoped to rows this sync owns — a spreadsheet row is never in scope, whatever the map says",
    );
  }

  // ── A MERGED CODE IS NOT A STALE CODE ────────────────────────────────────
  // The production shape that migration 20260819210000 missed, and that 20260819220000 fixes.
  // Merging vendor B into vendor A means re-pointing B's codes onto A's distributor_id. The live
  // map still carries those codes, but only ever under B — so retirement judged per-vendor reads
  // every one of them as dead. On production that was 2,671 rows (epda 1,556, Ibn sina 1,115),
  // none of them link-protected, i.e. the first real run would have deleted all of them and undone
  // both merges. Insert-side hidden-vendor guarding does NOT cover this: it is the same owner
  // decision approached from the delete side.
  {
    const PARENT = 41; // the vendor B was merged INTO; no map row ever resolves to it
    const seeded = syncAdditive(spreadsheetRows(), liveMap(), []);
    const mergedRow = seeded.table.find((row) => normalized(row.rawPharmacyCode) === "0001564574");
    assert.ok(mergedRow, "fixture sanity: the row about to be 'merged' must exist");

    // The merge itself: same code, now sitting under the parent. The map is untouched — it still
    // justifies this code under POS, exactly as production's map still justifies the Ibn Sina-Sato
    // codes under the hidden Ibn Sina-Sato vendor rather than under `Ibn sina`.
    const afterMerge = seeded.table.map((row) =>
      row.id === mergedRow.id ? { ...row, distributorId: PARENT } : row,
    );

    const result = syncAdditive(afterMerge, liveMap(), []);
    assert.equal(
      result.references_retired,
      0,
      "a code merged onto another vendor must NEVER be retired — the live map still carries it, just under the vendor it was merged away from, and deleting it undoes the owner's merge",
    );
    assert.ok(
      result.table.some((row) => row.id === mergedRow.id && row.distributorId === PARENT),
      "the merged row must survive intact under its new vendor, not merely go uncounted",
    );
    // It is still reported as stale-under-this-vendor, so the number stays visible to a human
    // rather than the sync pretending nothing is unusual.
    assert.ok(
      result.references_retained_linked >= 1,
      "a kept-but-unjustified row must still be counted, or the sync silently accumulates rows nobody can see",
    );
  }

  // The conservative rule must not swallow retirement whole: a code that leaves the map ENTIRELY
  // is still retired. Without this, the merge guard above would be indistinguishable from deleting
  // the retirement pass.
  {
    const seeded = syncAdditive(spreadsheetRows(), liveMap(), []);
    const goneMap = liveMap().filter((row) => normalized(row.customerCode) !== "0001564574");
    const result = syncAdditive(seeded.table, goneMap, []);
    assert.equal(
      result.references_retired,
      1,
      "a code absent from the map under EVERY vendor is genuinely dead and must still be retired",
    );
  }

  // ── THE MODEL AND THE SQL MUST AGREE ─────────────────────────────────────
  // Everything above is a model. These pin the shipped migration so the model cannot silently
  // outlive the SQL it claims to describe.
  {
    // The merge guard, in the SQL that actually runs. Without this clause the retirement pass
    // deletes every code the owner merged onto another vendor.
    assert.match(
      mergeGuardMigration,
      /and not exists \(\s*select 1 from public\.phx_v_sales_pharmacy_code_candidates c2\s*where c2\.normalized_pharmacy_code = r\.normalized_pharmacy_code\s*\)/,
      "retirement must refuse to delete a code the live map still carries under ANY vendor, or a re-run undoes the owner's vendor merges (2,671 rows on production)",
    );
    assert.match(
      mergeGuardMigration,
      /and not exists \(\s*select 1 from public\.marketing_pharmacy_distributor_codes dc\s*where dc\.reference_id = r\.id\s*\)/,
      "the follow-up must keep the link guard too — replacing the function wholesale is how a fix loses an earlier one",
    );
    assert.doesNotMatch(
      mergeGuardMigration,
      /delete from public\.marketing_pharmacy_code_references\s*\n\s*where source_file = 'source_of_sales_customer_map';/,
      "the blanket delete must not come back in the follow-up either",
    );
  }
  {
    assert.match(
      migration,
      /and not exists \(\s*select 1 from public\.marketing_pharmacy_code_references r\s*where r\.distributor_id = c\.distributor_id\s*and r\.compact_pharmacy_code = c\.compact_pharmacy_code\s*\)/,
      "the insert must carry the compact guard, or a differently-padded twin of an existing code breaks the resolver's PASS 2 invariant",
    );
    assert.match(
      migration,
      /and not exists \(\s*select 1 from public\.marketing_pharmacy_code_references r\s*where r\.distributor_id = c\.distributor_id\s*and r\.normalized_pharmacy_code = c\.normalized_pharmacy_code\s*\)/,
      "the insert must carry the normalized guard over the WHOLE table — this single clause is what the 44,244-code incident was missing",
    );
    assert.doesNotMatch(
      migration,
      /r\.source_file = 'source_of_sales_customer_map'\s+and r\.normalized_pharmacy_code/,
      "the guard must never be narrowed to this sync's own rows: the duplicates it has to prevent live under the SPREADSHEET source files",
    );
    assert.match(
      migration,
      /select distinct on \(c\.distributor_id, c\.normalized_pharmacy_code\)/,
      "the candidate view must de-duplicate the source against itself — a not-exists guard is blind to rows its own INSERT is adding",
    );
    assert.match(
      migration,
      /order by c\.distributor_id, c\.normalized_pharmacy_code, c\.source_row/,
      "`distinct on` without a matching ORDER BY picks an arbitrary row, so which map row represents a pair would change between runs",
    );
    assert.match(
      migration,
      /from public\.phx_v_sales_pharmacy_code_candidates c\s*where c\.distributor_active/,
      "the insert must skip hidden vendors — without it a re-run rebuilds the 5,520 rows the owner merged into Ibn sina and epda on 2026-08-19",
    );
    assert.match(
      migration,
      /md\.active\s+as distributor_active/,
      "the candidate view must carry the vendor's active flag rather than filtering on it, so retirement can ignore it and leave the 423 deliberately-hidden rows alone",
    );
    assert.doesNotMatch(
      migration,
      /delete from public\.marketing_pharmacy_code_references r[\s\S]{0,600}?c\.distributor_active/,
      "retirement must NOT filter on distributor_active: hiding a vendor is a visibility decision, not an instruction to delete its rows",
    );
    assert.match(
      migration,
      /alter column source_row type bigint/,
      "source_row must hold source_of_sales_customer_map.id (736,844 and climbing); the old integer cast is an overflow waiting to abort the sync",
    );

    // The blanket delete must be gone, and the retirement delete must carry both predicates.
    assert.doesNotMatch(
      migration,
      /delete from public\.marketing_pharmacy_code_references\s*\n\s*where source_file = 'source_of_sales_customer_map';/,
      "the unconditional 'refresh my own rows' delete must not come back — it NULLs live reference_id values through ON DELETE SET NULL",
    );
    assert.match(
      migration,
      /select 1 from public\.marketing_pharmacy_distributor_codes dc\s*where dc\.reference_id = r\.id/,
      "retirement must skip any row a customer code still points at, or the delete silently detaches a validated pharmacy code",
    );
    assert.match(
      migration,
      /revoke all on function public\.phx_sync_sales_pharmacy_codes_into_marketing\(\) from authenticated;/,
      "a signed-in user must not be able to fire a bulk rewrite of the reference database; the only caller is a service-role script",
    );
  }

  // The script that invites a re-run must not promise more than the function delivers.
  {
    const script = source("scripts/sync-sales-pharmacy-codes-into-marketing.ts");
    assert.doesNotMatch(
      script,
      /As Sales imports more distributors, re-run this\./,
      "the old header invited exactly the re-run that broke production; it must describe what re-running now actually does",
    );
    assert.match(
      script,
      /references_skipped_existing/,
      "the script must report the skipped count, so a re-run visibly proves it added nothing rather than looking like it did nothing",
    );
    assert.match(
      script,
      /references_held_hidden_vendor/,
      "the script must report codes held back by a hidden vendor — that number is how the owner sees what his vendor pruning costs in coverage",
    );
    assert.match(
      script,
      /pg_get_function_result/,
      "the script must read the function's signature BEFORE calling it; the old function does its damage in one statement, so noticing afterwards is worth nothing",
    );
  }
}
