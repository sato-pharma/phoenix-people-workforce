import assert from "node:assert/strict";

import {
  classifyOrganizationRow,
  createOrgCode,
} from "../src/lib/imports/org-rule-engine.ts";
import { lineRules } from "../src/lib/imports/org-rules.ts";

// Recurrence guard for the "Anti Inf" duplicate line (deleted `lines` id 53).
//
// The employee-org import (app/api/imports/employees/confirm/route.ts → upsertLines) upserts
// `lines` with onConflict:"code", where code = createOrgCode(organization.line.normalizedName),
// and links each employee to that same derived code. So the ONLY way an official line stays a
// single row is if its rule value slugs to the exact code already stored in `lines`. When
// migration 20260621240000 renamed line id 1 to "Anti infective" but `lineRules` was left mapping
// every anti-infective variant to "Anti Inf" (slug anti_inf ≠ anti_infective), every import minted
// a fresh duplicate row. Same latent trap for office → "Office" vs the stored head_office.
// The display spelling was later standardized to "Anti Infective" (owner decision); the code stays
// anti_infective so the slug still targets the same canonical row.

// Single source of truth: the canonical `lines` rows (verified against production id 1–4).
const CANONICAL_LINES = [
  { name: "Anti Infective", code: "anti_infective" }, // id 1
  { name: "Pedia", code: "pedia" }, //                    id 2
  { name: "CNS", code: "cns" }, //                        id 3
  { name: "Head Office", code: "head_office" }, //        id 4
];
const CANONICAL_CODES = new Set(CANONICAL_LINES.map((l) => l.code));

function classifyLine(input: string) {
  return classifyOrganizationRow({
    rowNumber: 1,
    department: "Sales",
    line: input,
    area: null,
    team: null,
    position: "Medical Rep",
  }).line;
}

export async function runImportsLineCanonicalizationTests() {
  // ── Every spelling variant an importer might type resolves to ONE canonical line ──
  const cases: Array<{ input: string; name: string; code: string }> = [
    { input: "Anti Inf", name: "Anti Infective", code: "anti_infective" },
    { input: "anti infective", name: "Anti Infective", code: "anti_infective" },
    { input: "Anti-Infective", name: "Anti Infective", code: "anti_infective" },
    { input: "ANTI INFECTIOUS", name: "Anti Infective", code: "anti_infective" },
    { input: "Office", name: "Head Office", code: "head_office" },
    { input: "Head Office", name: "Head Office", code: "head_office" },
    { input: "CNS", name: "CNS", code: "cns" },
    { input: "Pedia", name: "Pedia", code: "pedia" },
    { input: "Pediatrics", name: "Pedia", code: "pedia" },
  ];

  for (const c of cases) {
    const line = classifyLine(c.input);
    assert.equal(line.displayName, c.name, `"${c.input}" → line name "${c.name}" (stored in lines.name)`);
    assert.equal(line.code, c.code, `"${c.input}" → line code "${c.code}" (upsert conflict target)`);
    // The employee → line link uses createOrgCode(normalizedName) (employee-validator.ts). It must
    // resolve to the SAME canonical code, or the employee would point at a different/duplicate row.
    assert.equal(
      createOrgCode(line.normalizedName),
      c.code,
      `"${c.input}" → employee lineCode "${c.code}" matches the upserted line code`,
    );
  }

  // ── The exact regression: "Anti Inf" must never be a line name again ──
  const antiInf = classifyLine("Anti Inf");
  assert.equal(antiInf.displayName, "Anti Infective", 'the abbreviated "Anti Inf" must canonicalize to "Anti Infective"');
  assert.notEqual(antiInf.code, "anti_inf", 'the "Anti Inf" label must NOT keep the divergent code anti_inf that minted duplicate line id 53');

  // ── Invariant: NO rule may map to a label whose slug isn't a real lines row ──
  // This is the structural recurrence-proof — reintroducing "Anti Inf" (or any other off-canonical
  // label) fails the suite immediately, before it can create a duplicate in production.
  for (const [key, value] of Object.entries(lineRules)) {
    const code = createOrgCode(value);
    assert.ok(
      code !== null && CANONICAL_CODES.has(code),
      `lineRules["${key}"] = "${value}" slugs to "${code}", not a canonical lines.code ` +
        `(${[...CANONICAL_CODES].join(", ")}). A rule value must equal an exact lines.name so the ` +
        `import upserts onto the existing row instead of minting a duplicate.`,
    );
  }
  assert.ok(
    !Object.values(lineRules).includes("Anti Inf"),
    'lineRules must not map to "Anti Inf" — it diverges from the stored line "Anti Infective" and recreates duplicate line id 53',
  );
}
