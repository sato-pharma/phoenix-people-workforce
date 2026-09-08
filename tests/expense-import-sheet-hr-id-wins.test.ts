import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { resolveHrIdFromEmployeeMaps } from "../src/lib/outstation/expense-import.ts";

/**
 * An HR ID written in the sheet must beat a match on the specialist's NAME.
 *
 * THE BUG. The resolver consulted the employee directory first and, on a miss, fell through to
 * matching the name — so the sheet's own id was reached only when the name matched nothing. That is
 * harmless for anyone still employed and wrong for everyone who has left, because a leaver is not in
 * the directory at all.
 *
 * Measured on the July 2026 expense sheet, production ozucdzovmcqvepbozvqf, 2026-09-08:
 * `Ahmed.Abdallah` is B-74, a District Sales Manager who resigned on 31 August. The directory missed
 * him; the name match then found `Ahmed Hemdan Ahmed Elsayed Abdallah` — B-58, an ACTIVE Medical
 * Representative in a different area, who shares only the surname — and **4,742 EGP of a departed
 * manager's travel would have been reimbursed to him**. Writing `B-74` into the sheet did not fix
 * it: the name match still won. Three more leavers in the same file (B-175, B-23, B-5) resolved to
 * nothing at all, so their 6,690 EGP would have imported with a null hr_id and reached no payroll
 * run, since getApprovedExpenseTotalsForPayroll skips a row without one.
 *
 * All four failures are the same shape and the same cause: the directory cannot see leavers, and an
 * expense sheet is precisely the document that arrives after somebody has left.
 */

function readSource(relativePath: string) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

/** The directory as the importer sees it: ACTIVE employees only — leavers are absent by design. */
function activeOnlyDirectory() {
  return {
    codeByHrId: new Map([
      ["b-58", "B-58"],
      ["b-12", "B-12"],
      ["aa", "AA"],
    ]),
    codeByName: new Map([
      // Both Abdallahs key to the same surname fragment. This collision is the bug's engine.
      ["ahmed abdallah", "B-58"],
      ["ahmedabdallah", "B-58"],
      ["dina fadel", "B-12"],
      ["dinafadel", "B-12"],
    ]),
    residenceByHrId: new Map(),
    residenceByName: new Map(),
  } as unknown as Parameters<typeof resolveHrIdFromEmployeeMaps>[0];
}

export function runExpenseImportSheetHrIdWinsTests() {
  const maps = activeOnlyDirectory();

  // ── THE HEADLINE ───────────────────────────────────────────────────────────────────────────
  // A leaver's id, stated in the sheet, against a name that matches somebody still employed.
  assert.equal(
    resolveHrIdFromEmployeeMaps(maps, "Ahmed.Abdallah", "B-74"),
    "B-74",
    "an HR ID written in the sheet must win over a surname match — B-58 here is a different, " +
      "still-employed person, and paying him a leaver's travel is the failure this prevents",
  );

  // The three that resolved to nothing before now resolve to what the sheet says.
  for (const [name, id] of [["Ahmed.Nashaat", "B-175"], ["Yehya.Kamal", "B-23"], ["Ahmed.Hekal", "B-5"]] as const) {
    assert.equal(
      resolveHrIdFromEmployeeMaps(maps, name, id),
      id,
      `${name}: a leaver named in no directory must still take the id the sheet states`,
    );
  }

  // ── The directory still does its one remaining job: canonicalising casing ──────────────────
  assert.equal(
    resolveHrIdFromEmployeeMaps(maps, "Dina.Fadel", "b-12"),
    "B-12",
    "an id the directory recognises comes back in the directory's own casing, not the sheet's",
  );

  // Short and unusual ids are real here. `AA` is the CEO; a stricter shape rule would drop him.
  //
  // These deliberately pair the odd id with a specialist the directory CAN resolve. Paired with an
  // unknown name they prove nothing: a rejected id falls through to the name match, misses, and is
  // then handed back by the `?? stated` fallback anyway — so the assertion passes whether the guard
  // accepted it or not. Tightening the guard to `letters-dash-digits` was tried against the earlier
  // version of this test and it stayed GREEN. With a resolvable name, a rejected id returns that
  // person instead, and the difference is visible.
  assert.equal(
    resolveHrIdFromEmployeeMaps(maps, "Dina.Fadel", "AA"),
    "AA",
    "a two-letter id is a real id — production has AA and AB, and a stricter shape rule drops the CEO",
  );
  assert.equal(
    resolveHrIdFromEmployeeMaps(maps, "Dina.Fadel", "B-HIST-MG"),
    "B-HIST-MG",
    "and so is a multi-hyphen one — production has B-HIST-MG and c-o1",
  );

  // ── No id in the sheet: the name match is unchanged ────────────────────────────────────────
  assert.equal(
    resolveHrIdFromEmployeeMaps(maps, "Dina.Fadel", ""),
    "B-12",
    "with no id in the sheet the name match still resolves, exactly as before",
  );
  assert.equal(
    resolveHrIdFromEmployeeMaps(maps, "Nobody.AtAll", ""),
    null,
    "and an unmappable row with no id still comes back null rather than inventing one",
  );

  // ── Junk in the HR column must NOT become an hr_id ─────────────────────────────────────────
  // `Column2` is an alias for the HR ID column, so a sheet with a stray note there would otherwise
  // have it written straight into `hr_id` now that the sheet wins.
  assert.equal(
    resolveHrIdFromEmployeeMaps(maps, "Dina.Fadel", "see the note below"),
    "B-12",
    "a value that is not shaped like an id falls through to the name match, as it always did",
  );
  assert.equal(
    resolveHrIdFromEmployeeMaps(maps, "Dina.Fadel", "Ahmed.Abdallah"),
    "B-12",
    "a NAME sitting in the HR column is not an id either — the dot and the length give it away",
  );

  // ── The order is the fix, so pin it where it is decided ────────────────────────────────────
  const source = readSource("../src/lib/outstation/expense-import.ts");
  const fn = source.match(/export function resolveHrIdFromEmployeeMaps\([\s\S]*?\n\}/)?.[0];
  assert.ok(fn, "the resolver must still exist and be exported for this test to reach it");
  const sheetBranch = fn.indexOf("SHEET_HR_ID_SHAPE.test(stated)");
  const nameBranch = fn.indexOf("employeeNameKeys(specialist)");
  assert.ok(sheetBranch > -1 && nameBranch > -1, "both routes must still be present");
  assert.ok(
    sheetBranch < nameBranch,
    "the sheet's id must be consulted BEFORE the name match — reversing these two is the bug, " +
      "and it is invisible until a leaver's expenses are imported",
  );
}
