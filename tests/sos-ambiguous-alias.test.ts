import assert from "node:assert/strict";

import { buildAliasIndex } from "../src/lib/sales/normalizer/crosswalks.ts";

// THE AMBIGUOUS NAME RULE.
//
// Egypt reuses place names across governorates. Production currently holds 12 such pairs as
// deliberately separate bricks — الصالحية in Sharkia AND Qena, الرحمانية in Behira AND Kafr
// El-Sheikh, ابراهيميه in Alexandria AND Sharkia, مصطفى كامل as an Alex street AND a downtown
// square. The owner's ruling on these is explicit: "dol bricks mokhtlfa msh ghaltha" — they are
// different bricks, not a mistake.
//
// The danger is not the bricks, it is the alias index built over them. Its unique index is on
// (normalized_alias, target_type, target_code), so ONE name may legally point at TWO bricks. The
// original code did a plain `.set()`, which keeps whichever row the database returned last — a
// silent, arbitrary winner. Every sale carrying that name would then land in the wrong area and be
// credited to the wrong rep, with nothing anywhere to show it happened.
//
// These tests pin the rule: ambiguous resolves to NOTHING, so the row goes to review instead.
export function runSosAmbiguousAliasTests() {
  const id = (v: string) => v;
  const pick = (row: Record<string, unknown>) => String(row.target_code ?? "");

  // ── 1. One name, two different bricks -> neither wins ──────────────────────
  const clash = buildAliasIndex(
    [
      { alias: "الصالحية", target_code: "B212-3" }, // Sharkia 2
      { alias: "الصالحية", target_code: "B210-1" }, // Qena 2
    ],
    pick,
    id,
  );
  assert.equal(
    clash.index.has("الصالحية"),
    false,
    "an ambiguous name must resolve to nothing — not to the last row read",
  );
  assert.equal(clash.conflicts.has("الصالحية"), true, "the clash must be recorded, not swallowed");

  // ── 2. Order must not decide the outcome ──────────────────────────────────
  // The original bug was order-dependent: whichever row came last silently won. Feeding the same
  // two rows in the opposite order must produce the identical (empty) result.
  const reversed = buildAliasIndex(
    [
      { alias: "الصالحية", target_code: "B210-1" },
      { alias: "الصالحية", target_code: "B212-3" },
    ],
    pick,
    id,
  );
  assert.equal(reversed.index.has("الصالحية"), false, "result must not depend on row order");
  assert.deepEqual([...reversed.conflicts], [...clash.conflicts]);

  // ── 3. A third row for an already-conflicted name cannot revive it ────────
  const revived = buildAliasIndex(
    [
      { alias: "الرحمانية", target_code: "B182-2" },
      { alias: "الرحمانية", target_code: "B200-4" },
      { alias: "الرحمانية", target_code: "B182-2" }, // duplicate of the first
    ],
    pick,
    id,
  );
  assert.equal(revived.index.has("الرحمانية"), false, "a later row must not resurrect a dropped key");

  // ── 4. Duplicate rows pointing at the SAME target are not a conflict ──────
  // The alias table legitimately holds repeats (same name learned from several imports). Treating
  // those as ambiguous would throw away good mappings.
  const dupes = buildAliasIndex(
    [
      { alias: "طنطا", target_code: "B193-1" },
      { alias: "طنطا", target_code: "B193-1" },
    ],
    pick,
    id,
  );
  assert.equal(dupes.index.get("طنطا"), "B193-1", "identical repeats must still resolve");
  assert.equal(dupes.conflicts.size, 0, "identical repeats are not a conflict");

  // ── 5. Unambiguous names are untouched ────────────────────────────────────
  const clean = buildAliasIndex(
    [
      { alias: "بنها", target_code: "B208-1" },
      { alias: "الزقازيق", target_code: "B211-3" },
    ],
    pick,
    id,
  );
  assert.equal(clean.index.size, 2);
  assert.equal(clean.conflicts.size, 0);

  // ── 6. Identity is compared on the WHOLE target, not just the code ────────
  // territoryAliasByKey values carry target_type too: the same code under a different type is a
  // different target, and must conflict.
  const typed = buildAliasIndex(
    [
      { alias: "المنشأه", target_type: "brick", target_code: "X1" },
      { alias: "المنشأه", target_type: "area", target_code: "X1" },
    ],
    (row) => ({ targetType: String(row.target_type ?? "brick"), targetCode: String(row.target_code ?? "") }),
    (v) => `${v.targetType} ${v.targetCode}`,
  );
  assert.equal(typed.index.has("المنشأه"), false, "same code under a different target_type must conflict");

  // ── 7. Blank / missing aliases are skipped, never keyed as "" ─────────────
  const blanks = buildAliasIndex(
    [
      { alias: "", target_code: "B1-1" },
      { alias: null, target_code: "B1-2" },
      { alias: "   ", target_code: "B1-3" },
    ],
    pick,
    id,
  );
  assert.equal(blanks.index.size, 0, "blank aliases must not create an empty-string key");
  assert.equal(blanks.conflicts.size, 0);

  console.log("sos ambiguous alias tests passed");
}
