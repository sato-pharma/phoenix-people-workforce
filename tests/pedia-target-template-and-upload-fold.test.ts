import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { foldAreaOptionsForLine } from "../src/lib/sales/closing-area-merges.ts";
import {
  validateTargetRows,
  type TargetInputRow,
  type TargetValidationRefs,
} from "../src/lib/sales/monthly-targets.ts";

/**
 * THE PEDIA TARGET TEMPLATE OFFERS ONE AREA FOR THE MERGED PAIR, AND THE UPLOAD FOLDS ONTO IT.
 *
 * ## Why this exists
 *
 * The Targets grid now renders Pedia's Fayoum (`GZ6`) + Beni Suef (`UE9`) as ONE row — the owner's
 * ruling, restated 2026-09-05: "in pedia only they are one area yes". That left the authoring side
 * contradicting the display side:
 *
 *   · `au_v_line_area_map` carries BOTH Pedia rows with `carries_target = true`, so
 *     `loadTargetableAreas("pedia")` listed "Beni Suef" as its own area in the download template;
 *   · `validateTargetRows` accepted a `pedia|UE9` row and stored it on `UE9`.
 *
 * A target authored that way is written to a cell the only screen able to show it will never
 * render — the grid shows the merged `GZ6` row. Authored, saved, invisible.
 *
 * ## The collision the fix has to own
 *
 * Folding `UE9` onto `GZ6` makes a clash reachable that the sheet does not look like it has: Fayoum
 * on one row and Beni Suef on another are now ONE cell. `phx_upsert_monthly_targets` is
 * ON CONFLICT DO UPDATE, so both would be sent and the LAST would silently win — the identical
 * last-write-wins loss this pair already caused in the grid. The later row is rejected with a
 * message naming the row it collides with. Summing them would be inventing a rule nobody stated;
 * rejecting says exactly what to do.
 *
 * Note this also closes a pre-existing silent loss: two rows for the SAME area and product (no
 * merge involved) used to last-write-win too, with nothing reported.
 */

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

/** Minimal refs mirroring what `loadTargetValidationRefs` builds from `au_v_line_area_map`. */
function refs(): TargetValidationRefs {
  return {
    lineByKey: new Map([["pedia", "pedia"], ["cns", "cns"]]),
    areaByKey: new Map([
      ["gz6", "GZ6"],
      ["fayoum", "GZ6"],
      ["ue9", "UE9"],
      ["beni suef", "UE9"],
      ["gz1", "GZ1"],
    ]),
    // Both Pedia halves carry a target in the live map — that is what made the template offer both.
    lineAreaCarriesTarget: new Map([
      ["pedia|GZ6", true],
      ["pedia|UE9", true],
      ["pedia|GZ1", true],
      ["cns|GZ6", true],
      ["cns|UE9", true],
    ]),
    productByKey: new Map([["p1", "P1"], ["p2", "P2"]]),
    confidentialByKey: new Set<string>(),
  };
}

function inputRow(input: Partial<TargetInputRow> & { rowNumber: number; area: string }): TargetInputRow {
  return {
    period: "2026-09",
    line: "pedia",
    product: "P1",
    targetUnits: null,
    targetValue: 100,
    ...input,
  };
}

export function runPediaTargetTemplateAndUploadFoldTests() {
  // ── 1. THE TEMPLATE — one option for the merged pair, under the survivor's code ──────────────
  // `loadTargetableAreas` needs a live DB, so the fold it now applies is exercised directly on the
  // shape that query returns.
  const fromMap = [
    { areaCode: "GZ1", areaName: "Giza 1", regionCode: "GZ", areaState: null },
    { areaCode: "GZ6", areaName: "Fayoum", regionCode: "GZ", areaState: null },
    { areaCode: "UE9", areaName: "Beni Suef", regionCode: "UE", areaState: null },
  ];
  const pediaOptions = foldAreaOptionsForLine("pedia", fromMap);
  assert.deepEqual(
    pediaOptions.map((a) => `${a.areaCode}:${a.areaName}`),
    ["GZ1:Giza 1", "GZ6:Fayoum - Beni Suef"],
    "the Pedia template must offer ONE area for the merged pair. Offering \"Beni Suef\" separately "
      + "invites a target written to a cell the grid — which renders the pair as one merged row — can "
      + "never display or edit",
  );

  // Anti Infective has no rule and must pass through untouched, both halves intact — folding it
  // would silently delete a targetable area from the template.
  assert.deepEqual(
    foldAreaOptionsForLine("anti_infective", fromMap).map((a) => a.areaCode),
    ["GZ1", "GZ6", "UE9"],
    "Anti Infective is deliberately NOT merged — Beni Suef is its own UE-1 territory there",
  );

  // CNS folds from August. Nothing targetable is lost by it: on CNS both codes carry
  // `carries_target = false` in au_v_line_area_map, so neither was offered as a target area anyway.
  assert.deepEqual(
    foldAreaOptionsForLine("cns", fromMap).map((a) => a.areaCode),
    ["GZ1", "GZ6"],
    "CNS offers the merged pair as one option from August",
  );
  assert.deepEqual(
    foldAreaOptionsForLine("cns", fromMap, "2026-07").map((a) => a.areaCode),
    ["GZ1", "GZ6", "UE9"],
    "and July, which is published, still offers the two separately",
  );

  // …and `loadTargetableAreas` must actually APPLY it. The two assertions above exercise the helper,
  // which was already correct — deleting the call in the loader left them both green. Pinned at
  // source because the loader needs a live DB, and the whole template fix lives in this one call.
  const moduleSource = readSource("../src/lib/sales/monthly-targets.ts");
  assert.match(
    moduleSource,
    /return foldAreaOptionsForLine\(lineCode, areas\);/,
    "loadTargetableAreas must fold its option list before returning it — without this the download "
      + "template offers \"Beni Suef\" for Pedia again and the helper tests above still pass",
  );

  // ── 2. THE UPLOAD — a "Beni Suef" row is accepted and stored on the merged cell ──────────────
  const folded = validateTargetRows([inputRow({ rowNumber: 2, area: "Beni Suef" })], refs());
  assert.deepEqual(folded.errors, [], "a Pedia Beni Suef row is valid input — it names a real area");
  assert.equal(
    folded.valid[0]!.area_code,
    "GZ6",
    "and must be STORED on the merged cell. Left on UE9 it is written to a row the grid never "
      + "renders, so the operator sees no target where he just set one",
  );

  // CNS folds too, from August — so a CNS "Beni Suef" row is stored on the merged cell exactly as
  // Pedia's is. Anti Infective still keeps its own code, which the option-list assertion above
  // pins (the upload fixture's line map only knows the two folding lines).
  const cns = validateTargetRows([inputRow({ rowNumber: 2, area: "Beni Suef", line: "cns" })], refs());
  assert.equal(
    cns.valid[0]!.area_code,
    "GZ6",
    "CNS stores Beni Suef on the merged cell from August — left on UE9 it would be written to a " +
      "row the grid never renders",
  );

  // ── 3. THE COLLISION the fold makes reachable ───────────────────────────────────────────────
  const clash = validateTargetRows(
    [
      inputRow({ rowNumber: 2, area: "Fayoum", targetValue: 100 }),
      inputRow({ rowNumber: 7, area: "Beni Suef", targetValue: 50 }),
    ],
    refs(),
  );
  assert.equal(
    clash.valid.length,
    1,
    "two rows that fold onto one cell must not BOTH be sent — phx_upsert_monthly_targets is "
      + "ON CONFLICT DO UPDATE, so the second would silently overwrite the first",
  );
  assert.equal(clash.valid[0]!.target_value, 100, "the first row stands; the later one is the rejected one");
  assert.equal(clash.errors.length, 1);
  assert.equal(clash.errors[0]!.code, "duplicate_target_cell");
  assert.equal(clash.errors[0]!.rowNumber, 7);
  assert.match(
    clash.errors[0]!.message,
    // `[\s\S]` rather than `.` with the /s flag: TS1501 — dotAll needs an es2018+ target.
    /Row 2 already sets [\s\S]*"GZ6" and "UE9" are ONE area[\s\S]*Combine them into a single row\./,
    "the message must name the row it collides with AND explain that the two areas are one on this "
      + "line — otherwise the author sees a duplicate error for two rows that look different",
  );

  // ── 4. The same guard on a plain duplicate — a silent loss that predates the fold ────────────
  const plain = validateTargetRows(
    [inputRow({ rowNumber: 2, area: "Fayoum" }), inputRow({ rowNumber: 3, area: "Fayoum" })],
    refs(),
  );
  assert.equal(plain.valid.length, 1, "two rows for the SAME cell were previously both sent, last-write-wins");
  assert.doesNotMatch(
    plain.errors[0]!.message,
    /ONE area/,
    "a plain duplicate must NOT claim two areas were merged — that explanation is only true when the "
      + "fold actually caused the clash",
  );

  // ── 5. Not over-applied — different products and different periods are different cells ───────
  const distinct = validateTargetRows(
    [
      inputRow({ rowNumber: 2, area: "Fayoum", product: "P1" }),
      inputRow({ rowNumber: 3, area: "Beni Suef", product: "P2" }),
      inputRow({ rowNumber: 4, area: "Fayoum", product: "P1", period: "2026-10" }),
    ],
    refs(),
  );
  assert.deepEqual(distinct.errors, [], "the cell key is (period, line, area, product) — only a full match collides");
  assert.equal(distinct.valid.length, 3);

  // ── 6. Validation still reports the ORIGINAL area, not the folded one ───────────────────────
  // Folding before the mapping checks would make an "Other" or unmapped area report itself as GZ6.
  const notInLine = validateTargetRows(
    [inputRow({ rowNumber: 2, area: "GZ1", line: "cns" })],
    refs(),
  );
  assert.equal(notInLine.errors[0]!.code, "area_not_in_line");
  assert.match(
    notInLine.errors[0]!.message,
    /"GZ1"/,
    "an unmapped area must name ITSELF in the error — validation runs on the original code and only "
      + "the stored code is folded",
  );
}
