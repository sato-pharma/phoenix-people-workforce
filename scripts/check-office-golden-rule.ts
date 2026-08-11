/**
 * The Office golden-rule lock. Computes the two fingerprints that pin the owner's Office allocation
 * rule and reports any drift.
 *
 *   pnpm run check:office-rule
 *
 * Used by `tests/office-golden-rule-lock.test.ts` (which runs in the required CI `validate` job) and
 * by `scripts/office-rule-unlock.ts` (which is the only sanctioned way to re-pin). The rule itself,
 * and why it is locked, is documented in `src/lib/sales/office-golden-rule.ts`.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { computeOfficeAllocation } from "../src/lib/sales/office-allocation.ts";
import {
  OFFICE_RULE_BEHAVIOUR_FINGERPRINT,
  OFFICE_RULE_LOCK_MARKERS,
  OFFICE_RULE_REQUIRED_CLAUSES,
  OFFICE_RULE_SOURCE_FINGERPRINT,
} from "../src/lib/sales/office-golden-rule.ts";
import type { SalesReferenceData } from "../src/lib/sales/monthly-distributor-import.ts";

export const OFFICE_ALLOCATION_PATH = fileURLToPath(
  new URL("../src/lib/sales/office-allocation.ts", import.meta.url),
);

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/**
 * Drop comments so the rule's documentation can be improved without breaking the lock, while any
 * change to the code itself still fires it. Tracks string and template state so a `//` inside a
 * literal survives. There are no regex literals in the locked region; if one is ever added the
 * stripping stays deterministic, so the lock still holds — it just strips a little more.
 */
export function stripComments(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (c === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out += c;
      i += 1;
      while (i < source.length) {
        out += source[i];
        if (source[i] === "\\") {
          i += 1;
          if (i < source.length) out += source[i];
          i += 1;
          continue;
        }
        if (source[i] === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/** Comments gone, every whitespace run collapsed to one space. The unit the fingerprint is taken of. */
export const normalizeSource = (source: string) => stripComments(source).replace(/\s+/g, " ").trim();

/** Pull the text between the LOCKED START/END markers. Throws if either marker is missing or reordered. */
export function readLockedRegion(filePath = OFFICE_ALLOCATION_PATH): string {
  const source = readFileSync(filePath, "utf8");
  const start = source.indexOf(OFFICE_RULE_LOCK_MARKERS.start);
  const end = source.indexOf(OFFICE_RULE_LOCK_MARKERS.end);
  if (start < 0) throw new Error(`Office golden rule: START marker "${OFFICE_RULE_LOCK_MARKERS.start}" is missing from ${filePath}. The lock cannot be evaluated — restore it.`);
  if (end < 0) throw new Error(`Office golden rule: END marker "${OFFICE_RULE_LOCK_MARKERS.end}" is missing from ${filePath}. The lock cannot be evaluated — restore it.`);
  if (end <= start) throw new Error("Office golden rule: the END marker appears before the START marker. The lock cannot be evaluated.");
  return source.slice(start + OFFICE_RULE_LOCK_MARKERS.start.length, end);
}

export const sourceFingerprint = (filePath = OFFICE_ALLOCATION_PATH) =>
  sha256(normalizeSource(readLockedRegion(filePath)));

/** Which required clauses are no longer present verbatim (whitespace-insensitive). */
export function missingClauses(filePath = OFFICE_ALLOCATION_PATH): string[] {
  const haystack = normalizeSource(readFileSync(filePath, "utf8"));
  return OFFICE_RULE_REQUIRED_CLAUSES.filter(
    (c) => !haystack.includes(c.snippet.replace(/\s+/g, " ").trim()),
  ).map((c) => `${c.clauseId}: ${c.meaning} — expected to find \`${c.snippet}\``);
}

// ── the behaviour probe ──────────────────────────────────────────────────────
// Deliberately adversarial. Every clause of the rule changes at least one number here:
//   • VALUE vs UNITS basis — CNS area V1 sells many cheap units, V2 few expensive ones, and the two
//     bases give opposite answers.
//   • PER LINE — Pedia sells only in P1, at a value big enough to dominate a blended share.
//   • ONE BLENDED SHARE — X-RARE sells in exactly one area, so a per-product share would place all
//     of its office units there instead of spreading them.
//   • UNITS distributed, VALUE derived — the two office products have very different prices, so
//     distributing value instead of units moves every unit column.
//   • BRICK SPLIT BY UNITS — V1 has two bricks at an uneven 3:1 unit split.
//   • ZERO PRICE — a priced-at-zero product contributes units but no value.
//   • NATIONAL — an office product on a line with no sales of its own.
const probeReferences: SalesReferenceData = {
  distributors: [{ code: "Office", name: "Office" }],
  products: [
    { factoryPrice: 4, family: "CNS", familyCode: "CNS", line: "CNS", productCode: "CHEAP", productName: "Cheap CNS", source: "" },
    { factoryPrice: 220, family: "CNS", familyCode: "CNS", line: "CNS", productCode: "DEAR", productName: "Dear CNS", source: "" },
    { factoryPrice: 0, family: "CNS", familyCode: "CNS", line: "CNS", productCode: "FREE", productName: "Zero-priced CNS", source: "" },
    { factoryPrice: 37.5, family: "CNS", familyCode: "CNS", line: "CNS", productCode: "XRARE", productName: "One-area CNS", source: "" },
    { factoryPrice: 90, family: "Pedia", familyCode: "PED", line: "Pedia", productCode: "PEDIA", productName: "Pedia Product", source: "" },
    { factoryPrice: 12, family: "Anti Infective", familyCode: "AI", line: "Anti Infective", productCode: "ORPHAN", productName: "Unsold-line Product", source: "" },
  ],
  regions: [
    { areaCode: "", areaName: "", regionCode: "R1", regionName: "Region One" },
    { areaCode: "", areaName: "", regionCode: "R2", regionName: "Region Two" },
  ],
  areas: [
    { areaCode: "V1", areaName: "Value Area One", regionCode: "R1", regionName: "Region One" },
    { areaCode: "V2", areaName: "Value Area Two", regionCode: "R1", regionName: "Region One" },
    { areaCode: "V3", areaName: "Value Area Three", regionCode: "R2", regionName: "Region Two" },
    { areaCode: "P1", areaName: "Pedia Area", regionCode: "R2", regionName: "Region Two" },
  ],
  bricks: [
    { areaCode: "V1", areaName: "Value Area One", blockCode: "BL1", blockName: "Block One", brickId: "BR-1A", brickName: "Brick 1A", regionCode: "R1", regionName: "Region One" },
    { areaCode: "V1", areaName: "Value Area One", blockCode: "BL1", blockName: "Block One", brickId: "BR-1B", brickName: "Brick 1B", regionCode: "R1", regionName: "Region One" },
    { areaCode: "V2", areaName: "Value Area Two", blockCode: "BL2", blockName: "Block Two", brickId: "BR-2A", brickName: "Brick 2A", regionCode: "R1", regionName: "Region One" },
    { areaCode: "V3", areaName: "Value Area Three", blockCode: "BL3", blockName: "Block Three", brickId: "BR-3A", brickName: "Brick 3A", regionCode: "R2", regionName: "Region Two" },
    { areaCode: "P1", areaName: "Pedia Area", blockCode: "BL4", blockName: "Block Four", brickId: "BR-4A", brickName: "Brick 4A", regionCode: "R2", regionName: "Region Two" },
  ],
};

const probeBrickShare = [
  // V1: 900 cheap units (3:1 across two bricks) = 3,600 value. Most UNITS, least VALUE per unit.
  { productCode: "CHEAP", brickId: "BR-1A", areaCode: "V1", regionCode: "R1", units: 675 },
  { productCode: "CHEAP", brickId: "BR-1B", areaCode: "V1", regionCode: "R1", units: 225 },
  // V2: 60 dear units = 13,200 value. Fewest UNITS, most VALUE — the units/value inversion.
  { productCode: "DEAR", brickId: "BR-2A", areaCode: "V2", regionCode: "R1", units: 60 },
  // V3: 400 zero-priced units (no value at all) + 100 XRARE (3,750). Zero-price contributes units only.
  { productCode: "FREE", brickId: "BR-3A", areaCode: "V3", regionCode: "R2", units: 400 },
  { productCode: "XRARE", brickId: "BR-3A", areaCode: "V3", regionCode: "R2", units: 100 },
  // Pedia lives only in P1, and at 90 EGP it would swamp a blended all-lines share.
  { productCode: "PEDIA", brickId: "BR-4A", areaCode: "P1", regionCode: "R2", units: 1_000 },
];

const probeOfficeProducts = [
  { productCode: "CHEAP", productName: "Cheap CNS", units: 5_000, rowNumber: 1 },
  { productCode: "DEAR", productName: "Dear CNS", units: 137, rowNumber: 2 },
  { productCode: "XRARE", productName: "One-area CNS", units: 813, rowNumber: 3 },
  { productCode: "PEDIA", productName: "Pedia Product", units: 2_435, rowNumber: 4 },
  { productCode: "ORPHAN", productName: "Unsold-line Product", units: 44, rowNumber: 5 },
];

/** Run the real allocation over the probe and return its exact output, canonically ordered. */
export function runBehaviourProbe() {
  const result = computeOfficeAllocation({
    period: "2026-07",
    distributor: { code: "Office", name: "Office" },
    fileName: "office-golden-rule-probe.xlsx",
    sheetName: "Sheet1",
    mapped: probeOfficeProducts,
    unmappedNames: [],
    regionShare: [],
    brickShare: probeBrickShare,
    references: probeReferences,
  });
  return result.parsedRows
    .map((r) => ({
      product: r.productCode,
      region: r.regionCode,
      area: r.areaCode,
      brick: r.brickId,
      units: Number(r.qty.toFixed(6)),
      value: Number(r.value.toFixed(6)),
    }))
    .sort(
      (a, b) =>
        a.product.localeCompare(b.product) ||
        a.region.localeCompare(b.region) ||
        a.area.localeCompare(b.area) ||
        a.brick.localeCompare(b.brick),
    );
}

export const behaviourFingerprint = () => sha256(JSON.stringify(runBehaviourProbe()));

export type OfficeRuleLockReport = {
  ok: boolean;
  sourceOk: boolean;
  behaviourOk: boolean;
  clausesOk: boolean;
  source: { pinned: string; actual: string };
  behaviour: { pinned: string; actual: string };
  missing: string[];
};

export function evaluateOfficeRuleLock(filePath = OFFICE_ALLOCATION_PATH): OfficeRuleLockReport {
  const source = { pinned: OFFICE_RULE_SOURCE_FINGERPRINT, actual: sourceFingerprint(filePath) };
  const behaviour = { pinned: OFFICE_RULE_BEHAVIOUR_FINGERPRINT, actual: behaviourFingerprint() };
  const missing = missingClauses(filePath);
  const sourceOk = source.pinned === source.actual;
  const behaviourOk = behaviour.pinned === behaviour.actual;
  const clausesOk = missing.length === 0;
  return { ok: sourceOk && behaviourOk && clausesOk, sourceOk, behaviourOk, clausesOk, source, behaviour, missing };
}

export const UNLOCK_INSTRUCTIONS =
  "The Office allocation golden rule is LOCKED (owner, 2026-08-11). To change it, run\n" +
  "    pnpm run office-rule:unlock\n" +
  "and enter the owner's password. That is the only sanctioned way to re-pin the fingerprints —\n" +
  "editing src/lib/sales/office-golden-rule.ts by hand is exactly what this check exists to catch.\n" +
  "If you did not mean to change the rule, revert your edit to the locked region.";

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href) {
  const report = evaluateOfficeRuleLock();
  const mark = (ok: boolean) => (ok ? "OK  " : "FAIL");
  console.log(`${mark(report.sourceOk)} source fingerprint    pinned ${report.source.pinned.slice(0, 16)} · actual ${report.source.actual.slice(0, 16)}`);
  console.log(`${mark(report.behaviourOk)} behaviour fingerprint pinned ${report.behaviour.pinned.slice(0, 16)} · actual ${report.behaviour.actual.slice(0, 16)}`);
  console.log(`${mark(report.clausesOk)} required clauses      ${report.missing.length === 0 ? "all 4 present" : report.missing.join("\n     ")}`);
  if (!report.ok) {
    console.error(`\n${UNLOCK_INSTRUCTIONS}`);
    process.exit(1);
  }
  console.log("\nThe Office golden rule is intact.");
}
