import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { fromBaseUnits, toBaseUnits } from "../src/lib/production-planning/display-units.ts";
import {
  COMPOSITION_BASES,
  formatQty,
  MATERIAL_SUPPLIERS,
  parseQty,
  QTY_SCALE,
  SETTLED_SUPPLIERS,
} from "../src/lib/production-planning/rules.ts";
import {
  PP,
  PP_EN,
  PRODUCTION_PLANNING_ERRORS,
  PRODUCTION_PLANNING_ERRORS_EN,
} from "../src/lib/production-planning/strings.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * Production Planner — entering and changing a formula line FROM THE SCREEN.
 *
 * The owner asked for this on 2026-10-08 ("wire the composition editor into the planner Settings
 * tab") after the retire control shipped and its restore hint had to say, truthfully, that a
 * material comes back with no composition. `saveMaterialAndComposition` and its route were correct
 * and tested, and reached by NO control at all: measured on the branch before this one, the Settings
 * tab posted to `/stock`, `/fx`, `/prices`, `/runs`, `/settings`, `/access-grants` and to
 * `/materials` only with an `active` flag — never to the field save. So a quantity, a basis, a
 * supplier or an overage could be changed only by hand-written SQL.
 *
 * ── The one defect here that would not look like one ──────────────────────────────────────────────
 *
 * `qty_per_basis` is stored in the material's BASE unit — grams. The owner's source data is in the
 * DISPLAY unit: DBK's sheet is headed "Quantity Aluminum / box" and reads `0.018`, which is 18 g.
 * A field that takes kilograms and a row that holds grams differ by a thousand, and a thousandfold
 * slip in either direction is an ordinary-looking number on an ordinary-looking row:
 *
 *   • seeded wrong → the field opens on 18 under a kilogram label, saves 18,000 g, and the buy list
 *     asks DBK for eighteen tonnes of film;
 *   • converted wrong on save → it stores 0.018 g, and six runs of film cost nothing at all.
 *
 * So the first half of this suite is ARITHMETIC on the real converters, imported: they live in
 * `src/lib/production-planning/display-units.ts` precisely so a test can run them rather than read
 * them. The rest is source shape, because the write path is three PostgREST calls — what is pinned
 * there is which route the editor posts to, what it leaves out, and what it shows him before saving.
 */

const WORKSPACE = "src/components/production-planning/production-planning-workspace.tsx";
const SERVICE = "src/lib/production-planning/service.ts";

/**
 * 🔴 Comments stripped with the sanctioned stripper before every source assertion.
 *
 * The editor's own prose names `active`, the removal it refuses and the figures it must not store,
 * so a raw read would pass its own checks on the comments explaining them. `stripComments` blanks in
 * place, so offsets and line numbers survive; a hand-rolled strip is refused by
 * `tests/comment-strip-ratchet.test.ts`.
 */
const sourceOf = (path: string) => stripComments(readFileSync(path, "utf8"));

/**
 * One named function's body, by brace counting.
 *
 * Deliberately not a regex: a regex that stops at the first blank line or at a closing brace in
 * column 0 passes when the block it was watching is moved one indentation level out — which is
 * exactly the edit this is here to catch.
 */
function bodyOf(source: string, signature: string): string {
  const at = source.indexOf(signature);
  assert.ok(at >= 0, `expected to find ${JSON.stringify(signature)}`);
  const open = source.indexOf("{", at);
  assert.ok(open >= 0, `${JSON.stringify(signature)} should open a body`);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open, index + 1);
    }
  }
  throw new Error(`unbalanced braces after ${JSON.stringify(signature)}`);
}

const KG = { basePerDisplay: "1000" }; // grams per kilogram — every mass material in this module
const COUNT = { basePerDisplay: "1" }; // a piece is a piece: cartons, stickers, leaflets, seals

export function runProductionPlanningCompositionEditorTests() {
  // ── The unit arithmetic, on the module's own real figures ──────────────────────────────────────

  // The aluminium film, the material this defect was measured on: DBK's sheet says 0.018 kg a box,
  // and the row holds 18 g.
  assert.equal(toBaseUnits("0.018", KG), "18", "🔴 0.018 kg of film must store as 18 g, not as 0.018");
  assert.equal(fromBaseUnits("18", KG), "0.018", "🔴 and the field must open on 0.018, never on 18");

  const realFigures: Array<[string, string]> = [
    ["0.018", "18"], // aluminium film, per box of 12
    ["120", "120000"], // paracetamol, Guamusin's six runs
    ["24", "24000"], // guaifenesin
    ["0.005", "5"], // xanthan gum and citric acid, per 5 ml dose
    ["0.0035", "3.5"], // lemon flavour — a BASE figure that is itself fractional
    ["0.0067", "6.7"], // potassium sorbate
    ["72.1", "72100"], // ivy extract
    ["4284.8", "4284800"], // the figure that proves this is not floating point
  ];
  for (const [display, base] of realFigures) {
    assert.equal(toBaseUnits(display, KG), base, `${display} kg should store as ${base} g`);
    assert.equal(
      fromBaseUnits(base, KG),
      display,
      `🔴 ${base} g should open the field as ${display} kg — the two must be exact inverses`,
    );
  }

  // 🔴 The ROUND TRIP is the assertion, not the two directions separately: a pair of functions that
  // are each "nearly right" is exactly how 18 becomes 18,000.
  for (const [display, base] of realFigures) {
    assert.equal(fromBaseUnits(toBaseUnits(display, KG), KG), display, `${display} must survive a round trip`);
    assert.equal(toBaseUnits(fromBaseUnits(base, KG), KG), base, `${base} must survive the reverse round trip`);
  }

  // 🔴 And it is NOT done in floating point, in EITHER direction. These two are the measured
  // premise — a `* 1000` and a `/ 1000` written the obvious way each produce a figure no sheet in
  // this module contains, and 1.001 kg and 2.1 g are both perfectly ordinary quantities here.
  assert.equal(String(Number("1.001") * 1000), "1000.9999999999999", "the premise: the multiply is wrong");
  assert.equal(String(Number("2.1") / 1000), "0.0021000000000000003", "and so is the divide");
  assert.equal(toBaseUnits("1.001", KG), "1001", "the string arithmetic is right");
  assert.equal(fromBaseUnits("2.1", KG), "0.0021", "in both directions");

  // A count material converts by 1, so both directions are identity — cartons, stickers, leaflets
  // and the aluminium seal all sit here, and a stray factor would silently change every one.
  for (const value of ["1", "12", "10000", "68250"]) {
    assert.equal(toBaseUnits(value, COUNT), value, `a count material must not scale ${value}`);
    assert.equal(fromBaseUnits(value, COUNT), value, `and must not scale ${value} back`);
  }

  // Anything that is not a plain decimal is handed back untouched, in both directions: the field
  // then shows exactly what is stored, which is wrong-LOOKING rather than wrong.
  for (const odd of ["", "  ", "abc", "1e3", "-5", "1,5", "."]) {
    assert.equal(toBaseUnits(odd, KG), odd.trim(), `toBaseUnits must not transform ${JSON.stringify(odd)}`);
    assert.equal(fromBaseUnits(odd, KG), odd.trim(), `fromBaseUnits must not transform ${JSON.stringify(odd)}`);
  }
  // Nor when the factor is not a power of ten. No such material exists today; if one is added the
  // converters refuse it rather than inventing a shift that is nearly right.
  assert.equal(toBaseUnits("2", { basePerDisplay: "144" }), "2", "a non-decimal factor is left alone");
  assert.equal(fromBaseUnits("288", { basePerDisplay: "144" }), "288", "in both directions");
  // And a missing material is the same refusal, not a crash: the editor can be open on a material
  // the workspace has since reloaded without.
  assert.equal(toBaseUnits("0.018", undefined), "0.018");
  assert.equal(fromBaseUnits("18", undefined), "18");

  // The base figures above are what the service will parse. Proving they survive `parseQty` and
  // `formatQty` closes the loop between this screen and the stored row.
  for (const [, base] of realFigures) {
    assert.equal(formatQty(parseQty(base, "qtyPerBasis")), base, `${base} must round trip the service's own parser`);
  }
  assert.equal(parseQty("18", "qtyPerBasis"), BigInt(18) * QTY_SCALE, "18 g is 18 whole base units");

  // ── The editor posts the field save, never the retire ──────────────────────────────────────────

  const workspace = sourceOf(WORKSPACE);
  const saveLine = bodyOf(workspace, "const saveLine = async ()");

  assert.ok(
    !/\bactive\b/.test(saveLine),
    '🔴 the editor must not send an `active` flag: the route splits on `"active" in body`, so one ' +
      "present at all — even false — routes a formula save into the retire path",
  );
  assert.match(saveLine, /materialId: editingMaterial\.id/);
  assert.match(
    saveLine,
    /productId: data\.productId/,
    "the service only touches the composition when BOTH productId and qtyPerBasis are present",
  );
  assert.match(
    saveLine,
    /qtyPerBasis: toBaseUnits\(typed, editingMaterial\)/,
    "🔴 the typed figure goes through toBaseUnits — the field is the display unit, the row is base",
  );
  assert.match(
    saveLine,
    /overagePct: lineOverage\.trim\(\) === "" \? null : lineOverage\.trim\(\)/,
    "🔴 a blank overage is NULL, so it inherits the module default — Guamusin's explicit 0 is a " +
      "Guamusin decision and must not become every material's",
  );
  assert.match(
    saveLine,
    /lineFrom\.trim\(\) === "" \? \{\} : \{ effectiveFrom: lineFrom\.trim\(\) \}/,
    "an omitted date lets the service default to today rather than sending an empty string",
  );
  assert.match(saveLine, /Number\(typed\) <= 0/, "zero and below are refused before the round trip");
  assert.match(
    saveLine,
    /t\.compositionNoRemoval/,
    "🔴 and a typed ZERO is answered with what to do instead — a line cannot be removed, the " +
      "material is retired",
  );

  // The seed converts OUT of base units. Opening the field on the stored figure is the same defect
  // reversed, and it is the one a reviewer would not see.
  const openLine = bodyOf(workspace, "const openLine = (material: WireMaterial)");
  assert.match(
    openLine,
    /fromBaseUnits\(line\.qtyPerBasis, material\)/,
    "🔴 the field opens on the DISPLAY figure, never on the stored base one",
  );
  assert.match(openLine, /setLineBasis\(line\?\.basis \?\? "per_dose"\)/, "a new line opens on the common basis");
  assert.match(
    openLine,
    /setLineSupplier\(line\?\.supplier \?\? material\.supplier \?\? "factory"\)/,
    "and on who the product link says brings it, else the common supplier",
  );

  // ── The selects offer exactly what the service accepts ─────────────────────────────────────────

  assert.match(
    workspace,
    /import \{[^}]*\bCOMPOSITION_BASES\b[^}]*\bMATERIAL_SUPPLIERS\b[^}]*\bSETTLED_SUPPLIERS\b[^}]*\} from "@\/lib\/production-planning\/rules"/,
    "🔴 the enums come from the module's own kernel — a retyped list is how a select and the " +
      "table's own CHECK start to disagree",
  );
  assert.match(workspace, /COMPOSITION_BASES\.map\(/, "every basis is offered");
  assert.match(workspace, /MATERIAL_SUPPLIERS\.map\(/, "and every supplier");
  assert.match(
    workspace,
    /!SETTLED_SUPPLIERS\.includes\(lineSupplier\)/,
    "🔴 an unsettled supplier is warned about BEFORE the save — prodplan_plan_lines refuses it at " +
      "the commit, which is far too late to find out",
  );
  // The warning must name the consequence, not merely exist.
  assert.match(PP_EN.compositionUnsettledWarning, /blocks a committed plan/i);
  assert.equal(SETTLED_SUPPLIERS.length, 2, "two settled suppliers; a third needs this warning rethought");

  // The service's own refusals are still the gate; the client guard only shortens the trip.
  const service = sourceOf(SERVICE);
  const save = bodyOf(
    service,
    "export async function saveMaterialAndComposition(access: AccessContext, body: Record<string, unknown>)",
  );
  assert.match(save, /qtyPerBasis <= BigInt\(0\)/, "the service refuses zero regardless of the screen");
  assert.match(save, /if \(!basis\) throw/, "and an unknown basis");
  assert.match(save, /if \(!supplier\) throw/, "and an unknown supplier");
  assert.ok(PRODUCTION_PLANNING_ERRORS.qtyMustBePositive.length > 0);
  assert.ok(PRODUCTION_PLANNING_ERRORS_EN.qtyMustBePositive.length > 0);

  // ── The stored figure is echoed back before the save ───────────────────────────────────────────

  assert.match(
    workspace,
    /t\.compositionQtyStoredPreview/,
    "🔴 the figure that will land in the database is shown back in its own unit — the whole " +
      "defence against the thousandfold slip is that he reads it before saving",
  );
  assert.match(
    workspace,
    /storedPreview !== "" && storedPreview !== lineQty\.trim\(\)/,
    "and it is hidden when the conversion changed nothing, so it never becomes noise",
  );
  assert.match(
    workspace,
    /const storedPreview = editingMaterial \? toBaseUnits\(lineQty\.trim\(\), editingMaterial\) : ""/,
    "the echo is the SAME conversion the save uses — a second implementation could agree with the " +
      "field while disagreeing with the row",
  );

  // ── Names, never ids ──────────────────────────────────────────────────────────────────────────

  assert.match(
    workspace,
    /grant\.personName \?\? grant\.hrId/,
    "🔴 a grant row leads with the NAME and falls back to the id — the owner's standing rule, and " +
      "this list showed a bare HR id until now",
  );
  // The lookup itself moved out to the shared `namesByHrId` once three modules were found keeping
  // their own copy of it (and this one's copy did not chunk its filter). What this suite still owns
  // is that the grant list READS IT THERE: the mixed-case trap, the chunking and the display name
  // are pinned by `tests/employees-names-by-hr-id.test.ts`, against the behaviour rather than the
  // text, so re-asserting them here would only duplicate a fingerprint of the old copy.
  const grantList = bodyOf(service, "export async function listAccessGrants(access: AccessContext)");
  assert.match(
    grantList,
    /await namesByHrId\(/,
    "🔴 the grant list resolves names through the shared namesByHrId — production stores hr_id " +
      "mixed-case, so a hand-rolled .in() matches nobody and returns NO error",
  );
  assert.match(
    grantList,
    /personName: names\.get\(String\(row\.hr_id\)\)/,
    "and it reads the index by the id itself — the accessor canonicalises, so no call site is left " +
      "writing `get(canonicalHrIdKey(id) ?? \"\")`, which looks up the EMPTY key when there is no id",
  );
  assert.match(
    service,
    /import \{ namesByHrId \} from "@\/lib\/employees\/names-by-hr-id"/,
    "imported from the shared module, not re-declared locally",
  );

  // ── Both catalogues, no Arabic left in the English half ────────────────────────────────────────

  const keys = [
    "settingsCompositionHint",
    "compositionColMaterial",
    "compositionColQty",
    "compositionColBasis",
    "compositionColSupplier",
    "compositionEdit",
    "compositionEnter",
    "compositionCancel",
    "compositionEditorFor",
    "compositionQty",
    "compositionQtyTypedIn",
    "compositionQtyStoredAs",
    "compositionQtyStoredPreview",
    "compositionQtyRequired",
    "compositionBasis",
    "compositionSupplier",
    "compositionOverage",
    "compositionOverageHint",
    "compositionEffectiveFrom",
    "compositionEffectiveFromHint",
    "compositionUnsettledWarning",
    "compositionNoRemoval",
  ] as const;
  for (const key of keys) {
    assert.ok(PP[key] && PP[key].length > 0, `${key} is missing from the Arabic catalogue`);
    assert.ok(PP_EN[key] && PP_EN[key].length > 0, `${key} is missing from the English catalogue`);
    assert.ok(
      !/[؀-ۿ]/.test(PP_EN[key]),
      `🔴 ${key} leaves an Arabic word in the middle of an English page`,
    );
  }

  // Every basis the select offers has to be nameable, or an option renders blank and he picks it by
  // position.
  assert.equal(COMPOSITION_BASES.length, 5, "five bases; a sixth needs a label in both catalogues");
  assert.equal(MATERIAL_SUPPLIERS.length, 3, "three suppliers, one of them the unsettled state");

  // ── The formula is the FIRST section in the tab ────────────────────────────────────────────────

  const settingsTab = workspace.slice(workspace.indexOf("export function SettingsTab({"));
  const order = [...settingsTab.matchAll(/<SectionTitle[^>]*title=\{(t\.[A-Za-z]+)\}/g)].map((match) => match[1]);
  assert.deepEqual(
    order,
    [
      "t.settingsComposition",
      "t.settingsRetired",
      "t.settingsTitle",
      "t.settingsAlarmEnabled",
      "t.settingsExpiryAlarmEnabled",
      "t.settingsAccess",
    ],
    "🔴 the formula comes FIRST — it is what this tab is opened to read, and it used to sit under " +
      "the numbers, both alarms and the access list",
  );

  console.log("  production planning — the composition editor: OK");
}
