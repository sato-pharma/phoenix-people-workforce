import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { PROFILE_FIELDS } from "../src/lib/sales/normalizer/distributor-profile-store.ts";
import {
  FREE_GOODS_FLAG_HINT,
  FREE_GOODS_FLAG_LABEL,
  FREE_GOODS_FLAG_SHORT_LABEL,
  freeGoodsFlagNote,
} from "../src/lib/sales/normalizer/free-goods-flag.ts";
import { profilesToHeaderGrid } from "../src/lib/sales/normalizer/profile-grid.ts";
import { RAW_DISTRIBUTOR_PROFILES } from "../src/lib/sales/normalizer/profiles.ts";
import { CODED_HEADERS } from "../src/lib/sales/normalizer/service.ts";

// THE PROFILE'S `bonusColumns` FIELD IS NAMED FOR WHAT IT DOES: A FREE-GOODS FLAG THAT SKIPS THE WHOLE ROW.
//
// The engine skips a row WHOLE when that column holds anything other than 0 or false. #4028 took El
// Qema's bonus COUNT out of the built-in profile because mapping it there dropped paid units. But the
// editor, the Database Validation grid and the master workbook all still called the field "Bonus Qty"
// or "B. Qty", which is an invitation to type a bonus count into it. A saved in-app mapping WHOLLY
// replaces the built-in one, so that one entry would bring the row-drop back with no warning. Owner,
// 2026-09-07, restated 2026-09-18: no distributor's bonus is ever counted, and paid units always import.
//
// Display text only. The keys, the DB columns and the coded sheet's real "B. Qty" header are pinned
// here too, so that nothing read back as a key moved with the label.

const OLD_QTY_LABEL = /\bbonus\s*qty\b|^b\.?\s*qty$/i;

export function runProfileFreeGoodsFlagLabelTests() {
  // ── 1. The wording itself says flag, whole row, never a bonus count ──
  assert.match(FREE_GOODS_FLAG_LABEL, /free-goods flag/i);
  assert.match(FREE_GOODS_FLAG_LABEL, /whole row skipped/i);
  assert.doesNotMatch(FREE_GOODS_FLAG_LABEL, /qty|quantity/i, "the label must not call the flag a quantity");
  assert.match(FREE_GOODS_FLAG_SHORT_LABEL, /free-goods flag/i);
  assert.doesNotMatch(FREE_GOODS_FLAG_SHORT_LABEL, /qty|quantity/i);
  assert.match(FREE_GOODS_FLAG_HINT, /never map a bonus count/i, "the hint must forbid mapping a bonus count");
  assert.match(FREE_GOODS_FLAG_HINT, /0 or false/, "the hint must say which values keep the row");
  assert.match(FREE_GOODS_FLAG_HINT, /entire row, paid units included/i, "the hint must say paid units go with the row");
  // The editor is a client component and imports this module: it may import nothing, so it can never
  // drag a server-only module into the browser bundle.
  const flagModule = readFileSync("src/lib/sales/normalizer/free-goods-flag.ts", "utf8");
  assert.doesNotMatch(flagModule, /^\s*import\s/m, "free-goods-flag.ts must stay import-free (client-safe)");

  // ── 2. The store's PROFILE_FIELDS: label changed, key and DB column did not ──
  const bonus = PROFILE_FIELDS.find((f) => f.key === "bonusColumns");
  assert.ok(bonus, "PROFILE_FIELDS keeps its bonusColumns entry");
  assert.equal(bonus.column, "bonus_columns", "the DB column the save path writes is unchanged");
  assert.equal(bonus.label, FREE_GOODS_FLAG_LABEL);
  for (const f of PROFILE_FIELDS) assert.doesNotMatch(f.label, OLD_QTY_LABEL, `PROFILE_FIELDS label "${f.label}" calls the flag a quantity`);
  assert.deepEqual(
    PROFILE_FIELDS.map((f) => `${f.key}:${f.column}`),
    [
      "productCodeColumns:product_code_columns", "productNameColumns:product_name_columns", "qtyColumns:qty_columns",
      "branchCodeColumns:branch_code_columns", "branchNameColumns:branch_name_columns", "bonusColumns:bonus_columns",
      "valueColumns:value_columns", "discountColumns:discount_columns", "dateColumns:date_columns",
      "customerCodeColumns:customer_code_columns", "customerNameColumns:customer_name_columns",
      "customerAddressColumns:customer_address_columns", "areaIdColumns:area_id_columns", "areaNameColumns:area_name_columns",
      "brickIdColumns:brick_id_columns", "brickNameColumns:brick_name_columns", "regionColumns:region_columns",
    ],
    "every field key and DB column is exactly as before: only a display label moved",
  );

  // ── 3. The Database Validation grid, as emitted ──
  const grid = profilesToHeaderGrid(RAW_DISTRIBUTOR_PROFILES);
  const bonusColumn = grid.columns.find((c) => c.key === "bonus");
  assert.ok(bonusColumn, "the grid keeps its `bonus` column key");
  assert.equal(bonusColumn.label, FREE_GOODS_FLAG_SHORT_LABEL);
  for (const c of grid.columns) assert.doesNotMatch(c.label, OLD_QTY_LABEL, `grid header "${c.label}" calls the flag a quantity`);
  const epdaBank = grid.rows.find((r) => r.distributorCode === "EP-BK");
  assert.ok(epdaBank, "EP-BK is in the grid");
  assert.equal(epdaBank.cells.bonus, "is_bonus", "EPDA's real free-goods flag still shows under the column");
  const qema = grid.rows.find((r) => r.distributorCode === "QM");
  assert.ok(qema, "El Qema is in the grid");
  assert.equal(qema.cells.bonus, "—", "El Qema maps no free-goods flag (#4028)");
  // The coded sheet's "B. Qty" is a real header the importer reads back, and a different thing from
  // the flag. It must not have moved with the grid's label.
  assert.ok((CODED_HEADERS as readonly string[]).includes("B. Qty"), "the coded sheet still emits its B. Qty header");

  // ── 4. The master workbook's Distributor_Template_Rules note ──
  const note = freeGoodsFlagNote("is_bonus");
  assert.match(note, /free-goods flag/i);
  assert.match(note, /"is_bonus"/);
  assert.match(note, /skipped whole/i);
  assert.match(note, /never a bonus count/i);
  const masterWorkbook = readFileSync("src/lib/sales/master-workbook.ts", "utf8");
  assert.match(masterWorkbook, /p\.bonusColumns\?\.\[0\] \? freeGoodsFlagNote\(p\.bonusColumns\[0\]\)/, "the workbook note is built by freeGoodsFlagNote");
  assert.doesNotMatch(masterWorkbook, /Bonus qty col/i, "the workbook no longer calls the flag a bonus qty column");

  // ── 5. The editor (a client .tsx, read as source) ──
  const editor = readFileSync("src/components/sales/distributor-profile-editor.tsx", "utf8");
  assert.match(
    editor,
    /\{ key: "bonusColumns", label: FREE_GOODS_FLAG_LABEL, hint: FREE_GOODS_FLAG_HINT \}/,
    "the editor labels bonusColumns as the free-goods flag and carries the never-a-bonus-count hint",
  );
  assert.doesNotMatch(editor, /"Bonus Qty"|"B\. Qty"/, "the editor no longer calls the flag a bonus quantity");
  const hintRender = editor.match(/\{f\.hint \? <span className="([^"]*)">\{f\.hint\}<\/span> : null\}\s*<input/);
  assert.ok(hintRender, "the editor renders a field's hint between its label and its input");
  const hintClass = hintRender[1];
  assert.doesNotMatch(hintClass, /truncate|line-clamp|whitespace-nowrap/, "the hint wraps; it is never cut with an ellipsis");
  assert.doesNotMatch(hintClass, /rounded/, "the hint adds no rounded corner");
  assert.match(hintClass, /text-phx-warn/, "the hint reads in the design system's warning ink");
}
