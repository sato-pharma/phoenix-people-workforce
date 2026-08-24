import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  employmentStatusLabel,
  employmentStatusLabels,
} from "../src/lib/employees/employment-status-label.ts";

/**
 * Two stored values that reached the Hiring Documents Control screen as stored values, both live
 * on production on 24 Aug 2026.
 *
 *   - The Employee Status filter listed "active", "resigned", "terminated" in raw lowercase, while
 *     the table one column over read correctly. Nothing clever was happening in the table: `Badge`
 *     carries `uppercase` in its class, so the same raw code simply arrived styled. An `<option>`
 *     cannot be styled that way, which is why the code has to become words before it is rendered.
 *   - Every one of the ten configured documents printed its primary key underneath its name —
 *     "b748745e-b674-479e-915d-d01f4c84dcd4" below "National ID copy".
 *
 * Both break the same standing rule: show human-readable names, never raw codes or IDs.
 */
export function runHiringDocumentsLabelTests() {
  const manager = readFileSync("src/components/hiring-documents/hiring-documents-manager.tsx", "utf8");

  // ---------------------------------------------------------------------------
  // The headline: the exact strings that were in the dropdown.
  // ---------------------------------------------------------------------------
  assert.equal(employmentStatusLabel("active"), "Active", "the filter listed a raw 'active'");
  assert.equal(employmentStatusLabel("resigned"), "Resigned", "the filter listed a raw 'resigned'");
  assert.equal(employmentStatusLabel("terminated"), "Terminated", "the filter listed a raw 'terminated'");

  // The other two statuses production actually holds. They are bookkeeping states, but a person
  // still has to read them in a filter list, so an underscore is not an acceptable answer.
  assert.equal(employmentStatusLabel("historical_payroll_record"), "Historical payroll record");
  assert.equal(employmentStatusLabel("system_placeholder"), "System placeholder");
  assert.equal(employmentStatusLabel("on_leave"), "On leave", "sentence case, not Title Case");

  // ---------------------------------------------------------------------------
  // No status may render as a raw or half-cooked value, whatever it is.
  // ---------------------------------------------------------------------------
  for (const code of Object.keys(employmentStatusLabels)) {
    const label = employmentStatusLabel(code);
    assert.ok(label.length > 0, `${code} must have a label`);
    assert.ok(!label.includes("_"), `${code} rendered with an underscore: ${label}`);
    assert.ok(/^[A-Z]/.test(label), `${code} rendered without a capital: ${label}`);
  }

  // A status that reaches the database before it reaches this file still reads as words.
  assert.equal(employmentStatusLabel("contract_expired"), "Contract expired", "an untaught code still reads as prose");
  assert.equal(employmentStatusLabel("ACTIVE"), "Active", "the stored casing must not decide the label");
  assert.equal(employmentStatusLabel(""), "", "empty in, empty out");
  assert.equal(employmentStatusLabel(null), "", "null must not render as 'Null'");
  assert.equal(employmentStatusLabel(undefined), "", "undefined must not render as 'Undefined'");

  // ---------------------------------------------------------------------------
  // The screen has to actually use it — in the dropdown AND in the badge beside it, so the two
  // can never drift back apart.
  // ---------------------------------------------------------------------------
  assert.match(
    manager,
    /<option key=\{status\} value=\{status\}>\{employmentStatusLabel\(status\)\}<\/option>/,
    "the Employee Status filter must render words, not the stored code",
  );
  assert.ok(
    !/\{status\.replace\(\/_\/g, " "\)\}/.test(manager),
    "the filter went back to humanising the code inline instead of using the shared label",
  );
  assert.match(
    manager,
    /const label = employmentStatusLabel\(normalized\) \|\| "Unknown";/,
    "the badge must take its words from the same place as the dropdown",
  );

  // ---------------------------------------------------------------------------
  // The document's primary key is not a label. Covers the desktop table and the mobile card.
  // ---------------------------------------------------------------------------
  assert.ok(
    !/>\{document\.id\}</.test(manager),
    "a document's UUID is being rendered as text again — it belongs in the closure, not on screen",
  );
  assert.ok(
    !/font-mono text-xs text-\[#94A3B8\]">\{document\.id\}/.test(manager),
    "the UUID line under the document name came back",
  );
  // The name itself must still be there in both places — a fix that deleted the wrong line would
  // otherwise pass everything above.
  assert.equal(
    (manager.match(/<p className="font-bold text-\[#0F172A\]">\{document\.name\}<\/p>/g) ?? []).length,
    2,
    "the document name belongs on the desktop row and the mobile card — both, and unchanged",
  );
}
