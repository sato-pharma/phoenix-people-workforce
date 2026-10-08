import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { parsePct, QTY_SCALE } from "../src/lib/production-planning/rules.ts";
import {
  otherProductsUsingMaterial,
  type LoadedMaterial,
  type ProductionPlanningData,
} from "../src/lib/production-planning/service.ts";
import {
  PP,
  PP_EN,
  PRODUCTION_PLANNING_ERRORS,
  PRODUCTION_PLANNING_ERRORS_EN,
} from "../src/lib/production-planning/strings.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * Production Planner — retiring a material from the screen, and bringing it back.
 *
 * The owner asked for this on 2026-10-08 ("let the planner screen deactivate a material") after a
 * night in which three materials had to be switched off by hand-written SQL: the pre-split combined
 * `LEAFLET`, `STICKER_GUAMUSIN` when he corrected his own packaging list, and `LEAFLET_OLD` when he
 * said to forget the old artwork. Every one of those was a database change for something that reads
 * like a click — the hole in his own standing rule that everything in this module is editable from
 * the screen and stored in the database.
 *
 * ── The four ways this feature could be wrong while looking right ────────────────────────────────
 *
 *  1. **It deletes instead of switching off.** The stock row IS the written-off record — 68,250 old
 *     leaflets EGPI really reported — so a delete destroys evidence rather than hiding a row.
 *  2. **It deletes the formula row instead of closing it.** A plan committed last month reproduces
 *     from the formula it was committed under; deleting the row rewrites that silently.
 *  3. **A restore re-opens the old formula row.** Then a reactivation revives a quantity nobody
 *     re-checked, which is precisely the leaflet double-count: two leaflet lines, 68,250 pieces of
 *     superseded artwork covering new production, every figure on the row still looking ordinary.
 *  4. **It retires a SHARED material with no warning.** Retiring is material-level, and the citric
 *     acid anhydrous and the lemon flavour genuinely belong to both products — so a retire from
 *     Ivyronc's screen shortens Guamusin's buy list with nothing on screen having said so.
 *
 * The first three are source-shape assertions, because the write path is three PostgREST calls and
 * standing a real client up in a test is not done here. The fourth is a real behavioural test: the
 * decision was extracted as a pure function, `otherProductsUsingMaterial`, so that it could be one.
 */

const SERVICE = "src/lib/production-planning/service.ts";
const ROUTE = "app/api/production-planning/materials/route.ts";
const SCREEN = "src/components/production-planning/production-planning-workspace.tsx";

/**
 * 🔴 Comments are STRIPPED before every source assertion, with the sanctioned stripper.
 *
 * Not hygiene — a requirement here. The prose on `setMaterialActive` explains at length why it must
 * never DELETE anything and why the STOCK rows are left alone, so it contains both of the words the
 * assertions below search for. Read raw, this file would pass its own "never deletes" check on the
 * comment that says so, and would fail the opposite way the day somebody rewrote that comment.
 * `stripComments` blanks a comment in place, so every offset and line number survives; a hand-rolled
 * line-wise strip is refused by `tests/comment-strip-ratchet.test.ts`.
 */
const sourceOf = (path: string) => stripComments(readFileSync(path, "utf8"));

/** One named function's body, comments already blanked. */
function functionBody(source: string, name: string): string {
  const at = source.indexOf(`export async function ${name}(`);
  assert.ok(at >= 0, `${name} should be exported from the service`);
  const next = source.indexOf("\nexport ", at + 1);
  return source.slice(at, next < 0 ? source.length : next);
}

/**
 * The `{ … }` that opens at `needle`, matched by counting braces rather than by a regex.
 *
 * A lazy `[\s\S]*?\n  \}` closes at whatever indentation happens to come first, so it passes on a
 * block that was moved one level in or out — which is exactly the edit that would move the formula
 * close out of the retire branch. Counting is what makes "inside this branch" a real claim.
 */
function blockAfter(source: string, needle: string): string {
  const at = source.indexOf(needle);
  assert.ok(at >= 0, `expected to find ${JSON.stringify(needle)}`);
  const open = source.indexOf("{", at);
  assert.ok(open >= 0, `${JSON.stringify(needle)} should open a block`);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open, index + 1);
    }
  }
  throw new Error(`unbalanced braces after ${JSON.stringify(needle)}`);
}

/**
 * The source between two landmarks — for JSX, where {@link blockAfter} cannot be used.
 *
 * JSX is not brace-delimited the way a statement block is: the first `{` after a condition is the
 * next interpolation, `{t.settingsRetireAlsoUsedBy}`, and counting braces from there returns that
 * one expression rather than the branch. So a JSX region is bounded by what comes after it instead.
 */
function sliceBetween(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  assert.ok(start >= 0, `expected to find ${JSON.stringify(from)}`);
  const end = source.indexOf(to, start + from.length);
  assert.ok(end > start, `expected ${JSON.stringify(to)} to follow ${JSON.stringify(from)}`);
  return source.slice(start, end);
}

const PARACETAMOL: LoadedMaterial = {
  basePerDisplay: BigInt(1000) * QTY_SCALE,
  baseUnit: "g",
  code: "PARACETAMOL",
  displayUnit: "kg",
  id: "mat-paracetamol",
  isImported: false,
  leadTimeDays: null,
  minOrderQty: null,
  nameAr: "باراسيتامول",
  nameEn: "Paracetamol",
  notes: null,
  purchaseIncrement: null,
  reorderCoverRuns: null,
  sortOrder: 1,
  unitKind: "mass",
};

/** The real shared case: citric acid anhydrous is on Ivyronc AND Guamusin. */
const CITRIC_ACID: LoadedMaterial = {
  ...PARACETAMOL,
  code: "CITRIC_ACID_ANH",
  id: "mat-citric",
  nameAr: "حمض الستريك",
  nameEn: "Citric acid anhydrous",
  sortOrder: 2,
};

const GEOMETRY = {
  doseMl: BigInt(5) * QTY_SCALE,
  goodUnitMl: BigInt(100) * QTY_SCALE,
  runVolumeMl: BigInt(1_250_000) * QTY_SCALE,
  sampleUnitMl: BigInt(40) * QTY_SCALE,
  unitsPerBox: BigInt(1) * QTY_SCALE,
  wholeRunsOnly: true,
};

/**
 * Three products on purpose. Guamusin and Ivyronc are the two real ones; the third has NO row in
 * `materialIdsByProductId` at all — the product shape that gets every material through
 * `materialsForProduct`'s own fallback, and the one an "absent means does not use it" reading drops
 * from the warning.
 */
function planningData(links: Map<string, Set<string>>): ProductionPlanningData {
  return {
    compositionsByProductId: new Map(),
    fx: { rateDate: "2026-10-08", source: "manual", usdToEgpMicro: BigInt(48) * QTY_SCALE },
    learning: new Map(),
    level: "full",
    locations: [{ code: "EGPI", id: "loc-egpi", isFactory: true, nameAr: "المصنع", nameEn: "EGPI" }],
    materialIdsByProductId: links,
    materials: [PARACETAMOL, CITRIC_ACID],
    prices: [],
    products: [
      { code: "IVYRONC", factoryLocationId: "loc-egpi", geometry: GEOMETRY, id: "prod-ivyronc", manufacturerName: "EGPI", measureUnit: "ml", nameAr: "آيفيرونك", nameEn: "Ivyronc", notes: null },
      { code: "GUAMUSIN", factoryLocationId: "loc-egpi", geometry: GEOMETRY, id: "prod-guamusin", manufacturerName: "DBK", measureUnit: "g", nameAr: "جواموسين", nameEn: "Guamusin", notes: null },
      { code: "SEEDED_EARLY", factoryLocationId: "loc-egpi", geometry: GEOMETRY, id: "prod-unlinked", manufacturerName: "EGPI", measureUnit: "ml", nameAr: "منتج قديم", nameEn: "Seeded early", notes: null },
    ],
    settings: {
      alarmDryRun: true,
      alarmEnabled: false,
      alarmLastEvaluatedOn: null,
      alarmLastSentOn: null,
      defaultOveragePct: parsePct("3"),
      expiryAlarmDryRun: true,
      expiryAlarmEnabled: false,
      expiryLastEvaluatedOn: null,
      expiryLastSentOn: null,
      expiryWarnDays: 90,
      fxFallbackUsdToEgp: null,
      fxFetchDryRun: true,
      fxFetchEnabled: false,
      reorderCoverRuns: QTY_SCALE,
      updatedAt: null,
      updatedByLogin: null,
    },
    stock: [],
  };
}

export function runProductionPlanningRetireMaterialTests() {
  // ── The shared-material warning, which is the half with real logic ────────────────────────────

  const data = planningData(
    new Map([
      ["prod-ivyronc", new Set([PARACETAMOL.id, CITRIC_ACID.id])],
      ["prod-guamusin", new Set([CITRIC_ACID.id])],
    ]),
  );

  // Paracetamol is on Ivyronc alone — but the unlinked product gets every material, so it IS
  // affected and must be named. Reading an absent join row as "does not use it" returns [] here, and
  // the screen would then promise that a retire touched nothing.
  assert.deepEqual(
    otherProductsUsingMaterial(data, "prod-ivyronc", PARACETAMOL.id).map((product) => product.code),
    ["SEEDED_EARLY"],
    "🔴 a product with no join rows uses every material, exactly as materialsForProduct treats it",
  );

  assert.deepEqual(
    otherProductsUsingMaterial(data, "prod-ivyronc", CITRIC_ACID.id).map((product) => product.code),
    ["GUAMUSIN", "SEEDED_EARLY"],
    "🔴 citric acid anhydrous really is on both products — retiring it from Ivyronc shortens Guamusin's buy list",
  );
  assert.deepEqual(
    otherProductsUsingMaterial(data, "prod-guamusin", CITRIC_ACID.id).map((product) => product.code),
    ["IVYRONC", "SEEDED_EARLY"],
    "and the warning is symmetric — the same retire seen from the other screen",
  );

  // The product being looked at is never named as a side effect of itself.
  for (const productId of ["prod-ivyronc", "prod-guamusin", "prod-unlinked"]) {
    assert.ok(
      !otherProductsUsingMaterial(data, productId, CITRIC_ACID.id).some((product) => product.id === productId),
      `${productId} must not appear in its own "also used by" list`,
    );
  }

  // An EMPTY set is the same case as an absent one — `materialsForProduct` returns every material for
  // both — so a check that only tested `undefined` would miss half of it.
  assert.deepEqual(
    otherProductsUsingMaterial(
      planningData(
        new Map([
          ["prod-ivyronc", new Set([PARACETAMOL.id])],
          ["prod-guamusin", new Set<string>()],
          ["prod-unlinked", new Set([PARACETAMOL.id])],
        ]),
      ),
      "prod-ivyronc",
      CITRIC_ACID.id,
    ).map((product) => product.code),
    ["GUAMUSIN"],
    "🔴 an empty join set is the no-rows fallback too, not a product that uses nothing",
  );

  // No product selected yet: nothing is excluded, so every product that uses it is simply listed.
  assert.deepEqual(
    otherProductsUsingMaterial(data, null, CITRIC_ACID.id).map((product) => product.code),
    ["IVYRONC", "GUAMUSIN", "SEEDED_EARLY"],
    "with no product selected the list is every product that uses the material",
  );

  // ── Deactivate, never delete; close the formula, never drop it ─────────────────────────────────

  const service = sourceOf(SERVICE);
  const retire = functionBody(service, "setMaterialActive");

  assert.ok(!/\.delete\(/.test(retire), "🔴 nothing is ever deleted — the stock row IS the written-off record");
  assert.ok(
    !/T\.stock/.test(retire),
    "🔴 and the stock table is not touched at all: the 68,250 old leaflets stay on the books as reported",
  );
  assert.match(retire, /is_active: active/, "the material's own flag is what moves");
  assert.match(retire, /T\.productMaterials/, "the product links are switched off, so a restore can put them back");
  assert.match(retire, /\.is\("effective_to", null\)/, "only the row IN FORCE is closed, never the history");
  assert.match(
    retire,
    /\.lt\("effective_from", today\)/,
    "a row opened TODAY is left alone — closing it at its own effective_from is not a window the database accepts",
  );
  assert.match(retire, /assertWrite\(access\)/, "a read-only grant cannot retire anything");
  assert.match(retire, /writeAuditLog\(/, "and every retire is on the record");

  // 🔴 The formula close lives INSIDE `if (!active)` and nowhere else, counted by braces rather than
  // matched by a lazy regex. This is the one assertion standing between a restore and the leaflet
  // double-count: a reactivation that also revived the old quantity.
  assert.match(
    retire,
    /if \(!active\) \{/,
    "🔴 the formula close is BRANCH-GUARDED — dropping the guard to 'simplify' is what makes a restore revive a quantity nobody re-checked",
  );
  const retireOnly = blockAfter(retire, "if (!active)");
  assert.match(retireOnly, /effective_to: today/, "the formula row is CLOSED at today, never deleted");
  assert.equal(
    retire.split("effective_to: today").length - 1,
    retireOnly.split("effective_to: today").length - 1,
    "🔴 the only close in this function is the one inside the retire branch — a restore must not re-open the old line",
  );

  // Order is the safety: a half-done retire must leave the material VISIBLE with no formula line
  // (which reads "formula not entered" and is harmless), never hidden holding a live one.
  const closeAt = retire.indexOf("effective_to: today");
  const switchOffAt = retire.indexOf(".update({ is_active: active, updated_at: now })");
  assert.ok(closeAt >= 0 && switchOffAt >= 0, "both writes should be present");
  assert.ok(closeAt < switchOffAt, "🔴 compositions close BEFORE the material switches off");

  // ── The retired list must not be reachable from a plan ─────────────────────────────────────────

  assert.ok(
    !/retired/i.test(blockAfter(service, "export type ProductionPlanningData =")),
    "🔴 ProductionPlanningData carries NO retired list — one there is what would let computePlan see an inactive material",
  );
  assert.match(service, /async function listRetiredMaterials\(\)/, "it is a separate read for the screen");
  assert.ok(
    !/export async function listRetiredMaterials/.test(service),
    "and it stays unexported, so nothing else can reach for it",
  );
  assert.match(
    blockAfter(service, "async function listRetiredMaterials()"),
    /\.eq\("is_active", false\)/,
    "the retired list asks for the inactive rows",
  );

  // ── One endpoint, split on the PRESENCE of the flag ────────────────────────────────────────────

  const route = sourceOf(ROUTE);
  assert.match(
    route,
    /if \("active" in body\)/,
    '🔴 split on `"active" in body`, never on truthiness: `active: false` and no `active` at all are different requests, and a truthy test reads a retire as a field save',
  );
  assert.match(route, /setMaterialActive\(access, body\)/, "and the retire goes nowhere near the field save");
  assert.match(route, /assertSameOriginMutation\(request\)/, "still CSRF-guarded");

  // A body with no flag is refused rather than defaulted — either default does the opposite of one
  // of the two intentions.
  assert.match(retire, /typeof body\.active !== "boolean"/);
  assert.ok(PRODUCTION_PLANNING_ERRORS.activeFlagRequired.length > 0, "the refusal exists in Arabic");
  assert.ok(PRODUCTION_PLANNING_ERRORS_EN.activeFlagRequired.length > 0, "and in English");
  assert.ok(
    !/[؀-ۿ]/.test(PRODUCTION_PLANNING_ERRORS_EN.activeFlagRequired),
    "with no Arabic left in the English refusal",
  );

  // ── Both catalogues, because this is a full second screen ──────────────────────────────────────

  const keys = [
    "settingsRetire",
    "settingsRetireHint",
    "settingsRetireAlsoUsedBy",
    "settingsRetired",
    "settingsRetiredNone",
    "settingsRestore",
    "settingsRestoreHint",
  ] as const;
  for (const key of keys) {
    assert.ok(PP[key] && PP[key].length > 0, `${key} is missing from the Arabic catalogue`);
    assert.ok(PP_EN[key] && PP_EN[key].length > 0, `${key} is missing from the English catalogue`);
    assert.ok(
      !/[؀-ۿ]/.test(PP_EN[key]),
      `🔴 ${key} leaves an Arabic word in the middle of an English page`,
    );
  }
  assert.match(
    PP_EN.settingsRestoreHint,
    /not restored/,
    "the English hint says plainly that the formula line does not come back",
  );
  assert.match(PP_EN.settingsRetireHint, /keeps the stock/, "and that the stock is kept");

  // ── The screen: both controls exist, both gated on write, the warning before the click ─────────

  const screen = sourceOf(SCREEN);
  assert.match(screen, /active: false/, "a retire is sent");
  assert.match(screen, /active: true/, "and a restore");
  assert.match(
    screen,
    /material\.alsoUsedByProductIds\.length > 0/,
    "🔴 the shared-product warning is rendered BEFORE the click, not reported after it",
  );
  assert.match(screen, /t\.settingsRetireAlsoUsedBy/, "and it comes from the bundle, so it follows the language toggle");

  // The ids resolve through `S.name`, so an English reader never reads an Arabic product name.
  const warning = sliceBetween(screen, "material.alsoUsedByProductIds.length > 0", ") : null}");
  assert.match(warning, /S\.name\(product\)/, "🔴 the product names go through S.name, never a raw nameAr");
  assert.ok(!/nameAr|nameEn/.test(warning), "and the warning names no language-specific field at all");

  // Both controls sit behind `canWrite` — the retire button in the composition list, the restore
  // section as a whole. A read-only grant must not be offered either.
  assert.match(
    sliceBetween(screen, "data.retiredMaterials.length === 0", ") : ("),
    /t\.settingsRetiredNone/,
    "an empty retired list says so rather than rendering nothing",
  );
  assert.match(
    screen,
    /canWrite \? \(\s*<section className=\{PANEL\}>\s*<SectionTitle subtitle=\{t\.settingsRestoreHint\}/,
    "🔴 the whole restore section is gated on canWrite",
  );
  /**
   * 🔴 And so is EVERY retire button, counted rather than pattern-matched.
   *
   * This started as `canWrite ? (\s*<button … t.settingsRetire`, which held only while the retire
   * button was the first thing inside the gate. The composition editor (2026-10-08) put an
   * Edit/Enter button beside it inside a wrapper, and the regex stopped matching although the gate
   * was exactly where it had always been — a test that fails on a harmless edit teaches the next
   * session to loosen it, and a loosened one would pass with no gate at all.
   *
   * So the check is now arithmetic: find every `canWrite ? (` region by counting parentheses, and
   * require that every single retire call in the file — `{ materialId: …, active: false }` — sits
   * inside one. There are two, the table row and the phone card.
   */
  const gatedRegions: string[] = [];
  for (let at = screen.indexOf("canWrite ? ("); at >= 0; at = screen.indexOf("canWrite ? (", at + 1)) {
    const open = screen.indexOf("(", at + "canWrite ?".length);
    let depth = 0;
    for (let index = open; index < screen.length; index += 1) {
      if (screen[index] === "(") depth += 1;
      else if (screen[index] === ")") {
        depth -= 1;
        if (depth === 0) {
          gatedRegions.push(screen.slice(open, index + 1));
          break;
        }
      }
    }
  }
  const RETIRE_CALL = /active: false/g;
  const retireCalls = (screen.match(RETIRE_CALL) ?? []).length;
  const gatedCalls = gatedRegions.reduce((total, region) => total + (region.match(RETIRE_CALL) ?? []).length, 0);
  assert.equal(retireCalls, 2, "two retire controls: the desktop table row and the phone card");
  assert.equal(
    gatedCalls,
    retireCalls,
    "🔴 every retire control sits inside a `canWrite ? (` region — a read-only grant must not be " +
      "offered one at all",
  );

  console.log("  production planning — retire a material: OK");
}
