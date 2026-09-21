import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { mapVisitRow } from "@/lib/crm/reads";
import { resolveVisitTypeLabel } from "@/lib/crm/visit-types";

/**
 * The vendor writes the literal string "Unknown" into `visit_type_description` for eight distinct
 * codes, so that column can no more tell a public holiday from admin work than a blank could.
 * Anything that shows a reader the raw string is showing them nothing: measured on production
 * 2026-09-21, 3,077 rows since January carry it, none of them null, across 2,311 rep-days — and on
 * 2026-08-27 all 156 rows of that day read "Unknown" on the field-workforce visits screen.
 *
 * `mapVisitRow` is where the resolution belongs, because `visits-report/service.ts` re-exports it
 * to BOTH `getVisitsReportData` (the screen) and `getVisitsReportExportRows` (the download): one
 * call site is what keeps those two saying the same word about the same row.
 */

function visitRow(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    agent_crm_id: 1,
    crm_visit_id: 1,
    id: "v1",
    visit_date: "2026-08-27",
    ...overrides,
  };
}

function label(visitType: number | null, description: string | null, comment: string | null = null) {
  return mapVisitRow(
    visitRow({ visit_type: visitType, visit_type_description: description, comment }),
  ).visitTypeDescription;
}

export async function runVisitTypeLabelIsResolvedTests() {
  // ── The defect this file exists for, checked FIRST ────────────────────────
  // The first cut of this change called resolveVisitTypeLabel in reads.ts with NO import for it.
  // Stripped of types that is not a compile error, it is a ReferenceError thrown from the first
  // mapVisitRow call — which reads as "resolveVisitTypeLabel is not defined" and says nothing
  // about what to do. Checking the import before any behaviour turns that into a sentence.
  const reads = readFileSync(join(process.cwd(), "src/lib/crm/reads.ts"), "utf8");
  assert.ok(
    /import \{[^}]*\bresolveVisitTypeLabel\b[^}]*\} from "@\/lib\/crm\/visit-types";/.test(reads),
    "reads.ts calls resolveVisitTypeLabel but does not import it from @/lib/crm/visit-types",
  );

  // ── The eight codes the vendor calls "Unknown" ────────────────────────────
  // Every one of these read the single word "Unknown" on screen before this change.
  const resolvedFromUnknown: Array<[number, string]> = [
    [-5, "Vacations & Leaves"], // Public Holiday — grouped with leave, not named as the holiday
    [-6, "Vacations & Leaves"], // Casual Leave
    [-7, "Admin Work"], // Ambiguous, with no comment to route it
    [-16, "Training"],
    [-19, "Meeting"],
    [-20, "Admin Work"],
    [-21, "Business Review (BRM)"],
    [-30, "Regular"], // Unlabeled field visit, with no comment to route it
  ];
  for (const [code, expected] of resolvedFromUnknown) {
    assert.equal(
      label(code, "Unknown"),
      expected,
      `visit_type ${code} must resolve to "${expected}" — the vendor's "Unknown" is the same ` +
        `string on all eight of these codes, so rendering it raw tells a reader nothing`,
    );
  }

  // ── A real vendor description always wins ─────────────────────────────────
  // This is not a rename of the documented enum.
  assert.equal(label(0, "Regular Visit"), "Regular Visit");
  assert.equal(label(-8, "Campaign (Prospection)"), "Campaign (Prospection)");
  assert.equal(
    label(0, "  Regular Visit  "),
    "Regular Visit",
    "a padded vendor description is trimmed, not treated as absent",
  );

  // ── The comment is what separates the two codes that share one label ──────
  assert.equal(label(-30, "Unknown", "Pharmacy visit El Ezaby"), "Pharmacy Visit");
  assert.equal(label(-30, "Unknown", "saw dr ahmed"), "Regular");
  assert.equal(label(-7, "Unknown", "health day"), "Health Day");
  assert.equal(label(-7, "Unknown", "annual leave"), "Vacations & Leaves");
  assert.equal(label(-7, "Unknown", "meeting with team"), "Meeting");

  // ── mapVisitRow must PASS the comment through, not drop it ────────────────
  // Resolving without the comment silently collapses the two code groups above onto one label.
  assert.equal(
    label(-30, "Unknown", "Pharmacy visit El Ezaby"),
    resolveVisitTypeLabel(-30, "Unknown", "Pharmacy visit El Ezaby"),
    "mapVisitRow must hand the row's comment to the resolver — dropping it turns every -7 and " +
      "-30 row into the code's default label",
  );
  assert.notEqual(
    label(-30, "Unknown", "Pharmacy visit El Ezaby"),
    resolveVisitTypeLabel(-30, "Unknown", null),
    "this pair must differ, otherwise the assertion above cannot fail and proves nothing",
  );

  // ── An unmapped code still reads as a code, never as "Unknown" ────────────
  assert.equal(label(-99, "Unknown"), "Type -99");
  assert.equal(label(null, "Unknown"), "Type ?");

  // ── The screen must not reach around mapVisitRow ──────────────────────────
  // This view reads rep-day.ts, which passes visit_type_description through raw, so it resolves at
  // render time instead. Every site must go through the helper.
  const viewPath = join(
    process.cwd(),
    "src/components/field-workforce-compliance/field-workforce-visits-view.tsx",
  );
  const view = readFileSync(viewPath, "utf8");
  const rawRenders = view
    .split("\n")
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => /\bvisit\.visitTypeDescription\b/.test(line))
    .filter(({ line }) => !line.includes("resolveVisitTypeLabel("))
    .map(({ n }) => `field-workforce-visits-view.tsx:${n}`);
  assert.deepEqual(
    rawRenders,
    [],
    "this screen must render the visit type through visitTypeLabel() only — a raw " +
      "visit.visitTypeDescription is the word \"Unknown\" for eight different kinds of day",
  );
  assert.ok(
    view.includes("function visitTypeLabel(visit: Visit): string {"),
    "the visitTypeLabel helper must exist — the assertion above passes trivially without it",
  );
  assert.ok(
    !/\?\? \(visit\.visitType === 0 \? "Regular Visit"/.test(view),
    'the old `?? (visitType === 0 ? "Regular Visit" : `Type N`)` fallback must be gone — it could ' +
      "not fire even once, because the vendor column is never null",
  );
}
