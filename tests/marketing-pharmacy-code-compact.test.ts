import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { resolvePharmacyCodeReference } from "@/lib/marketing-requests/service";

// ─────────────────────────────────────────────────────────────────────────────
// A rep must find a pharmacy by the code the pharmacy actually quotes.
//
// Reported from production 2026-08-16: Customer Validation said pharmacy code 1503246 was "not in
// the Phoenix database". It was — POS reference row 30537, stored as '0001503246'. POS, and only
// POS, exports its customer codes zero-padded to 10 digits: 27,611 of its 27,612 reference rows,
// which is 61% of the whole 45,414-row reference database. Every other distributor stores none.
// The lookup compared strings exactly after nothing but trim + lowercase, so for the LARGEST
// distributor the check could effectively never return "tracked".
//
// Two halves, and the second is the one that costs money:
//   1. the lookup must find the padded row from the unpadded code
//   2. what gets STORED must be the padded code, because ROI attribution joins sales on
//      normalized_pharmacy_code with exact string equality (migration 20260808231742, line 159).
//      Fixing only (1) would make the badge say "tracked" while ROI read zero forever — the
//      system would lie more convincingly than before.
//
// The zero-stripped pass is safe because it collapses nothing: verified over all 45,414 production
// rows, no two distinct codes inside one distributor share a zero-stripped key. Should an import
// ever create one, the resolver must say 'ambiguous' rather than pick a row — pinned below.
// ─────────────────────────────────────────────────────────────────────────────

type ReferenceRow = { distributorId: number; id: number; rawPharmacyCode: string };

function normalized(raw: string) {
  return String(raw ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

/** The fake's copy of `compact_pharmacy_code` (migration 20260816053000). */
function compact(code: string) {
  if (!/^[0-9]+$/.test(code)) return "";
  return code.replace(/^0+/, "") || "0";
}

type FakeOptions = {
  /** Column names filtered on, one entry per round trip actually issued. */
  issued: string[][];
  /** Simulates a database that has not had the compact column added yet. */
  withoutCompactColumn?: boolean;
  /** Simulates a database predating `normalized_pharmacy_code`, forcing the in-memory fallback. */
  withoutNormalizedColumn?: boolean;
};

function fakeSupabase(rows: ReferenceRow[], options: FakeOptions) {
  const missingColumn = { code: "42703", message: 'column does not exist' };

  return {
    from() {
      return {
        select() {
          const filters: Array<[string, unknown]> = [];
          const builder = {
            eq(column: string, value: unknown) {
              filters.push([column, value]);
              return builder;
            },
            limit() {
              return builder.run();
            },
            run() {
              options.issued.push(filters.map(([column]) => column));
              const filtersColumn = (name: string) => filters.some(([column]) => column === name);
              if (filtersColumn("compact_pharmacy_code") && options.withoutCompactColumn) {
                return Promise.resolve({ data: null, error: missingColumn });
              }
              if (filtersColumn("normalized_pharmacy_code") && options.withoutNormalizedColumn) {
                return Promise.resolve({ data: null, error: missingColumn });
              }

              const matched = rows.filter((row) =>
                filters.every(([column, value]) => {
                  if (column === "distributor_id") return row.distributorId === value;
                  if (column === "normalized_pharmacy_code") return normalized(row.rawPharmacyCode) === value;
                  if (column === "compact_pharmacy_code") return compact(normalized(row.rawPharmacyCode)) === value;
                  return false;
                }),
              );
              return Promise.resolve({
                data: matched.map((row) => ({
                  id: row.id,
                  normalized_pharmacy_code: normalized(row.rawPharmacyCode),
                  raw_pharmacy_code: row.rawPharmacyCode,
                })),
                error: null,
              });
            },
            then(onFulfilled: unknown, onRejected: unknown) {
              return builder.run().then(
                onFulfilled as never,
                onRejected as never,
              );
            },
          };
          return builder;
        },
      };
    },
  };
}

/** The real production row the owner could not find, plus an unpadded neighbour. */
const POS_ROWS: ReferenceRow[] = [
  { distributorId: 19, id: 30537, rawPharmacyCode: "0001503246" },
  { distributorId: 17, id: 44001, rawPharmacyCode: "1503246" },
];

function source(relPath: string): string {
  return readFileSync(relPath, "utf8");
}

export async function runMarketingPharmacyCodeCompactTests() {
  // ── THE HEADLINE ─────────────────────────────────────────────────────────
  // Typing the code the pharmacy quotes finds the zero-padded POS row.
  {
    const issued: string[][] = [];
    const result = await resolvePharmacyCodeReference({
      distributorId: 19,
      normalizedPharmacyCode: "1503246",
      supabase: fakeSupabase(POS_ROWS, { issued }) as never,
    });

    assert.equal(
      result.status,
      "matched",
      "typing 1503246 must find POS reference 0001503246 — the padding is the distributor's export format, not part of the pharmacy's identity",
    );
    assert.equal(result.referenceId, 30537, "the match must be the real POS row, not a neighbouring distributor's");
    assert.equal(
      result.canonicalCode,
      "0001503246",
      "the resolver must hand back the code THE SALES DATA CARRIES, because ROI attribution joins on it with exact string equality",
    );
    assert.equal(issued.length, 2, "an unpadded miss costs exactly one extra round trip — the Atlantic hop is not free");
  }

  // A rep who types the padded form must not pay for the second pass at all.
  {
    const issued: string[][] = [];
    const result = await resolvePharmacyCodeReference({
      distributorId: 19,
      normalizedPharmacyCode: "0001503246",
      supabase: fakeSupabase(POS_ROWS, { issued }) as never,
    });

    assert.equal(result.status, "matched", "the exact code must still match exactly, unchanged by this fix");
    assert.equal(result.canonicalCode, "0001503246", "an exact match is already canonical");
    assert.equal(issued.length, 1, "pass 2 must not run when pass 1 already matched");
    assert.ok(
      issued[0].includes("normalized_pharmacy_code"),
      "pass 1 stays on the exact indexed column so today's matches can never change verdict",
    );
  }

  // Distributor scoping survives. The unpadded row under Ibn sina must not leak into a POS lookup
  // and vice versa — 35 zero-stripped keys repeat ACROSS distributors in production.
  {
    const issued: string[][] = [];
    const result = await resolvePharmacyCodeReference({
      distributorId: 17,
      normalizedPharmacyCode: "1503246",
      supabase: fakeSupabase(POS_ROWS, { issued }) as never,
    });
    assert.equal(result.referenceId, 44001, "every pass stays scoped to the distributor asked about");
    assert.equal(issued.length, 1, "Ibn sina stores no padding, so its codes match on pass 1");
  }

  // A genuinely absent code stays absent. The fix must not invent a match.
  {
    const issued: string[][] = [];
    const result = await resolvePharmacyCodeReference({
      distributorId: 19,
      normalizedPharmacyCode: "9999999",
      supabase: fakeSupabase(POS_ROWS, { issued }) as never,
    });
    assert.equal(result.status, "not_found", "stripping zeros must widen the search, never fabricate a hit");
    assert.equal(result.canonicalCode, null, "nothing was proven, so there is no canonical code to store");
    assert.equal(result.referenceId, null, "not_found never carries a reference id");
  }

  // If an import ever DOES create a collision, refuse to guess.
  {
    const issued: string[][] = [];
    const result = await resolvePharmacyCodeReference({
      distributorId: 19,
      normalizedPharmacyCode: "1503246",
      supabase: fakeSupabase(
        [
          { distributorId: 19, id: 30537, rawPharmacyCode: "0001503246" },
          { distributorId: 19, id: 30538, rawPharmacyCode: "01503246" },
        ],
        { issued },
      ) as never,
    });
    assert.equal(
      result.status,
      "ambiguous",
      "two stored codes sharing one zero-stripped key must report ambiguous — picking one would silently attribute a pharmacy's sales to the wrong row",
    );
    assert.equal(result.canonicalCode, null, "an ambiguous verdict must never hand a code back to be stored");
  }

  // An alphanumeric code that legitimately begins with '0' is not a padded number.
  {
    const issued: string[][] = [];
    const result = await resolvePharmacyCodeReference({
      distributorId: 19,
      normalizedPharmacyCode: "0a1503246",
      supabase: fakeSupabase([{ distributorId: 19, id: 1, rawPharmacyCode: "a1503246" }], { issued }) as never,
    });
    assert.equal(result.status, "not_found", "only purely numeric codes are compacted — '0a…' is a different code, not a padded one");
    assert.equal(issued.length, 1, "a non-numeric code must not spend a second round trip");
  }

  // A database without the compact column yet must still answer truthfully, not throw. The repo
  // ships the migration and the code together, but a stale preview must degrade, not break.
  {
    const issued: string[][] = [];
    const result = await resolvePharmacyCodeReference({
      distributorId: 19,
      normalizedPharmacyCode: "1503246",
      supabase: fakeSupabase(POS_ROWS, { issued, withoutCompactColumn: true }) as never,
    });
    assert.equal(result.status, "not_found", "a missing compact column falls back to the strict exact verdict rather than failing the save");
  }

  // The in-memory fallback (no normalized column at all) applies the SAME two passes in the same
  // order — otherwise the two code paths would disagree about whether a pharmacy exists.
  {
    const issued: string[][] = [];
    const result = await resolvePharmacyCodeReference({
      distributorId: 19,
      normalizedPharmacyCode: "1503246",
      supabase: fakeSupabase(POS_ROWS, { issued, withoutNormalizedColumn: true }) as never,
    });
    assert.equal(result.status, "matched", "the fallback path must be zero-padding tolerant too");
    assert.equal(result.canonicalCode, "0001503246", "the fallback must return the same canonical code as the indexed path");
  }

  // ── WHAT GETS STORED ─────────────────────────────────────────────────────
  // Both write paths must persist the canonical code, or ROI attribution silently reads zero.
  {
    const serviceSource = source("src/lib/marketing-requests/service.ts");
    assert.match(
      serviceSource,
      /const storedPharmacyCode = reference\.canonicalCode \?\? vendorCode\.normalizedPharmacyCode;/,
      "Customer Validation must store the reference's canonical code, falling back to the rep's entry only when nothing matched",
    );
    assert.match(
      serviceSource,
      /normalized_pharmacy_code: storedPharmacyCode,/,
      "the insert must write storedPharmacyCode — writing the rep's raw entry is exactly the bug that makes a 'tracked' pharmacy report zero ROI",
    );

    const writerSource = source("src/lib/marketing-requests/roi-sheet-writer.ts");
    assert.match(
      writerSource,
      /const storedPharmacyCode = reference\.canonicalCode \?\? identity\.normalizedCode;/,
      "the bulk ROI importer must canonicalise on the same rule as the UI, or the two creation paths drift again",
    );
    assert.match(
      writerSource,
      /normalized_pharmacy_code: storedPharmacyCode,/,
      "the importer's upsert must write the canonical code too",
    );
  }

  // ── THE SQL AND THE TYPESCRIPT MUST AGREE ────────────────────────────────
  // `compact_pharmacy_code` is a stored generated column; if its expression and compactNumericCode
  // ever diverge, the indexed lookup returns nothing and the failure is silent.
  {
    const migration = source("supabase/migrations/20260816050358_marketing_pharmacy_code_compact_key.sql");
    assert.match(
      migration,
      /~ '\^\[0-9\]\+\$'/,
      "the column must compact only purely numeric codes, matching compactNumericCode's guard",
    );
    assert.match(
      migration,
      /ltrim\(lower\(btrim\(regexp_replace\(coalesce\(raw_pharmacy_code, ''\), '\\s\+', ' ', 'g'\)\)\), '0'\)/,
      "the column must strip leading zeros off the SAME normalization the exact column uses",
    );
    assert.match(
      migration,
      /nullif\(/,
      "an all-zero code must compact to '0', never to the empty string that would match every blank",
    );
    assert.match(
      migration,
      /create index if not exists marketing_pharmacy_code_refs_compact_lookup_idx\s+on public\.marketing_pharmacy_code_references \(distributor_id, compact_pharmacy_code\)/,
      "pass 2 must be an index probe — without this index it scans the distributor's 27,612 rows on every keystroke",
    );
  }
}
